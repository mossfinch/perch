// The flow verdict — and the guards that hold the island's Swift and the daily report to
// the SAME number. Those two answering differently is the failure this file exists for.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { APP_GROUP_SWIFT, islandPath, pkgPath } = require("./island-paths");

// ⚠️ The whole point of the split: the island (Swift) computes the desktop
// widget's numbers, the daily report (python) computes the terminal's. One
// algorithm, two implementations, and nothing but this test standing between
// them and a slow drift nobody notices — the two are never read side by side.
//
// The cases below are not decoration. Each one is a boundary where a
// plausible-looking reimplementation goes wrong:
//   · the 4-hour weld (the bug the settle layer exists for)
//   · a complete after a long quiet middle (must be trusted anyway)
//   · a gap of EXACTLY the cutoff (must not cut — the rule is "longer than")
//   · a gap one second past it (must cut)
//   · a single event that never completes (a turn of zero length, not nothing)
//   · stretches bridging at exactly the bridge, and breaking one second past
//   · a complete arriving long after a WAITING event (the empty chair — the
//     silence is a human who walked off, and must not be backfilled as work)
//   · a completed turn past the plausible ceiling (dropped from flow, kept as
//     a settled turn)
const FLOW_CASES = [
  // line A: interrupted at 30s, silent ~4h, new session, complete
  [0, "working", "/x/a", "claude"], [30, "working", "/x/a", "claude"],
  [14000, "working", "/x/a", "claude"], [14100, "complete", "/x/a", "claude"],
  // line B: a 600s completed turn remains trusted despite a long quiet middle
  [0, "working", "/x/b", "codex"], [600, "complete", "/x/b", "codex"],
  // line C: a gap of exactly the cutoff -> one turn, not two
  [20000, "working", "/x/c", "claude"], [20120, "working", "/x/c", "claude"],
  [20130, "complete", "/x/c", "claude"],
  // line D: one second past the cutoff -> cut at the LAST EVENT SEEN (so the
  // truncated turn is 40s long, not 121), then a fresh turn opens
  [30000, "working", "/x/d", "claude"], [30040, "working", "/x/d", "claude"],
  [30161, "working", "/x/d", "claude"], [30200, "complete", "/x/d", "claude"],
  // line E: one lone event, no complete, nothing after
  [40000, "waiting", "/x/e", "codex"],
  // line F: starts exactly one bridge after E ended -> same stretch
  [40300, "working", "/x/f", "claude"], [40400, "complete", "/x/f", "claude"],
  // line G: one second past the bridge -> a new stretch
  [40701, "working", "/x/g", "claude"], [40800, "complete", "/x/g", "claude"],
  // line H: the empty chair. The agent asked for approval, nobody was there for
  // half an hour, then the answer came and closed the turn. Those 30 minutes are
  // an empty chair, not an agent working -> the turn ends at the WAITING event
  // and is truncated, because that is the last thing the log actually saw.
  [50000, "working", "/x/h", "claude"], [50020, "waiting", "/x/h", "claude"],
  [51820, "complete", "/x/h", "claude"],
  // line I: a synthetic 480-second quiet turn behind a WORKING event.
  // The silence sits behind a WORKING event, so the complete stays trusted whole
  // -> line H's rule must never reach in here and halve a genuine turn.
  [60000, "working", "/x/i", "codex"], [60480, "complete", "/x/i", "codex"],
  // line J: a 3-hour completed turn (the machine slept, or the session sat open
  // all night), then a 5-minute turn exactly one bridge later. The implausible
  // one is dropped from flow — it stays a settled turn, and busy/runIntervals
  // already drop it — so the stretch is those 5 minutes alone, not 3h05m.
  [70000, "working", "/x/j", "claude"], [80800, "complete", "/x/j", "claude"],
  [81100, "working", "/x/j", "claude"], [81400, "complete", "/x/j", "claude"],
];

