// Arguing with the reading: a hand-set score, taking one back, and the ledger that has to
// survive both without ever quietly losing a day.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ISLAND_CARE_LEDGER_SWIFT, islandViews, viewModelSource, APP_GROUP_SWIFT, islandPath } = require("./island-paths");

test("a flow correction holds until the island changes its mind, and a spent one never revives", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-correct-"));
  const main = path.join(tmp, "main.swift");
  fs.writeFileSync(main, `
import Foundation

// ⓪ The wire format. Pinned here because it is a contract with whatever reads
//    the corrections file back, not an internal name that may be renamed.
precondition(FlowVerdict.inFlow.rawValue == "in_flow")
precondition(FlowVerdict.notInFlow.rawValue == "not_in_flow")

// ① No correction, no argument: the island's own verdict passes through.
precondition(FlowSense.resolve(auto: .inFlow, override: nil).verdict == .inFlow)
precondition(FlowSense.resolve(auto: .notInFlow, override: nil).verdict == .notInFlow)
precondition(FlowSense.resolve(auto: .inFlow, override: nil).override == nil)

// ② A hand correction outranks the machine's verdict, and STANDS until new
//    machine evidence arrives.
//    If the next tick overwrites it, the control springs back under the finger.
let saidOut = FlowSense.Override(said: .notInFlow, machineSaid: .inFlow)
let held = FlowSense.resolve(auto: .inFlow, override: saidOut)
precondition(held.verdict == .notInFlow, "while the island still says what it said, you win")
precondition(held.override == saidOut, "and the correction is still standing")

// ③ …but the moment the island changes its mind there is new evidence the
//    correction never spoke to, so it expires. This is the reason a correction
//    carries what the machine said rather than a timestamp.
let expired = FlowSense.resolve(auto: .notInFlow, override: saidOut)
precondition(expired.verdict == .notInFlow, "the island takes the wheel back")
precondition(expired.override == nil, "and the spent correction is dropped, not kept")

// ④ The symmetric half: a dim wave, corrected to "in flow after all".
let saidIn = FlowSense.Override(said: .inFlow, machineSaid: .notInFlow)
precondition(FlowSense.resolve(auto: .notInFlow, override: saidIn).verdict == .inFlow)
precondition(FlowSense.resolve(auto: .notInFlow, override: saidIn).override == saidIn)
precondition(FlowSense.resolve(auto: .inFlow, override: saidIn).verdict == .inFlow)
precondition(FlowSense.resolve(auto: .inFlow, override: saidIn).override == nil)

// ⑤ The island swings about and lands back on what it first said. The
//    correction expired on the first swing and must NOT come back to life.
//    This is the whole reason resolve hands the surviving correction BACK:
//    the caller keeps what it is given, exactly as the view model does.
var standing: FlowSense.Override? = saidOut
var kept: [FlowVerdict] = []
for auto: FlowVerdict in [.inFlow, .notInFlow, .inFlow, .inFlow, .notInFlow, .inFlow] {
    let step = FlowSense.resolve(auto: auto, override: standing)
    standing = step.override
    kept.append(step.verdict)
}
precondition(kept == [.notInFlow, .notInFlow, .inFlow, .inFlow, .notInFlow, .inFlow],
             "an expired correction reappeared when the island swung back: \\(kept)")
precondition(standing == nil, "a spent correction must stay spent")

// Control: holding the ORIGINAL correction forever — the bug where one
// forgotten flip quietly poisons every later reading — must answer
// DIFFERENTLY at exactly that step, or ⑤ is proving nothing at all.
let poisoned = ([.inFlow, .notInFlow, .inFlow] as [FlowVerdict])
    .map { FlowSense.resolve(auto: $0, override: saidOut).verdict }
precondition(poisoned[2] == .notInFlow, "control: a kept-forever correction is supposed to poison this step")
precondition(poisoned != Array(kept.prefix(3)), "control: the two ways of holding a correction must differ")
print("ok")
`);

  const compile = (sense, out) =>
    execFileSync("swiftc", [islandPath("FlowMath.swift"), sense, main, "-o", out], { stdio: "pipe" });
  const binary = path.join(tmp, "flow-correct-check");
  compile(islandPath("FlowSense.swift"), binary);
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "ok");

  // Mutation. ⚠️ Prove the ammunition was loaded — a replacement string that
  // matches nothing mutates nothing, and the "red" never comes.
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
  // ① The correction never expires: ③ and ⑤ both die.
  mustDie(mutate("guard auto == override.machineSaid else", "guard true else"),
    "a correction must not outlive the verdict it was filed against");
  // ② The correction is spent on the spot: ② dies — the wave springs back.
  mustDie(mutate("return (override.said, override)", "return (auto, override)"),
    "a correction must survive the samples that follow it");
  // ③ A spent correction handed back instead of dropped: ⑤ dies, because it
  //    then revives the moment the island swings back to its first answer.
  mustDie(mutate("else { return (auto, nil) }   // the ground moved; the correction is spent",
                 "else { return (auto, override) }"),
    "a spent correction must be dropped, not handed back to be revived later");

  // The view model is the caller that makes ⑤ true: it has to STORE what
  // resolve hands back. Keeping its own copy instead is the same forever-bug
  // wearing a pure function as a disguise.
  const vm = viewModelSource();
  assert.match(vm, /FlowSense\.resolve\(auto: auto, override: flowOverride\)[\s\S]{0,240}flowOverride = surviving/,
    "the view model must keep the correction resolve hands back, or a spent one lives forever");
  // A correction is filed against WHAT THE ISLAND SAID, never against what the
  // wave happened to be showing — without that pairing it can never expire.
  assert.match(vm, /FlowSense\.Override\(said: said, machineSaid: flowAuto\)/,
    "the correction must record the island's own verdict, not the corrected one");
  const correct = vm.match(/func correctFlow\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(correct, "IslandViewModel has no correctFlow()");
  assert.match(correct, /FlowCorrectionLog\.append\(/, "the correction is never written down");
  // Writing it down is an observer, not a gate: a disk that will not take the
  // line must not decide whether the wave answers at all.
  assert.doesNotMatch(correct, /(if|guard)[^\n]*FlowCorrectionLog/,
    "a failed write must not decide whether the correction takes effect");

  // The wave IS the button. Bars are 2.4pt wide with 3.6pt gaps, so without a
  // hit shape most presses land in a gap and nothing happens.
  const view = islandViews();
  const strip = view.match(/struct AgentActivityStrip: View \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(strip, "AgentActivityStrip not found");
  assert.match(strip, /let onTap: \(\) -> Void/, "the wave has no way to report a press");
  assert.match(strip, /\.contentShape\(Rectangle\(\)\)[\s\S]{0,240}\.onTapGesture/,
    "the wave needs a hit area, or a press between two bars counts for nothing");
  assert.match(view, /AgentActivityStrip\([\s\S]{0,240}viewModel\.correctFlow\(\)/,
    "the card never wires the wave's press to the correction");
  // The wave's look is not this change's business: brightness and pace still
  // come from FlowSense alone, and the height seed and colour are untouched.
  assert.match(strip, /FlowSense\.opacity\(for:/);
  assert.match(strip, /flow\.waveClock\(at: context\.date\) \* tempo/);

  // Nothing a person reads on the island is in Chinese. Control group first —
  // a scan that finds nothing proves nothing until it has been shown to find
  // something.
  // Escaped, not literal: two of the six range ends are an ideographic
  // space and unassigned code points, so spelled out they look like damage.
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const literals = (swift) =>
    swift.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const planted = literals('        .help("按一下")\n');
  assert.equal(planted.length, 1, "control: the literal scanner sees no string at all");
  assert.ok(CJK.test(planted[0]), "control: the scanner cannot tell Chinese from anything else");
  assert.equal(literals("// 只有注释\nlet x = 1\n").length, 0,
    "control: the scanner reads the comments it is supposed to skip");
  for (const s of literals(strip)) assert.ok(!CJK.test(s), `the wave shows Chinese: ${s}`);
});

test("a flow correction lands as one line, and a write that fails never reaches the island", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-corrections-"));
  const stub = path.join(tmp, "stub.swift");
  const main = path.join(tmp, "main.swift");
  // AppGroup pulls in the app bundle; it is not on the path under test, which
  // always writes into a directory the caller names. Same stub shape as the
  // day-score test next door.
  fs.writeFileSync(stub, `
import Foundation
enum AppGroup { static var containerURL: URL { URL(fileURLWithPath: NSTemporaryDirectory()) } }
`);
  fs.writeFileSync(main, `
import Foundation

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let t0 = Date(timeIntervalSince1970: 1_770_000_000)
let file = FlowCorrectionLog.file(for: t0, in: dir)
func body() -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }

// ⑦ The directory does not exist yet. The very first correction ever filed is
//    exactly the one that would be dropped if nobody created it.
precondition(!FileManager.default.fileExists(atPath: dir.path),
             "the test handed over a directory that already exists — nothing is proved")
precondition(FlowCorrectionLog.write(said: .notInFlow, machine: .inFlow, at: t0, into: dir))
precondition(FileManager.default.fileExists(atPath: dir.path), "the corrections directory was not created")

// ⑥ One correction, one line, appended — never rewriting what is already there.
precondition(FlowCorrectionLog.write(said: .inFlow, machine: .inFlow, at: t0.addingTimeInterval(60), into: dir))
precondition(body().split(separator: "\\n").count == 2,
             "two corrections must be two lines, got \\(body().split(separator: "\\n").count)")
precondition(body().hasSuffix("\\n"),
             "a line left without its newline glues the next correction onto itself")

// ⑧ A half-written line — a crash mid-append, a disk that filled up. It must
//    damage itself and NOTHING BEFORE IT. Everything after it goes on landing.
if let handle = try? FileHandle(forWritingTo: file) {
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: Data(#"{"machineSaid":"in_flow","said":"not_i"#.utf8))
    try? handle.close()
}
precondition(FlowCorrectionLog.write(said: .inFlow, machine: .notInFlow, at: t0.addingTimeInterval(120), into: dir))
precondition(FlowCorrectionLog.write(said: .notInFlow, machine: .notInFlow, at: t0.addingTimeInterval(180), into: dir))

// ⑨ Nowhere to write it. ⚠️ The assertion is that this program REACHES the
//    line below: a correction the island cannot record must not throw, must
//    not crash, and must not stop the island doing its actual job.
let nowhere = URL(fileURLWithPath: "/dev/null/perch-flow-corrections")
precondition(FlowCorrectionLog.write(said: .inFlow, machine: .notInFlow, at: t0, into: nowhere) == false,
             "a write that cannot happen must say so")
precondition(!FileManager.default.fileExists(atPath: nowhere.path))
print("still here")
`);

  const compile = (log, out) =>
    execFileSync("swiftc",
      [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"), log, stub, main, "-o", out],
      { stdio: "pipe" });
  const binary = path.join(tmp, "flow-corrections-check");
  compile(islandPath("FlowCorrectionLog.swift"), binary);

  const dir = path.join(tmp, "flow-corrections");
  assert.equal(fs.existsSync(dir), false, "control: the directory must not exist before the run");
  assert.equal(execFileSync(binary, [dir], { encoding: "utf8" }).trim(), "still here");

  // One file per day, named after the day.
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `one day, one file — found ${files.join(", ")}`);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/, `not a day file: ${files[0]}`);

  const rows = fs.readFileSync(path.join(dir, files[0]), "utf8").split("\n").filter((l) => l.length);
  assert.equal(rows.length, 4, "four appends and one tear must leave four lines");
  const parsed = rows.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const good = parsed.filter(Boolean);
  // Control first: the torn line must really be unreadable, or "the reader
  // skipped it" is a claim about nothing.
  assert.equal(parsed.length - good.length, 1, "the torn line parsed fine — the tear was not a tear");
  assert.equal(good.length, 3, "a torn line swallowed a record that was already safely on disk");

  for (const r of good) {
    assert.deepEqual(Object.keys(r).sort(), ["machineSaid", "said", "t"], `wrong fields: ${JSON.stringify(r)}`);
    assert.ok(["in_flow", "not_in_flow"].includes(r.said), `bad verdict: ${r.said}`);
    assert.ok(["in_flow", "not_in_flow"].includes(r.machineSaid), `bad verdict: ${r.machineSaid}`);
    assert.ok(!Number.isNaN(Date.parse(r.t)), `unreadable timestamp: ${r.t}`);
  }
  // The fixture must cover both directions, or a writer hardwired to one
  // answer sails through every line above.
  assert.ok(good.some((r) => r.said === "in_flow") && good.some((r) => r.said === "not_in_flow"),
    "control: the case list must contain both things you can say");
  // The two that were on disk BEFORE the tear are intact and in order…
  assert.deepEqual([good[0].said, good[0].machineSaid], ["not_in_flow", "in_flow"]);
  assert.deepEqual([good[1].said, good[1].machineSaid], ["in_flow", "in_flow"]);
  assert.equal(Date.parse(good[1].t) - Date.parse(good[0].t), 60_000, "the timestamps are not the ones written");
  // …and the append AFTER the tear lands clean on a line of its own.
  assert.deepEqual([good[2].said, good[2].machineSaid], ["not_in_flow", "not_in_flow"]);

  // ⚠️ The original verdict is never rewritten — tuning the three provisional
  // numbers means laying what the island said beside what it was told, and that
  // comparison dies the moment the two share a file.
  const flowLog = fs.readFileSync(islandPath("FlowCorrectionLog.swift"), "utf8");
  assert.match(flowLog, /appendingPathComponent\("flow-corrections"\)/, "corrections need their own directory");
  // Comments stripped first: the docstring explains these very separations by
  // naming them, and an assertion that reads prose goes red on its own
  // explanation. (Same shape as the UserDefaults.standard note next door.)
  const flowCode = flowLog.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  // ⚠️ `TodaySummary` came off this list when the desktop widget went: it was
  // that widget's summary writer and the third reader of the event log, and an
  // alternative that can never match again is an assertion with no subject. The
  // rule is unchanged: the corrections writer may not touch the observations.
  assert.doesNotMatch(flowCode, /agent-events|AgentEventLog/,
    "the corrections writer must not be able to touch the observations");

  // Mutation, with the same loaded-ammunition check as above.
  let mutant = 0;
  const mutate = (from, to) => {
    const hits = flowLog.split(from).length - 1;
    assert.equal(hits, 1, `mutation string is stale — matched ${hits} times, wanted 1: ${from}`);
    const file = path.join(tmp, `mutant-${mutant++}.swift`);
    fs.writeFileSync(file, flowLog.split(from).join(to));
    return file;
  };
  const mustDie = (source, why) => {
    const out = source.replace(/\.swift$/, "");
    compile(source, out);          // it must still COMPILE, or nothing is proved
    assert.throws(() => execFileSync(out, [path.join(tmp, `out-${path.basename(out)}`)], { stdio: "pipe" }),
      /Command failed/, why);
  };
  // ① Nobody creates the directory: the first ever correction vanishes.
  mustDie(mutate("try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)",
                 "_ = directory"),
    "the corrections directory must be created rather than assumed");
  // ② The newline dropped: two corrections share a line and neither parses.
  mustDie(mutate("data.append(0x0A)", "_ = 0x0A"),
    "every correction must end its own line");
  // ③ A failed write reported as a success: the island would then believe a
  //    correction is on disk that never got there.
  mustDie(mutate("return (try? data.write(to: url)) != nil",
                 "_ = try? data.write(to: url); return true"),
    "a write that failed must not report success");
});

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

test("an unparsable ledger must throw, never wipe history as an empty ledger", () => {
  // This one RUNS REAL CODE, no grepping: recording goes "load → append one →
  // write back whole", and "does an unreadable file get wiped?" only counts
  // when actually executed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-ledger-corrupt-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "ledger-corrupt-check");
  const ledgerPath = path.join(tmp, "care-ledger.json");

  fs.writeFileSync(main, `
import Foundation

let ledgerURL = URL(fileURLWithPath: "${ledgerPath}")

// 1. File absent = empty ledger. Normal state (no sessions yet), not an error.
let fresh = try! CareLedgerStore.load(from: ledgerURL)
precondition(fresh.records.isEmpty)
precondition(fresh.version == 1)

// 2. Two valid records
let r1 = CareRecord(date: "2026-07-28", moveId: "neck-rolls", category: .neck, sets: 1, seconds: 40, source: "island", at: "2026-07-28T09:00:00+00:00")
let r2 = CareRecord(date: "2026-07-28", moveId: "eyes-blink", category: .eyes, sets: 1, seconds: 20, source: "island", at: "2026-07-28T10:00:00+00:00")
_ = try! CareLedgerStore.append(r1, to: ledgerURL)
let two = try! CareLedgerStore.append(r2, to: ledgerURL)
precondition(two.records.count == 2)

// 3. Corrupt the ledger — the whole point of this test
let corrupt = "{ this is not a ledger"
try! Data(corrupt.utf8).write(to: ledgerURL)

// 3a. load must throw. Quietly returning empty makes the next recording treat it as "never existed".
var loadThrew = false
do { _ = try CareLedgerStore.load(from: ledgerURL) } catch { loadThrew = true }
precondition(loadThrew, "unparsable must throw, never return an empty ledger")

// 3b. append must throw, and the broken file must keep every byte
var appendThrew = false
do { _ = try CareLedgerStore.append(r1, to: ledgerURL) } catch { appendThrew = true }
precondition(appendThrew, "unreadable means no writing past it")
let after = try! String(contentsOf: ledgerURL, encoding: .utf8)
precondition(after == corrupt, "the broken file must stay untouched — overwriting it means losing the history")
`);

  execFileSync("swiftc", [ISLAND_CARE_LEDGER_SWIFT, APP_GROUP_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });
});

test("a correction discards the snapshot it argues with, not the week it does not", () => {
  // Two different reasons to throw a landing read away, and only one of them
  // makes its seven days stale:
  //   · a newer read owns the week now — its days really are older, drop them;
  //   · someone pressed a day while this read walked — its CORRECTIONS
  //     snapshot predates the press, but no press changes a measurement.
  // Separate counters keep a correction from invalidating the seven measured days.
  const week = fs.readFileSync(islandPath("IslandViewModel+Week.swift"), "utf8");
  const vm = viewModelSource();

  // Control: both counters must exist and be distinct, or every assertion
  // below is describing the same variable twice.
  assert.match(vm, /var weekGeneration = 0/, "control: the read counter is gone");
  assert.match(vm, /var correctionGeneration = 0/, "the correction counter is gone — one counter is back");

  // A press bumps the corrections counter and nothing else.
  const correct = week.match(/func correctDay\([\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(correct, "correctDay not found");
  assert.match(correct, /correctionGeneration &\+= 1/, "a press no longer invalidates the snapshot it argues with");
  assert.doesNotMatch(correct, /weekGeneration &\+= 1/,
    "a press invalidates the whole read again — the other six days go with it");

  // The publish takes the two guards in order, and the days land between them.
  const publish = week.match(/await MainActor\.run \{[\s\S]*?\n            \}/)?.[0] ?? "";
  assert.ok(publish, "the publish block not found");
  const iDays = publish.indexOf("self.week = read.days");
  const iReadGuard = publish.indexOf("self.weekGeneration == generation");
  const iCorrGuard = publish.indexOf("self.correctionGeneration == correctionsAt");
  const iCorr = publish.indexOf("self.weekCorrections = read.corrections");
  assert.ok(iReadGuard >= 0 && iDays >= 0 && iCorrGuard >= 0 && iCorr >= 0,
    "the publish block lost one of its four moving parts");
  assert.ok(iReadGuard < iDays,
    "the days publish before the newer-read check — stale over fresh is back");
  assert.ok(iDays < iCorrGuard,
    "the days are behind the corrections guard again, so a press still drops them");
  assert.ok(iCorrGuard < iCorr,
    "the corrections publish unguarded — a snapshot older than the press wins");

  // The read has to capture the corrections counter at START, or comparing it
  // at landing time compares a value with itself.
  assert.match(week, /let correctionsAt = correctionGeneration/,
    "the corrections counter is not sampled when the read starts");
});

test("a correction can be taken back, and only a line that names the field takes it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-day-score-clear-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "run");
  fs.writeFileSync(main, `
import Foundation
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let file = dir.appendingPathComponent("day-scores.jsonl")
func put(_ lines: [String]) {
    try! (lines.joined(separator: "\\n") + "\\n").write(to: file, atomically: true, encoding: .utf8)
}
func look() -> [String: Any] {
    let a = DayScore.scores(from: file)["2026-08-24"]
    return ["flow": a?.flow as Any? ?? NSNull(), "rhythm": a?.rhythm as Any? ?? NSNull()]
}
var out: [String: Any] = [:]
put([#"{"date":"2026-08-24","flow":4}"#, #"{"date":"2026-08-24","rhythm":2}"#])
out["said"] = look()
put([#"{"date":"2026-08-24","flow":4}"#, #"{"date":"2026-08-24","rhythm":2}"#,
     #"{"date":"2026-08-24","rhythm":3}"#])
out["otherFieldOnly"] = look()
out["cleared"] = DayScore.clear(date: "2026-08-24", field: .flow, to: file)
out["afterClear"] = look()
out["clearRhythmRefused"] = DayScore.clear(date: "2026-08-24", field: .rhythm, to: file)
// A rule kept at one end of a file is not a rule: the reader has to refuse the
// same line the writer refuses to produce.
put([#"{"date":"2026-08-24","rhythm":4,"progress":3}"#,
     #"{"date":"2026-08-24","rhythm":null,"progress":null}"#])
let held = DayScore.scores(from: file)["2026-08-24"]
out["nulledByHand"] = ["rhythm": held?.rhythm as Any? ?? NSNull(),
                       "progress": held?.progress as Any? ?? NSNull()]
put([#"{"date":"2026-08-24","flow":4}"#, #"{"date":"2026-08-24","flow":null}"#])
out["flowNulledByHand"] = DayScore.scores(from: file)["2026-08-24"]?.flow as Any? ?? NSNull()
out["arguedAgain"] = DayScore.record(date: "2026-08-24", field: .flow, value: 5, to: file)
out["afterArguingAgain"] = look()
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`);
  execFileSync("swiftc", [islandPath("DayScore.swift"), APP_GROUP_SWIFT, main, "-o", binary],
    { stdio: "pipe" });
  const r = JSON.parse(execFileSync(binary, [tmp], { encoding: "utf8" }));

  assert.deepEqual(r.said, { flow: 4, rhythm: 2 }, "control: the fixture was not read back as written");
  assert.deepEqual(r.otherFieldOnly, { flow: 4, rhythm: 3 },
    "a line answering another question wiped flow — absent is being read as empty");

  assert.equal(r.cleared, true, "clearing a flow correction was refused");
  assert.equal(r.afterClear.flow, null, "the correction survived being taken back");
  assert.equal(r.afterClear.rhythm, 3, "taking back flow took another field's answer with it");

  assert.equal(r.clearRhythmRefused, false, "a question with no other answer was allowed to be emptied");
  // …and the reader must refuse it too. A hand-written or future `rhythm: null`
  // would otherwise erase an answer nothing else in the world can supply.
  assert.deepEqual(r.nulledByHand, { rhythm: 4, progress: 3 },
    "an explicit null erased an answer the writer is forbidden to erase");
  // Control: the field that IS allowed to be taken back still is, or the rule
  // above would pass by refusing everything.
  assert.equal(r.flowNulledByHand, null, "control: flow can no longer be taken back either");

  assert.equal(r.arguedAgain, true, "a day could not be argued with again after being cleared");
  assert.equal(r.afterArguingAgain.flow, 5, "the day would not take a new correction after a clear");
});
