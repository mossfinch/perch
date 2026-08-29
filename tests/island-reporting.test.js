// What the day report prints: the columns, the shadow features, the machine-readable
// reading other projects pull, and the score line.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandViews, islandPath, pkgPath } = require("./island-paths");

test("the machine-readable reading is the same number the human reads", () => {
  // A number that gets SPENT downstream must not be a second opinion. The
  // report already prints the island's reading as prose; anything that reads
  // it with a program has to get that same number, not a neighbour of it.
  //
  // ⚠️ The trap this exists to close: `--features` carries `flow2/5/10_min`
  // from a shadow experiment — different bridge thresholds and a different
  // answer, and `flow5_min` reads like the obvious field to take. Wiring
  // to it would put a third algorithm into circulation with nothing on screen
  // to say so.
  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, io, json, re, contextlib
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
rep.day_scores = lambda: {}
t0 = datetime(2026,7,28,9,0,0)
def e(sec, ev, proj, src): return {"dt": t0+timedelta(seconds=sec), "event": ev, "project": proj, "source": src}
# Quick handoffs, and enough of them to run past an hour: the prose switches
# format at the hour mark, so a shorter fixture would leave that branch unread.
evs = []
at = 0
for i in range(60):
    evs.append(e(at, "working", "/x/a", "claude"))
    evs.append(e(at+40, "complete", "/x/a", "claude"))
    at += 100
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rep.report("2026-07-28", evs)
prose = buf.getvalue()
m = re.search(r"flow\\s+(?:(\\d+)h)?(\\d+)m", prose)
human = (int(m.group(1) or 0) * 60 + int(m.group(2))) if m else None
# A day too thin to judge: three handoffs is under FLOW_WINDOW, so the
# verdict was never taken. Without this half, "judged" could be hard-wired
# true and every assertion above would still pass.
thin = []
at = 0
for i in range(3):
    thin.append(e(at, "working", "/x/a", "claude"))
    thin.append(e(at+40, "complete", "/x/a", "claude"))
    at += 100
print(json.dumps({"human": human, "machine": rep.daily_reading("2026-07-28", evs),
                  "thin": rep.daily_reading("2026-07-28", thin)}))
`], { encoding: "utf8" });
  const r = JSON.parse(out);

  // Control: the fixture really produced a reading, or "equal" below is two
  // zeros agreeing about nothing.
  assert.ok(r.human > 0, `control: the prose reported no flow at all — ${r.human}`);
  assert.equal(r.machine.flow_minutes, r.human,
    "the machine-readable flow minutes are not the number printed on screen");
  assert.equal(r.machine.date, "2026-07-28", "the reading does not say which day it is for");
  assert.equal(r.machine.judged, true,
    "eight quick handoffs must count as judged — a spender cannot tell 'measured zero' from 'never measured' without it");
  assert.ok(Number.isInteger(r.machine.agents_ran_minutes),
    "agents-ran must be whole minutes: the downstream ledger takes an integer");
  // The other half of `judged`, and the reason this test has two fixtures: an
  // always-true flag reads exactly like a working one from the green side.
  assert.equal(r.thin.judged, false,
    "three handoffs is under the window — a day nothing was measured on must not claim it was");
  assert.equal(r.thin.flow_minutes, 0,
    "control: the thin day really does measure zero, so `judged` is the only thing separating the two cases");
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
const FLOW_SPANS_PY = `
import contextlib, importlib.util, io, json, os, sys
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", sys.argv[1])
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
# The answers ledger sits beside the installed island; this test is about the
# flow column, and stubbing it keeps the check honest on a machine with no app.
rep.day_scores = lambda: {}
t0 = datetime(2026, 7, 28, 9, 0, 0)
directory = sys.argv[2]
day = "2026-07-28"

def settled_from(pairs):
    return [(t0 + timedelta(seconds=a), t0 + timedelta(seconds=b), "/x/a", "claude", False)
            for a, b in pairs]

def spans(pairs):
    return [[int((a - t0).total_seconds()), int((b - t0).total_seconds())]
            for a, b in rep.flow_spans(settled_from(pairs))]

dense  = [(s, s + 10) for s in range(0, 281, 40)]     # 8 turns, picked up 30s apart
broken = dense + [(2090, 2100)]                        # …then half an hour of nothing
thin   = [(s, s + 10) for s in range(0, 161, 40)]      # 5 turns = only 4 pickups

# The same broken day, through the report itself: events on disk, read and
# printed exactly the way the terminal command does it.
with open(os.path.join(directory, day + ".jsonl"), "w", encoding="utf-8") as fh:
    for a, b in broken:
        for at, ev in ((a, "working"), (b, "complete")):
            fh.write(json.dumps({"t": (t0 + timedelta(seconds=at)).isoformat(), "event": ev,
                                 "project": "/x/a", "source": "claude"}) + "\\n")
rep.events_dir = lambda: directory
events = rep.load(day, directory)
st = rep.settled(events)

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rep.report(day, events)
day_text = buf.getvalue()

sys.argv = ["island-day-report.py", "--summary"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rep.main()
summary_text = buf.getvalue()

total = lambda spans: int(sum((b - a for a, b in spans), timedelta()).total_seconds())
print(json.dumps({"dense": spans(dense), "broken": spans(broken), "thin": spans(thin),
                  "new_total": total(rep.flow_spans(st)),
                  "old_total": total(rep.flow_stretches(st)),
                  "day_text": day_text, "summary_text": summary_text}, sort_keys=True))
`;

test("the report's flow column is the island's verdict laid over the day, not the old bridged total", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-spans-"));
  const run = (module) => JSON.parse(execFileSync(
    "python3", ["-B", "-c", FLOW_SPANS_PY, module, tmp], { encoding: "utf8" }));
  const r = run(pkgPath("island-day-report.py"));

  // ① Dense commanding, one span. It opens at the SIXTH turn's start (200s),
  //    because that is when the fifth pickup lands — before it the island has
  //    not seen enough to claim anything — and it closes 4.5 minutes after the
  //    last start, which is the drop-out doing exactly what it says.
  assert.deepEqual(r.dense, [[200, 550]],
    "dense pickups must read as one unbroken span, opening at the fifth pickup and closing at the drop-out");
  // ② Half an hour of nothing in the middle: two spans, and the break is the
  //    drop-out — no bridge, no welding, nothing carried across the silence.
  assert.deepEqual(r.broken, [[200, 550], [2090, 2360]],
    "a long silence must break the span at the drop-out, not be bridged over");
  // ③ A day that never reached five pickups says nothing at all. Silence is
  //    "no", never "probably".
  assert.deepEqual(r.thin, [], "four pickups is not five — such a day has no flow to report");

  // ④ The column itself. The two measures deliberately differ so this proves
  //    the printed column selects the verdict total, not bridged runtime.
  assert.equal(r.new_total, 620);
  assert.equal(r.old_total, 300);
  const flowLine = r.day_text.split("\n").find((l) => l.trim().startsWith("flow "));
  assert.ok(flowLine, "the day report printed no flow line at all");
  assert.match(flowLine, /flow\s+10m20s across 2 span\(s\)/,
    "the day report's flow column is not the verdict's total");
  // The label must identify the judgment behind the number.
  assert.match(flowLine, /island judged you in flow/,
    "the flow line must say whose judgment it is printing");
  assert.match(r.summary_text, /2026-07-28\s+10m20s/,
    "the --summary table's flow column did not follow the day report");

  // ⑤ Mutation, ammunition counted before firing. Both call sites are wired one
  //    at a time, because a table and a day report that disagree about the same
  //    word is the exact failure this section exists to end.
  let mutant = 0;
  const mutate = (from, to) => {
    const src = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
    const hits = src.split(from).length - 1;
    assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1: ${from}`);
    const file = path.join(tmp, `mutant-${mutant++}.py`);
    fs.writeFileSync(file, src.split(from).join(to));
    return file;
  };
  const dayFlow = (out) => out.day_text.split("\n").find((l) => l.trim().startsWith("flow "));
  const back = run(mutate("    spans = flow_spans(st)", "    spans = flow_stretches(st)"));
  assert.match(dayFlow(back), /flow\s+5m00s/,
    "mutation: the day report went back to the bridged total and the assertion stayed quiet");
  assert.ok(!/10m20s/.test(dayFlow(back)), "mutation: the day report's flow line did not move at all");
  const backTable = run(mutate("            flow_total = sum((b - a for a, b in flow_spans(st)), timedelta())",
                               "            flow_total = sum((b - a for a, b in flow_stretches(st)), timedelta())"));
  assert.match(backTable.summary_text, /2026-07-28\s+5m00s/,
    "mutation: the --summary table went back to the bridged total and the assertion stayed quiet");
});


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