test("the island's Swift flow math and the python report answer identically, turn for turn", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-math-"));

  const py = `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026, 7, 28, 9, 0, 0)
cases = ${JSON.stringify(FLOW_CASES)}
evs = [{"dt": t0 + timedelta(seconds=s), "event": e, "project": p, "source": src} for s, e, p, src in cases]
st = rep.settled(evs)
fl = rep.flow_stretches(st)
ri = rep.run_intervals(st)
print(json.dumps({
  "turns": [{"start": int((a - t0).total_seconds()), "end": int((b - t0).total_seconds()),
             "project": p, "source": s, "truncated": tr} for a, b, p, s, tr in st],
  "stretches": [{"start": int((a - t0).total_seconds()), "end": int((b - t0).total_seconds())} for a, b in fl],
  "runs": [{"start": int((a - t0).total_seconds()), "end": int((b - t0).total_seconds())} for a, b in ri],
  "flow": int(sum((b - a).total_seconds() for a, b in fl)),
}, sort_keys=True))
`;
  // ⚠️ The python side above still computes the old measure (`flow_stretches`
  // / `run_intervals`); the Swift side has no half of either, because nothing
  // in the island calls them and comparing one live function against a corpse
  // proves nothing about drift. The genuine PAIR is `settle` ↔ `settled`, and
  // that is what gets compared turn for turn. The old measure's own numbers
  // stay asserted below, python-only, so they cannot move unnoticed either.
  const fromPython = JSON.parse(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8" }));

  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "flow-math-check");
  fs.writeFileSync(main, `
import Foundation

let t0 = Date(timeIntervalSince1970: 1_700_000_000)
let cases: [(Double, String, String, String)] = [
${FLOW_CASES.map(([s, e, p, src]) => `    (${s}, ${JSON.stringify(e)}, ${JSON.stringify(p)}, ${JSON.stringify(src)}),`).join("\n")}
]
let events = cases.map { FlowMath.Event(time: t0.addingTimeInterval($0.0), event: $0.1, project: $0.2, source: $0.3) }
let turns = FlowMath.settle(events)
func at(_ d: Date) -> Int { Int(d.timeIntervalSince(t0)) }
let turnRows = turns.map {
    "{\\"end\\":\\(at($0.end)),\\"project\\":\\"\\($0.project)\\",\\"source\\":\\"\\($0.source)\\",\\"start\\":\\(at($0.start)),\\"truncated\\":\\($0.truncated)}"
}
print("{\\"turns\\":[\\(turnRows.joined(separator: ","))]}")

// The plausible ceiling is still the island's own — FlowSense reads it — so the
// case list must keep containing a turn past it, or every assertion below about
// implausible turns is being made against a list that has none.
let plausible = turns.filter { $0.seconds < FlowMath.maxTurn }
precondition(plausible.count < turns.count,
             "the case list must actually contain an implausible turn, or the assertions about one prove nothing")
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), main, "-o", binary], { stdio: "pipe" });
  const fromSwift = JSON.parse(execFileSync(binary, { encoding: "utf8" }));

  // Control group first: a comparison of two empty answers is always equal.
  assert.ok(fromPython.turns.length >= 8, `python side produced only ${fromPython.turns.length} turns`);
  assert.deepEqual(fromSwift, { turns: fromPython.turns },
    "the Swift settle layer and the python report have drifted apart");

  // ...and then what they must BOTH say, so a shared mistake cannot pass either.
  const secs = (t) => t.end - t.start;
  assert.deepEqual(fromPython.turns.filter((t) => t.truncated).map(secs).sort((a, b) => a - b),
    [0, 20, 30, 40],
    "a truncated turn ends at the last event SEEN — the 4h weld at 30s, the one-past-cutoff line at 40s, "
    + "the empty chair at 20s, and a lone event that never completed is a turn of zero length, not nothing at all");
  assert.deepEqual(fromPython.turns.filter((t) => !t.truncated).map(secs).sort((a, b) => a - b),
    [39, 99, 100, 100, 130, 300, 480, 600, 10800],
    "a complete is trusted across a quiet middle (600s, 480s), a gap of exactly the cutoff does not cut (130s), "
    + "and the 3-hour turn stays a settled turn — it is dropped from flow, not from the record");
  assert.equal(fromPython.stretches.length, 9,
    "parallel lines merge, a 4h silence breaks, and one second past the bridge starts a new stretch");
  assert.equal(fromPython.flow, 2329);

  // The two leaks this case list was extended for, named one at a time so a
  // failure says WHICH lie came back rather than "some total moved".
  //
  // ① The empty chair. A complete more than the idle cut after a WAITING event
  //    settles the turn at that waiting event, not at the complete: the human
  //    was gone for the 30 minutes in between, and counting them paints agent
  //    work over an empty chair.
  const chair = fromPython.turns.find((t) => t.project === "/x/h");
  assert.deepEqual([chair.start, chair.end, chair.truncated], [50000, 50020, true],
    "the waiting tail was backfilled: the turn must end at the waiting event, marked truncated");
  // ② …and the same rule must NOT touch silence behind a working event.
  const nail = fromPython.turns.find((t) => t.project === "/x/i");
  assert.deepEqual([nail.start, nail.end, nail.truncated], [60000, 60480, false],
    "the synthetic quiet turn broke: WORKING still means the agent is active, so its complete stays trusted");
  // ③ The implausible turn is in the settled record and in no stretch at all —
  //    the same turn run_intervals and busy already drop. One reader must not
  //    strike it off one number and count it in the next.
  //    ⚠️ python-only: the old measure lives on that side alone.
  assert.ok(fromPython.turns.some((t) => t.start === 70000 && secs(t) === 10800),
    "the 3-hour turn must still be reported as a settled turn");
  assert.ok(!fromPython.stretches.some((s) => s.start === 70000),
    "a 3-hour turn must not open a flow stretch");
  assert.ok(fromPython.stretches.every((s) => s.end - s.start < 2 * 60 * 60),
    "no stretch may be built out of a turn past the plausible ceiling");

  // ④ run_intervals answers a different question than flow_stretches ("was a
  //    machine actually running", no bridging at all), so numbers that only
  //    ever agreed with the stretches would prove nothing: the counts must
  //    differ. The shadow features read both, which is why they are kept —
  //    under their own names, and no longer called "flow".
  assert.equal(fromPython.runs.length, 11,
    "runs merge only where turns genuinely overlap — parallel A+B become one span, the rest stay apart");
  assert.ok(fromPython.runs.length > fromPython.stretches.length,
    "runs must not collapse like stretches do, or the bridge is leaking into a number that bridges nothing");
  const netSeconds = fromPython.runs.reduce((n, r) => n + (r.end - r.start), 0);
  assert.equal(netSeconds, 1908,
    "net running time counts parallel work once (A inside B) and never counts a gap");
  assert.equal(fromPython.flow - netSeconds, 421,
    "flow minus net is exactly what the 5-minute bridge welded in — the shadow report's bridged_gap");
  assert.ok(!fromPython.runs.some((r) => r.start === 70000),
    "the 3-hour turn must be dropped from net running time too, by the SAME ceiling flow uses");
});

// ── In flow right now ─────────────────────────────────────────────────────
//
// The rule:
//   in flow = the median of the last 5 pickup delays is under 90 seconds
//             AND less than 4.5 minutes have passed since a turn last STARTED
//
// A pickup delay is the gap between an agent really finishing and the next turn
// being set to work — "how long after the agent finishes does the person pick
// it up". The daily report has recorded it for a long time; this is the first
// time it reaches the screen.
//
// ⚠️ 90s / 5 / 4.5min are PROVISIONAL. They get re-derived from recorded
// corrections, never nudged by hand.
//
// `chain` lays out one line of turns: each turn works 10 seconds, the next
// starts `gap` seconds after it finished. N gaps need N+1 turns — the last one
// is only a landing point, and contributes no pickup of its own.
const chain = (gaps) => {
  const turns = [];
  let t = 0;
  for (const gap of gaps) {
    turns.push([t, t + 10, false]);   // [startSec, endSec, truncated]
    t += 10 + gap;
  }
  turns.push([t, t + 10, false]);
  return turns;
};

const lastStartOf = (turns) => Math.max(...turns.map((t) => t[0]));

const FLOW_SENSE_CASES = [
  // ① Five quick pickups: the plain yes.
  { name: "five 30s pickups", turns: chain([30, 30, 30, 30, 30]), after: 1,
    gaps: [30, 30, 30, 30, 30], inFlow: true },
  // ② One trip to the kettle must not throw the verdict out. This is the whole
  //    reason it is a median and not a mean — the mean here is 84s and sits
  //    under the line by luck, but push that one gap to 20 minutes and a mean
  //    convicts where the median would not notice.
  { name: "four quick, one five-minute", turns: chain([30, 30, 300, 30, 30]), after: 1,
    gaps: [30, 30, 300, 30, 30], inFlow: true },
  // ③ Three slow out of five: now the middle number itself is slow.
  { name: "three slow of five", turns: chain([30, 300, 300, 300, 30]), after: 1,
    gaps: [30, 300, 300, 300, 30], inFlow: false },
  // ④ Both sides of the pickup boundary — the rule is strictly under.
  { name: "median exactly 90s", turns: chain([30, 30, 90, 300, 300]), after: 1,
    gaps: [30, 30, 90, 300, 300], inFlow: false },
  { name: "median 89s", turns: chain([30, 30, 89, 300, 300]), after: 1,
    gaps: [30, 30, 89, 300, 300], inFlow: true },
  // ⑤ Four records is not five. Someone who just sat down has not shown enough
  //    for the island to claim anything — silence defaults to "no".
  { name: "only four pickups", turns: chain([30, 30, 30, 30]), after: 1,
    gaps: [30, 30, 30, 30], inFlow: false },
  // ⑥ The drop-out works on its own: every pickup was quick, and nothing has
  //    been set to work for five minutes.
  { name: "quick pickups, idle five minutes", turns: chain([30, 30, 30, 30, 30]), after: 300,
    gaps: [30, 30, 30, 30, 30], inFlow: false },
  // ⑦ Both sides of the drop-out boundary, which is also strictly under.
  { name: "269s since the last start", turns: chain([30, 30, 30, 30, 30]), after: 269,
    gaps: [30, 30, 30, 30, 30], inFlow: true },
  { name: "270s since the last start", turns: chain([30, 30, 30, 30, 30]), after: 270,
    gaps: [30, 30, 30, 30, 30], inFlow: false },
  { name: "271s since the last start", turns: chain([30, 30, 30, 30, 30]), after: 271,
    gaps: [30, 30, 30, 30, 30], inFlow: false },
  // ⑧ Who may be a take-off. A truncated turn's "end" is the last thing the
  //    log SAW — an interrupt, or a person who walked away from an approval —
  //    and an implausible turn's end sits on the far side of a sleeping
  //    machine. Neither is a finish, so neither starts a pickup; both may
  //    still be LANDED on, because a start is always a real observed event.
  //    Here only the two 90-second gaps are real: allow the truncated turn to
  //    take off and a third gap appears out of nothing.
  { name: "truncated and implausible turns are no take-off",
    turns: [[0, 10, true], [100, 110, false], [200, 210, false],
            [300, 8000, false], [9000, 9010, false]],
    after: 1, gaps: [90, 90], inFlow: false },
  // ⑨ Two lines running at once, and the ORDER is the whole case. The long line
  //    starts first and finishes last, so listed in turn order its 100s pickup
  //    comes FIRST — but it happened LAST. Ordered by turn end (the rule), the
  //    last five are [10, 10, 1000, 1500, 100]: median 100, no flow. Left in
  //    input order they are [100, 10, 10, 10, 1000, 1500]: median 10, flow all
  //    afternoon — the flattering answer.
  //
  //    ⚠️ Until this case existed, reverting the sort on either side left every
  //    pickup-level test green; only the day-total test one layer up caught it.
  //    Every other fixture here is a single line, where the two orders agree.
  { name: "a long line overlapping short ones",
    turns: [[0, 3000, false], [100, 200, false], [210, 300, false],
            [310, 400, false], [410, 500, false], [1500, 1600, false],
            [3100, 3200, false]],
    after: 1, gaps: [10, 10, 10, 1000, 1500, 100], inFlow: false },
];

const flowSenseMain = (cases) => `
import Foundation

struct Case {
    let name: String
    let turns: [(Double, Double, Bool)]
    let now: Double
    let gaps: [Int]
    let inFlow: Bool
}
let t0 = Date(timeIntervalSince1970: 1_700_000_000)
let cases: [Case] = [
${cases.map((c) => `    Case(name: ${JSON.stringify(c.name)},
         turns: [${c.turns.map(([s, e, tr]) => `(${s}, ${e}, ${tr})`).join(", ")}],
         now: ${lastStartOf(c.turns) + c.after},
         gaps: [${c.gaps.join(", ")}],
         inFlow: ${c.inFlow}),`).join("\n")}
]

var rows: [String] = []
for c in cases {
    let turns = c.turns.map {
        FlowMath.Turn(start: t0.addingTimeInterval($0.0), end: t0.addingTimeInterval($0.1),
                      project: "/p/one", source: "claude", truncated: $0.2)
    }
    let gaps = FlowSense.pickupGaps(turns).map { Int($0) }
    let verdict = FlowSense.inFlow(turns: turns, now: t0.addingTimeInterval(c.now))
    precondition(gaps == c.gaps, "\\(c.name): pickup delays \\(gaps), expected \\(c.gaps)")
    precondition(verdict == c.inFlow, "\\(c.name): verdict \\(verdict), expected \\(c.inFlow)")
    rows.append("{\\"gaps\\":[\\(gaps.map(String.init).joined(separator: ","))],"
                + "\\"inFlow\\":\\(verdict),\\"name\\":\\"\\(c.name)\\"}")
}
print("[" + rows.joined(separator: ",") + "]")
`;

test("the island judges flow from pickup delays, and a truncated turn is no take-off", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-sense-"));
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, flowSenseMain(FLOW_SENSE_CASES));

  const compile = (sense, out) =>
    execFileSync("swiftc", [islandPath("FlowMath.swift"), sense, main, "-o", out], { stdio: "pipe" });

  const binary = path.join(tmp, "flow-sense-check");
  compile(islandPath("FlowSense.swift"), binary);
  const fromSwift = JSON.parse(execFileSync(binary, { encoding: "utf8" }));

  assert.equal(fromSwift.length, FLOW_SENSE_CASES.length, "not every case reached the judgment");
  for (const [i, c] of FLOW_SENSE_CASES.entries()) {
    assert.deepEqual(fromSwift[i], { gaps: c.gaps, inFlow: c.inFlow, name: c.name },
      `flow verdict wrong for: ${c.name}`);
  }
  // Control group: the case list must actually contain both answers, or a
  // judgment hardwired to one of them would sail through all of the above.
  assert.ok(fromSwift.some((c) => c.inFlow) && fromSwift.some((c) => !c.inFlow),
    "the cases only ever expect one answer — such a comparison proves nothing");

  // Mutation. Every line above is one comparison, and a test that cannot be
  // made to fail is not testing them.
  // ⚠️ Prove the ammunition was loaded: a replacement string that matches
  // nothing mutates nothing, and the "red" never comes.
  let mutant = 0;
  const mutate = (from, to) => {
    const src = fs.readFileSync(islandPath("FlowSense.swift"), "utf8");
    const hits = src.split(from).length - 1;
    assert.equal(hits, 1, `mutation string is stale — matched ${hits} times, wanted 1: ${from}`);
    const file = path.join(tmp, `mutant-${mutant++}.swift`);
    fs.writeFileSync(file, src.split(from).join(to));
    return file;
  };
  const mustDie = (source, why) => {
    const out = source.replace(/\.swift$/, "");
    compile(source, out);          // it must still COMPILE, or nothing is proved
    assert.throws(() => execFileSync(out, { stdio: "pipe" }), /Command failed/, why);
  };
  // ① A truncated turn allowed to start a pickup: case ⑧ grows a third gap
  //    that never happened.
  mustDie(mutate("turn.truncated || turn.seconds >= FlowMath.maxTurn",
                 "turn.seconds >= FlowMath.maxTurn"),
    "a truncated turn may not take off");
  // ② The pickup boundary loosened to "at most": a median of exactly 90s
  //    would count as quick.
  mustDie(mutate("median(recent) < quickPickup", "median(recent) <= quickPickup"),
    "the pickup threshold must stay strict");
  // ③ The five-record floor removed: one quick pickup would be enough to
  //    announce flow.
  mustDie(mutate("gaps.count >= window", "gaps.count >= 1"),
    "fewer than five pickups must never read as flow");
  // ④ The drop-out loosened the same way.
  mustDie(mutate("sinceLastStart < dropOut", "sinceLastStart <= dropOut"),
    "the drop-out threshold must stay strict");
  // ⑤ Mean instead of median: case ② is the one that separates them — four
  //    quick pickups and one trip to the kettle.
  mustDie(mutate("sorted.count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2",
                 "values.reduce(0, +) / Double(values.count)"),
    "one slow pickup out of five must not drag the verdict with it");
});

test("the pickup delay means the same thing in Swift and in the daily report", () => {
  // The same split, and the same hazard, as the flow math above: the island
  // computes this for the wave, the report computes it for the terminal, and
  // nothing but this stands between them and a drift nobody reads.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-pickup-"));

  const fromPython = JSON.parse(execFileSync("python3", ["-B", "-c", `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026, 7, 28, 9, 0, 0)
cases = ${JSON.stringify(FLOW_CASES)}
evs = [{"dt": t0 + timedelta(seconds=s), "event": e, "project": p, "source": src} for s, e, p, src in cases]
st = rep.settled(evs)
print(json.dumps({"gaps": [int(g.total_seconds()) for g in rep.pickup_gaps(st)],
                  "turns": len(st),
                  "truncated": sum(1 for *_, tr in st if tr)}, sort_keys=True))
`], { encoding: "utf8" }));

  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "pickup-check");
  fs.writeFileSync(main, `
import Foundation

let t0 = Date(timeIntervalSince1970: 1_700_000_000)
let cases: [(Double, String, String, String)] = [
${FLOW_CASES.map(([s, e, p, src]) => `    (${s}, ${JSON.stringify(e)}, ${JSON.stringify(p)}, ${JSON.stringify(src)}),`).join("\n")}
]
let events = cases.map { FlowMath.Event(time: t0.addingTimeInterval($0.0), event: $0.1, project: $0.2, source: $0.3) }
let turns = FlowMath.settle(events)
let gaps = FlowSense.pickupGaps(turns).map { Int($0) }
print("{\\"gaps\\":[\\(gaps.map(String.init).joined(separator: ","))],"
      + "\\"truncated\\":\\(turns.filter(\\.truncated).count),\\"turns\\":\\(turns.count)}")
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"), main, "-o", binary],
    { stdio: "pipe" });
  const fromSwift = JSON.parse(execFileSync(binary, { encoding: "utf8" }));

  // Control group first: a comparison of two empty answers is always equal.
  assert.ok(fromPython.gaps.length >= 5, `python side produced only ${fromPython.gaps.length} pickups`);
  assert.ok(fromPython.truncated >= 3, "the shared case list must contain truncated turns, or nothing is proved");
  assert.deepEqual(fromSwift, fromPython, "the island's pickup delay and the report's have drifted apart");

  // ...and what they must BOTH say. Thirteen settled turns, four of them
  // truncated and one implausible: eight may take off, and the one that ends
  // last has no start after it to land on — so seven pickups, not thirteen.
  assert.equal(fromPython.turns, 13);
  assert.equal(fromPython.gaps.length, 7,
    "only a turn closed by a real complete, inside the plausible ceiling, and with a later start "
    + "to land on may produce a pickup delay");
});

