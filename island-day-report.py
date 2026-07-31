#!/usr/bin/env python3
"""The island's daily work report — counts facts, guesses no states.

Data comes from `AgentEventLog` (the island appends every agent event it
receives, verbatim, one line each).

**What it knows**: when you first put an agent to work, when you last did,
how many turns went back and forth, how long each turn ran, which project and
which agent the time landed on. All of it is counted off timestamps.

**What it does not know** (the report's wording must hold this line):
  · "started" = the first time you handed out work, not when you sat down.
    Half an hour of reading docs beforehand doesn't count.
  · A turn's duration is time the AGENT was running — you were waiting for
    it, not doing the work yourself.
  · A gap is indistinguishable: lunch, a meeting, or you writing code by
    hand — the island only sees agents.
So the report says "how long you and the agents worked together" and never
claims to know how focused you were.

**How turns are cut**: the hooks push both UserPromptSubmit and PostToolUse
as `working`, so one `working` line cannot tell "you hit enter" from "a tool
finished". The boundaries still derive: `complete` closes a turn, and the
first `working` after it opens a new one. Grouped by (source, project) — two
agents running in two projects in parallel are two independent conversations.

Usage:
    python3 island-day-report.py            # today
    python3 island-day-report.py 2026-07-10
    python3 island-day-report.py --list     # which days have data
"""
from __future__ import annotations   # so `X | None` annotations parse on macOS's stock python 3.9

import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta

def _app_group() -> str:
    """Read the App Group from the installed island; never hard-coded — a
    Team ID links to the Apple developer account's registrant name."""
    plist = "/Applications/Perch.app/Contents/Info.plist"
    if not os.path.exists(plist):
        raise SystemExit(f"{plist} not found. Install the island first: python3 install-island-app.py (same directory)")
    out = subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :AppGroupID", plist],
                         capture_output=True, text=True).stdout.strip()
    # Must look like group.<something>, with NO Team prefix: the Team ID gets
    # stamped into the shipped binary via the entitlement, and creates a
    # folder named after it on every user's machine.
    if not out.startswith("group.") or not out.removeprefix("group."):
        raise SystemExit(f"Bad App Group in the installed island (got {out!r})")
    return out


def events_dir() -> str:
    """Where the island writes its event log.

    Resolved lazily, NOT at import time: the tests import this module to drive
    the real turn-cutting function, and reading the installed app during
    import would make them depend on whether this machine happens to have
    Perch installed.
    """
    return os.path.expanduser(f"~/Library/Group Containers/{_app_group()}/agent-events")


# A quiet stretch at least this long shows as a "gap" — display only, feeds no logic
GAP = timedelta(minutes=30)
# A turn open longer than this most likely lost its complete (session killed);
# excluded from the "agents ran in total" number
MAX_TURN = timedelta(hours=2)


def load(day, directory):
    path = os.path.join(directory, f"{day}.jsonl")
    if not os.path.exists(path):
        return None
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
            # Convert to local time for display. Timestamps may end in Z (UTC)
            # or carry a local offset; reading Z literally shifts "started" by
            # a whole timezone. astimezone() treats both alike.
            dt = datetime.fromisoformat(e["t"].replace("Z", "+00:00"))
            e["dt"] = dt.astimezone() if dt.tzinfo else dt
            out.append(e)
        except Exception:
            continue          # skip half/broken lines: broken observability must not crash the report
    out.sort(key=lambda e: e["dt"])
    return out


def turns(events):
    """Cut into turns. Returns (start, end-or-None, project, source)."""
    by_line = defaultdict(list)
    for e in events:
        by_line[(e["source"], e["project"])].append(e)

    result = []
    for (source, project), evs in by_line.items():
        start = None
        for e in evs:
            if e["event"] == "complete":
                if start is not None:
                    result.append((start, e["dt"], project, source))
                    start = None
            elif start is None:          # first working/waiting after a complete = a new turn
                start = e["dt"]
        if start is not None:
            result.append((start, None, project, source))   # no complete received; still open
    result.sort(key=lambda t: t[0])
    return result


def hm(td):
    total = int(td.total_seconds())
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m" if h else (f"{m}m{s:02d}s" if m else f"{s}s")


def short(path):
    return os.path.basename(path.rstrip("/")) or path


def report(day, events):
    print(f"\n  {day}")
    print("  " + "─" * 46)
    if not events:
        print("  No data for this day.\n")
        return

    first, last = events[0]["dt"], events[-1]["dt"]
    print(f"  started  {first:%H:%M}   (first time you handed out work, not when you sat down)")
    print(f"  ended    {last:%H:%M}")
    print(f"  span     {hm(last - first)}")

    ts = turns(events)
    done = [(a, b) for a, b, _, _ in ts if b]
    durations = sorted(b - a for a, b in done if b - a < MAX_TURN)
    dropped = len(done) - len(durations)
    busy = sum(durations, timedelta())

    print()
    print(f"  {len(ts)} turns; agents ran {hm(busy)} in total")
    if durations:
        mid = durations[len(durations) // 2]
        print(f"  longest {hm(durations[-1])}   shortest {hm(durations[0])}   median {hm(mid)}")
    if dropped:
        # These turns DID complete; they just ran longer than the plausible
        # ceiling, which usually means the machine slept or the session sat
        # open. Don't claim they never completed — say what is actually known.
        print(f"  ⚠️ {dropped} completed turn(s) ran longer than {MAX_TURN}; excluded from the total as implausible")
    open_turns = sum(1 for _, b, _, _ in ts if b is None)
    if open_turns:
        print(f"  ⚠️ {open_turns} turn(s) still open (no complete received)")

    for label, idx in (("by project", 2), ("by agent", 3)):
        agg = defaultdict(lambda: [0, timedelta()])
        for t in ts:
            key = short(t[idx]) if idx == 2 else t[idx]
            agg[key][0] += 1
            if t[1] and t[1] - t[0] < MAX_TURN:
                agg[key][1] += t[1] - t[0]
        print(f"\n  {label}")
        for k, (n, d) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
            print(f"    {k:<22} {n:>3} turns  {hm(d):>8}")

    gaps = [
        (events[i]["dt"], events[i + 1]["dt"])
        for i in range(len(events) - 1)
        if events[i + 1]["dt"] - events[i]["dt"] >= GAP
    ]
    print(f"\n  gaps ≥{int(GAP.total_seconds() // 60)} min (the island can't tell lunch from a meeting from you coding by hand)")
    if gaps:
        for a, b in gaps:
            print(f"    {a:%H:%M}–{b:%H:%M}   {hm(b - a)}")
    else:
        print("    none")
    print()


def main():
    args = [a for a in sys.argv[1:]]
    directory = events_dir()
    if not os.path.isdir(directory):
        print(f"No data directory yet: {directory}")
        print("It gets created once the island runs and receives its first agent event.")
        return
    days = sorted(f[:-6] for f in os.listdir(directory) if f.endswith(".jsonl"))
    if "--list" in args:
        print("Days with data:")
        for d in days:
            n = sum(1 for _ in open(os.path.join(directory, f"{d}.jsonl"), encoding="utf-8"))
            print(f"  {d}   {n} events")
        return
    day = args[0] if args else datetime.now().strftime("%Y-%m-%d")
    events = load(day, directory)
    if events is None:
        print(f"No data for {day}. Days that have some: {', '.join(days) or '(none at all)'}")
        return
    report(day, events)


if __name__ == "__main__":
    main()