// One synthetic day, laid out so every shadow feature has something to be
// wrong about. Seconds from 09:00.
//   · lines A (claude) and B (codex) run in parallel on the SAME project
//   · line C is a second project — the cross-project switch, and the one place
//     where merging across projects and merging within one disagree
//   · line C also holds the day's single `waiting`, and an interrupt whose
//     turn gets truncated
//   · line D is the 3-hour implausible turn: it must vanish from every derived
//     number and appear only in the quality group

// One synthetic day, laid out so every shadow feature has something to be
// wrong about. Seconds from 09:00.
//   · lines A (claude) and B (codex) run in parallel on the SAME project
//   · line C is a second project — the cross-project switch, and the one place
//     where merging across projects and merging within one disagree
//   · line C also holds the day's single `waiting`, and an interrupt whose
//     turn gets truncated
//   · line D is the 3-hour implausible turn: it must vanish from every derived
//     number and appear only in the quality group
const FEATURE_DAY = [
  [0, "working", "/p/alpha", "claude"], [120, "complete", "/p/alpha", "claude"],
  [60, "working", "/p/alpha", "codex"], [240, "complete", "/p/alpha", "codex"],
  [1300, "working", "/p/alpha", "claude"], [1400, "complete", "/p/alpha", "claude"],
  [1500, "working", "/p/beta", "claude"], [1520, "waiting", "/p/beta", "claude"],
  [1560, "complete", "/p/beta", "claude"],
  [2000, "working", "/p/beta", "claude"], [2050, "working", "/p/beta", "claude"],
  [2200, "working", "/p/beta", "claude"], [2260, "complete", "/p/beta", "claude"],
  [5000, "working", "/p/gamma", "codex"], [15800, "complete", "/p/gamma", "codex"],
];