// ── One flow, one definition ──────────────────────────────────────────────
//
// The report and island answer the same question through the cross-language
// pair `FlowSense.inFlow` ↔ `in_flow()`.
// ⚠️ The three provisional numbers (90s / 5 / 4.5min) live in two files, and
// this test is the only thing keeping each of them ONE number: it compares the
// constants themselves, and then every boundary case for case. The python side
// is not allowed its own opinion about any of them.
const FLOW_VERDICT_PY = `
import importlib.util, json, sys
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", sys.argv[1])
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026, 7, 28, 9, 0, 0)
rows = []
for c in json.loads(sys.argv[2]):
    turns = [(t0 + timedelta(seconds=s), t0 + timedelta(seconds=e), "/p/one", "claude", tr)
             for s, e, tr in c["turns"]]
    rows.append({"name": c["name"],
                 "gaps": [int(g.total_seconds()) for g in rep.pickup_gaps(turns)],
                 "inFlow": rep.in_flow(turns, t0 + timedelta(seconds=c["now"]))})
print(json.dumps({"cases": rows,
                  "constants": {"dropOut": int(rep.DROP_OUT.total_seconds()),
                                "quickPickup": int(rep.QUICK_PICKUP.total_seconds()),
                                "window": rep.FLOW_WINDOW}}, sort_keys=True))
`;

