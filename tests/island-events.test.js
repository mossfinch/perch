// The raw material: what the agents did, written down without judgement, and the settle
// layer that turns a stream of events back into turns.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { viewModelSource, APP_GROUP_SWIFT, islandPath, pkgPath } = require("./island-paths");

test("event log: record without judging, and time must match the human's clock", () => {
  const log = fs.readFileSync(islandPath("AgentEventLog.swift"), "utf8");

  // ⚠️ ISO8601DateFormatter defaults to UTC (trailing Z) while day-splitting
  // uses the local zone. Diverge and the report is off by a whole timezone.
  assert.match(log, /f\.timeZone = TimeZone\.current/, "the timestamp must set the local zone explicitly, or the report is a timezone off");

  // Everything the island writes stays in its own App Group; no shared
  // directories, no paths outside that container. Strip comments first so words
  // legitimately used in comments don't collide.
  const code = (s) => s.replace(/\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "");
  assert.match(log, /appendingPathComponent\("agent-events"\)/);
  assert.doesNotMatch(code(log), /Shared\//);

  // Broken observability must never affect the island's work: all writes on
  // the serial queue, and no try! / crashes
  assert.match(log, /queue\.async/);
  assert.doesNotMatch(log, /try!/);
  // Log the full path, not the display name — future grouping by directory depends on it
  const vm = viewModelSource();
  assert.match(vm, /AgentEventLog\.append\(project: dir, source: source, event: status\.logName\)/);
  assert.doesNotMatch(vm, /AgentEventLog\.append\([^)]*displayName/);

  const rep = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
  // The report may only claim what it knows: "how long you and the agents
  // worked together", never how focused you were. Check only lines that
  // actually print — the docstring legitimately explains "never claims to
  // know how focused", and that explanation must stay.
  const printed = rep.split("\n").filter((l) => l.includes("print(")).join("\n");
  assert.doesNotMatch(printed, /focus/i, "the report must not claim to know your focus — the island cannot see the human");
  // Old logs end in Z; reading must convert, never treat it literally as local time
  assert.match(rep, /astimezone\(\)/);

  // Behavior test: turns must cut as "complete closes one, the next working
  // opens a new one", and two (source, project) pairs in parallel are two
  // independent lines. Grepping cannot catch a wrong cut.
  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
# Same rule as the codex installer: importing and turn-cutting must work with
# no island installed, or this test only passes on the author's machine.
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026,7,28,9,0,0)
def e(sec, ev, proj, src): return {"dt": t0+timedelta(seconds=sec), "event": ev, "project": proj, "source": src}
evs = [
  e(0,"working","/x/a","claude"), e(5,"working","/x/a","claude"),   # tool calls within one turn
  e(10,"waiting","/x/a","claude"), e(60,"complete","/x/a","claude"),# turn 1 = 60s
  e(100,"working","/x/a","claude"), e(130,"complete","/x/a","claude"),# turn 2 = 30s
  e(20,"working","/x/b","codex"),                                    # turn 3, no complete
]
ts = rep.turns(evs)
closed = [(b-a).total_seconds() for a,b,_,_ in ts if b]
print(json.dumps({"turns": len(ts), "closed": sorted(closed),
                  "open": sum(1 for _,b,_,_ in ts if b is None)}))
`], { encoding: "utf8" });
  const r = JSON.parse(out);
  assert.equal(r.turns, 3, "each line cuts its own turns: a has two + b has one");
  assert.deepEqual(r.closed, [30, 60], "turn duration = first working to complete; mid-turn tool calls open no new turn");
  assert.equal(r.open, 1, "a turn without complete must stay marked open, never counted as 0 seconds");
});


// ⚠️ The REAL writer against the REAL reader, and it is the only test that runs
// `AgentEventLog`'s write path at all. Until it existed the round-trip fixtures
// were written from JavaScript, so the writer was executed by nothing — and the
// three things below are load-bearing for the whole flow reading:
//
//   · the timestamp the writer emits must be one the reader can parse. Give the
//     writer fractional seconds and `recent` returns NOTHING from that moment
//     on: the verdict and the week go permanently to zero while the daily report
//     (python parses either shape) keeps working, so the two languages split
//     with no error anywhere.
//   · the window's upper bound is CLOSED. `DayFlow.week` asks for the day minus
//     one second precisely because of that; make it half-open and every event
//     stamped 23:59:59 falls into no day at all.
//   · the file a line lands in is named for the LOCAL day of its own timestamp.

// ⚠️ The REAL writer against the REAL reader, and it is the only test that runs
// `AgentEventLog`'s write path at all. Until it existed the round-trip fixtures
// were written from JavaScript, so the writer was executed by nothing — and the
// three things below are load-bearing for the whole flow reading:
//
//   · the timestamp the writer emits must be one the reader can parse. Give the
//     writer fractional seconds and `recent` returns NOTHING from that moment
//     on: the verdict and the week go permanently to zero while the daily report
//     (python parses either shape) keeps working, so the two languages split
//     with no error anywhere.
//   · the window's upper bound is CLOSED. `DayFlow.week` asks for the day minus
//     one second precisely because of that; make it half-open and every event
//     stamped 23:59:59 falls into no day at all.
//   · the file a line lands in is named for the LOCAL day of its own timestamp.

// ⚠️ The REAL writer against the REAL reader, and it is the only test that runs
// `AgentEventLog`'s write path at all. Until it existed the round-trip fixtures
// were written from JavaScript, so the writer was executed by nothing — and the
// three things below are load-bearing for the whole flow reading:
//
//   · the timestamp the writer emits must be one the reader can parse. Give the
//     writer fractional seconds and `recent` returns NOTHING from that moment
//     on: the verdict and the week go permanently to zero while the daily report
//     (python parses either shape) keeps working, so the two languages split
//     with no error anywhere.
//   · the window's upper bound is CLOSED. `DayFlow.week` asks for the day minus
//     one second precisely because of that; make it half-open and every event
//     stamped 23:59:59 falls into no day at all.
//   · the file a line lands in is named for the LOCAL day of its own timestamp.

// ⚠️ The REAL writer against the REAL reader, and it is the only test that runs
// `AgentEventLog`'s write path at all. Until it existed the round-trip fixtures
// were written from JavaScript, so the writer was executed by nothing — and the
// three things below are load-bearing for the whole flow reading:
//
//   · the timestamp the writer emits must be one the reader can parse. Give the
//     writer fractional seconds and `recent` returns NOTHING from that moment
//     on: the verdict and the week go permanently to zero while the daily report
//     (python parses either shape) keeps working, so the two languages split
//     with no error anywhere.
//   · the window's upper bound is CLOSED. `DayFlow.week` asks for the day minus
//     one second precisely because of that; make it half-open and every event
//     stamped 23:59:59 falls into no day at all.
//   · the file a line lands in is named for the LOCAL day of its own timestamp.
test("what the event log writes is what the event log reads back", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-log-roundtrip-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "roundtrip");
  fs.writeFileSync(main, `
import Foundation
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
// A fixed local day, and the last second of it — the boundary the day window
// depends on. Built from components so the machine's own zone is what is tested.
var c = DateComponents()
c.year = 2026; c.month = 8; c.day = 12
let cal = Calendar.current
let dayStart = cal.date(from: c)!
let atNoon = dayStart.addingTimeInterval(12 * 3600)
let lastSecond = dayStart.addingTimeInterval(24 * 3600 - 1)
let nextDay = dayStart.addingTimeInterval(24 * 3600)

AgentEventLog.write(project: "/p/one", source: "claude", event: "working", at: atNoon, into: dir)
AgentEventLog.write(project: "/p/two", source: "codex", event: "complete", at: lastSecond, into: dir)
AgentEventLog.write(project: "/p/three", source: "claude", event: "waiting", at: nextDay, into: dir)

// Exactly what DayFlow.week asks for: the whole day, stopping one second short
// of midnight.
let got = AgentEventLog.recent(since: dayStart, now: dayStart.addingTimeInterval(24 * 3600 - 1), from: dir)
let rows = got.map { ["event": $0.event, "project": $0.project, "source": $0.source,
                      "offset": Int($0.time.timeIntervalSince(dayStart))] }
let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.sorted() ?? []
print(String(data: try! JSONSerialization.data(withJSONObject: ["rows": rows, "files": files]),
             encoding: .utf8)!)
`);
  execFileSync("swiftc", [islandPath("AgentEventLog.swift"), islandPath("FlowMath.swift"),
                          APP_GROUP_SWIFT, main, "-o", binary], { stdio: "pipe" });
  const got = JSON.parse(execFileSync(binary, [tmp], { encoding: "utf8" }));

  // Control: the writer really wrote, or every assertion below is about nothing.
  assert.deepEqual(got.files.filter((f) => f.endsWith(".jsonl")).sort(),
    ["2026-08-12.jsonl", "2026-08-13.jsonl"],
    "control: the writer did not produce one file per local day");

  // ① Everything inside the window comes back, in time order, field for field.
  assert.deepEqual(got.rows, [
    { event: "working", project: "/p/one", source: "claude", offset: 12 * 3600 },
    { event: "complete", project: "/p/two", source: "codex", offset: 24 * 3600 - 1 },
  ], "the writer and the reader disagree about what was written");
  // ② …and the one at 23:59:59 is IN it. That is the whole reason the day window
  //    may stop one second short of midnight instead of dropping data.
  assert.ok(got.rows.some((r) => r.offset === 24 * 3600 - 1),
    "the last second of the day was dropped — the window's upper bound went half-open");
  // ③ …and the event a second later is NOT, because it belongs to the next day.
  assert.ok(!got.rows.some((r) => r.project === "/p/three"),
    "an event from the next day leaked into this one");
});

test("the settle layer cuts orphan welds, trusts completes, and flow bridges parallel work", () => {
  // An interrupted turn (no complete) welded to the NEXT session by pure
  // pairing turns a stretch of seconds into hours. The settle layer exists to
  // cut exactly that weld — while still trusting a complete across mid-turn
  // silence, because a tool can run for many quiet minutes and truncating it
  // would halve a genuine turn.
  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026,7,28,9,0,0)
def e(sec, ev, proj, src): return {"dt": t0+timedelta(seconds=sec), "event": ev, "project": proj, "source": src}
evs = [
  # line A: interrupted at 30s, silent ~4h, new session, complete — the weld case
  e(0,"working","/x/a","claude"), e(30,"working","/x/a","claude"),
  e(14000,"working","/x/a","claude"), e(14100,"complete","/x/a","claude"),
  # line B: 600s turn with a long quiet middle — the complete must be trusted
  e(0,"working","/x/b","codex"), e(600,"complete","/x/b","codex"),
]
st = rep.settled(evs)
closed = sorted(int((b-a).total_seconds()) for a,b,_,_,tr in st if not tr)
trunc  = sorted(int((b-a).total_seconds()) for a,b,_,_,tr in st if tr)
fl = rep.flow_stretches(st)
print(json.dumps({
  "closed": closed, "trunc": trunc,
  "stretches": len(fl),
  "flow": int(sum((b-a).total_seconds() for a,b in fl)),
}))
`], { encoding: "utf8" });
  const s = JSON.parse(out);
  assert.deepEqual(s.trunc, [30], "the interrupted turn is cut at its last event, not welded to the next session");
  assert.deepEqual(s.closed, [100, 600],
    "the new session closes at its own complete (100s), and the quiet-middle turn keeps its full 600s — completes are trusted");
  // Flow: line B's 600s turn covers line A's fragment (parallel work bridges),
  // then a 4-hour break, then the second session — two stretches, 700s total.
  assert.equal(s.stretches, 2, "parallel lines merge into one stretch; a 4-hour silence breaks it");
  assert.equal(s.flow, 700, "stretch length is wall-clock first-start to last-end, summed");
});

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