test("the shadow features record what the day measured, and judge none of it", () => {
  // The whole point of these numbers is to be laid beside hand-written answers
  // months from now. If one of them quietly means something other than it says,
  // the comparison is worse than having none — so every field is pinned here on
  // a day whose right answers can be counted by hand.
  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
t0 = datetime(2026, 8, 3, 9, 0, 0)
cases = ${JSON.stringify(FEATURE_DAY)}
evs = sorted(({"dt": t0 + timedelta(seconds=s), "event": e, "project": p, "source": src}
              for s, e, p, src in cases), key=lambda e: e["dt"])
print(json.dumps(rep.day_features("2026-08-03", evs), sort_keys=True))
`], { encoding: "utf8" });
  const f = JSON.parse(out);

  assert.equal(f.date, "2026-08-03", "every line must say which day it is, or --all is a pile of anonymous numbers");

  // Coherence, both cuts. Merging across projects welds alpha's 13:00 turn to
  // beta's 15:00 one (100s apart, inside the bridge); keeping projects apart
  // does not. That disagreement is the entire reason both are recorded.
  assert.equal(f.merged_runs, 3, "cross-project merging bridges alpha→beta: three stretches");
  assert.equal(f.sameproj_runs, 4, "within one project that same bridge cannot apply: four stretches");
  assert.equal(f.merged_longest_min, 4.3, "longest merged stretch is 2000–2260 = 260s");
  assert.equal(f.sameproj_longest_min, 4.3, "the longest single-project stretch is the same 260s one");
  assert.equal(f.project_switches, 1, "turns run alpha,alpha,alpha,beta,beta,beta — one switch, and the implausible gamma turn is not a fourth");

  // Pickup latency. Gaps: 1180 (after A1), 1060 (after B1), 100 (after A2),
  // 440 (after C1), 2740 (after C3 → the gamma start).
  assert.equal(f.pickup_p50_s, 1060, "nearest-rank median of the five real gaps");
  assert.equal(f.pickup_p90_s, 2740, "the 45-minute gap before the gamma turn is a real gap and must show at p90");

  // …and the asymmetry that gap list depends on: a turn that never finished
  // cannot START a gap (its end is only what the log last saw), while any
  // turn's START is a real observed event and may END one.
  assert.ok(f.pickup_p90_s === 2740,
    "the implausible turn's START closed the last gap — dropping it there would hide a 45-minute wait");

  // The one waiting, and the bound that must never be called a response time.
  assert.equal(f.waiting_count, 1);
  assert.equal(f.waiting_upper_min, 0.7, "waiting at 1520, next event on that line at 1560 — 40s is an upper bound, not a measurement");

  // Density. Six plausible turns across a 15800s span; the busiest stretch is
  // the 240s one holding two turns.
  assert.equal(f.turns_per_hour, 1.37);
  assert.equal(f.max_stretch_density, 30, "2 turns inside a 240-second stretch = 30 turns/hour");

  // Net vs. bridged: what actually ran, and what the constant welded in.
  assert.equal(f.net_agent_min, 8.5, "parallel A and B overlap and are counted once");
  assert.equal(f.bridged_gap_min, 4.2, "flow (12.7) minus net (8.5) is exactly the gaps the 5-minute bridge swallowed");

  // The sensitivity row: one day answering "what should the bridge be".
  assert.ok(f.flow2_min <= f.flow5_min && f.flow5_min <= f.flow10_min,
    "a wider bridge can only ever weld more, never less");
  assert.deepEqual([f.flow2_min, f.flow5_min, f.flow10_min], [10.2, 12.7, 20],
    "the three bridges must move the number by a visible amount, or the row cannot answer anything");

  // Quality: the anomalies are the exception to "plausible turns only", because
  // reporting them is the whole job of this group.
  assert.equal(f.turns, 7, "all seven settled turns are in the record");
  assert.equal(f.truncated, 1, "the interrupted turn on line C");
  assert.equal(f.implausible, 1, "the 3-hour gamma turn");

  // Per-source counts expose a silent source even when other sources keep logging.
  assert.deepEqual(f.events_by_source, { claude: 11, codex: 4 });
  assert.deepEqual(f.last_event_by_source, { claude: "09:37", codex: "13:23" });

  // Nothing here may be a verdict. The features are raw counts by contract:
  // the moment a "score"/"level"/"quality" key appears, someone has started
  // judging in a file whose job is to observe.
  assert.deepEqual(Object.keys(f).filter((k) => /score|level|rating|grade|focus/i.test(k)), [],
    "the shadow report records; it does not grade");
});

test("--features prints one raw JSON line per day and touches nothing on disk", () => {
  // A day with no events must still produce a line (a silent day is data), and
  // the whole feature must write NOTHING: the event log stays the only record.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-features-"));
  fs.writeFileSync(path.join(dir, "2026-08-03.jsonl"),
    FEATURE_DAY.map(([s, e, p, src]) => JSON.stringify({
      event: e, project: p, source: src,
      t: new Date(Date.UTC(2026, 7, 3, 1, 0, s)).toISOString(),
    })).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "2026-08-04.jsonl"), "");

  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
rep.events_dir = lambda: ${JSON.stringify(dir)}
sys.argv = ["island-day-report.py", "--features", "--all"]
rep.main()
`], { encoding: "utf8" });

  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2, "--all means one line per day that has a file, empty ones included");
  const rows = lines.map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.date), ["2026-08-03", "2026-08-04"]);
  assert.equal(rows[0].turns, 7, "the day read off a real .jsonl must agree with the in-memory case");
  assert.equal(rows[1].turns, 0);
  assert.equal(rows[1].turns_per_hour, null, "a day with no span has no turns per hour — null, never a fabricated 0");
  // sort_keys: the lines are meant to be diffed and eyeballed across days
  assert.deepEqual(Object.keys(rows[0]), [...Object.keys(rows[0])].sort(),
    "keys must be sorted, or two days' lines cannot be read side by side");

  assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-08-03.jsonl", "2026-08-04.jsonl"],
    "the shadow report may not create a single file — features are computed from the log, never stored");
});