test("the flow verdict, and the three numbers it rests on, mean the same thing in Swift and in the daily report", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-verdict-"));
  const cases = FLOW_SENSE_CASES.map((c) => ({
    name: c.name, turns: c.turns, now: lastStartOf(c.turns) + c.after,
  }));
  const runPython = (module) => JSON.parse(execFileSync(
    "python3", ["-B", "-c", FLOW_VERDICT_PY, module, JSON.stringify(cases)], { encoding: "utf8" }));
  const fromPython = runPython(pkgPath("island-day-report.py"));

  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "flow-verdict-check");
  fs.writeFileSync(main, `
import Foundation

let t0 = Date(timeIntervalSince1970: 1_700_000_000)
let cases: [(String, [(Double, Double, Bool)], Double)] = [
${cases.map((c) => `    (${JSON.stringify(c.name)}, [${c.turns.map(([s, e, tr]) => `(${s}, ${e}, ${tr})`).join(", ")}], ${c.now}),`).join("\n")}
]
var rows: [String] = []
for (name, spec, now) in cases {
    let turns = spec.map {
        FlowMath.Turn(start: t0.addingTimeInterval($0.0), end: t0.addingTimeInterval($0.1),
                      project: "/p/one", source: "claude", truncated: $0.2)
    }
    let gaps = FlowSense.pickupGaps(turns).map { Int($0) }
    let verdict = FlowSense.inFlow(turns: turns, now: t0.addingTimeInterval(now))
    rows.append("{\\"gaps\\":[\\(gaps.map(String.init).joined(separator: ","))],"
                + "\\"inFlow\\":\\(verdict),\\"name\\":\\"\\(name)\\"}")
}
print("{\\"cases\\":[\\(rows.joined(separator: ","))],"
      + "\\"constants\\":{\\"dropOut\\":\\(Int(FlowSense.dropOut)),"
      + "\\"quickPickup\\":\\(Int(FlowSense.quickPickup)),\\"window\\":\\(FlowSense.window)}}")
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"), main, "-o", binary],
    { stdio: "pipe" });
  const fromSwift = JSON.parse(execFileSync(binary, { encoding: "utf8" }));

  // Control group first: two empty answers always compare equal, and a case
  // list that only ever expects one verdict would pass under a hardwired one.
  assert.equal(fromPython.cases.length, FLOW_SENSE_CASES.length,
    "not every case reached the python judgment");
  assert.ok(fromPython.cases.some((c) => c.inFlow) && fromPython.cases.some((c) => !c.inFlow),
    "the cases only ever expect one answer — such a comparison proves nothing");
  assert.deepEqual(fromSwift, fromPython, "the island's flow verdict and the report's have drifted apart");

  // The python copy must read the shared constants and may not keep a
  // threshold of its own that can drift.
  // Comparing only the answers these cases happen to produce cannot catch 90s
  // being quietly read as 120s.
  assert.deepEqual(fromPython.constants, { quickPickup: 90, window: 5, dropOut: 270 },
    "the three provisional numbers moved — they are re-derived from the corrections, never edited by hand");

  // …and every boundary still answered the way the Swift side says.
  for (const [i, c] of FLOW_SENSE_CASES.entries()) {
    assert.deepEqual(fromPython.cases[i], { gaps: c.gaps, inFlow: c.inFlow, name: c.name },
      `flow verdict wrong for: ${c.name}`);
  }

  // Mutation. ⚠️ Twice over: count the ammunition before firing (an anchor that
  // matches nothing mutates nothing), and count the hits after (a mutation that
  // changes six cases when it should change one is telling you the case list,
  // not the rule, is what died).
  let mutant = 0;
  const mutate = (from, to) => {
    const src = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
    const hits = src.split(from).length - 1;
    assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1: ${from}`);
    const file = path.join(tmp, `mutant-${mutant++}.py`);
    fs.writeFileSync(file, src.split(from).join(to));
    return file;
  };
  const mustFlip = (file, names, why) => {
    const after = runPython(file);
    const changed = after.cases
      .filter((row, i) => JSON.stringify(row) !== JSON.stringify(fromPython.cases[i]))
      .map((row) => row.name)
      .sort();
    assert.deepEqual(changed, [...names].sort(), why);
  };

  // ① The pickup threshold loosened to "at most": a median of exactly 90s
  //    would read as quick. Exactly one case sits on that line.
  mustFlip(mutate("_median(recent) < QUICK_PICKUP", "_median(recent) <= QUICK_PICKUP"),
    ["median exactly 90s"], "the pickup threshold must stay strict");
  // ② The five-record floor removed: one quick pickup would announce flow.
  mustFlip(mutate("len(gaps) < FLOW_WINDOW", "len(gaps) < 1"),
    ["only four pickups"], "fewer than five pickups must never read as flow");
  // ③ The drop-out loosened the same way.
  mustFlip(mutate("now - last_start >= DROP_OUT", "now - last_start > DROP_OUT"),
    ["270s since the last start"], "the drop-out threshold must stay strict");
  // ④ Mean instead of median. ⚠️ The separating case is NOT the trip to the
  //    kettle (its mean is 84s and slips under the line by luck) — it is the
  //    89-second median, whose mean is 149.8s.
  mustFlip(mutate("return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2",
                  "return sum(s, timedelta()) / len(s)"),
    ["median 89s"], "one slow pickup out of five must not drag the verdict with it");
  // ⑤ The verdict must go through `pickup_gaps` and nothing else — a second
  //    copy of that rule is exactly the drift this file exists to prevent. Let
  //    a truncated turn take off and case ⑧ grows a gap that never happened.
  mustFlip(mutate("if truncated or b - a >= max_turn:", "if b - a >= max_turn:"),
    ["truncated and implausible turns are no take-off"],
    "in_flow must read pickup_gaps, truncation rule included");
  // ⑥⑦⑧ Each constant is live, and none of them is duplicated as a literal
  //    somewhere down the file where an edit here would not reach it.
  //    ⚠️ Two cases sit between 90 and 120 now: the boundary case, and the
  //    overlapping-lines case whose end-ordered median is exactly 100.
  mustFlip(mutate("QUICK_PICKUP = timedelta(seconds=90)", "QUICK_PICKUP = timedelta(seconds=120)"),
    ["a long line overlapping short ones", "median exactly 90s"],
    "QUICK_PICKUP is not the number the verdict actually uses");
  mustFlip(mutate("FLOW_WINDOW = 5", "FLOW_WINDOW = 4"),
    ["median 89s", "only four pickups"], "FLOW_WINDOW is not the number the verdict actually uses");
  mustFlip(mutate("DROP_OUT = timedelta(minutes=4.5)", "DROP_OUT = timedelta(minutes=5)"),
    ["270s since the last start", "271s since the last start"],
    "DROP_OUT is not the number the verdict actually uses");
});

