// What the island DOES while it runs: source health, the care ledger and session clock,
// the socket it listens on, the status it keeps, and the sweeps that age it.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ISLAND_CARE_LEDGER_SWIFT, ISLAND_CATALOG, islandViews, viewModelSource, SOURCE_HEALTH_SWIFT, APP_GROUP_SWIFT, CARE_MOVE_POOL_SWIFT, CARE_SESSION_CLOCK_SWIFT, CARE_SESSION_RECORDER_SWIFT, islandPath, pkgPath } = require("./island-paths");

test("source health remains validated and atomically published for background diagnostics", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-source-health-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "source-health-check");
  const source = islandPath("SourceHealth.swift");

  fs.writeFileSync(main, `
import Foundation

let recoveredJSON = #"""
{
  "schema_version": 1,
  "generated_at": "2026-08-13T00:00:00.000Z",
  "sources": {
    "claude": {"status":"healthy","freshness_status":"current","native_turns":3},
    "codex": {"status":"recovered_with_gap","freshness_status":"current","native_turns":5}
  },
  "alerts": [
    {"source":"codex","kind":"coverage_gap_recovered","count":2,"first_at":"2026-08-12T10:00:00.000Z","last_at":"2026-08-12T11:00:00.000Z"}
  ]
}
"""#
let snapshot = try! SourceHealthSnapshot.decode(Data(recoveredJSON.utf8))
precondition(snapshot.schemaVersion == 1)
precondition(snapshot.sources["codex"]?.status == "recovered_with_gap")
precondition(snapshot.sources["claude"]?.nativeTurns == 3)
precondition(snapshot.alerts.count == 1)
precondition(snapshot.alerts[0].source == "codex")

do {
  _ = try SourceHealthSnapshot.decode(Data("not-json".utf8))
  preconditionFailure("malformed health must not decode as healthy")
} catch {}

let publishDirectory = URL(fileURLWithPath: ${JSON.stringify(tmp)})
  .appendingPathComponent("published", isDirectory: true)
let canonical = Data("{\\\"record_id\\\":\\\"a\\\",\\\"reconstructed\\\":true}\\n".utf8)
try! SourceHealthStore.publish(
  health: Data(recoveredJSON.utf8), canonical: canonical, directory: publishDirectory)
precondition(try! Data(contentsOf: publishDirectory.appendingPathComponent("source-health.json")) == Data(recoveredJSON.utf8))
precondition(try! Data(contentsOf: publishDirectory.appendingPathComponent("canonical-turns.jsonl")) == canonical)
`);

  execFileSync("swiftc", [source, APP_GROUP_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });
});

test("health stays out of the visual layer while background publication remains available", () => {
  const view = islandViews();
  const viewModel = viewModelSource();
  const health = fs.readFileSync(SOURCE_HEALTH_SWIFT, "utf8");

  assert.doesNotMatch(view, /sourceHealth|healthWarning|healthCritical|Perch history warning|feed missing|feed lagging|history rebuilt|History check/);
  assert.doesNotMatch(viewModel, /sourceHealth|startSourceHealthMonitoring|refreshSourceHealth/);
  assert.doesNotMatch(health, /SourceHealthNotice|SourceHealthSeverity|func notices|feed missing|feed lagging|history rebuilt|History check/);
  assert.match(health, /static func publish\(/, "background publication must survive the visual removal");
  assert.match(health, /SourceHealthSnapshot\.decode\(health\)/, "published health must still be schema-validated");
});

// The island's (Perch's) own tests. The island must be liftable as a whole,
// so the tests travel with it.
//
// ⚠️ Two tests deliberately stay behind upstream: they assert that code
// outside this package keeps its hands off the island — moved into Perch they
// would be meaningless (what they guard against does not exist here), and
// only upstream do they work as the reverse guard.
//
// ⚠️ Every python subprocess below runs with `-B`, and that flag is load
// bearing: without it the interpreter drops `__pycache__/*.pyc` next to the
// scripts, and a .pyc embeds the absolute path of its source. Running the
// tests would then plant a home-directory path inside the very package these
// tests exist to keep clean — and the privacy guard would not see it, because
// those files are born after the scan.

// The island's (Perch's) own tests. The island must be liftable as a whole,
// so the tests travel with it.
//
// ⚠️ Two tests deliberately stay behind upstream: they assert that code
// outside this package keeps its hands off the island — moved into Perch they
// would be meaningless (what they guard against does not exist here), and
// only upstream do they work as the reverse guard.
//
// ⚠️ Every python subprocess below runs with `-B`, and that flag is load
// bearing: without it the interpreter drops `__pycache__/*.pyc` next to the
// scripts, and a .pyc embeds the absolute path of its source. Running the
// tests would then plant a home-directory path inside the very package these
// tests exist to keep clean — and the privacy guard would not see it, because
// those files are born after the scan.

test("care ledger model round-trips records and locks the wire format", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-care-ledger-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "care-ledger-check");

  fs.writeFileSync(main, `
import Foundation

// 1. category enum covers exactly the four care categories, and rejects anything else
precondition(CareCategory.allCases.map { $0.rawValue }.sorted() == ["eyes", "face", "neck", "shoulders"])
precondition(CareCategory(rawValue: "back") == nil)

// 2. append is order-preserving and starts from an empty version-1 ledger
var ledger = CareLedger.empty
precondition(ledger.version == 1)
precondition(ledger.records.isEmpty)
let r1 = CareRecord(date: "2026-07-06", moveId: "neck-rolls", category: .neck, sets: 2, seconds: 50, source: "island", at: "2026-07-06T14:32:05Z")
let r2 = CareRecord(date: "2026-07-06", moveId: "eyes-202020", category: .eyes, sets: 1, seconds: 20, source: "island", at: "2026-07-06T14:40:00Z")
ledger.append(r1)
ledger.append(r2)
precondition(ledger.records.count == 2)
precondition(ledger.records[0].moveId == "neck-rolls")
precondition(ledger.records[1].moveId == "eyes-202020")

// 3. Codable round-trip is lossless
let data = try! JSONEncoder().encode(ledger)
let decoded = try! JSONDecoder().decode(CareLedger.self, from: data)
precondition(decoded == ledger)

// 4. wire format uses the exact keys + string-encoded category from the spec
let recordData = try! JSONEncoder().encode(r1)
let json = String(data: recordData, encoding: .utf8)!
for key in ["\\"date\\"", "\\"moveId\\"", "\\"category\\"", "\\"sets\\"", "\\"seconds\\"", "\\"source\\"", "\\"at\\""] {
    precondition(json.contains(key), "missing key \\(key) in \\(json)")
}
precondition(json.contains("\\"neck\\""))  // category encodes as its raw string, never a number
`);

  execFileSync("swiftc", [ISLAND_CARE_LEDGER_SWIFT, APP_GROUP_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });
});