// The CLI fixture keeps the real field order, spacing and quoting, with only
// the timezone offset anonymized.
// Whatever the read rule becomes, this old-format line must still read back as
// the 2 it was given.
const CLI_SCORE_LINE =
  '{"date": "2026-08-01", "score": 2, "note": "", "at": "2026-08-01T22:05:06+00:00"}';

// A ledger with every kind of line that can be in it. 8-11 is the island's own
// pre-split format, re-scored; 8-10 is the case that separates the two read
// rules — an old one-number score with a NEW answer appended after it, where
// "last line per date" and "last line per field" disagree.
const SEED_LEDGER = [
  CLI_SCORE_LINE,
  '{"at":"2026-08-11T17:23:32Z","date":"2026-08-11","note":"","score":2}',
  '{"at":"2026-08-11T17:23:32Z","date":"2026-08-11","note":"","score":3}',
  '{"at":"2026-08-10T10:00:00Z","date":"2026-08-10","note":"","score":5}',
].join("\n") + "\n";

// What both readers must say about that ledger once the island has answered
// 8-12 twice (and re-answered rhythm) and 8-10 once.
const LEDGER_EXPECTED = {
  "2026-08-01": { rhythm: null, progress: null, legacy: 2 },
  "2026-08-10": { rhythm: 2, progress: null, legacy: 5 },
  "2026-08-11": { rhythm: null, progress: null, legacy: 3 },
  "2026-08-12": { rhythm: 3, progress: 2, legacy: null },
};