// The verdict is instantaneous; the report's column is a duration. `flow_spans`
// is the bridge, and it may only change its answer at the two moments the
// verdict itself can change: a turn STARTS (a new pickup delay lands, so judge
// again), or 4.5 minutes pass since the last start (the drop-out fires). No
// third rule, and in particular no bridging — the welding is what the old
// column did.

// The verdict is instantaneous; the report's column is a duration. `flow_spans`
// is the bridge, and it may only change its answer at the two moments the
// verdict itself can change: a turn STARTS (a new pickup delay lands, so judge
// again), or 4.5 minutes pass since the last start (the drop-out fires). No
// third rule, and in particular no bridging — the welding is what the old
// column did.

// ── A day's flow total is the verdict walked along the day ────────────────
//
// ⚠️ `DayFlow.seconds` ↔ `flow_spans()` is a FOURTH cross-language pair, and
// this is the only thing keeping them one answer. The three pins above cover
// `settle`, `pickupGaps` and `inFlow` — the verdict AT A MOMENT — and not one
// of them notices when the two sides disagree about how to TOTAL a day.
//
// ⚠️ The failure this exists to catch is directional, and it flatters. A total
// built by bridging gaps ("that silence was short enough, count it") makes a
// BREAK ADD TIME: step away for a quarter of an hour and the day scores higher
// than working straight through it. Nothing on screen would say so, and the
// number is the one the week perch paints.
const DAY_FLOW_PY = `
import importlib.util, json, sys
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", sys.argv[1])
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026, 7, 28, 9, 0, 0)
rows = []
for c in json.loads(sys.argv[2]):
    turns = [(t0 + timedelta(seconds=s), t0 + timedelta(seconds=e), p, "claude", tr)
             for s, e, p, tr in c["turns"]]
    rows.append({"name": c["name"],
                 "seconds": int(sum((b - a).total_seconds() for a, b in rep.flow_spans(turns))),
                 "work": int(sum(((b - a) for a, b in rep.run_intervals(turns)),
                                 __import__("datetime").timedelta()).total_seconds())})
print(json.dumps(rows))
`;