test("a restarted island reads its own log back instead of starting blind", () => {
  // The flow verdict needs at least five pickups before it says anything.
  // A restart must seed recent events from disk, or too few samples read as a
  // confident "not in flow".
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-event-replay-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "event-replay-check");
  const logs = path.join(tmp, "logs");
  fs.mkdirSync(logs);
  // Fixtures use the local-offset shape `append` writes, with the offset read
  // from THIS machine.
  // `recent` names its day files in local time; a hardcoded offset lands the
  // stamps on a different day than their filenames.
  const at = (local) => {
    const mins = -new Date(local).getTimezoneOffset();
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    return `${local}${mins < 0 ? "-" : "+"}${pad(mins / 60)}:${pad(Math.abs(mins) % 60)}`;
  };
  const row = (t, event) =>
    JSON.stringify({ event, project: "/work/a", source: "claude", t });
  // A local 22:30→00:30 window straddles midnight and two day files.
  fs.writeFileSync(path.join(logs, "2026-08-15.jsonl"), [
    row(at("2026-08-15T20:00:00"), "working"),   // BEFORE the window
    row(at("2026-08-15T23:00:00"), "working"),   // in
    row(at("2026-08-15T23:10:00"), "complete"),  // in
    "{ this line is not json",                     // a half-written tail must not be fatal
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(logs, "2026-08-16.jsonl"), [
    row(at("2026-08-16T00:05:00"), "working"),   // in — the far side of midnight
    row(at("2026-08-16T02:00:00"), "working"),   // AFTER `now`
  ].join("\n") + "\n");

  fs.writeFileSync(main, `
import Foundation

let f = ISO8601DateFormatter()
f.formatOptions = [.withInternetDateTime]
let now = f.date(from: "${at("2026-08-16T00:30:00")}")!
let since = now.addingTimeInterval(-FlowMath.maxTurn)
let dir = URL(fileURLWithPath: "${logs}")

let got = AgentEventLog.recent(since: since, now: now, from: dir)
precondition(got.count == 3, "expected the 3 in-window rows, got \\(got.count)")
// Across the day boundary the result stays ordered by event time, never by
// whatever order the filesystem enumerated the files in.
precondition(got.map(\\.event) == ["working", "complete", "working"],
             "out of order or wrong rows: \\(got.map(\\.event))")
precondition(got[0].time < got[1].time && got[1].time < got[2].time, "not sorted by time")
precondition(got[2].time > f.date(from: "${at("2026-08-16T00:00:00")}")!,
             "the row past midnight was dropped — the second day file was never read")
precondition(got.allSatisfy { $0.project == "/work/a" && $0.source == "claude" },
             "the reader mangled a field")

// A missing log directory means there are no recent events, never a crash.
let empty = AgentEventLog.recent(since: since, now: now,
                                 from: URL(fileURLWithPath: "${logs}/nope"))
precondition(empty.isEmpty, "a missing log should read as no events")

// A wider window must read MORE events, proving the three above came from
// filtering and not from a broken reader.
let wide = AgentEventLog.recent(since: f.date(from: "${at("2026-08-15T00:00:00")}")!,
                                now: f.date(from: "${at("2026-08-17T00:00:00")}")!,
                                from: dir)
precondition(wide.count == 5, "control: a wide window should see all 5 good rows, got \\(wide.count)")
`);

  execFileSync("swiftc", [islandPath("AgentEventLog.swift"), islandPath("FlowMath.swift"),
                          APP_GROUP_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });

  // ⚠️ Order is correctness: seeding must happen BEFORE the monitor opens, or
  //    an event can land in memory and be read back out of the log at once, and
  //    one turn gets counted twice.
  const vm = viewModelSource();
  const seed = vm.indexOf("seedFlowFromLog()");
  const listen = vm.indexOf("startAgentMonitoring()");
  assert.ok(seed >= 0, "IslandViewModel no longer seeds the verdict from the log");
  assert.ok(listen >= 0, "control: startAgentMonitoring() should still be called from init");
  assert.ok(seed < listen,
    "the monitor opens before the log is replayed — turns will be counted twice");
  assert.match(vm, /AgentEventLog\.recent\(since: now\.addingTimeInterval\(-FlowMath\.maxTurn\)/,
    "the seed window drifted off the one noteForFlow prunes to");

  // The source comment must describe log replay; saying the log is never
  // reloaded would contradict the runtime behaviour guarded above.
  assert.ok(!/Kept in memory rather than reloaded from the log/.test(vm),
    "the comment still says the log is never reloaded, and it is");
});

test("care move pool and session recorder lock the island content + ledger rules", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-care-session-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "care-session-check");

  fs.writeFileSync(main, `
import Foundation

// Content contract: 5 moves, 13 frames, two selectable categories.
precondition(CareMovePool.all.count == 5)
precondition(CareMovePool.all[0].id == "chin-tuck")
precondition(CareMovePool.all.filter { $0.category == .neck }.count == 4)
precondition(CareMovePool.all.filter { $0.category == .eyes }.count == 1)
precondition(Set(CareMovePool.all.map { $0.id }).count == 5)
precondition(CareMovePool.all.flatMap { $0.frames }.count == 13)
precondition(CareMovePool.selectableCategories == [.neck, .eyes])

// Third element = whether it is a pass-through frame: pass-throughs get a fixed 1s, holds split the rest (long-quick-long)
let expected: [(String, CareCategory, Int, Int, [(String, String, Bool)])] = [
    ("chin-tuck", .neck, 8, 34, [
        ("CareMoveChinTuckAlign", "align", false),
        ("CareMoveChinTuckStart", "start", false)
    ]),
    ("neck-side-stretch", .neck, 2, 40, [
        ("CareMoveSideNeckTiltLeft", "tilt left", false),
        ("CareMoveSideNeckUpright", "upright", true),
        ("CareMoveSideNeckTiltRight", "tilt right", false)
    ]),
    ("levator-stretch", .neck, 2, 40, [
        ("CareMoveLevatorDown", "look down", false),
        ("CareMoveLevatorCenter", "center", true),
        ("CareMoveLevatorOther", "other side", false)
    ]),
    ("trap-massage", .neck, 1, 30, [
        ("CareMoveTrapLeft", "left", false),
        ("CareMoveTrapRight", "right", false)
    ]),
    ("eye-orbital-massage", .eyes, 8, 40, [
        ("CareMoveEyeOrbitalInner", "inner", false),
        ("CareMoveEyeOrbitalTemple", "temple", false),
        ("CareMoveEyeOrbitalUnder", "under", false)
    ])
]

for (move, contract) in zip(CareMovePool.all, expected) {
    precondition(move.id == contract.0)
    precondition(move.category == contract.1)
    precondition(move.reps == contract.2)
    precondition(move.seconds == contract.3)
    precondition(move.targetReps == "x\\(contract.2)")
    precondition(move.frames.map { ($0.assetName, $0.label, $0.isPassThrough) }.elementsEqual(contract.4, by: {
        $0.0 == $1.0 && $0.1 == $1.1 && $0.2 == $1.2
    }))
    for index in move.frames.indices {
        precondition((0.8...30.0).contains(move.frameDuration(at: index)))
    }
    precondition(Set(move.frames.map { $0.assetName }).count == move.frames.count)
}

precondition(CareMovePool.first(in: .neck).id == "chin-tuck")
precondition(CareMovePool.first(in: .eyes).id == "eye-orbital-massage")
precondition(CareMovePool.next(in: .neck, after: "chin-tuck").id == "neck-side-stretch")
precondition(CareMovePool.next(in: .neck, after: "trap-massage").id == "chin-tuck")
precondition(CareMovePool.next(in: .eyes, after: "eye-orbital-massage").id == "eye-orbital-massage")

// Recording rule: whole sets count as sets
let cal = Calendar(identifier: .gregorian)
var comps = DateComponents()
comps.year = 2026; comps.month = 7; comps.day = 7; comps.hour = 14; comps.minute = 32; comps.second = 5
let fixed = cal.date(from: comps)!
let move = CareMovePool.all[0]  // chin-tuck / neck
let rec = CareSessionRecorder.makeRecord(move: move, setsCompleted: 2, elapsedSeconds: 50, at: fixed, calendar: cal)
precondition(rec.moveId == "chin-tuck")
precondition(rec.category == .neck)
precondition(rec.sets == 2)
precondition(rec.seconds == 50)
precondition(rec.source == "island")
precondition(rec.date == "2026-07-07")
precondition(!rec.at.isEmpty)

// Partial sets never round up: 0 sets -> sets=0, only seconds recorded
let partial = CareSessionRecorder.makeRecord(move: move, setsCompleted: 0, elapsedSeconds: 18, at: fixed, calendar: cal)
precondition(partial.sets == 0)
precondition(partial.seconds == 18)
`);

  execFileSync("swiftc", [ISLAND_CARE_LEDGER_SWIFT, APP_GROUP_SWIFT, CARE_MOVE_POOL_SWIFT, CARE_SESSION_RECORDER_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });
});

