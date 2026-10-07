import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "island-day-report.py"


def load_module():
    spec = importlib.util.spec_from_file_location("island_day_report", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stamp(day, hh, mm):
    """A local-offset timestamp the way the island writes them."""
    local = datetime(day.year, day.month, day.day, hh, mm).astimezone()
    return local.isoformat(timespec="seconds")


def day_lines(day, project="/work/a", source="codex"):
    """A small day: three turns, quick pickups, so the reading is not all zeros."""
    out = []
    minute = 0
    for _ in range(6):
        out.append({"event": "working", "project": project, "source": source, "t": stamp(day, 10, minute)})
        out.append({"event": "complete", "project": project, "source": source, "t": stamp(day, 10, minute + 1)})
        minute += 2
    return "".join(json.dumps(e, sort_keys=True) + "\n" for e in out)


class FakeIsland:
    """An AF_UNIX server that answers one ledger request the way the island does."""

    def __init__(self, base, reply):
        self.path = str(base / "b.sock")
        self.reply = reply
        self.request = bytearray()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        connection, _ = self.server.accept()
        with connection:
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                self.request.extend(chunk)
            connection.sendall(self.reply)

    def close(self):
        self.thread.join(timeout=2)
        self.server.close()


class BridgeReadingTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        # AF_UNIX paths are short-limited; keep the socket near the temp root.
        self.tmp = tempfile.TemporaryDirectory(prefix="pb")
        self.base = Path(self.tmp.name)
        self.today = datetime.now().date()
        self.yesterday = self.today - timedelta(days=1)

    def tearDown(self):
        self.tmp.cleanup()

    def write_directory(self, days):
        directory = self.base / "agent-events"
        directory.mkdir()
        for day in days:
            (directory / f"{day.isoformat()}.jsonl").write_text(day_lines(day), "utf-8")
        return str(directory)

    def test_bridge_reading_equals_directory_reading_for_the_same_lines(self):
        directory = self.write_directory([self.yesterday, self.today])
        concatenated = day_lines(self.yesterday) + day_lines(self.today)
        island = FakeIsland(self.base, b"OK\n" + concatenated.encode("utf-8"))
        try:
            wanted = [self.yesterday.isoformat(), self.today.isoformat()]
            via_bridge = self.module.load_via_bridge(wanted, socket_path=island.path)
        finally:
            island.close()
        for day in wanted:
            expected = self.module.daily_reading(day, self.module.load(day, directory))
            self.assertEqual(self.module.daily_reading(day, via_bridge[day]), expected)
            self.assertGreater(expected["flow_minutes"], 0, "the fixture must not be an all-zero day")

    def test_bridge_asks_for_just_enough_days_and_names_the_reconciler(self):
        wanted_day = self.today - timedelta(days=3)
        island = FakeIsland(self.base, b"OK\n")
        try:
            result = self.module.load_via_bridge([wanted_day.isoformat()], socket_path=island.path)
        finally:
            island.close()
        self.assertEqual(bytes(island.request), b"hook-ledger-request\t4\t0\treconciler")
        self.assertEqual(result, {wanted_day.isoformat(): None}, "nothing recorded stays None, not []")

    def test_all_reaches_the_islands_full_window(self):
        island = FakeIsland(self.base, b"OK\n" + day_lines(self.today).encode("utf-8"))
        try:
            result = self.module.load_via_bridge(None, socket_path=island.path)
        finally:
            island.close()
        self.assertEqual(bytes(island.request), b"hook-ledger-request\t31\t0\treconciler")
        self.assertEqual(list(result), [self.today.isoformat()])

    def test_reading_via_bridge_never_looks_at_the_directory(self):
        island = FakeIsland(self.base, b"OK\n" + day_lines(self.today).encode("utf-8"))

        def forbidden():
            raise AssertionError("--via-bridge must not resolve the events directory")

        self.module.events_dir = forbidden
        self.module.bridge_socket = lambda: island.path
        out = io.StringIO()
        sys.argv = ["island-day-report.py", "--reading", "--via-bridge"]
        try:
            with redirect_stdout(out):
                self.module.main()
        finally:
            island.close()
        lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([line["date"] for line in lines], [self.today.isoformat()])
        self.assertEqual(set(lines[0]), {"date", "flow_minutes", "agents_ran_minutes", "judged"})

    def test_via_bridge_without_reading_is_refused(self):
        sys.argv = ["island-day-report.py", "--via-bridge"]
        with self.assertRaises(SystemExit) as stop:
            self.module.main()
        self.assertIn("--reading", str(stop.exception))

    def test_island_down_is_a_loud_failure_not_an_empty_day(self):
        missing = str(self.base / "nobody.sock")
        with self.assertRaises(SystemExit) as stop:
            self.module.request_ledger(missing, 2, attempts=3, sleep=lambda _: None)
        self.assertIn("Is the island running?", str(stop.exception))

    def test_island_error_reply_is_reported_not_swallowed(self):
        island = FakeIsland(self.base, b"ERR\tbad-request")
        try:
            with self.assertRaises(SystemExit) as stop:
                self.module.load_via_bridge([self.today.isoformat()], socket_path=island.path)
        finally:
            island.close()
        self.assertIn("bad-request", str(stop.exception))

    def test_days_beyond_the_islands_window_are_refused_up_front(self):
        old = (self.today - timedelta(days=40)).isoformat()
        with self.assertRaises(SystemExit) as stop:
            self.module.load_via_bridge([old], socket_path=str(self.base / "unused.sock"))
        self.assertIn("directory", str(stop.exception))


if __name__ == "__main__":
    unittest.main()