// [start, end, project, truncated]

// [start, end, project, truncated]

// [start, end, project, truncated]

// [start, end, project, truncated]
const dayChain = (count, every, length, from = 0, project = "/p/a") =>
  Array.from({ length: count }, (_, i) => [from + i * every, from + i * every + length, project, false]);

const DAY_FLOW_CASES = [
  // ① A plain worked stretch: ten turns, 30s between finishing one and setting
  //    the next going. Every start after the fifth judges "in flow", and each
  //    span runs to the next start — so the total is the working day itself,
  //    plus DROP_OUT of the island still saying yes after the last start.
  { name: "ten quick pickups", turns: dayChain(10, 90, 60) },
  // ② An 830-second gap sits between two worked stretches, past the 270s
  //    drop-out limit.
  //    The gap sits under a 900s bridging threshold (890s between starts), so
  //    a bridge would count it whole as flow.
  { name: "a break longer than the drop-out", turns: [...dayChain(10, 90, 60), ...dayChain(10, 90, 60, 1700)] },
  // ③ Two lines running at once — the case every pin above is blind to,
  //    because their fixtures contain no long turn that both OVERLAPS the short
  //    ones and has a later start to land on. An afternoon of parallel agents
  //    is this shape, not ①'s.
  //
  //    ⚠️ The numbers are chosen, not decorative, and this case is what pins
  //    the ORDER. Sorted by turn end — the rule — the pickups are
  //    [10, 10, 10, 1000, 1500, 100], so the last five are
  //    [10, 10, 1000, 1500, 100]: median 100, over the line, no flow. Sorted by
  //    turn START instead, the long line's 100 moves to the front and the last
  //    five become [10, 10, 10, 1000, 1500]: median 10, under the line, flow all
  //    afternoon. Take any of it away and the two orders agree and this case
  //    proves nothing.
  { name: "two lines overlapping", turns: [
      [0, 3000, "/p/long", false],
      [100, 200, "/p/short", false],
      [210, 300, "/p/short", false],
      [310, 400, "/p/short", false],
      [410, 500, "/p/short", false],
      [1500, 1600, "/p/short", false],
      [3100, 3200, "/p/short", false],
  ] },
  // ④ Fewer than five pickups is always no, so a day can be busy and still
  //    total zero. Without this the comparison could pass on two zeros.
  { name: "only three turns", turns: dayChain(3, 90, 60) },
  { name: "nothing at all", turns: [] },
  // ⑤ A turn exactly at the cap must be excluded on BOTH sides; the boundary
  //    is strictly `< maxTurn`.
  { name: "a turn at the cap", turns: [[0, 2 * 60 * 60, "/p/cap", false],
                                       [100, 160, "/p/a", false]] },
];