test("island view model writes care records through the shared store", () => {
  const vm = viewModelSource();
  assert.match(vm, /CareLedgerStore\.append/);
  assert.match(vm, /CareSessionRecorder\.makeRecord/);

  const view = islandViews();
  assert.doesNotMatch(view, /care card coming soon/);
});

test("care session clock derives frames and reps from monotonic elapsed time", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-care-clock-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "care-clock-check");

  fs.writeFileSync(main, `
import Foundation

func check(_ position: CareSessionPosition, elapsed: Double, frame: Int, reps: Int, complete: Bool) {
    precondition(abs(position.elapsed - elapsed) < 0.000_001)
    precondition(position.currentFrameIndex == frame)
    precondition(position.completedReps == reps)
    precondition(position.isComplete == complete)
}

let chin = CareMovePool.first(in: .neck)
var clock = CareSessionClock()
clock.start(at: 100)
// chin tuck: 8 reps / 34s, two-frame tick-tock, one cycle 4.25s = tuck 2.13s -> neutral 2.13s
check(clock.position(for: chin, at: 100), elapsed: 0, frame: 0, reps: 0, complete: false)
check(clock.position(for: chin, at: 102), elapsed: 2, frame: 0, reps: 0, complete: false)
check(clock.position(for: chin, at: 103), elapsed: 3, frame: 1, reps: 0, complete: false)
check(clock.position(for: chin, at: 106.5), elapsed: 6.5, frame: 1, reps: 1, complete: false)
check(clock.position(for: chin, at: 140), elapsed: 40, frame: 0, reps: 8, complete: true)

let trap = CareMovePool.all.first { $0.id == "trap-massage" }!
// trap: 1 rep / 30s, two-frame tick-tock (a massage has no center station), left 15s -> right 15s in one go
check(clock.position(for: trap, at: 103), elapsed: 3, frame: 0, reps: 0, complete: false)
let eyes = CareMovePool.first(in: .eyes)
// eyes: 8 reps / 40s, three acupoints in equal beats around the eye socket, one cycle 5s = 1.67s per point
check(clock.position(for: eyes, at: 112), elapsed: 12, frame: 1, reps: 2, complete: false)
check(clock.position(for: eyes, at: 120), elapsed: 20, frame: 0, reps: 4, complete: false)

// Path: swing out and back — the middle frame is visited again on the return leg
precondition(CareMovePool.all.first { $0.id == "levator-stretch" }!.playbackSequence == [0, 1, 2, 1])
precondition(CareMovePool.all.first { $0.id == "trap-massage" }!.playbackSequence == [0, 1])   // a massage has no center station
precondition(CareMovePool.all.first { $0.id == "neck-side-stretch" }!.playbackSequence == [0, 1, 2, 1])
precondition(chin.playbackSequence == [0, 1])             // two-frame tick-tock: tuck <-> neutral
precondition(eyes.playbackSequence == [0, 1, 2])           // three acupoints around the eye socket

// Pass-through frames take the short beat: a cycle goes long-quick-long-quick, not equal parts
let lev = CareMovePool.all.first { $0.id == "levator-stretch" }!
precondition(abs(lev.frameDuration(at: 1) - 1.0) < 0.000_001)                          // through-center fixed at 1s
precondition(abs(lev.frameDuration(at: 0) - (40.0 / 2.0 - 2.0) / 2.0) < 0.000_001)     // hold 9.0s = even split of the cycle's remainder
precondition(lev.frameDuration(at: 1) < lev.frameDuration(at: 0) / 3)

// The real point: change reps/total duration and the through-center time must
// not move an inch — only hold frames follow. (A beat-proportional model
// would drift the through-center time with cycle length.)
let levVariant = CareMove(id: "lev-variant", category: .neck, name: "variant",
                          reps: 4, seconds: 60, frames: lev.frames, playback: .pingPong)
precondition(abs(levVariant.frameDuration(at: 1) - lev.frameDuration(at: 1)) < 0.000_001)
precondition(levVariant.frameDuration(at: 0) != lev.frameDuration(at: 0))
check(clock.position(for: lev, at: 102), elapsed: 2, frame: 0, reps: 0, complete: false)
check(clock.position(for: lev, at: 109.5), elapsed: 9.5, frame: 1, reps: 0, complete: false)   // through center, outbound
check(clock.position(for: lev, at: 112), elapsed: 12, frame: 2, reps: 0, complete: false)
check(clock.position(for: lev, at: 119.5), elapsed: 19.5, frame: 1, reps: 0, complete: false)  // through center, return leg
check(clock.position(for: lev, at: 120), elapsed: 20, frame: 0, reps: 1, complete: false)
check(clock.position(for: trap, at: 120), elapsed: 20, frame: 1, reps: 0, complete: false)
check(clock.position(for: trap, at: 130), elapsed: 30, frame: 0, reps: 1, complete: true)

// A delayed refresh skips directly to the correct frame and rep.
check(clock.position(for: chin, at: 121), elapsed: 21, frame: 1, reps: 4, complete: false)

clock.pause(at: 110)
check(clock.position(for: chin, at: 130), elapsed: 10, frame: 0, reps: 2, complete: false)
clock.pause(at: 140)
check(clock.position(for: chin, at: 150), elapsed: 10, frame: 0, reps: 2, complete: false)
clock.resume(at: 130)
clock.resume(at: 132)
check(clock.position(for: chin, at: 135), elapsed: 15, frame: 1, reps: 3, complete: false)
`);

  execFileSync("swiftc", [ISLAND_CARE_LEDGER_SWIFT, APP_GROUP_SWIFT, CARE_MOVE_POOL_SWIFT, CARE_SESSION_CLOCK_SWIFT, main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });
});

