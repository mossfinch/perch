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

**Two layers, on purpose.** `turns()` is the raw cut: it holds no thresholds
and reports exactly what the log shows, open ends included. `settled()` sits
on top and holds the judgment calls, because the raw cut alone gets whole
days wrong: interrupting an agent (Esc, closed window) leaves a turn with no
`complete`, and pure pairing then welds it to the NEXT session, so a stretch of
seconds can come out hours long and drag the whole day's total with it.
The settle rules:
  · `complete` settles a turn, and the silence before it is trusted whenever
    the last thing seen was `working` — a single tool can run for many quiet
    minutes mid-turn, and truncating across that silence would have cut a
    genuine turn in half;
  · unless that last event was `waiting` and the complete came more than
    IDLE_CUT later. Then the silence is an empty chair, not a tool: the agent
    asked for approval and nobody was there, so the turn ends at the waiting
    event and is truncated. Answering half an hour later does not turn the
    half hour into work;
  · an open turn whose conversation goes quiet longer than IDLE_CUT is
    truncated at its last event (the cut has to sit WELL beyond the gap between
    one working event and the next, or it would truncate live turns; the
    boundary is pinned by behaviour tests).

**Flow** is the island's own verdict, laid over the day — the same words the
wave on screen is saying, not a second idea wearing the same name. Someone is in
flow when the median of the last five pickup delays is under 90 seconds AND
something was set to work less than 4.5 minutes ago (`in_flow`; the three
numbers are copied from `FlowSense.swift` and a test compares them, so neither
side can hold its own opinion). `flow_spans` walks that verdict along the day —
the answer can only change where a turn STARTS, or 4.5 minutes after the last
one did — and the `flow` column is their total.

⚠️ **`flow` and the bridged measure answer different questions.** `flow` counts
only the stretches where orders were really going out fast. The bridged measure
asks "how long were agents running, with every gap under FLOW_BRIDGE welded
shut", which counts an agent grinding away alone all evening — it survives only
inside the shadow features, and reading one as a version of the other is the
mistake this split exists to prevent.

The old measure is still computed, under its own names and never called flow:
`flow_stretches` (bridged wall-clock) and `run_intervals` (no bridging at all)
feed the shadow features, and both readings are needed beside the self-scores.
⚠️ FLOW_BRIDGE stays a provisional constant, to be re-fitted rather than tuned.

Usage:
    python3 island-day-report.py            # today
    python3 island-day-report.py 2026-07-10
    python3 island-day-report.py --list     # which days have data
    python3 island-day-report.py --summary  # every day: flow, busy, score
    python3 island-day-report.py --features [day|--all]   # one raw JSON line per day
    python3 island-day-report.py --reading  [day|--all]   # the shipped readings, machine-readable

⚠️ `--reading` and `--features` are not two views of the same thing. `--reading`
carries what the island shows; `--features` carries a shadow experiment computed
with different bridge thresholds, and the two do not agree. Anything that acts on a
number takes `--reading` — a day with no log prints no line there, so a caller
can tell "nothing recorded" from "measured zero".
"""
from __future__ import annotations   # so `X | None` annotations parse on macOS's stock python 3.9

import json
import math
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta

def group_core(group: str) -> str:
    """The `group.x` core from either spelling the OS uses — `group.x` bare,
    or `TEAMID.group.x` once the installer stamps a signing Team into the
    entitlement (macOS names the on-disk container with the prefix then).
    Returns "" when it is neither. Same rule as both hook installers; the
    full value, prefix and all, is what names the container directory."""
    core = group[group.index("group."):] if ".group." in group and not group.startswith("group.") else group
    if not core.startswith("group.") or not core.removeprefix("group."):
        return ""
    return core


def _app_group() -> str:
    """Read the App Group from the installed island; never hard-coded — a
    Team ID links to the Apple developer account's registrant name."""
    plist = "/Applications/Perch.app/Contents/Info.plist"
    if not os.path.exists(plist):
        raise SystemExit(f"{plist} not found. Install the island first: python3 install-island-app.py (same directory)")
    out = subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :AppGroupID", plist],
                         capture_output=True, text=True).stdout.strip()
    if not group_core(out):
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
# An OPEN turn whose conversation stays quiet this long is truncated at its
# last event (see the docstring for the measured basis). A complete is trusted
# across silence that sits behind a `working` event — a tool running quietly —
# but not behind a `waiting` one, which is a person who walked away.
IDLE_CUT = timedelta(seconds=120)
# Provisional: a finish picked up within this counts as unbroken flow for the
# OLD measure (flow_stretches). To be re-fitted against self-scored days, not
# tuned by hand.
FLOW_BRIDGE = timedelta(minutes=5)

