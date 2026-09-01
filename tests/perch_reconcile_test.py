import hashlib
import importlib.util
import io
import json
import os
import re
import base64
import socket
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# Dual layout, the same two worlds tests/island-paths.js resolves: upstream the
# Since the 2026-08-31 split both the working repo and the package are flat, so
# the repo root. Probed by a directory only the package has — never by counting
# levels up from this file, which is what pinned these tests to one layout and
# left them unable to run inside the extracted package at all.
PKG = ROOT
MODULE_PATH = PKG / "perch-reconcile.py"


def load_module():
    spec = importlib.util.spec_from_file_location("perch_reconcile", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The scheduled job does not run this file. The installer takes a byte copy to
# `~/.perch/bin/perch-reconcile` and launchd runs that, so editing the source
# changes nothing until the installer runs again -- and every other test here
# reads the source, which means a fully green suite can sit beside a deployed
# copy that is months behind and quietly seeing fewer rows.
# Both helper scripts are deployed the same way and go stale the same way: a
# byte copy under ~/.perch/bin that a scheduler or a provider hook runs instead
# of the file you just edited. They are checked in one place so that neither can
# be remembered without the other.
DEPLOYED_COPIES = (
    ("the history rebuild", Path.home() / ".perch" / "bin" / "perch-reconcile", MODULE_PATH),
    ("the hook launcher", Path.home() / ".perch" / "bin" / "perch-hook", PKG / "perch-hook.sh"),
)


def _code_only(path):
    """The file with its agent sticky notes taken out.

    ⚠️ Sticky notes are BY DEFINITION the lines that do not ship: the publishing
    step strips them, so a published copy and the tree it came from differ in
    exactly those lines and in no others. Comparing raw bytes therefore calls a
    freshly published package "stale" against the very install it was made from
    — which is not a stale install, it is the same code wearing fewer notes.
    Everything that decides behaviour survives this, so a real drift still shows.
    """
    # ⚠️ The SAME rule the publishing step uses, not a looser one of our own: it
    # drops a line only when the line IS a note — leading space, a comment
    # marker, then the tag. Dropping every line that merely CONTAINS the tag
    # would also swallow a line of real code that mentions it, and a genuine
    # drift on that line would then be normalised away into "same".
    # ⚠️ The tag is spelled in halves for the same reason export-perch.py spells
    # it that way: a file carrying it whole fails the residue check.
    tag = "AIDEV"
    note = re.compile(r"\s*(#|//)\s*" + tag + r"-(NOTE|TODO|QUESTION)\b", re.I)
    return "\n".join(line for line in path.read_text(encoding="utf-8").split("\n")
                     if not note.match(line))


def deployed_copy_verdict(installed, source):
    """Say whether the copy that runs is the CODE in this tree.

    "absent" when nothing is installed, "same" when the two carry the same code,
    and "stale" for anything else. Not mtime: a checkout resets mtime, so a fresh
    clone of older code would look newer than the copy running it.
    """
    if not installed.is_file():
        return "absent"
    return "same" if _code_only(installed) == _code_only(source) else "stale"


def write_jsonl(path, records, partial_tail=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records)
    if partial_tail is not None:
        body += partial_tail
    path.write_text(body, encoding="utf-8")


def codex_session(session_id, cwd, turns):
    records = [
        {
            "timestamp": "2026-08-12T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": session_id, "cwd": cwd},
        }
    ]
    for turn in turns:
        turn_id, started_at, ended_at, outcome = turn
        records.append(
            {
                "timestamp": started_at,
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": turn_id},
            }
        )
        if outcome == "completed":
            records.append(
                {
                    "timestamp": ended_at,
                    "type": "event_msg",
                    "payload": {"type": "task_complete", "turn_id": turn_id},
                }
            )
        elif outcome == "interrupted":
            records.append(
                {
                    "timestamp": ended_at,
                    "type": "event_msg",
                    "payload": {
                        "type": "turn_aborted",
                        "turn_id": turn_id,
                        "reason": "interrupted",
                    },
                }
            )
    return records