test("island care session uses monotonic state and agent completion does not interrupt it", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  // The App Group definition lives in AppGroup.swift (the ledger should not
  // depend on the socket listener just to know the container path).
  // Invariant: the container id is read from Info.plist; no Team ID in source.
  const appGroup = fs.readFileSync(islandPath("AppGroup.swift"), "utf8");
  assert.match(appGroup, /forInfoDictionaryKey: "AppGroupID"/);
  assert.match(monitor, /AppGroup\.id/);
  assert.match(monitor, /case "complete"/);   // event semantics (transport asserted elsewhere)
  assert.match(monitor, /case "working"/);

  const vm = viewModelSource();
  assert.match(vm, /NSSound/);
  // Frame changes must be audible: side-neck/levator are done with the head
  // turned away, eyes off the screen — visual cues like the fade bar are useless there
  assert.match(vm, /beatSound/);
  assert.match(vm, /position\.currentFrameIndex != currentFrameIndex/);
  // Pass-through frames don't tick: they are the interval between sides, not
  // a new move; ticking on every frame change turns one rep into four scattered ticks
  assert.match(vm, /!currentMove\.frames\[position\.currentFrameIndex\]\.isPassThrough/);
  // Scope to applyProjectEvent FIRST, then find the .done branch. Anchoring on
  // "the file's first case .done:" breaks as soon as anyone adds a switch-bearing
  // method to IslandAgentStatus — the capture then stretches into
  // applyProjectEvent and swallows the endSession machinery into a false failure.
  // ⚠️ Invariant: agent completion only chimes; it must never interrupt a running session.
  const applyBlock = vm.match(/private func applyProjectEvent\([\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(applyBlock.length > 0, "applyProjectEvent not found");
  const doneBlock = applyBlock.match(/case \.done:([\s\S]*?)case \.waiting/)?.[1] ?? "";
  assert.ok(doneBlock.length > 0, "no .done branch inside applyProjectEvent");
  assert.match(doneBlock, /playChime/);
  assert.doesNotMatch(doneBlock, /finishSession|endSession|persistCareSession/);

  assert.match(vm, /enum CareSessionPhase[\s\S]*?case paused/);
  assert.match(vm, /@Published var completedReps: Int/);
  assert.match(vm, /@Published var currentFrameIndex: Int/);
  assert.match(vm, /func selectCategory\(_ category: CareCategory\)/);
  assert.match(vm, /func startSession\(\)/);
  assert.match(vm, /func pauseSession\(\)/);
  assert.match(vm, /func resumeSession\(\)/);
  assert.match(vm, /func endSession\(\)/);
  assert.match(vm, /ProcessInfo\.processInfo\.systemUptime/);
  assert.match(vm, /CareSessionClock/);
  assert.match(vm, /setsCompleted: 1,[\s\S]{0,300}persistCareSession\(record, playCompletionSound: true\)/);
  assert.doesNotMatch(vm, /elapsedSeconds \+= 1/);
  assert.doesNotMatch(vm, /try\? CareLedgerStore\.append/);

  const startBlock = vm.match(/func startSession\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  const finishBlock = vm.match(/func endSession\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.doesNotMatch(startBlock, /agentStatus/);
  assert.doesNotMatch(finishBlock, /agentStatus/);

  const script = fs.readFileSync(pkgPath("install-island-hooks.py"), "utf8");
  assert.match(script, /UserPromptSubmit/);
  assert.match(script, /Stop/);
  assert.match(script, /perch-backup/);
});

test("island receives agent events over a unix domain socket, zero polling", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  // Push-style socket server: bind + listen + DispatchSource, no polling
  assert.match(monitor, /AF_UNIX/);
  assert.match(monitor, /sockaddr_un/);
  assert.match(monitor, /\bbind\b/);
  assert.match(monitor, /\blisten\b/);
  assert.match(monitor, /DispatchSource/);
  assert.match(monitor, /bridge\.sock/);              // the socket lives in the app group container
  assert.match(monitor, /AppGroup\.containerURL/);   // container derivation: see AppGroup.swift
  assert.doesNotMatch(monitor, /Timer\.scheduledTimer/);   // zero polling
  assert.match(monitor, /case "complete"/);
  assert.match(monitor, /case "working"/);

  // The installer pushes over the socket (nc -U), stays additive + backed up,
  // and can replace an older file-based hook on migration
  const script = fs.readFileSync(pkgPath("install-island-hooks.py"), "utf8");
  assert.match(script, /bridge\.sock/);
  assert.match(script, /nc/);
  assert.match(script, /-U/);
  assert.match(script, /perch-backup/);            // backup kept
  assert.match(script, /UserPromptSubmit/);
  assert.match(script, /Stop/);
});

test("island gains a 4th waiting state (PermissionRequest→yellow) + auto-peek choreography", () => {
  const vm = viewModelSource();
  assert.match(fs.readFileSync(islandPath("AgentStatus.swift"), "utf8"),
               /enum IslandAgentStatus[\s\S]*?case waiting/);   // four states
  assert.match(vm, /onWaiting/);
  assert.match(vm, /return \.waiting/);   // waiting is reachable (via aggregateStatus())
  assert.match(vm, /isHovering/);                                   // expanded = OR of three
  assert.match(vm, /peekActive/);                                   // auto-peek choreography
  assert.match(vm, /sessionPhase == \.active/);                     // stays open during a session
  assert.match(vm, /caredThisRound/);                               // done auto-peeks only if you cared this round
  assert.match(vm, /wasBusy[\s\S]*?if !wasBusy/);  // peek only on the aggregate's first start

  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  assert.match(monitor, /var onWaiting/);
  assert.match(monitor, /case "waiting"/);

  const view = islandViews();
  assert.match(view, /statusWorking/);   // blue
  assert.match(view, /statusWaiting/);   // yellow
  assert.match(view, /statusDone/);      // green
  assert.match(view, /case \.waiting/);  // the view's switch covers waiting

  const script = fs.readFileSync(pkgPath("install-island-hooks.py"), "utf8");
  assert.match(script, /PermissionRequest/);   // yellow is driven by permission requests
  assert.match(script, /"waiting"/);
});

test("island tracks per-project status dots, hook carries project dir", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  assert.match(monitor, /@MainActor \(String, String\) -> Void/);   // callbacks carry (project cwd, source)

  const vm = viewModelSource();
  assert.match(vm, /struct ProjectStatus/);
  assert.match(vm, /@Published var projects/);
  assert.match(vm, /func applyProjectEvent/);
  assert.match(vm, /func aggregateStatus/);   // aggregate state drives the leaf
  assert.match(vm, /pruneStale/);             // stale pruning

  const view = islandViews();
  assert.match(view, /struct ProjectDot/);
  // Per-project dots live in the opened card, fed the real project list;
  // the closed capsule reports counts derived from the same list.
  assert.match(view, /AgentStatusDots\(projects:/);
  assert.match(view, /AgentActivityStrip\(projects: viewModel\.projects/);
  assert.match(view, /StatusTally\.counts\(viewModel\.projects\.map\(\\\.status\)\)/);

  const script = fs.readFileSync(pkgPath("install-island-hooks.py"), "utf8");
  assert.match(script, /CLAUDE_PROJECT_DIR/);   // the hook carries the project dir
});

test("the socket bridge accepts bounded reconciliation payloads for App Group publication", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  assert.match(monitor, /case "reconciliation"/);
  assert.match(monitor, /onReconciliation/);
  assert.match(monitor, /maxReconciliationBytes\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(monitor, /hook-ledger-request/);
  assert.match(monitor, /respondWithHookLedger/);
  assert.match(monitor, /maxHookLedgerBytes\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
});

test("yellow must be able to turn back to blue: PostToolUse pushes working", () => {
  // Yellow would otherwise never exit: approving emits NO event, and
  // UserPromptSubmit only fires when the human types — so "asked once" would
  // mean "yellow until the turn ends": you approve, the agent works another
  // 20 minutes, the dot stays yellow.
  // PostToolUse is the only signal that DISPROVES "something is stuck": a
  // tool finished, therefore nothing waits on a human.
  for (const f of ["install-island-hooks.py", "install-codex-island-hooks.py"]) {
    const s = fs.readFileSync(pkgPath(f), "utf8");
    const events = s.match(/EVENTS = \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(events.length > 0, `${f}: EVENTS not found`);
    assert.match(events, /"PostToolUse":\s*"working"/, `${f}: PostToolUse must push working`);
    // Yellow itself must not get lost — it is the only "really waiting on your approval" signal
    assert.match(events, /"PermissionRequest":\s*"waiting"/, `${f}: yellow is gone`);
    assert.match(events, /"Stop":\s*"complete"/, `${f}: green is gone`);
  }

  // codex side: report exactly the entries that changed, never a hard-coded
  // count. Over-reporting sends people hunting for buttons that don't exist;
  // under-reporting leaves hooks silently skipped (the trust hash covers the
  // command itself; unchanged commands stay trusted).
  const cx = fs.readFileSync(pkgPath("install-codex-island-hooks.py"), "utf8");
  assert.doesNotMatch(cx, /These \d+ entr/);

  // Run the real upsert instead of grepping: a new entry must report "needs
  // trust", an identical reinstall must report "no re-trust". Grepping can't
  // catch a renamed variable (text assertions still pass after a rename).
  const out = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cx", ${JSON.stringify(pkgPath("install-codex-island-hooks.py"))})
cx = importlib.util.module_from_spec(spec); spec.loader.exec_module(cx)
# Importing must not require an installed island — and neither may anything
# these tests drive. Make the reader explode to prove it: a fresh clone and CI
# have no /Applications/Perch.app, and a test that only passes on the author's
# machine is not a test.
def no_app(*a, **k):
    raise SystemExit("no island installed")
cx.app_group_id = no_app
foreign = {"hooks": [{"command": "someone-elses-hook", "type": "command"}]}
root = {"hooks": {"PostToolUse": [dict(foreign)]}}
# Explicit launcher path: the command must be buildable without Perch
# installed, or this test only passes on a machine that already has it.
# ⚠️ Old expectation: an explicit socket AND lastrun, because the command
# carried both inline. It no longer carries either — that is the whole point
# of this change (a command whose text never changes cannot cost the owner
# another Trust click). What marks a command as ours is now the launcher path.
cmd = cx.hook_command("working", "/x/.perch/bin/perch-hook")
assert cx.is_perch_command(cmd), "the built command is not recognized as ours; this test proves nothing"
_, first = cx.upsert(root, "PostToolUse", cmd)          # new
_, again = cx.upsert(root, "PostToolUse", cmd)          # identical reinstall
_, edited = cx.upsert(root, "PostToolUse", cmd + " #x") # command changed
moved = root["hooks"]["PostToolUse"][0] != foreign      # was the foreign entry moved?
print(json.dumps({"first": first, "again": again, "edited": edited, "moved": moved,
                  "count": len(root["hooks"]["PostToolUse"])}))
`], { encoding: "utf8" });
  const r = JSON.parse(out);
  assert.equal(r.first, true, "a new hook must report 'needs trust'");
  assert.equal(r.again, false, "an unchanged command must not send anyone clicking Trust again");
  assert.equal(r.edited, true, "a changed command must report 'needs re-trust', or codex silently skips it");
  assert.equal(r.moved, false, "a foreign entry was moved — all their trust hashes would break");
  assert.equal(r.count, 2, "reinstalling must not pile up duplicates");
});

test("yellow survives the 15-min sweep, no silent container fallback, screen changes recompute, closing unmounts the card", () => {
  // Strip comments before asserting: banned words legitimately appear in
  // comments (e.g. "don't add .help()"), and unstripped they collide.
  const code = (s) => s.replace(/\/\/.*$/gm, "");
  const read = (name) => code(fs.readFileSync(islandPath(name), "utf8"));

  // ② Yellow's expiry policy has its OWN real-behavior test (see "stale
  //    policy runs real behavior" below). Here only the call site: pruneStale
  //    must go through StalePolicy, and the ViewModel keeps no duration constants.
  // the extensions count: a constant hidden there is still in the view model.
  // ⚠️ Comments stripped — the `\d+ \* 60` rule below would otherwise fire on a
  // comment that merely mentions a duration.
  const vm = viewModelSource().replace(/\/\/.*$/gm, "");
  const prune = vm.match(/func pruneStale\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(prune, /StalePolicy\.isStale\(/, "pruning must go through StalePolicy, no inline judgment");
  assert.doesNotMatch(vm, /\d+ \* 60/,
    "no duration constants in the ViewModel — the policy exists once, somewhere tests can reach");
  assert.doesNotMatch(prune, /removeAll \{ \$0\.updatedAt < cutoff \}/, "the old blanket sweep must not remain");

  // ③ Failing to get the App Group container must crash loudly. A sandboxed
  //    app's homeDirectoryForCurrentUser is the home INSIDE the container;
  //    falling back there writes everything into a shadow directory nothing
  //    outside can read, without a sound.
  const group = read("AppGroup.swift");
  assert.doesNotMatch(group, /homeDirectoryForCurrentUser/, "no fallback to the sandbox's own home");
  const container = group.match(/static let containerURL[\s\S]*?\n    \}\(\)/)?.[0] ?? "";
  assert.match(container, /fatalError/, "an unavailable container must crash on the spot with a clear reason");

  // ④ Panel coordinates are computed against THE screen of that moment; without
  //    recomputing after a screen change the island draws on a screen that no
  //    longer exists (looks exactly like a crash)
  const wc = read("IslandWindowController.swift");
  assert.match(wc, /didChangeScreenParametersNotification[\s\S]{0,240}activate\(\)/,
    "the screen-change notification must rerun activate() to reposition");

  // ⑤ Closing must UNMOUNT the whole card: it holds a 30fps TimelineView, and opacity 0 doesn't stop it
  const view = read("IslandView.swift");
  const stack = view.match(/ZStack\(alignment: \.top\)[\s\S]*?\n        \}/)?.[0] ?? "";
  assert.match(stack, /if phase == \.opened \{[\s\S]*?openedPlaceholder/, "the card mounts only when opened");
  assert.match(stack, /\} else \{[\s\S]*?capsule\(display: display\)/, "closed keeps only the capsule");
  assert.doesNotMatch(stack, /\.opacity\(phase == \.opened/, "no faking removal with opacity");
});

test("stale policy runs real behavior: yellow survives a meal, blue/green go at 15 minutes", () => {
  // ⚠️ Regex-matching the ternary inside `pruneStale` is a fake gate: keep
  // the literal, swap the real comparison back to 15 minutes, and behavior
  // regresses to the original bug (yellow swept) while the test stays green.
  //
  // So the policy must be extracted into pure-Foundation StalePolicy to be
  // testable at all — buried in IslandViewModel, that class drags in AppKit
  // and the socket listener and cannot be constructed in a test (touching
  // AppGroup.id hits fatalError), leaving only literal-matching.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-stale-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "stale-check");

  fs.writeFileSync(main, `
import Foundation
let min = 60.0, hour = 3600.0

// Blue/green (isWaiting=false): the 15-minute line
precondition(!StalePolicy.isStale(isWaiting: false, age: 14 * min), "removed at 14 minutes — too early")
precondition(!StalePolicy.isStale(isWaiting: false, age: 15 * min), "exactly 15 minutes should not remove")
precondition( StalePolicy.isStale(isWaiting: false, age: 16 * min), "16 minutes should remove")

// Yellow (isWaiting=true): IT MUST STILL BE THERE AFTER A MEAL — the whole point of the rule
precondition(!StalePolicy.isStale(isWaiting: true, age: 16 * min), "yellow swept at 16 minutes")
precondition(!StalePolicy.isStale(isWaiting: true, age: 90 * min), "back from lunch and yellow is gone")
precondition(!StalePolicy.isStale(isWaiting: true, age: 8 * hour), "exactly 8 hours should not remove")
// But never-expiring is wrong too: a closed session sends no more events, and the dot would hang forever, lying
precondition( StalePolicy.isStale(isWaiting: true, age: 8 * hour + 1), "a never-expiring yellow is also wrong")

// The two lines must genuinely differ, yellow's being longer
precondition(StalePolicy.waiting > StalePolicy.busy, "yellow's line is not longer than blue/green's — no distinction at all")
`);

  // Feed ONLY StalePolicy.swift: it must be pure Foundation — dragging in AppKit makes it untestable again
  execFileSync("swiftc", [islandPath("StalePolicy.swift"), main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });

  // The policy exists once: no duration constants anywhere else
  const policy = fs.readFileSync(islandPath("StalePolicy.swift"), "utf8");
  assert.match(policy, /^import Foundation$/m);
  assert.doesNotMatch(policy, /import (AppKit|SwiftUI|Combine)/, "a UI framework import makes it untestable again");
});

test("perch care-move assets match exactly what the move pool references", () => {
  const pool = fs.readFileSync(CARE_MOVE_POOL_SWIFT, "utf8");
  const assets = [...pool.matchAll(/assetName: "(\w+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 10, "the move pool should reference a set of keyframe assets");

  // Direction two: the catalog must hold no CareMove* the pool doesn't reference (orphans)
  const orphans = fs
    .readdirSync(ISLAND_CATALOG)
    .filter((name) => name.startsWith("CareMove") && name.endsWith(".imageset"))
    .map((name) => name.replace(/\.imageset$/, ""))
    .filter((name) => !assets.includes(name));
  assert.deepEqual(orphans, [], `orphan assets in the catalog (unreferenced by the pool): ${orphans.join(", ")}`);

  // Direction one: every asset the pool references must exist and conform
  for (const assetName of assets) {
    const imageSet = path.join(ISLAND_CATALOG, `${assetName}.imageset`);
    assert.ok(fs.existsSync(path.join(imageSet, "Contents.json")), `${assetName} Contents.json should exist`);
    const png = path.join(imageSet, `${assetName}.png`);
    assert.ok(fs.existsSync(png), `${assetName}.png should exist`);

    const metadata = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", png], { encoding: "utf8" });
    assert.match(metadata, /pixelWidth: 512/, `${assetName} should be 512px wide`);
    assert.match(metadata, /pixelHeight: 512/, `${assetName} should be 512px tall`);
    assert.match(metadata, /hasAlpha: yes/, `${assetName} should have alpha`);
  }

  // ⚠️ The artwork-slicing pipeline is checked upstream, not here: it does not
  // ship, and referencing it from the island's tests would make the island
  // unliftable.
});