# The island's own three numbers, for the verdict the `flow` column now reports.
# ⚠️ COPIED FROM `FlowSense.swift` — quickPickup / window / dropOut, in that
# order — and compared against it by the island suite. They are one number
# each living in two files; this side gets no opinion of its own. Like
# FLOW_BRIDGE they are provisional, and get re-derived from recorded corrections, never
# nudged by hand.
QUICK_PICKUP = timedelta(seconds=90)
FLOW_WINDOW = 5
DROP_OUT = timedelta(minutes=4.5)


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


def settled(events, idle_cut=IDLE_CUT):
    """The judgment layer over the raw cut: every turn gets an end.

    Returns (start, end, project, source, truncated). `truncated` marks turns
    whose end is the last thing the log SAW rather than a received complete —
    downstream may count them, but must not present them as cleanly finished.

    Kept separate from turns() so the raw layer stays threshold-free and its
    behavior test stays honest about what the log literally contains.
    """
    by_line = defaultdict(list)
    for e in events:
        by_line[(e["source"], e["project"])].append(e)

    result = []
    for (source, project), evs in by_line.items():
        start = last = last_kind = None
        for e in evs:
            if e["event"] == "complete":
                if start is not None:
                    # Which silence just ended? Behind a `working` event it is a
                    # tool running quietly (one can go many minutes without a
                    # word), so the complete is trusted whole. Behind a
                    # `waiting` event it is an empty chair — the agent asked for
                    # approval and nobody was there — and the answer, whenever it
                    # finally came, does not make those minutes work. End the turn
                    # where the log last saw anything, and mark it truncated.
                    if last_kind == "waiting" and e["dt"] - last > idle_cut:
                        result.append((start, last, project, source, True))
                    else:
                        result.append((start, e["dt"], project, source, False))
                start = last = last_kind = None
                continue
            # The weld this layer exists to cut: a turn left open by an
            # interrupt, silent past the cutoff, must not absorb the next
            # session. Truncate at the last event and let a new turn open.
            if start is not None and e["dt"] - last > idle_cut:
                result.append((start, last, project, source, True))
                start = e["dt"]
            elif start is None:
                start = e["dt"]
            last = e["dt"]
            last_kind = e["event"]
        if start is not None:
            result.append((start, last, project, source, True))
    result.sort(key=lambda t: t[0])
    return result


def flow_stretches(settled_turns, bridge=FLOW_BRIDGE, max_turn=MAX_TURN):
    """THE OLD MEASURE, kept for comparison — **not what "flow" means here**.

    ⚠️ It answers "how long were agents running today, with every gap under
    `bridge` welded shut", which counts an agent grinding away alone all evening
    as flow and has no opinion at all about the person. The product meaning of
    the word lives in
    `in_flow` / `flow_spans` (the island's own verdict). This one stays because
    the shadow features record it, and the two readings have to sit side by side
    before anyone can say which was actually being felt — the name is
    deliberately unchanged so that everything already written down about it
    still points at the same number.

    Merge settled turns (any agent, any project) into unbroken stretches.
    Two turns belong to one stretch when the later one starts before the
    earlier one ends plus `bridge` — which covers both "picked up quickly"
    and "another line was already running through the gap". Returns
    (start, end) per stretch, wall-clock.

    Turns at or beyond `max_turn` are skipped, for the same reason "agents ran
    in total" already skips them: the machine slept or the session sat open all
    night, and one such turn would spread a night nobody worked across the
    headline number. The SAME constant, so the hill chart and the headline can
    never disagree about which turns were real.
    """
    stretches = []
    for a, b, _, _, _ in settled_turns:
        if b - a >= max_turn:
            continue
        if stretches and a <= stretches[-1][1] + bridge:
            stretches[-1][1] = max(stretches[-1][1], b)
        else:
            stretches.append([a, b])
    return [(a, b) for a, b in stretches]