def with_ordinal(records):
    """Re-emit Codex records the way a newer Codex writes them.

    Codex began putting an ``ordinal`` between ``timestamp`` and ``type`` on
    2026-08-21.  Nothing about the record's meaning changed — but a scanner
    that assumes the two fields touch stops seeing the record at all, and says
    nothing, because in its eyes the line was never a lifecycle row.
    """
    out = []
    for index, record in enumerate(records):
        moved = {"timestamp": record["timestamp"], "ordinal": index}
        moved.update({k: v for k, v in record.items() if k != "timestamp"})
        out.append(moved)
    return out


def claude_prompt(session_id, prompt_id, uuid, timestamp, cwd):
    return {
        "type": "user",
        "sessionId": session_id,
        "promptId": prompt_id,
        "uuid": uuid,
        "timestamp": timestamp,
        "cwd": cwd,
        "message": {"role": "user", "content": "fixture content is ignored"},
    }


def claude_assistant_real_order(session_id, uuid, timestamp, cwd, stop_reason, answer_chars):
    """An assistant record in the field order a real transcript writes.

    The fixtures above put ``type`` first, which is why they never noticed the
    scanner reading only the head of a line: in a real transcript the whole
    message body — the answer text and every tool input — sits BEFORE the
    top-level ``type``, so the longer the answer, the further out that field
    lands.  And the field that settles a turn only ever rides a long line: a
    turn ends when the model stops talking, which is when it has said the most.
    """
    return {
        "parentUuid": "parent-" + uuid,
        "sessionId": session_id,
        "cwd": cwd,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "x" * answer_chars}],
            "stop_reason": stop_reason,
        },
        "type": "assistant",
        "uuid": uuid,
        "timestamp": timestamp,
    }


def claude_assistant(session_id, uuid, timestamp, cwd, stop_reason, api_error=False):
    return {
        "type": "assistant",
        "sessionId": session_id,
        "uuid": uuid,
        "timestamp": timestamp,
        "cwd": cwd,
        "message": {"stop_reason": stop_reason, "content": []},
        "isApiErrorMessage": api_error,
    }


class PerchReconcileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reconcile_module = load_module()

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.base = Path(self.tempdir.name)
        self.codex = self.base / "codex"
        self.claude = self.base / "claude"
        self.hooks = self.base / "hooks.jsonl"
        self.out = self.base / "out"

    def tearDown(self):
        self.tempdir.cleanup()

    def run_reconcile(self, generated_at="2026-08-13T00:00:00Z", **kwargs):
        return self.reconcile_module.reconcile(
            codex_root=self.codex,
            claude_root=self.claude,
            hook_ledgers=[self.hooks],
            out_dir=self.out,
            generated_at=generated_at,
            **kwargs,
        )

    def test_publish_bridge_transfers_exact_derived_files_without_provider_text(self):
        socket_path = self.base / "bridge.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(1)
        received = bytearray()

        def receive():
            connection, _ = server.accept()
            with connection:
                while True:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    received.extend(chunk)

        thread = threading.Thread(target=receive)
        thread.start()
        health = b'{"schema_version":1,"alerts":[]}\n'
        canonical = b'{"record_id":"a","reconstructed":true}\n'
        try:
            self.reconcile_module.publish_reconciliation(socket_path, health, canonical)
            thread.join(timeout=2)
        finally:
            server.close()

        self.assertFalse(thread.is_alive())
        event, health64, canonical64, source = bytes(received).split(b"\t")
        self.assertEqual(event, b"reconciliation")
        self.assertEqual(source, b"reconciler")
        self.assertEqual(base64.b64decode(health64, validate=True), health)
        self.assertEqual(base64.b64decode(canonical64, validate=True), canonical)

    def test_hook_snapshot_request_receives_only_app_exported_lifecycle_ledger(self):
        socket_path = self.base / "bridge-ledger.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(1)
        ledger = b'{"event":"working","project":"/work/a","source":"codex","t":"2026-08-12T10:00:00+00:00"}\n'
        request = bytearray()

        def serve():
            connection, _ = server.accept()
            with connection:
                while True:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    request.extend(chunk)
                connection.sendall(b"OK\n" + ledger)

        thread = threading.Thread(target=serve)
        thread.start()
        try:
            received = self.reconcile_module.request_hook_snapshot(socket_path, 7)
            thread.join(timeout=2)
        finally:
            server.close()

        self.assertFalse(thread.is_alive())
        self.assertEqual(bytes(request), b"hook-ledger-request\t7\t0\treconciler")
        self.assertEqual(received, ledger)

    def test_hook_snapshot_request_retries_the_login_socket_race(self):
        socket_path = self.base / "delayed-bridge.sock"
        ledger = b'{"event":"working","project":"/work/a","source":"codex","t":"2026-08-12T10:00:00+00:00"}\n'

        def delayed_server():
            time.sleep(0.05)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(socket_path))
                server.listen(1)
                connection, _ = server.accept()
                with connection:
                    while connection.recv(4096):
                        pass
                    connection.sendall(b"OK\n" + ledger)

        thread = threading.Thread(target=delayed_server)
        thread.start()
        received = self.reconcile_module.request_hook_snapshot(
            socket_path, 7, attempts=20, sleep=lambda _: time.sleep(0.01))
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertEqual(received, ledger)

    def read_turns(self):
        path = self.out / "canonical-turns.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def test_missing_codex_hook_is_not_hidden_by_live_claude_source(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "codex-session",
                "/work/codex",
                [("turn-a", "2026-08-12T10:00:00Z", "2026-08-12T10:02:00Z", "completed")],
            ),
        )
        write_jsonl(
            self.claude / "project" / "claude.jsonl",
            [
                claude_prompt("claude-session", "prompt-a", "user-a", "2026-08-12T10:00:00Z", "/work/claude"),
                claude_assistant("claude-session", "assistant-a", "2026-08-12T10:01:00Z", "/work/claude", "end_turn"),
            ],
        )
        write_jsonl(
            self.hooks,
            [
                {"t": "2026-08-12T10:00:01Z", "event": "working", "project": "/work/claude", "source": "claude"},
                {"t": "2026-08-12T10:01:00Z", "event": "complete", "project": "/work/claude", "source": "claude"},
            ],
        )

        result = self.run_reconcile()

        self.assertEqual(result["health"]["sources"]["codex"]["status"], "degraded")
        self.assertEqual(result["health"]["sources"]["codex"]["uncovered_turns"], 1)
        self.assertEqual(result["health"]["sources"]["codex"]["freshness_status"], "missing")
        self.assertEqual(result["health"]["sources"]["claude"]["status"], "healthy")
        self.assertEqual(result["health"]["sources"]["claude"]["freshness_status"], "current")
        self.assertEqual([alert["source"] for alert in result["health"]["alerts"]], ["codex"])

    def test_restart_rescan_rebuilds_cache_and_is_byte_stable(self):
        path = self.codex / "sessions" / "rollout-a.jsonl"
        first = codex_session(
            "session-a",
            "/work/a",
            [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
        )
        write_jsonl(path, first)
        write_jsonl(self.hooks, [])
        self.run_reconcile()
        self.assertEqual(len(self.read_turns()), 1)

        second = codex_session(
            "session-a",
            "/work/a",
            [
                ("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed"),
                ("turn-2", "2026-08-12T11:00:00Z", "2026-08-12T11:01:00Z", "completed"),
            ],
        )
        write_jsonl(path, second)
        self.run_reconcile()
        cache = self.out / "canonical-turns.jsonl"
        first_hash = hashlib.sha256(cache.read_bytes()).hexdigest()
        self.assertEqual([turn["turn_id"] for turn in self.read_turns()], ["turn-1", "turn-2"])

        self.run_reconcile()
        second_hash = hashlib.sha256(cache.read_bytes()).hexdigest()
        self.assertEqual(first_hash, second_hash)

    def test_duplicate_markers_collapse_to_one_reconstructed_turn(self):
        records = codex_session(
            "session-a",
            "/work/a",
            [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
        )
        records.extend(records[1:])
        write_jsonl(self.codex / "sessions" / "rollout-a.jsonl", records)
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = self.read_turns()

        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["record_id"], "codex:session-a:turn-1")
        self.assertIs(turns[0]["reconstructed"], True)
        self.assertEqual(turns[0]["provenance"]["kind"], "codex_rollout")

    def test_partial_final_line_is_deferred_without_losing_complete_records(self):
        records = codex_session(
            "session-a",
            "/work/a",
            [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
        )
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            records,
            partial_tail='{"timestamp":"2026-08-12T11:00:00Z","type":"event_msg"',
        )
        write_jsonl(self.hooks, [])

        result = self.run_reconcile()

        self.assertEqual(len(self.read_turns()), 1)
        self.assertEqual(result["health"]["sources"]["codex"]["partial_lines"], 1)
        self.assertEqual(result["health"]["sources"]["codex"]["parse_errors"], 0)

    def test_parallel_projects_with_same_turn_id_remain_distinct(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [("turn-shared", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
            ),
        )
        write_jsonl(
            self.codex / "sessions" / "rollout-b.jsonl",
            codex_session(
                "session-b",
                "/work/b",
                [("turn-shared", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
            ),
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = self.read_turns()

        self.assertEqual(len(turns), 2)
        self.assertEqual({turn["project"] for turn in turns}, {"/work/a", "/work/b"})
        self.assertEqual(len({turn["record_id"] for turn in turns}), 2)

    def test_resumed_session_replays_history_and_must_not_overwrite_the_original_end(self):
        # Codex "resume" opens a NEW rollout file and replays the whole prior
        # conversation into it: the old session_meta comes along, and every past
        # turn is re-emitted stamped with the instant of the replay.  Reading
        # those as fresh events made a 5-minute turn look like it ran for a day.
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:05:00Z", "completed")],
            ),
        )
        resumed = [
            {
                "timestamp": "2026-08-12T20:00:00Z",
                "type": "session_meta",
                "payload": {"id": "session-b", "cwd": "/work/a"},
            },
            {
                "timestamp": "2026-08-12T20:00:00Z",
                "type": "session_meta",
                "payload": {"id": "session-a", "cwd": "/work/a"},
            },
        ]
        # replayed history: start and end land in the same write burst
        resumed.extend(
            codex_session(
                "ignored-header",
                "/work/a",
                [("turn-1", "2026-08-12T20:00:00.001Z", "2026-08-12T20:00:00.004Z", "completed")],
            )[1:]
        )
        # live work in the resumed session, minutes later
        resumed.extend(
            codex_session(
                "ignored-header",
                "/work/a",
                [("turn-2", "2026-08-12T20:10:00Z", "2026-08-12T20:12:00Z", "completed")],
            )[1:]
        )
        write_jsonl(self.codex / "sessions" / "rollout-b.jsonl", resumed)
        write_jsonl(self.hooks, [])

        result = self.run_reconcile()
        turns = {turn["record_id"]: turn for turn in self.read_turns()}

        # the original turn keeps the end its own file recorded
        self.assertEqual(
            turns["codex:session-a:turn-1"]["ended_at"], "2026-08-12T10:05:00.000Z"
        )
        # the resumed file is identified by its OWN (first) session_meta, so the
        # live turn is filed under session-b and never collides with session-a
        self.assertIn("codex:session-b:turn-2", turns)
        # the replayed copy is history, not work, and it is not in the ledger
        self.assertNotIn("codex:session-b:turn-1", turns)
        self.assertEqual(len(turns), 2)
        # dropping records silently is how a ledger starts lying: say how many
        self.assertEqual(result["health"]["sources"]["codex"]["replayed_turns_skipped"], 1)

    def test_a_single_session_file_keeps_its_short_turns_and_reports_no_replays(self):
        # Control group for the test above.  If the replay predicate ever widens
        # into "drop short turns", this fixture goes red: a normal file may hold
        # a genuinely instant turn, and dropping real work is worse than the bug.
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [
                    ("turn-1", "2026-08-12T10:00:00.000Z", "2026-08-12T10:00:00.002Z", "completed"),
                    ("turn-2", "2026-08-12T10:01:00Z", "2026-08-12T10:04:00Z", "completed"),
                ],
            ),
        )
        write_jsonl(self.hooks, [])

        result = self.run_reconcile()
        turns = {turn["record_id"]: turn for turn in self.read_turns()}

        self.assertEqual(len(turns), 2)
        self.assertEqual(
            turns["codex:session-a:turn-1"]["ended_at"], "2026-08-12T10:00:00.002Z"
        )
        self.assertEqual(result["health"]["sources"]["codex"]["replayed_turns_skipped"], 0)

    def test_a_turn_with_no_terminal_event_stays_open_instead_of_borrowing_an_end(self):
        # The honest answer to "when did this turn finish?" is sometimes "no
        # record says".  A null end is skipped downstream; an invented one is
        # counted as work that never happened.
        records = codex_session("session-a", "/work/a", [])
        records.append(
            {
                "timestamp": "2026-08-12T10:00:00Z",
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-open"},
            }
        )
        write_jsonl(self.codex / "sessions" / "rollout-a.jsonl", records)
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = {turn["record_id"]: turn for turn in self.read_turns()}

        self.assertIsNone(turns["codex:session-a:turn-open"]["ended_at"])
        self.assertEqual(turns["codex:session-a:turn-open"]["outcome"], "open")

    def test_claude_next_prompt_interrupts_open_turn_and_tool_result_does_not_start_one(self):
        write_jsonl(
            self.claude / "project" / "claude.jsonl",
            [
                claude_prompt("session-c", "prompt-1", "user-1", "2026-08-12T10:00:00Z", "/work/c"),
                claude_assistant("session-c", "assistant-tool", "2026-08-12T10:00:30Z", "/work/c", "tool_use"),
                {
                    "type": "user",
                    "sessionId": "session-c",
                    "promptId": "prompt-1",
                    "uuid": "tool-result",
                    "timestamp": "2026-08-12T10:00:31Z",
                    "cwd": "/work/c",
                    "message": {
                        "role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": "tool-a"}],
                    },
                },
                claude_prompt("session-c", "prompt-2", "user-2", "2026-08-12T10:01:00Z", "/work/c"),
                claude_assistant("session-c", "assistant-end", "2026-08-12T10:02:00Z", "/work/c", "end_turn"),
            ],
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = {turn["turn_id"]: turn for turn in self.read_turns()}

        self.assertEqual(set(turns), {"prompt-1", "prompt-2"})
        self.assertEqual(turns["prompt-1"]["outcome"], "interrupted")
        self.assertEqual(turns["prompt-1"]["ended_at"], "2026-08-12T10:01:00.000Z")
        self.assertEqual(turns["prompt-2"]["outcome"], "completed")

    def test_codex_records_settle_when_a_new_field_lands_between_two_old_ones(self):
        """A provider adding a field must not silently empty the rebuild.

        Both sessions here are the same work written by two Codex versions and
        differ only by an ``ordinal`` the newer one inserts.  A scanner keyed to
        the two fields touching sees one session and not the other, and reports
        no error either way: the rows it drops were never lifecycle rows to it.
        The control is the old shape — green before this test existed, so it
        cannot be what makes this test fail.
        """
        write_jsonl(
            self.codex / "sessions" / "rollout-old-shape.jsonl",
            codex_session("session-old", "/work/old",
                          [("turn-old", "2026-08-12T10:00:00Z", "2026-08-12T10:05:00Z", "completed")]),
        )
        write_jsonl(
            self.codex / "sessions" / "rollout-new-shape.jsonl",
            with_ordinal(codex_session(
                "session-new", "/work/new",
                [("turn-new", "2026-08-12T11:00:00Z", "2026-08-12T11:05:00Z", "completed")])),
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = {turn["turn_id"]: turn for turn in self.read_turns()}

        self.assertEqual(turns["turn-old"]["outcome"], "completed")
        self.assertEqual(turns["turn-new"]["outcome"], "completed")
        self.assertEqual(turns["turn-new"]["ended_at"], "2026-08-12T11:05:00.000Z")
        self.assertEqual(turns["turn-new"]["project"], "/work/new")

    def test_a_long_claude_answer_still_settles_its_turn(self):
        """Scanning one end of a line only is the same as not scanning it.

        Both sessions here end the same way — the model finishes talking — and
        differ only in how much it said.  A scanner that reads a bounded head
        keeps every prompt (prompts are short) and drops every completion
        (completions are long), so every turn stays open until the NEXT prompt
        closes it as interrupted, wearing that prompt's clock.  Resume a
        session days later and the turn reads days long.
        """
        write_jsonl(
            self.claude / "project" / "claude.jsonl",
            [
                # Control: a short answer. It settles even when only the head is
                # read, so on its own it can never show this bug.
                claude_prompt("session-short", "prompt-short", "u-1", "2026-08-12T10:00:00Z", "/work/c"),
                claude_assistant_real_order(
                    "session-short", "a-short", "2026-08-12T10:00:30Z", "/work/c", "end_turn", 20),
                # The same ending, said at length.
                claude_prompt("session-long", "prompt-long", "u-2", "2026-08-12T10:00:00Z", "/work/c"),
                claude_assistant_real_order(
                    "session-long", "a-long", "2026-08-12T10:02:00Z", "/work/c", "end_turn", 4096),
            ],
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = {turn["turn_id"]: turn for turn in self.read_turns()}

        self.assertEqual(turns["prompt-short"]["outcome"], "completed")
        self.assertEqual(turns["prompt-long"]["outcome"], "completed")
        self.assertEqual(turns["prompt-long"]["ended_at"], "2026-08-12T10:02:00.000Z")

    def test_claude_api_error_is_failed_and_open_tail_stays_open(self):
        write_jsonl(
            self.claude / "project" / "claude.jsonl",
            [
                claude_prompt("session-c", "prompt-fail", "user-1", "2026-08-12T10:00:00Z", "/work/c"),
                claude_assistant(
                    "session-c",
                    "assistant-error",
                    "2026-08-12T10:01:00Z",
                    "/work/c",
                    "stop_sequence",
                    api_error=True,
                ),
                claude_prompt("session-c", "prompt-open", "user-2", "2026-08-12T11:00:00Z", "/work/c"),
            ],
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()
        turns = {turn["turn_id"]: turn for turn in self.read_turns()}

        self.assertEqual(turns["prompt-fail"]["outcome"], "failed")
        self.assertEqual(turns["prompt-open"]["outcome"], "open")
        self.assertIsNone(turns["prompt-open"]["ended_at"])

    def test_codex_turn_aborted_preserves_interrupted_outcome(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "interrupted")],
            ),
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile()

        self.assertEqual(self.read_turns()[0]["outcome"], "interrupted")
        self.assertEqual(self.run_reconcile()["health"]["sources"]["codex"]["settled_turns"], 1)

    def test_source_recovery_keeps_historical_coverage_alert(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [
                    ("turn-gap", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed"),
                    ("turn-after", "2026-08-12T11:00:00Z", "2026-08-12T11:01:00Z", "completed"),
                ],
            ),
        )
        write_jsonl(
            self.hooks,
            [
                {"t": "2026-08-12T11:00:01Z", "event": "working", "project": "/work/a", "source": "codex"},
                {"t": "2026-08-12T11:01:00Z", "event": "complete", "project": "/work/a", "source": "codex"},
            ],
        )

        result = self.run_reconcile()
        health = result["health"]["sources"]["codex"]

        self.assertEqual(health["status"], "recovered_with_gap")
        self.assertEqual(health["uncovered_turns"], 1)
        self.assertEqual(result["health"]["alerts"][0]["kind"], "coverage_gap_recovered")

    def test_window_filter_keeps_only_turns_that_start_inside_requested_interval(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [
                    ("before", "2026-08-12T09:59:00Z", "2026-08-12T10:00:30Z", "completed"),
                    ("inside", "2026-08-12T10:30:00Z", "2026-08-12T10:31:00Z", "completed"),
                    ("after", "2026-08-12T11:00:00Z", "2026-08-12T11:01:00Z", "completed"),
                ],
            ),
        )
        write_jsonl(self.hooks, [])

        self.run_reconcile(window_start="2026-08-12T10:00:00Z", window_end="2026-08-12T11:00:00Z")

        self.assertEqual([turn["turn_id"] for turn in self.read_turns()], ["inside"])

    def test_window_prunes_old_files_without_calling_an_idle_provider_missing(self):
        old_codex = self.codex / "sessions" / "rollout-old.jsonl"
        old_claude = self.claude / "project" / "claude-old.jsonl"
        write_jsonl(
            old_codex,
            codex_session(
                "old-codex",
                "/work/old",
                [("old", "2026-07-01T10:00:00Z", "2026-07-01T10:01:00Z", "completed")],
            ),
        )
        write_jsonl(
            old_claude,
            [claude_prompt("old-claude", "old", "old-u", "2026-07-01T10:00:00Z", "/work/old")],
        )
        old_stamp = 1_783_000_000
        os.utime(old_codex, (old_stamp, old_stamp))
        os.utime(old_claude, (old_stamp, old_stamp))
        write_jsonl(self.hooks, [])

        result = self.run_reconcile(window_start="2026-08-06T00:00:00Z")

        self.assertEqual(result["turns"], [])
        for source in ("codex", "claude"):
            health = result["health"]["sources"][source]
            self.assertEqual(health["files_available"], 1)
            self.assertEqual(health["files_scanned"], 0)
        self.assertNotIn(
            "native_source_missing",
            {alert["kind"] for alert in result["health"]["alerts"]},
        )

    def test_window_still_rescans_an_old_session_file_modified_inside_window(self):
        active = self.codex / "sessions" / "2026" / "07" / "rollout-active.jsonl"
        write_jsonl(
            active,
            codex_session(
                "active-session",
                "/work/active",
                [("new-turn", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
            ),
        )
        inside_window_stamp = 1_786_520_000
        os.utime(active, (inside_window_stamp, inside_window_stamp))
        write_jsonl(self.hooks, [])

        result = self.run_reconcile(window_start="2026-08-06T00:00:00Z")

        self.assertEqual([turn["turn_id"] for turn in result["turns"]], ["new-turn"])
        self.assertEqual(result["health"]["sources"]["codex"]["files_scanned"], 1)

    def test_cli_returns_nonzero_when_a_source_coverage_alert_exists(self):
        write_jsonl(
            self.codex / "sessions" / "rollout-a.jsonl",
            codex_session(
                "session-a",
                "/work/a",
                [("turn-1", "2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z", "completed")],
            ),
        )
        write_jsonl(self.hooks, [])
        output = io.StringIO()

        with redirect_stdout(output):
            exit_code = self.reconcile_module.main(
                [
                    "--codex-root",
                    str(self.codex),
                    "--claude-root",
                    str(self.claude),
                    "--hook-ledger",
                    str(self.hooks),
                    "--dry-run",
                    "--fail-on-alert",
                ]
            )

        self.assertEqual(exit_code, 2)
        self.assertEqual(json.loads(output.getvalue())["sources"]["codex"]["status"], "degraded")

    def test_cli_alerts_when_both_authoritative_source_roots_are_missing(self):
        output = io.StringIO()

        with redirect_stdout(output):
            exit_code = self.reconcile_module.main(
                [
                    "--codex-root",
                    str(self.codex),
                    "--claude-root",
                    str(self.claude),
                    "--dry-run",
                    "--fail-on-alert",
                ]
            )

        result = json.loads(output.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertEqual(result["alerts"], 2)
        self.assertEqual(result["sources"]["codex"]["status"], "missing")
        self.assertEqual(result["sources"]["claude"]["status"], "missing")

    def test_deployed_copy_verdict_separates_absent_same_and_stale(self):
        source = self.base / "perch-reconcile.py"
        source.write_bytes(b"print('scan')\n")
        installed = self.base / "bin" / "perch-reconcile"

        self.assertEqual(deployed_copy_verdict(installed, source), "absent")

        installed.parent.mkdir(parents=True)
        installed.write_bytes(source.read_bytes())
        self.assertEqual(deployed_copy_verdict(installed, source), "same")

        # One byte is the whole point: the field that went unread in the drift
        # this guard exists for was a single word in a regular expression.
        source.write_bytes(b"print('scan')\n\n")
        self.assertEqual(deployed_copy_verdict(installed, source), "stale")

    def test_a_published_copy_is_not_stale_merely_for_having_lost_its_notes(self):
        # What publishing does to a file, done here by hand: the sticky notes go
        # and nothing else moves. This is the shape that broke the export once —
        # the copied package was compared against the install it came from and
        # declared out of date.
        source = self.base / "perch-reconcile.py"
        installed = self.base / "bin" / "perch-reconcile"
        installed.parent.mkdir(parents=True)
        note = "# " + "AIDEV" + "-NOTE: kept for the next reader"   # halves: see _code_only
        installed.write_text(note + "\nprint('scan')\n", encoding="utf-8")
        source.write_text("print('scan')\n", encoding="utf-8")
        self.assertEqual(deployed_copy_verdict(installed, source), "same")

        # Control: with the code itself changed it must still read stale, or the
        # rule above has quietly excused everything.
        source.write_text("print('scan twice')\n", encoding="utf-8")
        self.assertEqual(deployed_copy_verdict(installed, source), "stale")

    def test_a_line_that_merely_mentions_the_tag_is_still_compared(self):
        # The publishing step drops a line only when the line IS a note. A rule
        # that dropped every line MENTIONING the tag would erase this drift.
        tag = "AIDEV" + "-NOTE"
        source = self.base / "perch-reconcile.py"
        installed = self.base / "bin" / "perch-reconcile"
        installed.parent.mkdir(parents=True)
        installed.write_text(f'marker = "{tag}"\nprint("scan")\n', encoding="utf-8")
        source.write_text(f'marker = "{tag}!"\nprint("scan")\n', encoding="utf-8")
        self.assertEqual(deployed_copy_verdict(installed, source), "stale")

        # Control: identical code mentioning the tag must still read same, or
        # the assertion above would pass for the wrong reason.
        source.write_text(f'marker = "{tag}"\nprint("scan")\n', encoding="utf-8")
        self.assertEqual(deployed_copy_verdict(installed, source), "same")

    def test_what_the_schedulers_run_is_what_this_tree_holds(self):
        checked = 0
        for label, installed, source in DEPLOYED_COPIES:
            with self.subTest(label):
                verdict = deployed_copy_verdict(installed, source)
                if verdict == "absent":
                    continue
                checked += 1
                self.assertEqual(
                    verdict,
                    "same",
                    f"{installed} differs from {source}: {label} is running older code than "
                    "this tree holds. Re-run the installer that put it there.",
                )
        if checked == 0:
            raise unittest.SkipTest(
                "no helper copies installed on this machine; none of them can be stale")


if __name__ == "__main__":
    unittest.main()