test("a day's flow total is the same number in Swift and in the daily report", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-day-flow-"));
  const payload = JSON.stringify(DAY_FLOW_CASES);
  const runPython = (module) => JSON.parse(execFileSync(
    "python3", ["-B", "-c", DAY_FLOW_PY, module, payload], { encoding: "utf8" }));
  const fromPython = runPython(pkgPath("island-day-report.py"));

  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "day-flow-check");
  fs.writeFileSync(main, `
import Foundation
let raw = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [[String: Any]]
let t0 = Date(timeIntervalSince1970: 0)
// The ladder is fractions of an eight-hour day — 1h=⅛, 2h=¼, 4h=½, 6h=¾ — and
// the uneven spacing is the shape of the fractions themselves.
// Absolute rungs mean a level says the same thing on every install, rather
// than quintiles of one person's history.
precondition(DayFlow.level(forSeconds: 0) == 1)
precondition(DayFlow.level(forSeconds: 3599) == 1)
precondition(DayFlow.level(forSeconds: 3600) == 2, "an hour starts 2/5")
precondition(DayFlow.level(forSeconds: 7200) == 3, "two hours start 3/5")
precondition(DayFlow.level(forSeconds: 14399) == 3)
precondition(DayFlow.level(forSeconds: 14400) == 4, "four hours start 4/5")
precondition(DayFlow.level(forSeconds: 21599) == 4)
precondition(DayFlow.level(forSeconds: 21600) == 5, "six hours start 5/5")
var out: [[String: Any]] = []
for c in raw {
    let turns = (c["turns"] as! [[Any]]).map { t in
        FlowMath.Turn(start: t0.addingTimeInterval((t[0] as! NSNumber).doubleValue),
                      end: t0.addingTimeInterval((t[1] as! NSNumber).doubleValue),
                      project: t[2] as! String, source: "claude",
                      truncated: (t[3] as! NSNumber).boolValue)
    }
    out.append(["name": c["name"] as! String, "seconds": Int(DayFlow.seconds(turns: turns)),
                "work": Int(DayFlow.workSeconds(turns: turns))])
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"),
                          islandPath("DayFlow.swift"), islandPath("DayScore.swift"),
                          islandPath("AgentEventLog.swift"), APP_GROUP_SWIFT, main, "-o", binary],
    { stdio: "pipe" });
  const fromSwift = JSON.parse(execFileSync(binary, [payload], { encoding: "utf8" }));

  // Control group first: two lists of zeros are always equal.
  assert.equal(fromPython.length, DAY_FLOW_CASES.length,
    "the python side answered a different number of cases than were sent");
  assert.ok(fromPython.some((r) => r.seconds > 0) && fromPython.some((r) => r.seconds === 0),
    "the case list must contain both a day with flow and a day without, or an all-zero comparison passes");

  assert.deepEqual(fromSwift, fromPython, "the island's day total and the report's have drifted apart");

  // …and what they must BOTH say, so agreement alone cannot be the whole test.
  const said = Object.fromEntries(fromPython.map((r) => [r.name, r.seconds]));
  assert.equal(said["only three turns"], 0, "fewer than five pickups can never total any flow");
  assert.equal(said["nothing at all"], 0, "an empty day totals nothing");
  // Pinned to an independently reckoned constant, never derived from a
  // reading that could grow in lockstep with the bug.
  // The two stretches are 630s and 1080s, 1710s in total; the gap between them
  // is not flow.
  assert.equal(said["a break longer than the drop-out"], 1710,
    "a break longer than the drop-out is not flow — bridged, this day reads 2960");
  assert.equal(said["ten quick pickups"], 630, "the plain worked stretch moved");
  // Work and flow are DIFFERENT numbers, and this case must make the two come
  // out different.
  const work = Object.fromEntries(fromPython.map((r) => [r.name, r.work]));
  assert.equal(work["only three turns"], 180,
    "three 60s turns worked 180s — a day can have work and still no flow");
  assert.equal(said["only three turns"], 0, "control: that same day's flow is 0");
  assert.equal(work["a turn at the cap"], 60,
    "a turn exactly at maxTurn leaked into the work total — the bound went <=");
  // Work time is the wall-clock union; overlapping parallel turns count ONCE.
  assert.equal(work["two lines overlapping"], 3100,
    "parallel turns are being SUMMED — a day of parallel agents reads as more hours than the day has");
  // ⚠️ The order pin. A pickup is dated by the moment the agent FINISHED, so
  //    the most recent one here is the long line's 100s — over the line. Read in
  //    start order instead this day reads as flow throughout, which is the
  //    flattering answer and the wrong one.
  assert.equal(said["two lines overlapping"], 0,
    "the most recent pickup was 100s: a day judged on turn-END order cannot read as flow here");

  // Mutation. ⚠️ Ammunition counted before firing: an anchor that matches
  // nothing mutates nothing, and the green means only that the shot was blank.
  const mutate = (from, to) => {
    const src = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
    const hits = src.split(from).length - 1;
    assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1: ${from}`);
    const probe = path.join(tmp, "probe.py");
    fs.writeFileSync(probe, src.replace(from, to));
    return runPython(probe);
  };
  // ① The span must stop at DROP_OUT after a start. Bridge it to the old 15
  //    minutes instead and the break case swells — which is the exact bug.
  const bridged = mutate("end = s + DROP_OUT if i + 1 == len(starts) else min(starts[i + 1], s + DROP_OUT)",
                         "end = s + timedelta(minutes=15) if i + 1 == len(starts) else min(starts[i + 1], s + timedelta(minutes=15))");
  assert.notDeepEqual(bridged, fromPython, "bridging gaps changed nothing — the day total is not being measured");
  // ② The verdict has to come from `in_flow`, not from a second copy of the
  //    median rule inlined here — that is how the island's total drifted 3×
  //    from this one in the first place.
  const inlined = mutate("if not in_flow([t for t in settled_turns if t[0] <= s], s):",
                         "if not (len([t for t in settled_turns if t[0] <= s]) >= FLOW_WINDOW):");
  assert.notDeepEqual(inlined, fromPython, "replacing the verdict with a bare count changed nothing");
  // Every "agents ran" display uses the wall-clock union, net_ran.
  // The parallel sum may only appear under its own name, never dressed up as
  // work time.
  const repSrc = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
  assert.match(repSrc, /agents ran \{hm\(ran\)\}/,
    "the day report's 'agents ran' line stopped using the wall-clock union");
  assert.match(repSrc, /\{hm\(net_ran\(st\)\):>8\}/,
    "the summary's agents column stopped using the wall-clock union");
  assert.doesNotMatch(repSrc, /agents ran \{hm\(busy\)\}/,
    "a display site says 'agents ran' with the parallel sum again — a 12h wall prints as 22h");

  // The day report must accept both installed container spellings, `group.x`
  // and `TEAMID.group.x`.
  // Pinned to the prefix-free shape alone, it refuses to run after a signed
  // install.
  const shapes = JSON.parse(execFileSync("python3", ["-B", "-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rep", sys.argv[1])
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
print(json.dumps([rep.group_core("group.io.example.perch"),
                  rep.group_core("ABCDE12345.group.io.example.perch"),
                  rep.group_core("nonsense"), rep.group_core("group.")]))
`, pkgPath("island-day-report.py")], { encoding: "utf8" }));
  assert.deepEqual(shapes, ["group.io.example.perch", "group.io.example.perch", "", ""],
    "the report no longer accepts both container spellings (or accepts garbage)");

  // ③ Pickups are ordered by turn END; ordering by start reads an overlapping
  //    day's gaps as flow.
  const byStart = mutate("return [g for _, g in sorted(found, key=lambda p: p[0])]",
                         "return [g for _, g in found]");
  const overlapUnder = (rows) => rows.find((r) => r.name === "two lines overlapping").seconds;
  assert.notEqual(overlapUnder(byStart), overlapUnder(fromPython),
    "ordering pickups by turn start instead of end changed nothing — the order is not pinned");
});

test("a day too thin to judge is not a day with the lowest reading", () => {
  // `seconds == 0` had two meanings wearing one face. A day with plenty of
  // handoffs and none of them quick really measured zero; a day with fewer
  // than `window` pickups was never judged at all. The branch painted the
  // second one at 1/5 (a colour claiming a reading nobody took) while the text
  // showed `—` on the first (claiming no data about a day that was measured).
  // Both halves are pinned here because fixing one alone just moves the lie.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-judged-"));
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, `
import Foundation

// ⚠️ TODAY, not yesterday. The week runs Monday…Sunday, so on a Monday
// "yesterday" is Sunday and belongs to the PREVIOUS week — DayFlow.week would
// not contain it, report() would fall through to its missing branch, and the
// assertions below would read undefined instead of a verdict. This test was
// green six days a week and red every Monday. Today is always in this week.
let day = Calendar.current.startOfDay(for: Date())
func at(_ s: Double) -> Date { day.addingTimeInterval(3600 + s) }

// One quick round trip is not enough evidence: below FlowSense.window pickups
// the verdict refuses to answer, so this day has no reading at all.
let thin = (0..<2).map { i in
  FlowMath.Turn(start: at(Double(i) * 100), end: at(Double(i) * 100 + 30),
                project: "/p/a", source: "claude", truncated: false)
}
// Enough pickups to answer, every one of them far too slow: measured zero.
let slow = (0..<8).map { i in
  FlowMath.Turn(start: at(Double(i) * 1200), end: at(Double(i) * 1200 + 60),
                project: "/p/a", source: "claude", truncated: false)
}
// Enough pickups, all quick: a real reading.
let quick = (0..<8).map { i in
  FlowMath.Turn(start: at(Double(i) * 90), end: at(Double(i) * 90 + 30),
                project: "/p/a", source: "claude", truncated: false)
}

// ⚠️ Go through DayFlow.week, not through judgedness recomputed in the harness;
// otherwise the shipped judged field is never exercised.
func events(_ turns: [FlowMath.Turn]) -> [FlowMath.Event] {
  turns.flatMap { [
    FlowMath.Event(time: $0.start, event: "working", project: $0.project, source: $0.source),
    FlowMath.Event(time: $0.end, event: "complete", project: $0.project, source: $0.source),
  ] }
}
func report(_ name: String, _ turns: [FlowMath.Turn]) -> String {
  let week = DayFlow.week(now: Date(), calendar: .current) { _, _ in events(turns) }
  // The turns were laid on today, so read today's segment (see the note above).
  let key = DayScore.dayFormatter.string(from: day)
  guard let d = week.first(where: { $0.date == key }) else { return "{\\"name\\":\\"\\(name)\\",\\"missing\\":true}" }
  return "{\\"name\\":\\"\\(name)\\",\\"seconds\\":\\(Int(d.seconds)),\\"judged\\":\\(d.judged)}"
}
print("[" + [report("thin", thin), report("slow", slow), report("quick", quick)].joined(separator: ",") + "]")
`);
  const binary = path.join(tmp, "judged-check");
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"),
                          islandPath("DayScore.swift"), islandPath("DayFlow.swift"),
                          islandPath("AgentEventLog.swift"), APP_GROUP_SWIFT,
                          main, "-o", binary], { stdio: "pipe" });
  const rows = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));

  // Control: the three shapes must actually differ, or the assertions below
  // are all describing the same case.
  assert.equal(by.thin.judged, false, "too few pickups must leave the day unjudged");
  assert.equal(by.slow.judged, true, "enough pickups is enough to answer, however slow they were");
  assert.equal(by.quick.judged, true);
  assert.equal(by.thin.seconds, 0, "control: the thin day is one of the zeros");
  assert.equal(by.slow.seconds, 0, "control: the slow day is the OTHER zero");
  assert.ok(by.quick.seconds > 0, "control: the quick day must not be a zero at all");

  // The text half: a measured zero reads 0m, an unjudged day reads nothing.
  const row = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  assert.match(row, /static func flowLabel\([\s\S]{0,200}guard day\.judged else \{ return nil \}/,
    "flowLabel must refuse a day that was never judged");
  assert.match(row, /label\(seconds: day\.seconds\) \?\? "0m"/,
    "a judged day measuring zero must read 0m, not the missing-data dash");
  assert.doesNotMatch(row, /Self\.label\(seconds: (today|day)\.seconds\)/,
    "a flow reading still goes through the plain label, which cannot tell the two zeros apart");

  // The colour half: the branch must ask the same question.
  const perch = fs.readFileSync(islandPath("WeekPerch.swift"), "utf8");
  assert.match(perch, /private func paints\([\s\S]{0,400}day\.judged \|\| corrections\[day\.date\] != nil/,
    "the branch must paint only a day with a reading, or one a person corrected");
  assert.doesNotMatch(perch, /if !isFuture\(index\) \{\s*\n\s*UnevenRoundedRectangle/,
    "the branch still paints on future-ness alone, which cannot tell the two zeros apart");
});