def run_intervals(settled_turns, max_turn=MAX_TURN):
    """When an agent was actually running, as non-overlapping spans.

    Also an OLD-measure companion, kept for the same reason as
    `flow_stretches`: the shadow features record it (`net_agent_min`) and the
    comparison needs it. It is machine runtime, never a claim about the person.

    Unlike `flow_stretches` this bridges NOTHING — the gaps between spans are
    real gaps — and unlike summing turn durations it counts parallel work once.
    Turns at or beyond `max_turn` are dropped for the same reason the headline
    drops them.

    ⚠️ Has a Swift twin again — `DayFlow.workSeconds` totals these same
    spans for the island's "agents ran" reading — held together by a test
    that feeds both the same turns. Expects turns sorted by start, which
    `settled` returns.
    """
    out = []
    for a, b, _, _, _ in settled_turns:
        if b - a >= max_turn:
            continue
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def net_ran(settled_turns):
    """Wall-clock agent time: the union's total, the ONE number "agents ran"
    may mean anywhere. The island shows this same number (DayFlow.workSeconds,
    cross-pinned). Summing turns instead counts parallel lines as extra hours
    — a 12-hour wall of parallel agents prints as 22h "ran"."""
    return sum(((b - a) for a, b in run_intervals(settled_turns)), timedelta())


def same_project_stretches(settled_turns, bridge=FLOW_BRIDGE, max_turn=MAX_TURN):
    """The same day cut the other way: a stretch may never span two projects.

    `flow_stretches` merges across projects on purpose — another line running
    through the gap is still work. But "I stayed on one thing" and "I never sat
    idle" are different sensations, and only one of them may be what is scored.
    So both cuts get recorded every day, and once enough self-scored days exist
    the two columns can be laid beside the self-scores and asked which is which.

    Returns every project's stretches in one list, sorted by start.
    """
    by_project = defaultdict(list)
    for t in settled_turns:
        by_project[t[2]].append(t)
    out = []
    for turns_of_project in by_project.values():
        out.extend(flow_stretches(turns_of_project, bridge=bridge, max_turn=max_turn))
    out.sort()
    return out


def pickup_gaps(settled_turns, max_turn=MAX_TURN):
    """After an agent finished, how long until the next one was set to work.

    Only a turn closed by a real `complete` starts a gap: a truncated turn's
    "end" is the last thing the log SAW, which is not a finish, and an
    implausible turn's end sits on the far side of a sleeping machine. The
    other end is the first start after it on ANY line — a start is always a
    real observed event, so implausible and truncated turns are fine as the
    landing point even though they are not fine as the take-off.

    Only positive gaps exist by construction (the next start must be strictly
    later). ⚠️ What this measures is "how long until the next order went out",
    NOT "how long nothing was running" — another line may well have been
    running straight through the gap. `run_intervals` is the one that answers
    that other question.
    """
    starts = sorted(a for a, *_ in settled_turns)
    found = []
    for a, b, _, _, truncated in settled_turns:
        if truncated or b - a >= max_turn:
            continue
        nxt = next((s for s in starts if s > b), None)
        if nxt is not None:
            found.append((b, nxt - b))
    # ⚠️ Ordered by the turn's END, and `FlowSense.pickupGaps` orders the same
    # way. Callers take the LAST FLOW_WINDOW of these, so the order is part of
    # the answer and the two languages must agree on it.
    #
    # ⚠️ End, not start. A pickup delay belongs to the moment the agent
    # FINISHED; ordering by start files a long-running turn as old news when its
    # pickup only just happened, and lets turns that began later but finished
    # sooner push it out of the window.
    return [g for _, g in sorted(found, key=lambda p: p[0])]