test("the day score came off the card, and its ledger did not move", () => {
  // The card no longer renders a day score, but the ledger remains a supported
  // data contract for existing records and non-UI readers.
  const view = islandViews();
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");

  // ① Compiled into the ISLAND target. A file that exists on disk but in no
  //    target's sources builds green and ships nothing — same trap as an
  //    .appex that is present but never registered.
  const islandSources = pbx.match(/00A1CE00000000000000002C \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(islandSources.length > 0, "control: the island's Sources phase could not be read at all");
  assert.ok(islandSources.includes("DayScore.swift"), "DayScore.swift is not compiled into the island");

  // ② The view is gone — declaration AND mount point. An empty overlay left
  //    behind would be a layer that does nothing, which is the same smell as
  //    the dead code a later pass had to come back for.
  //    ⚠️ Control group first: a scan that finds nothing proves nothing until it
  //    has been shown to find something.
  const traces = (swift) => swift.match(/\bDayScoreDots\b|overlay\(alignment: \.bottomLeading\)/g) ?? [];
  assert.deepEqual(traces(view), [],
    `the score capsule is back on the card: ${traces(view)}`);
  const planted = traces(
    "        .overlay(alignment: .bottomLeading) {\n            DayScoreDots()\n        }\n");
  assert.equal(planted.length, 2,
    `control: the trace scanner cannot see a real mount — found ${planted.length}, wanted 2`);

  // ②b Nothing floats in a bottom corner. Nothing at all.
  //
  //     ⚠️ This assertion has been written three ways and the history is the
  //     point. First "nothing may float in a bottom corner"; then loosened to
  //     "exactly ONE thing may hold that corner" when the week branch was given
  //     it; now back to the first, strictest form.
  //
  //     ⚠️ The branch was never fighting the countdown bar — it was FLOATING.
  //        An overlay in a corner belongs to no row and no column: it sits on
  //        the frame strip's territory (the strip's frame ends 14pt from the
  //        bottom, the branch sat at 16pt) and reads as pasted on. Three
  //        instruments have been tried in that corner and all three read as
  //        badges. The corner is closed: anything on this card needs a row.
  const corners = view.match(/\.overlay\(alignment: \.bottom\w*\)/g) ?? [];
  assert.deepEqual(corners, [],
    `something floats in a bottom corner again — it needs a row, not a corner: ${corners}`);
  // Control: the corner scanner can see a mount when one is really there.
  const plantedCorner = ("        .overlay(alignment: .bottomTrailing) {\n            Thing()\n        }\n")
    .match(/\.overlay\(alignment: \.bottom\w*\)/g) ?? [];
  assert.equal(plantedCorner.length, 1,
    `control: the corner scanner cannot see a real mount — found ${plantedCorner.length}, wanted 1`);

  // ③ Behaviour, compiled and run — not grepped. One stub stands in for the
  //    symbol DayScore touches but this test must not drag in (AppGroup pulls
  //    the app bundle); it is not on the code path under test, which always
  //    passes an explicit file URL.
  //    DayScore owns the formatter, so the day names below use the production
  //    formatter; only AppGroup needs a stub to keep the app bundle out.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-dayscore-"));
  const stub = path.join(tmp, "stub.swift");
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(stub, `
import Foundation
enum AppGroup { static var containerURL: URL { URL(fileURLWithPath: NSTemporaryDirectory()) } }
`);
  fs.writeFileSync(main, `
import Foundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
func lineCount() -> Int {
    (try! String(contentsOf: url, encoding: .utf8)).split(separator: "\\n").count
}

// ① One appended line per answer, and a second answer for the same question
//    appends over the first rather than being refused.
let before = lineCount()
precondition(DayScore.record(date: "2026-08-12", field: .rhythm, value: 4, to: url))
precondition(DayScore.record(date: "2026-08-12", field: .progress, value: 2, to: url))
precondition(DayScore.record(date: "2026-08-12", field: .rhythm, value: 3, to: url),
             "re-answering must append, not refuse")
precondition(DayScore.record(date: "2026-08-10", field: .rhythm, value: 2, to: url))
// ② Out of range is refused — and refused has to mean nothing reached the file.
precondition(!DayScore.record(date: "2026-08-12", field: .rhythm, value: 0, to: url), "0 is not an answer")
precondition(!DayScore.record(date: "2026-08-12", field: .progress, value: 6, to: url), "6 is not an answer")
precondition(lineCount() == before + 4,
             "a refused answer still reached the ledger (\\(lineCount() - before) lines written, wanted 4)")

// ③ A torn half-line at the end must hide nothing before it.
var raw = try! Data(contentsOf: url)
raw.append("{\\"date\\": \\"2026-08-0".data(using: .utf8)!)
try! raw.write(to: url)

let answers = DayScore.scores(from: url)
precondition(answers["2026-08-01"]?.legacy == 2, "the CLI's own 8-01 line must read back unchanged")
precondition(answers["2026-08-01"]?.rhythm == nil && answers["2026-08-01"]?.progress == nil,
             "an old one-number score answers neither of the two questions")
precondition(answers["2026-08-11"]?.legacy == 3, "the last old-format line still wins for the old field")
precondition(answers["2026-08-12"]?.rhythm == 3 && answers["2026-08-12"]?.progress == 2,
             "each question takes its own last line")
precondition(answers["2026-08-10"]?.legacy == 5 && answers["2026-08-10"]?.rhythm == 2,
             "an old score and a new answer on one day must not knock each other out")
precondition(answers.count == 4, "a torn line must hide nothing and invent nothing")

// ④ Which day the stars ask about. Half an answer is not an answer.
let cal = Calendar.current
func day(_ d: Date) -> String { DayScore.dayFormatter.string(from: d) }
// The formatter moved out of TodaySummary and into DayScore, three lines
// unchanged. Pinned here because a formatter that stopped writing yyyy-MM-dd
// would send the stars to a day nothing else in the system names.
precondition(day(cal.date(from: DateComponents(year: 2026, month: 8, day: 9))!) == "2026-08-09",
             "DayScore.dayFormatter no longer writes yyyy-MM-dd")
let morning = cal.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 8))!
let noon = cal.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 12))!
let yd = day(cal.date(byAdding: .day, value: -1, to: morning)!)

var t = DayScore.target(now: morning, answers: [:])
precondition(t.date == yd && t.isBackfill, "morning + an unanswered yesterday must ask about yesterday")
t = DayScore.target(now: morning, answers: [yd: DayScore.DayAnswers(rhythm: 3)])
precondition(t.date == yd && t.isBackfill,
             "a yesterday with only one of the two answered must still be asked")
t = DayScore.target(now: morning, answers: [yd: DayScore.DayAnswers(legacy: 4)])
precondition(t.date == yd && t.isBackfill,
             "an old one-number score answers neither question and cannot close a day")
t = DayScore.target(now: morning, answers: [yd: DayScore.DayAnswers(rhythm: 3, progress: 2)])
precondition(t.date == day(morning) && !t.isBackfill, "both answers in means the question is today's")
t = DayScore.target(now: noon, answers: [:])
precondition(t.date == day(noon) && !t.isBackfill, "from noon the question is today's")

func cell(_ v: Int?) -> String { v.map { String($0) } ?? "null" }
let rows = answers.keys.sorted().map { d -> String in
    let a = answers[d]!
    return "\\"\\(d)\\":{\\"legacy\\":\\(cell(a.legacy)),\\"progress\\":\\(cell(a.progress)),\\"rhythm\\":\\(cell(a.rhythm))}"
}
print("{" + rows.joined(separator: ",") + "}")
`);

  // A fresh ledger per run, each in its own directory: the run tears the last
  // line on purpose, and the python reader below finds the file by name.
  let run = 0;
  const freshLedger = () => {
    const dir = path.join(tmp, `run-${run++}`);
    fs.mkdirSync(dir);
    const file = path.join(dir, "day-scores.jsonl");
    fs.writeFileSync(file, SEED_LEDGER);
    return file;
  };
  const compile = (source, out) =>
    execFileSync("swiftc", [source, stub, main, "-o", out], { stdio: "pipe" });

  const binary = path.join(tmp, "dayscore-check");
  compile(islandPath("DayScore.swift"), binary);
  const ledger = freshLedger();
  const fromSwift = JSON.parse(execFileSync(binary, [ledger], { encoding: "utf8" }));
  assert.deepEqual(fromSwift, LEDGER_EXPECTED, "the island reads its own ledger wrong");

  // ⑤ The other end of the same contract. The report reads THE VERY FILE the
  //    island just wrote — same bytes, torn tail and all — and must answer
  //    identically. Nothing but this assertion stands between the two readers.
  const fromPython = JSON.parse(execFileSync("python3", ["-B", "-c", `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
rep.events_dir = lambda: os.path.join(${JSON.stringify(path.dirname(ledger))}, "agent-events")
print(json.dumps(rep.day_scores(), sort_keys=True))
`], { encoding: "utf8" }));
  assert.deepEqual(fromPython, LEDGER_EXPECTED,
    "the report's read rule has drifted from the island's");

  // ⑥ Mutation. Both rules above are one line of code, and a test that cannot
  //    be made to fail is not testing them.
  //    ⚠️ Prove the ammunition was loaded: a replacement string that matches
  //    nothing mutates nothing, and the "red" never comes.
  let mutant = 0;
  const mutate = (from, to) => {
    const src = fs.readFileSync(islandPath("DayScore.swift"), "utf8");
    const hits = src.split(from).length - 1;
    assert.equal(hits, 1, `mutation string is stale — matched ${hits} times, wanted 1: ${from}`);
    const file = path.join(tmp, `mutant-${mutant++}.swift`);
    fs.writeFileSync(file, src.split(from).join(to));
    return file;
  };
  const mustDie = (source, why) => {
    const out = source.replace(/\.swift$/, "");
    compile(source, out);          // it must still COMPILE, or nothing is proved
    assert.throws(() => execFileSync(out, [freshLedger()], { stdio: "pipe" }), why);
  };
  // Reinitialising answers for each line would make the last line per date win
  // and erase its sibling field.
  mustDie(mutate("var answers = out[date] ?? DayAnswers()", "var answers = DayAnswers()"),
    /Command failed/);
  // Half an answer counted as a whole one: the morning that got as far as
  // "rhythm" would never be asked for the rest.
  mustDie(mutate("rhythm != nil && progress != nil", "rhythm != nil || progress != nil"),
    /Command failed/);
});

test("the report prints both answers, and a pre-split score still shows as legacy", () => {
  // Both current two-field records and legacy one-field records must render;
  // legacy values stay labelled rather than masquerading as either new field.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perch-score-report-"));
  const events = path.join(dir, "agent-events");
  fs.mkdirSync(events);
  const event = (day, sec, name) => JSON.stringify({
    event: name, project: "/x/a", source: "claude",
    t: new Date(Date.UTC(2026, 7, day, 1, 0, sec)).toISOString(),
  });
  for (const [day, seconds] of [[1, 120], [11, 180], [12, 300]]) {
    fs.writeFileSync(path.join(events, `2026-08-${String(day).padStart(2, "0")}.jsonl`),
      [event(day, 0, "working"), event(day, seconds, "complete")].join("\n") + "\n");
  }
  fs.writeFileSync(path.join(dir, "day-scores.jsonl"), [
    CLI_SCORE_LINE,                                                   // 8-01: old score only
    '{"at":"2026-08-12T02:00:00Z","date":"2026-08-11","rhythm":4}',    // 8-11: half answered
    '{"at":"2026-08-12T20:00:00Z","date":"2026-08-12","rhythm":3}',
    '{"at":"2026-08-12T20:00:05Z","date":"2026-08-12","progress":2}',
  ].join("\n") + "\n");

  const run = (argv) => execFileSync("python3", ["-B", "-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("rep", ${JSON.stringify(pkgPath("island-day-report.py"))})
rep = importlib.util.module_from_spec(spec); spec.loader.exec_module(rep)
def no_app(*a, **k):
    raise SystemExit("no island installed")
rep._app_group = no_app
rep.events_dir = lambda: ${JSON.stringify(events)}
sys.argv = ["island-day-report.py"] + ${JSON.stringify(argv)}
rep.main()
`], { encoding: "utf8" });

  const summary = run(["--summary"]);
  const row = (day) => summary.split("\n").find((l) => l.trimStart().startsWith(day)) ?? "";
  assert.ok(row("2026-08-01").includes("2 ●●○○○"),
    `the pre-split score no longer prints the way it always did: ${row("2026-08-01")}`);
  assert.ok(row("2026-08-01").includes("legacy"),
    `the pre-split score is not labelled as one: ${row("2026-08-01")}`);
  assert.ok(row("2026-08-12").includes("r3·p2"),
    `the two answers are not in the table: ${row("2026-08-12")}`);
  assert.ok(!row("2026-08-12").includes("legacy"),
    "a day with two real answers must not be labelled legacy");
  assert.ok(row("2026-08-11").includes("r4·p—"),
    `a question you have not answered must read as missing, not as a zero: ${row("2026-08-11")}`);
  // r and p are not self-explanatory; the table has to say what they are.
  assert.ok(summary.includes("rhythm") && summary.includes("progress"),
    "the table uses r/p with no key to read them by");

  // The single-day report goes through the same formatter — one implementation,
  // or the two views of one ledger drift.
  assert.ok(run(["2026-08-01"]).includes("2 ●●○○○"), "the day report dropped the old score");
  assert.ok(run(["2026-08-12"]).includes("r3·p2"), "the day report dropped the two answers");
});