def _median(values):
    """Median, never mean. One trip to the kettle is one number out of five and
    must not be able to drag the whole verdict along with it. Same shape as
    `FlowSense.median`, empty case included (a median of nothing is not a
    number, and both sides answer zero rather than inventing one)."""
    s = sorted(values)
    if not s:
        return timedelta()
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def in_flow(settled_turns, now):
    """In flow at `now` — the island's verdict, computed here.

    ⚠️ **This is a second implementation of `FlowSense.inFlow`**, and the only
    thing keeping the two one judgment is the cross-language test that feeds
    both the same cases and compares the ANSWERS and the three CONSTANTS. The
    island cannot shell out to python (sandboxed app), the report cannot link
    Swift; so the meaning is duplicated on purpose and pinned by test.

    The two halves are independent on purpose. The median says how the work has
    been going; the drop-out says whether it is still going at all — a stretch of
    quick pickups half an hour ago must not keep the column filling in while
    the desk is empty.

    Both comparisons are strict: landing exactly on a provisional threshold is
    not evidence of anything, and the conservative answer to "not sure" is no.
    Fewer than FLOW_WINDOW pickups is likewise always no — someone who has just
    sat down has not shown enough for anyone to claim anything.

    Pickup delays come from `pickup_gaps`, never from a second copy of that
    rule: only a turn closed by a real `complete` may start one.
    """
    if not settled_turns:
        return False
    last_start = max(a for a, *_ in settled_turns)
    if now - last_start >= DROP_OUT:
        return False
    gaps = pickup_gaps(settled_turns)
    if len(gaps) < FLOW_WINDOW:
        return False
    recent = gaps[-FLOW_WINDOW:]
    return _median(recent) < QUICK_PICKUP


def flow_spans(settled_turns):
    """The verdict above, walked along the day: (start, end) per span.

    An instant judgment becomes a duration only if you know when it can change,
    and it can change at exactly two kinds of moment:
      · a turn STARTS — a new pickup delay has landed, so judge again;
      · DROP_OUT after the last start — nothing was set to work, so: out.
    Between two starts nothing can move: a gap only becomes measurable when the
    next start lands on it, and time passing can only ever push the answer out.

    So each start that judges "in flow" holds until the next start (which gets
    judged on its own) or until it times out, whichever comes first; touching
    spans merge. ⚠️ **Nothing is bridged.** A silence is a break, full stop —
    welding gaps shut is what `flow_stretches` does, and the two must never be
    read as versions of each other. A span may therefore reach up to DROP_OUT
    past the day's last start: that is the island still saying "in flow" with
    nothing new to go on yet, which is exactly what it does on screen.
    """
    starts = sorted(a for a, *_ in settled_turns)
    spans = []
    for i, s in enumerate(starts):
        # What was knowable at `s`: turns that had started by then. A turn
        # still running contributes no pickup (nothing has landed after its
        # end yet), so this is the same evidence the island had at that moment.
        if not in_flow([t for t in settled_turns if t[0] <= s], s):
            continue
        end = s + DROP_OUT if i + 1 == len(starts) else min(starts[i + 1], s + DROP_OUT)
        if spans and s <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], end)
        else:
            spans.append([s, end])
    return [(a, b) for a, b in spans]


def waiting_bounds(events):
    """How long each `waiting` could have lasted — at most.

    A `waiting` event says the agent asked for approval and stopped. Nothing in
    the log says when the human answered; the next event on the SAME line is
    the only hard fact, and it says the answer came no later than that. So this
    returns an upper BOUND per waiting event — `None` when nothing followed on
    that line at all — and the name says bound because this must never be
    dressed up as a response time.

    Returns (waiting event time, bound or None), sorted by time.
    """
    by_line = defaultdict(list)
    for e in events:
        by_line[(e["source"], e["project"])].append(e)
    out = []
    for evs in by_line.values():
        for i, e in enumerate(evs):
            if e["event"] != "waiting":
                continue
            nxt = evs[i + 1]["dt"] if i + 1 < len(evs) else None
            out.append((e["dt"], nxt - e["dt"] if nxt is not None else None))
    out.sort(key=lambda p: p[0])
    return out


def _nearest_rank(values, q):
    """The smallest sample that at least a `q` share of them are ≤ (no
    interpolation, so every number printed is a gap that really happened).
    `None` for an empty sample: a percentile of nothing is not zero."""
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s), max(1, math.ceil(q * len(s)))) - 1]


def daily_reading(day, events):
    """The island's own readings for one day, in one machine-readable line.

    This is the SHIPPED arithmetic — the same `flow_spans` total that the human
    report prints as `flow  5h20m`, and the same `net_ran` behind `agents ran`.
    Anything that acts on these numbers reads them from here.

    ⚠️ Not `--features`. That line carries `flow2/5/10_min` from a shadow
    experiment: different bridge thresholds, a different answer, and
    `flow5_min` reads like the field an integrator would reach for.
    Taking it would put a third reading into circulation with nothing on screen
    to say so. The two outputs are pinned together by a test.

    `judged` answers a question a spender cannot ask of the minutes alone:
    fewer than FLOW_WINDOW pickups means the day was never measured, which is a
    different thing from a day that measured zero.
    """
    st = settled(events)
    flow_total = sum((b - a for a, b in flow_spans(st)), timedelta())
    return {
        "date": day,
        "flow_minutes": int(flow_total.total_seconds() // 60),
        "agents_ran_minutes": int(net_ran(st).total_seconds() // 60),
        "judged": len(pickup_gaps(st)) >= FLOW_WINDOW,
    }


def day_features(day, events):
    """One day, one flat dict of what the log MEASURED. No judgement, no score.

    Everything is computed from the event log at read time: nothing is stored,
    nothing feeds a number the island shows, nothing reaches the widget. It
    exists so that once enough self-scored days pile up, these columns can be
    laid beside the self-scores and asked which of them was actually
    feeling — the fitting comes later, and by hand.

    House rule for the derived groups: they count PLAUSIBLE turns only (under
    MAX_TURN), the same ones flow and "agents ran in total" already count. The
    quality group is the deliberate exception — reporting the anomalies is its
    whole job.
    """
    events = events or []
    st = settled(events)
    plausible = [t for t in st if t[1] - t[0] < MAX_TURN]
    merged = flow_stretches(st)
    sameproj = same_project_stretches(st)
    runs = run_intervals(st)
    gaps = pickup_gaps(st)
    waits = waiting_bounds(events)

    def minutes(td):
        return round(td.total_seconds() / 60, 1)

    def longest(stretches):
        return minutes(max((b - a for a, b in stretches), default=timedelta()))

    def flow_at(mins):
        spans = flow_stretches(st, bridge=timedelta(minutes=mins))
        return minutes(sum((b - a for a, b in spans), timedelta()))

    flow_total = sum((b - a for a, b in merged), timedelta())
    net = sum((b - a for a, b in runs), timedelta())
    span = events[-1]["dt"] - events[0]["dt"] if events else timedelta()

    # How densely commands were arriving inside the busiest stretch. Zero-length
    # stretches are skipped rather than divided by: one lone event that never
    # completed is a stretch of no duration, and "turns per zero hours" is not
    # a big number, it is not a number.
    densities = []
    for a, b in merged:
        if b <= a:
            continue
        inside = sum(1 for s, *_ in plausible if a <= s <= b)
        densities.append(inside / ((b - a).total_seconds() / 3600))

    projects = [t[2] for t in plausible]
    by_source = defaultdict(int)
    last_by_source = {}
    for e in events:
        by_source[e["source"]] += 1
        last_by_source[e["source"]] = e["dt"]

    return {
        "date": day,
        # coherence, two ways of cutting the same day
        "merged_runs": len(merged),
        "merged_longest_min": longest(merged),
        "sameproj_runs": len(sameproj),
        "sameproj_longest_min": longest(sameproj),
        "project_switches": sum(1 for i in range(len(projects) - 1) if projects[i] != projects[i + 1]),
        # how long an agent sat finished before the next one was set to work
        "pickup_p50_s": _nearest_rank([int(g.total_seconds()) for g in gaps], 0.5),
        "pickup_p90_s": _nearest_rank([int(g.total_seconds()) for g in gaps], 0.9),
        # approvals asked for; the minutes are an upper bound, never a response time
        "waiting_count": len(waits),
        "waiting_upper_min": minutes(sum((b for _, b in waits if b is not None), timedelta())),
        # density
        "turns_per_hour": round(len(plausible) / (span.total_seconds() / 3600), 2) if span else None,
        "max_stretch_density": round(max(densities), 2) if densities else None,
        # net running time vs. what the bridge welded into flow
        "net_agent_min": minutes(net),
        "bridged_gap_min": minutes(flow_total - net),
        # one day, three bridges: the data answering "what should the constant be"
        "flow2_min": flow_at(2),
        "flow5_min": flow_at(5),
        "flow10_min": flow_at(10),
        # quality of the day's record itself
        "turns": len(st),
        "truncated": sum(1 for *_, tr in st if tr),
        "implausible": sum(1 for a, b, _, _, _ in st if b - a >= MAX_TURN),
        # a source that logged nothing all day is evidence the day is incomplete
        "events_by_source": dict(sorted(by_source.items())),
        "last_event_by_source": {k: f"{v:%H:%M}" for k, v in sorted(last_by_source.items())},
    }


def day_scores():
    """The days answered by hand, {date: {"rhythm", "progress", "legacy"}}.

    LAST LINE PER FIELD wins, not per date: a line updates exactly the keys it
    carries. That is what lets three kinds of line share one append-only file —
    the pre-split one-number `score` lines (kept as `legacy`, never written
    again) and the island's `rhythm` / `progress` lines — without any of them
    knocking the others out.

    ⚠️ Same rule, byte for byte, as `DayScore.swift`'s `scores()`. Two readers,
    one file, and nothing but the island suite holding the ends together.

    Read-only here: the report lays the derived number beside the stated one
    and computes nothing from it — the check must stay a check.
    """
    path = os.path.join(os.path.dirname(events_dir()), "day-scores.jsonl")
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        try:
            row = json.loads(line)
            date = row["date"]
        except Exception:
            continue          # a torn line hides nothing written before it
        for key, field in (("rhythm", "rhythm"), ("progress", "progress"), ("score", "legacy")):
            value = row.get(key)
            # `not isinstance(bool)` because python alone thinks True is a 1,
            # and the Swift reader on the other end of this contract does not.
            if isinstance(value, int) and not isinstance(value, bool):
                out.setdefault(date, {"rhythm": None, "progress": None, "legacy": None})
                out[date][field] = value
    return out


def score_mark(row):
    """One cell for a day's own answers: `r3·p2`, `—` for a question nobody has
    not answered yet, and a pre-split score printed as it always was, labelled
    for what it is. One formatter, so the table and the day report cannot
    disagree about the same ledger."""
    if not row:
        return "—"
    out = []
    if row["rhythm"] is not None or row["progress"] is not None:
        r = row["rhythm"] if row["rhythm"] is not None else "—"
        p = row["progress"] if row["progress"] is not None else "—"
        out.append(f"r{r}·p{p}")
    if row["legacy"] is not None:
        n = row["legacy"]
        out.append(f"{n} {'●' * n}{'○' * (5 - n)} legacy")
    return "  ".join(out) if out else "—"


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

    st = settled(events)

    spans = flow_spans(st)
    flow_total = sum((b - a for a, b in spans), timedelta())
    print()
    print(f"  flow  {hm(flow_total)} across {len(spans)} span(s)   (how long the island judged you in flow: "
          f"last 5 pickups' median under {int(QUICK_PICKUP.total_seconds())}s, something set to work "
          f"within {DROP_OUT.total_seconds() / 60:g} min; hand-coding and reading are invisible here)")
    for a, b in spans:
        print(f"    {a:%H:%M}–{b:%H:%M}   {hm(b - a)}")
    breaks = [
        (spans[i][1], spans[i + 1][0])
        for i in range(len(spans) - 1)
    ]
    if breaks:
        print("  breaks between flow spans")
        for a, b in breaks:
            print(f"    {a:%H:%M} → {b:%H:%M}   {hm(b - a)}")
    answered = day_scores().get(day)
    if answered is not None:
        print(f"  your own answer for this day: {score_mark(answered)}")

    closed = sorted(b - a for a, b, _, _, tr in st if not tr and b - a < MAX_TURN)
    dropped = sum(1 for a, b, _, _, tr in st if not tr and b - a >= MAX_TURN)
    ran = net_ran(st)
    busy = sum((b - a for a, b, _, _, _ in st if b - a < MAX_TURN), timedelta())

    print()
    print(f"  {len(st)} turns; agents ran {hm(ran)}")
    if busy - ran >= timedelta(minutes=1):
        # A different, honest quantity — labor across parallel lines — under
        # its own name, never as "ran". Only when the two meaningfully differ:
        # a few seconds of overlap is scheduling noise, not parallel work.
        print(f"    ({hm(busy)} agent-hours summed across parallel lines)")
    if closed:
        mid = closed[len(closed) // 2]
        print(f"  longest {hm(closed[-1])}   shortest {hm(closed[0])}   median {hm(mid)}")
    if dropped:
        # These turns DID complete; they just ran longer than the plausible
        # ceiling, which usually means the machine slept or the session sat
        # open. Don't claim they never completed — say what is actually known.
        print(f"  ⚠️ {dropped} completed turn(s) ran longer than {MAX_TURN}; excluded from the total as implausible")
    truncated = sum(1 for *_, tr in st if tr)
    if truncated:
        # No complete ever came (interrupt, closed window, quota stall); the
        # end shown is the last thing the log saw, not a clean finish.
        print(f"  {truncated} turn(s) had no complete and were cut at their last event")

    for label, idx in (("by project", 2), ("by agent", 3)):
        agg = defaultdict(lambda: [0, timedelta()])
        for t in st:
            key = short(t[idx]) if idx == 2 else t[idx]
            agg[key][0] += 1
            if t[1] - t[0] < MAX_TURN:
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
    if "--summary" in args:
        # One line per day, the derived number laid beside the stated one.
        # This table is the whole point of the scores: the day the two columns
        # disagree is the day the constants above are shown to be wrong.
        scores = day_scores()
        print(f"\n  {'day':<12} {'flow':>8} {'agents':>8} {'turns':>6}  your answer")
        print("  " + "─" * 48)
        for d in days:
            evs = load(d, directory)
            st = settled(evs)
            flow_total = sum((b - a for a, b in flow_spans(st)), timedelta())
            print(f"  {d:<12} {hm(flow_total):>8} {hm(net_ran(st)):>8} {len(st):>6}  {score_mark(scores.get(d))}")
        # r and p are not self-explanatory, and a column nobody can read is a
        # column nobody checks. Neither is "flow" on its own: without the line
        # below, a reader carrying the bridged meaning in their head would read
        # these numbers as a collapse rather than as a different question.
        print("\n  r = rhythm (did the day hold together)"
              "   p = progress (did anything move)")
        print("  flow = how long the island judged you IN flow (five pickups running quick),"
              "   agents = wall-clock time with at least one agent running")
        print()
        return
    if "--reading" in args:
        # One line per day, shipped readings only. A day with no log at all
        # prints nothing rather than a zero: "nothing was recorded" and "the
        # day measured zero" are different answers, and a reader that gets 0
        # for both cannot tell which it was holding.
        rest = [a for a in args if a != "--reading"]
        if "--all" in rest:
            wanted = days
        else:
            wanted = [rest[0]] if rest else [datetime.now().strftime("%Y-%m-%d")]
        for d in wanted:
            evs = load(d, directory)
            if evs is None:
                continue
            print(json.dumps(daily_reading(d, evs), sort_keys=True))
        return
    if "--features" in args:
        # Shadow observation: one raw JSON line per day, straight to stdout.
        # Nothing here is stored and nothing is scored — the log stays the only
        # record, and these are just the questions we are learning to ask of it.
        rest = [a for a in args if a != "--features"]
        if "--all" in rest:
            wanted = days
        else:
            wanted = [rest[0]] if rest else [datetime.now().strftime("%Y-%m-%d")]
        for d in wanted:
            print(json.dumps(day_features(d, load(d, directory)), sort_keys=True))
        return
    day = args[0] if args else datetime.now().strftime("%Y-%m-%d")
    events = load(day, directory)
    if events is None:
        print(f"No data for {day}. Days that have some: {', '.join(days) or '(none at all)'}")
        return
    report(day, events)


if __name__ == "__main__":
    main()
