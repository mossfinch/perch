const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const { islandTree, islandPath, pkgPath, PKG } = require("./island-paths");
const ISLAND_CARE_LEDGER_SWIFT = islandPath("CareLedger.swift");
const ISLAND_CATALOG = islandPath("Assets.xcassets");
const ISLAND_VIEW_SWIFT = islandPath("IslandView.swift");
// The ledger needs the container location; the container id is read from
// Info.plist (AppGroup.swift). Compiling the ledger requires it.
const APP_GROUP_SWIFT = islandPath("AppGroup.swift");
const CARE_MOVE_POOL_SWIFT = islandPath("CareMovePool.swift");
const CARE_SESSION_CLOCK_SWIFT = islandPath("CareSessionClock.swift");
const CARE_SESSION_RECORDER_SWIFT = islandPath("CareSessionRecorder.swift");

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

test("perch target is wired as an LSUIElement notch app", () => {
  // No project.yml (XcodeGen recipe) here: a generator recipe never tracks
  // the pbxproj, and one run of xcodegen would rebuild the project from the
  // stale recipe, wiping weeks of changes.
  // ⚠️ The invariant: the island must be a standalone target with its own
  // bundle id, and the project file itself is the single source of truth.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  assert.match(pbx, /\/\* Perch \*\/ = \{\s*isa = PBXNativeTarget;/);

  // ⚠️ No literal bundle id pinned here — that would be over-specification.
  // The invariant is "the island has its own bundle id, identical in Debug
  // and Release", never "it must be called some particular name"; a pinned
  // literal turns every rename into "edit the tests".
  // (The "must not collide with anything else on the same machine"
  // counterpart lives upstream — it has to name what it checks against, and
  // that name doesn't ship.)
  //
  // The island's build-settings blocks = the ones whose INFOPLIST_FILE points
  // into Perch/ (one for Debug, one for Release)
  const islandIds = [...pbx.matchAll(/buildSettings = \{([\s\S]*?)\n\t\t\t\};/g)]
    .map((m) => m[1])
    .filter((b) => /INFOPLIST_FILE = Perch\//.test(b))
    .map((b) => b.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)?.[1]);
  assert.equal(islandIds.length, 2, "the island should have Debug + Release build configurations");
  assert.ok(islandIds[0], "no PRODUCT_BUNDLE_IDENTIFIER in the island's build settings");
  assert.equal(islandIds[1], islandIds[0], "Debug and Release bundle ids drifted apart");

  const plist = fs.readFileSync(islandPath("Info.plist"), "utf8");
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);

  const ent = fs.readFileSync(islandPath("Perch.entitlements"), "utf8");
  // No literal id asserted: a Team ID links to a developer account's real
  // name. The invariant stands — the entitlements must declare an App Group.
  assert.match(ent, /<key>com\.apple\.security\.application-groups<\/key>/);
  assert.match(ent, /<string>group\.[^<]+<\/string>/);

  const controller = fs.readFileSync(islandPath("IslandWindowController.swift"), "utf8");
  assert.match(controller, /NSPanel\(/);
  assert.match(controller, /\.borderless/);
  assert.match(controller, /safeAreaInsets\.top/);
  assert.match(controller, /auxiliaryTopLeftArea/);

  const app = fs.readFileSync(islandPath("PerchApp.swift"), "utf8");
  assert.match(app, /setActivationPolicy\(\.accessory\)/);
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
  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
  assert.match(vm, /CareLedgerStore\.append/);
  assert.match(vm, /CareSessionRecorder\.makeRecord/);

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
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

  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
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

test("island capsule has a distinct persistent done state + retained chime", () => {
  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
  const status = fs.readFileSync(islandPath("AgentStatus.swift"), "utf8");
  assert.match(status, /enum IslandAgentStatus[\s\S]*?case done/);
  assert.match(vm, /return \.done/);   // done is reachable (agentStatus comes from aggregateStatus())
  assert.doesNotMatch(vm, /playChime\(\)[\s\S]{0,200}agentStatus = \.idle/);   // completion never self-resets to idle
  assert.match(vm, /private let completionSound/);
  assert.match(vm, /CompletionChime/);   // audio read from the app bundle (sandbox-safe)
  assert.match(vm, /func hoverEntered\(\)[\s\S]*?\.done/);

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  assert.match(view, /repeatForever/);   // continuous pulse animation while working
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
  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
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

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
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

  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
  assert.match(vm, /struct ProjectStatus/);
  assert.match(vm, /@Published var projects/);
  assert.match(vm, /func applyProjectEvent/);
  assert.match(vm, /func aggregateStatus/);   // aggregate state drives the leaf
  assert.match(vm, /pruneStale/);             // stale pruning

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  assert.match(view, /struct ProjectDot/);
  // Per-project dots live in the opened card, fed the real project list;
  // the closed capsule reports counts derived from the same list.
  assert.match(view, /AgentStatusDots\(projects:/);
  assert.match(view, /AgentActivityStrip\(projects: viewModel\.projects/);
  assert.match(view, /StatusTally\.counts\(viewModel\.projects\.map\(\\\.status\)\)/);

  const script = fs.readFileSync(pkgPath("install-island-hooks.py"), "utf8");
  assert.match(script, /CLAUDE_PROJECT_DIR/);   // the hook carries the project dir
});

test("island is single-instance and installable as a real app", () => {
  const app = fs.readFileSync(islandPath("PerchApp.swift"), "utf8");
  assert.match(app, /NSRunningApplication\.current/);
  assert.match(app, /bundleIdentifier == bundleID && \$0\.processIdentifier != me\.processIdentifier/);
  assert.match(app, /NSApp\.terminate/);
  // The real invariant: the yield check must precede window creation. One
  // step later and the newcomer steals the socket from the incumbent first —
  // "two panels stacked, events delivered to the one that just started".
  const guardAt = app.search(/anotherInstanceIsRunning/);
  const windowAt = app.search(/IslandWindowController\(\)/);
  assert.ok(guardAt >= 0 && windowAt >= 0 && guardAt < windowAt,
    "the single-instance yield must happen before IslandWindowController");

  const installer = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  assert.match(installer, /Path\("\/Applications"\) \/ APP_NAME/);   // installed into /Applications, double-clickable
  assert.match(installer, /LaunchAgents/);                            // starts at login
  assert.match(installer, /"RunAtLoad": True/);
  // KeepAlive must be false: stacked on the single-instance guard it becomes a start→suicide→restart flap
  assert.match(installer, /"KeepAlive": False/);
  // Entitlement missing = sandbox denies the container = every hook event lost; must be caught at install.
  // What gets checked is that the SIGNATURE really carries the app-group
  // entitlement — with no Team prefix in the group name, "TeamIdentifier ==
  // group prefix" checks are meaningless and miss the real failure anyway.
  assert.match(installer, /def check_entitlement/);
  assert.match(installer, /def app_group_of/);
  // Read from the product, never compare against a hard-coded constant: the
  // constant eventually drifts from the real config, after which it can only
  // ever report "check passed"
  assert.match(installer, /Print :AppGroupID/);
});

test("the installer's socket check waits for a real connection, never for the file", () => {
  // ⚠️ The bug this guards against: a socket FILE may be the leftover of the
  // instance the installer just killed — pkill gives it no chance to unlink
  // its own — so "the file is there" says nothing about anyone listening.
  // Gating on the file and connecting once fails on the single most common
  // path there is: every reinstall, where the fresh island unlinks that
  // leftover and rebinds a moment later.
  const py = [
    "import sys, pathlib, socket, subprocess, tempfile, time",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))}, ['verify_socket'],`,
    "                    {'Path': pathlib.Path, 'subprocess': subprocess, 'time': time})",
    "verify = ns['verify_socket']",
    "naps = []",
    "def nap(seconds): naps.append(seconds)",
    // ① Refused twice (the leftover), then the fresh island binds -> must pass
    "answers = iter([1, 1, 0])",
    "verify('group.x', pathlib.Path('/nonexistent/bridge.sock'), lambda: next(answers), nap)",
    "assert len(naps) == 2, 'it stopped retrying the connect; waited only %d time(s)' % len(naps)",
    "def refuses(sock, why):",
    "    try:",
    "        verify('group.x', sock, lambda: 1, nap)",
    "        raise AssertionError('did not fail: ' + why)",
    "    except SystemExit as e:",
    "        return str(e)",
    // ② Never accepts AND no socket file -> the island never bound
    "msg = refuses(pathlib.Path('/nonexistent/bridge.sock'), 'nothing bound at all')",
    "assert 'never bound' in msg, 'wrong diagnosis: ' + msg",
    // ③ A real socket file nobody accepts on -> a different diagnosis, because
    //    it sends you looking somewhere else entirely
    "d = tempfile.mkdtemp(); real = pathlib.Path(d) / 'bridge.sock'",
    "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(str(real))",
    "assert real.is_socket(), 'the fixture is not a socket; this case tests nothing'",
    "msg = refuses(real, 'socket file present but dead')",
    "assert 'nothing accepts connections' in msg, 'wrong diagnosis: ' + msg",
    "print('ok')",
  ].join("\n");
  // Last line only: a successful check prints its own confirmation first
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out.split("\n").pop(), "ok", out);
});

test("the release audit compares the archive against the bundle, not against a list of known-bad shapes", () => {
  // ⚠️ What this replaces, and why the shape of the check changed: the gate used
  // to refuse entries carrying an 0x7875 extra, because that is the field `zip`
  // writes. The packing command later became ditto; ditto writes 0x5855 into the
  // LOCAL header instead, and zipfile exposes only the CENTRAL directory's copy —
  // so a shipped archive carried UID=502/GID=20 through a gate printing "no
  // packer identity". Naming bad fields one at a time cannot terminate. Declaring
  // the whole archive can: it must be the bundle's own entries and nothing else.
  //
  // Assembled at runtime, like the bundle test below, so the privacy guard does
  // not fire on the fixture that proves the privacy guard works.
  const home = ["/User", "s/"].join("");
  const buildPath = `${home}someone/Developer/priv/Perch/Care/`;
  const py = `
import zipfile, pathlib, tempfile, struct, importlib.util
spec = importlib.util.spec_from_file_location('pkgrel', ${JSON.stringify(pkgPath("package-release.py"))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
BUILD_PATH = ${JSON.stringify(buildPath)}

d = pathlib.Path(tempfile.mkdtemp())
app = d / 'Perch.app'
(app / 'Contents' / 'MacOS').mkdir(parents=True)
exe = app / 'Contents' / 'MacOS' / 'Perch'
exe.write_bytes(b'ordinary bytes'); exe.chmod(0o755)

def refuses(src, want, why):
    p = d / 'case.zip'
    p.write_bytes(src if isinstance(src, bytes) else src.read_bytes())
    try:
        m.audit(p, want)
        raise AssertionError('did not refuse: ' + why)
    except SystemExit as e:
        return str(e)

# ① control group: a faithful archive must pass, or the gate is unpassable
want = m.manifest(app)
ok = d / 'ok.zip'
m.pack(app, ok, want)
m.audit(ok, want)
raw = ok.read_bytes()

def eocd(b): return len(b) - 22
def cd_at(b): return struct.unpack_from('<I', b, eocd(b) + 16)[0]
def local_offsets(b):
    at = cd_at(b); outs = []
    for _ in range(struct.unpack_from('<H', b, eocd(b) + 10)[0]):
        nl, el, cl = struct.unpack_from('<HHH', b, at + 28)
        outs.append(struct.unpack_from('<I', b, at + 42)[0])
        at += 46 + nl + el + cl
    return outs

# ② THE REGRESSION: the packer's uid in the local header, central directory clean.
#    Inserted into the LAST local header so no other entry's offset moves.
last = max(local_offsets(raw))
blob = struct.pack('<HH', 0x5855, 12) + struct.pack('<IIHH', 0, 0, 502, 20)
t = bytearray(raw)
ins = last + 30 + struct.unpack_from('<H', raw, last + 26)[0]
t[ins:ins] = blob
struct.pack_into('<H', t, last + 28, len(blob) - 4)
struct.pack_into('<I', t, len(t) - 22 + 16, cd_at(raw) + len(blob))
probe = d / 'localonly.zip'; probe.write_bytes(bytes(t))
with zipfile.ZipFile(probe) as z:
    assert all(i.extra == b'' for i in z.infolist()), \\
        'fixture is not local-only: the old central-directory view would have caught it, so this proves nothing'
msg = refuses(bytes(t), want, 'uid carried in the local header alone')
assert 'local header' in msg and 'extra field' in msg, 'wrong reason: ' + msg

# ③ an entry nothing declared — the shape that covers comments, stray files, sidecars
(app / 'Contents' / 'sneak.txt').write_bytes(b'x')
more = m.manifest(app)
surplus = d / 'surplus.zip'; m.pack(app, surplus, more)
msg = refuses(surplus, want, 'an entry the bundle never declared')
assert 'not declared anywhere' in msg and 'sneak.txt' in msg, 'wrong reason: ' + msg

# ④ ...and the other direction: declared but absent, so a truncated archive is not "clean"
msg = refuses(ok, more, 'an entry the declaration has and the archive lacks')
assert 'missing' in msg, 'wrong reason: ' + msg
(app / 'Contents' / 'sneak.txt').unlink()

# ⑤ same names, different bytes: the digest is what makes "exactly the bundle" mean anything
bad = dict(want); k = 'Perch.app/' + m.EXEC_SUBPATH
bad[k] = want[k]._replace(digest='0' * 64)
msg = refuses(ok, bad, 'content that does not match the declaration')
assert 'content differs' in msg, 'wrong reason: ' + msg

# ⑥ bytes after the end record ship too, and no entry accounts for them
msg = refuses(raw + BUILD_PATH.encode(), want, 'bytes appended after the end record')
assert 'trailing bytes' in msg or 'end-of-central-directory' in msg, 'wrong reason: ' + msg

# ⑦ a length the record claims but the file does not have: two readers, two archives
t = bytearray(raw); struct.pack_into('<H', t, len(t) - 22 + 20, 32)
msg = refuses(bytes(t), want, 'end record claiming a comment that is not there')
assert 'comment' in msg, 'wrong reason: ' + msg

# ⑧ local header and central directory naming the same entry differently
t = bytearray(raw); nl = struct.unpack_from('<H', raw, last + 26)[0]
t[last + 30 + nl - 1:last + 30 + nl] = b'X'
msg = refuses(bytes(t), want, 'local and central directory disagree on the name')
assert 'names it' in msg, 'wrong reason: ' + msg

# ⑩ THE SECOND REGRESSION: bytes in the span between the last entry's data and the
#    central directory. An earlier gate checked three boundaries — nothing before the
#    first local header, nothing after the end record, central directory reaching the
#    end record — and passed this while printing "no bytes outside the records".
#    ditto refuses the same file outright, so the gate was calling an archive clean
#    that a double-click cannot even open.
def centrals(b):
    at, out = cd_at(b), []
    for _ in range(struct.unpack_from('<H', b, eocd(b) + 10)[0]):
        nl, el, cl = struct.unpack_from('<HHH', b, at + 28)
        out.append((at, b[at + 46:at + 46 + nl].decode(), struct.unpack_from('<I', b, at + 42)[0]))
        at += 46 + nl + el + cl
    return out

gap = bytearray(raw); where = cd_at(raw)
gap[where:where] = BUILD_PATH.encode()
struct.pack_into('<I', gap, len(gap) - 22 + 16, where + len(BUILD_PATH))
msg = refuses(bytes(gap), want, 'bytes between the last payload and the central directory')
assert 'belong to no record' in msg, 'wrong reason: ' + msg

# ⑪ a real clock instead of the fixed stamp — the archive would then say which
#    timezone it was packed in. pack() sets it; nothing used to confirm it had.
t = bytearray(raw)
for cat, name, lat in centrals(raw):
    struct.pack_into('<HH', t, cat + 12, 0x4A28, 0x5CE1)
    struct.pack_into('<HH', t, lat + 10, 0x4A28, 0x5CE1)
msg = refuses(bytes(t), want, 'a real wall-clock timestamp')
assert 'not the fixed' in msg, 'wrong reason: ' + msg

# ⑫ permissions that differ from the bundle's — checking only the executable's
#    +x bit left every other entry's mode unverified
t = bytearray(raw)
for cat, name, lat in centrals(raw):
    if name.endswith('MacOS/Perch'):
        struct.pack_into('<I', t, cat + 38, 0o100644 << 16)
msg = refuses(bytes(t), want, 'a mode that does not match the bundle')
assert 'in the archive' in msg and 'in the bundle' in msg, 'wrong reason: ' + msg

# ⑬ a multi-volume claim: the other parts are not here and nothing accounts for them
t = bytearray(raw); struct.pack_into('<H', t, len(t) - 22 + 4, 1)
msg = refuses(bytes(t), want, 'a multi-volume claim')
assert 'multi-part' in msg, 'wrong reason: ' + msg

# ⑨ UTF-32 build path: the encoding that sailed past a search written for UTF-8 and UTF-16
exe.write_bytes(b'pad' + BUILD_PATH.encode('utf-32-le'))
w32 = m.manifest(app); z32 = d / 'u32.zip'; m.pack(app, z32, w32)
msg = refuses(z32, w32, 'utf-32 build path')
assert 'utf-32-le' in msg, 'caught it but misreported the encoding: ' + msg
assert 'someone/Developer/priv' in msg, 'did not show the evidence: ' + msg

print('ok')
`;
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out.split("\n").pop(), "ok", out);
});

test("the installer refuses to ship a bundle carrying the builder's own paths", () => {
  // ⚠️ The gap this closes: every other guard here scans the REPOSITORY — the
  // manifest picks which files ship, the privacy test scans those. **The
  // compiled bundle is in none of it**, and the bundle is what a stranger
  // downloads. A Release build keeps its debug symbols unless something strips
  // them, and a DWARF file table is a list of the builder's absolute paths.
  // The fixture paths are assembled at runtime: written literally, this file
  // would itself carry an absolute home path and the privacy guard above would
  // fire on the test that proves the guard works. (Same reason its own needles
  // are joined rather than spelled out.)
  const home = ["/User", "s/"].join("");
  const one = `${home}someone/Developer/priv/Perch/Care/`;
  const two = `${home}other-person/x`;
  const py = [
    "import sys, pathlib, tempfile",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))}, ['verify_shipped_bytes'])`,
    "verify = ns['verify_shipped_bytes']",
    `ONE, TWO = ${JSON.stringify(one)}, ${JSON.stringify(two)}`,
    "root = pathlib.Path(tempfile.mkdtemp()) / 'Perch.app'",
    "(root / 'Contents' / 'MacOS').mkdir(parents=True)",
    "exe = root / 'Contents' / 'MacOS' / 'Perch'",
    "def refuses(why):",
    "    try:",
    "        verify(root)",
    "        raise AssertionError('did not refuse: ' + why)",
    "    except SystemExit as e:",
    "        return str(e)",
    // ① a build-machine path in the executable -> refuse, and say which file
    "exe.write_bytes(b'\\x00\\x01' + ONE.encode() + b'\\x00tail')",
    "msg = refuses('build path in the executable')",
    "assert 'Contents/MacOS/Perch' in msg, 'did not name the file: ' + msg",
    "assert ONE in msg, 'did not show the evidence: ' + msg",
    // ② same bundle once stripped -> must pass, or the gate is unpassable
    "exe.write_bytes(b'\\x00\\x01ordinary bytes\\x00tail')",
    "verify(root)",
    // ③ the needle is the SHAPE, not one username, and not one file: a
    //    contributor's own path in any resource counts just the same
    "(root / 'Contents' / 'Resources').mkdir()",
    "(root / 'Contents' / 'Resources' / 'x.bin').write_bytes(b'pad' + TWO.encode())",
    "msg = refuses('build path outside the executable')",
    "assert 'x.bin' in msg, 'only looked at the executable: ' + msg",
    "print('ok')",
  ].join("\n");
  // Last line only: a passing check prints its own confirmation first
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out.split("\n").pop(), "ok", out);
});

test("opened panel stacks nothing above the care card", () => {
  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const opened = view.match(/private func openedPlaceholder[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(opened.length > 0, "openedPlaceholder not found");
  assert.match(opened, /return GuidedCareCard\(/);
  // The frame height is fixed, so one extra sibling above the card = the
  // whole card pushed down and shrunk by the same amount — "auto-peek" and
  // "hover open" would no longer look like the same place (and the extra
  // content would sit behind the notch, invisible anyway). What this guards:
  // the card is the opened panel's ONLY content.
  assert.doesNotMatch(opened, /VStack|HStack|ZStack/);
});

test("codex island hooks install additively, never reordering foreign hooks", () => {
  const s = fs.readFileSync(pkgPath("install-codex-island-hooks.py"), "utf8");
  assert.match(s, /\.codex\/hooks\.json/);                    // rides the hooks system, never config.toml's notify chain
  assert.match(s, /"UserPromptSubmit": "working"/);
  assert.match(s, /"PermissionRequest": "waiting"/);
  assert.match(s, /"Stop": "complete"/);
  assert.match(s, /perch-backup/);                          // backup before writing
  assert.match(s, /trusted_hash/);             // the reason lives in the code, not in word of mouth
  // Replacement must happen at the HOOK level. Assigning a whole group is the
  // bug the A4 case below exists for: it takes somebody else's hooks down
  // together with ours, and a group-level self-check cannot see the damage.
  // Behavior is proven below; this bans the shape, which behavior cannot.
  assert.doesNotMatch(s, /^\s*groups\[[^\]]*\] = /m,
    "a whole-group assignment deletes any foreign hook sharing that group");

  // ⚠️ Two assertions were deliberately NOT written the obvious way:
  //
  // ① `assert.match(s, /PERCH_MARK = APP_GROUP/)` — that pattern is itself a
  //    bug (a changeable value as identity: change the App Group and old
  //    entries stop being recognized); recognition is by shape instead. And
  //    literal-matching assertions collide with comments — matching the
  //    comment that explains them still turns green. So the literal is
  //    BANNED instead.
  //
  // ② `assert.doesNotMatch(s, /groups\.pop\(/)` — that bans a WORD, while the
  //    real invariant is "other entries' indices must not move" (codex keys
  //    trusted_hash by `<file>:<event>:<group idx>:<hook idx>`; one shift and
  //    someone else's hook loses trust and silently stops). Banning the word
  //    also bans the perfectly safe "pop own duplicate off the tail".
  //    The invariant is verified by running the real upsert instead.
  assert.doesNotMatch(s, /^\w*MARK\w* = APP_GROUP$/m,
    "no changeable value as identity — the SHAPE is banned, not one name (a rename would dodge that)");

  const py = [
    "import copy, sys",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_marker",
    `ns = load_marker(${JSON.stringify(pkgPath("install-codex-island-hooks.py"))})`,
    "upsert = ns['upsert']",
    // A command must carry BOTH an own-artifact path inside the container and
    // the wire-protocol signature (path alone would misfire on other apps)
    "SOCK = '$HOME/Library/Group Containers/TTTTTTTTTT.group.x/bridge.sock'",
    "CMD = 'printf \"working' + chr(92) + 't%s' + chr(92) + 't%s-$$' + chr(92) + 'tcodex\" | nc -U \"' + SOCK + '\"'",
    "mine  = {'hooks': [{'command': CMD, 'timeout': 5, 'type': 'command'}]}",
    "other = {'hooks': [{'command': \"'$HOME/.some-tool/bin/some-tool-bridge' --source codex\"}]}",
    "assert ns['is_perch'](mine), 'our own crafted sample not recognized; sample or matcher broken'",
    "assert not ns['is_perch'](other), 'a foreign sample was misrecognized as ours'",
    // A1: duplicate stuck in the middle with foreign entries after it -> delete nothing, foreign indices stay put
    "root = {'hooks': {'Stop': [copy.deepcopy(other), copy.deepcopy(mine), copy.deepcopy(mine), copy.deepcopy(other)]}}",
    "upsert(root, 'Stop', CMD)",
    "g = root['hooks']['Stop']",
    "assert len(g) == 4, 'middle duplicates must not be touched; touching them shifts foreign indices'",
    "assert 'some-tool' in g[0]['hooks'][0]['command'], 'position 0 is no longer foreign'",
    "assert 'some-tool' in g[3]['hooks'][0]['command'], 'the foreign entry at position 3 was moved'",
    // A2: duplicate at the tail -> may be popped; popping the tail moves nobody's index
    "root = {'hooks': {'Stop': [copy.deepcopy(other), copy.deepcopy(mine), copy.deepcopy(mine)]}}",
    "upsert(root, 'Stop', CMD)",
    "g = root['hooks']['Stop']",
    "assert len(g) == 2, 'tail duplicates should be swept; %d groups remain' % len(g)",
    "assert 'some-tool' in g[0]['hooks'][0]['command'], 'the foreign entry was moved'",
    // A3: none of ours yet -> append at the end, never cut in line
    "root = {'hooks': {'Stop': [copy.deepcopy(other)]}}",
    "upsert(root, 'Stop', CMD)",
    "g = root['hooks']['Stop']",
    "assert len(g) == 2 and 'some-tool' in g[0]['hooks'][0]['command'], 'new entries must append at the end'",
    // A4 — a MIXED group: our hook sitting in the same group as someone
    // else's. Replacing the group as a whole (the obvious implementation)
    // silently deletes their hook, and a group-level self-check cannot see it,
    // because a group holding one of ours is excluded from the comparison.
    // Only our own hook object may be swapped; everything else in that group
    // keeps its place and its keys.
    "FOREIGN = other['hooks'][0]['command']",
    "mixed = {'matcher': '*', 'hooks': [{'command': FOREIGN},",
    "                                   {'command': CMD + ' #old', 'timeout': 5, 'type': 'command'}]}",
    "root = {'hooks': {'Stop': [mixed]}}",
    "upsert(root, 'Stop', CMD)",
    "g = root['hooks']['Stop']",
    "assert len(g) == 1, 'the mixed group must remain a single group'",
    "assert len(g[0]['hooks']) == 2, 'a hook disappeared from the mixed group'",
    "assert g[0]['hooks'][0]['command'] == FOREIGN, \"someone else's hook was deleted or moved\"",
    "assert g[0]['hooks'][1]['command'] == CMD, 'our hook was not updated in place'",
    "assert g[0].get('matcher') == '*', 'the group lost its other keys'",
    // A5 — and the pre-write self-check must SEE that foreign hook. Keyed by
    // group, a mixed group drops out of the comparison altogether, so losing
    // their hook inside one would read as perfectly clean. Keyed by address,
    // it is visible.
    "seen = ns['foreign_hooks']({'Stop': [mixed]})",
    "assert list(seen.values()) == [{'command': FOREIGN}], 'the self-check is blind to a foreign hook inside a mixed group'",
    "assert list(seen)[0] == ('Stop', 0, 0), 'foreign hooks must be keyed by exact address, not merely by group'",
    "print('ok')",
  ].join("\n");
  assert.equal(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim(), "ok");

  // A failed self-check must abort BEFORE the write, not report afterwards
  const check = s.match(/# Self-check before writing[\s\S]*?write_atomic\(HOOKS/)?.[0] ?? "";
  assert.ok(check.length > 0, "the self-check no longer sits between the edits and the write");
  assert.match(check, /raise SystemExit/);
  // The user's config is replaced by rename, never truncated in place: a
  // half-written hooks.json breaks their whole tool.
  assert.match(s, /os\.replace\(tmp, path\)/, "config writes must land atomically");
});

test("status dots split into rows by agent source, claude above codex", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  // Source is the later-added 4th field; older hooks push three fields, and a
  // three-field message must count as claude — or sessions still running with
  // an old hook (hooks are read once at session start) lose their row on upgrade.
  assert.match(monitor, /let rawSource = field\(3\)/);
  assert.match(monitor, /rawSource\.isEmpty \? "claude" : rawSource/);

  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
  assert.match(vm, /let source: String/);
  // The unique key must include the source: the same directory open in two
  // agents is two lines of work — keyed by directory alone they fight over
  // one dot and overwrite each other.
  assert.match(vm, /static func key\(source: String, dir: String\)[\s\S]{0,80}\\\(source\)/);
  assert.match(vm, /ProjectStatus\.key\(source: source, dir: dir\)/);

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  assert.match(view, /enum AgentRows/);
  assert.match(view, /static let order = \["claude", "codex"\]/);   // Claude on top
  // Unknown sources (a future agent) must not silently vanish
  assert.match(view, /for p in projects where !sources\.contains\(p\.source\)/);
  // Rows by source belong to the OPENED card only. The closed capsule reports
  // counts instead: 44pt of wing fits about five dots, and rows there only
  // ever distinguished the sources while both agents happened to be running.
  const card = view.match(/private struct AgentStatusDots[\s\S]*?\n\}/)?.[0] ?? "";
  const capsule = view.match(/private func statusCounts[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(capsule.length > 0, "statusCounts not found");
  assert.match(card, /AgentRows\.rows/);
  assert.doesNotMatch(capsule, /AgentRows\.rows/, "the closed capsule must not lay out per-source rows any more");
  // No text labels on the card's rows: 8pt row captions are the weakest, most
  // fragmented thing on it. The persistent caption right of the wave tells.
  assert.doesNotMatch(view, /AgentRows\.label/);
  // No tooltips on the dots: the island is a non-activating panel where
  // system tooltips never appear. Strip comments before checking — a comment
  // legitimately says "don't add .help()" and must stay, so nobody adds it back.
  const code = (s) => s.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code(card), /\.help\(/);
  assert.doesNotMatch(code(capsule), /\.help\(/);

  // The extra row must not steal height from the main area (the figure
  // strip): the two top constants must sum to a constant
  const top = Number(view.match(/activityTopPadding: CGFloat = (\d+)/)[1]);
  const height = Number(view.match(/activityHeight: CGFloat = (\d+)/)[1]);
  assert.equal(top + height, 40, "the top row must keep 40pt total, or it steals the figure strip's height");

  // Wire format: <event>\\t<dir>\\t<nonce>\\t<source>, source appended last (older hooks without it still work)
  for (const [f, src] of [["install-island-hooks.py", "claude"], ["install-codex-island-hooks.py", "codex"]]) {
    const script = fs.readFileSync(pkgPath(f), "utf8");
    assert.ok(script.includes(`%s-$$\\\\t${src}`), `${f}'s push must carry source ${src}`);
  }
});

test("the closed capsule tallies states, and the tally can never overflow the wing", () => {
  // Behavior, not grep: which groups appear, in what order, and that idle
  // never counts is display logic a regex over the view could only pretend to
  // check. The tally sits in a pure-Foundation file precisely so this test can
  // compile it on its own.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-tally-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "tally-check");

  fs.writeFileSync(main, `
import Foundation

// Nothing to report — the view draws its idle placeholder instead
precondition(StatusTally.counts([]).isEmpty)
precondition(StatusTally.counts([.idle, .idle]).isEmpty, "idle is the absence of news, never a group")

// One group per state, counted, idle dropped
let mixed: [IslandAgentStatus] = [.working, .done, .done, .waiting, .done, .idle]
precondition(StatusTally.counts(mixed) == [StatusCount(status: .working, count: 1),
                                           StatusCount(status: .waiting, count: 1),
                                           StatusCount(status: .done, count: 3)],
             "expected working/waiting/done in lifecycle order with idle dropped")

// An empty group is dropped, never rendered as a zero
precondition(StatusTally.counts([.done, .done]) == [StatusCount(status: .done, count: 2)])

// Order is fixed by lifecycle, not by size: a group that moved around as its
// count changed could not be read at a glance
let lopsided: [IslandAgentStatus] = [.done, .done, .done, .done, .working]
precondition(StatusTally.counts(lopsided).map(\\.status) == [.working, .done])

// **The whole point**: however many projects run, the capsule shows at most
// three things — so the wing can never overflow again, and nothing is lost.
let flood = [IslandAgentStatus](repeating: .done, count: 200)
          + [IslandAgentStatus](repeating: .working, count: 50)
precondition(StatusTally.counts(flood).count <= 3)
precondition(StatusTally.counts(flood).map(\\.count).reduce(0, +) == 250, "every project must still be counted")
`);

  // Feed ONLY AgentStatus.swift: it has to stay pure Foundation, or this test
  // cannot compile it and the display logic goes back to being checked by grep.
  execFileSync("swiftc", [islandPath("AgentStatus.swift"), main, "-o", binary], { stdio: "pipe" });
  execFileSync(binary, { stdio: "pipe" });

  const status = fs.readFileSync(islandPath("AgentStatus.swift"), "utf8");
  assert.match(status, /^import Foundation$/m);
  assert.doesNotMatch(status, /import (AppKit|SwiftUI|Combine)/, "a UI framework import makes it untestable again");
});

test("selected category ring shows how many moves and which one, continuously", () => {
  const pool = fs.readFileSync(CARE_MOVE_POOL_SWIFT, "utf8");
  assert.match(pool, /static func moves\(in category: CareCategory\)/);
  assert.match(pool, /static func index\(of moveID: String, in category: CareCategory\)/);

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const dock = view.match(/private struct CategoryDock[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(dock.length > 0, "CategoryDock not found");

  // The ring appears only when there is something to flip through — eyes has 1 move, no ring
  assert.match(dock, /moveCount > 1/);
  // "How many" is carried by the arc's length, never by cutting the circle into N segments (segments look broken)
  assert.match(dock, /\.trim\(from: 0, to: 1 \/ CGFloat\(moveCount\)\)/);
  assert.doesNotMatch(dock, /dash/i);
  // The base ring must be one full circle, no gaps
  assert.match(dock, /strokeBorder\(IslandPalette\.cue/);
  // The arc only turns forward: deriving the angle from moveIndex directly sweeps backward when flipping last->first
  assert.match(dock, /@State private var turn = 0/);
  assert.match(dock, /turn \+= \(\(newIndex - current\) % n \+ n\) % n/);
  assert.match(dock, /Double\(turn\) \/ Double\(moveCount\)/);
  assert.match(dock, /animation\(\.\w+\(duration: [\d.]+\), value: turn\)/);

  // Counts must derive from the move pool, never hard-coded
  assert.match(view, /moveCount: CareMovePool\.moves\(in: move\.category\)\.count/);
  assert.match(view, /moveIndex: CareMovePool\.index\(of: move\.id, in: move\.category\)/);
  assert.doesNotMatch(dock, /moveCount == 4|moveCount: 4/);
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
# Explicit socket/lastrun: the command must be buildable without Perch
# installed, or this test only passes on a machine that already has it.
# The paths still have to LOOK like container paths — that shape is what
# marks a command as ours.
FAKE = "/x/Library/Group Containers/group.test"
cmd = cx.hook_command("working", FAKE + "/bridge.sock", FAKE + "/codex-hook.lastrun")
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

test("no Team ID anywhere in the island's files — it links to the registrant's real name", () => {
  // A Team ID gets stamped into the product with the code signature:
  // `Developer ID Application: <real name> (<TEAM ID>)`. These files ship
  // as-is, so not one occurrence may stay.
  const TEAM = /\b[0-9A-Z]{10}\.group\./;   // an Apple Team ID is 10 uppercase alphanumerics
  // Must recurse into subdirectories: with sources grouped by duty, most
  // files are not at the top level — reading one level quietly guts the guard.
  const islandFiles = islandTree()
    .filter((f) => /\.(swift|entitlements|plist)$/.test(f))
    .map((f) => pkgPath("Perch", f));
  const scripts = ["install-island-app.py", "install-island-hooks.py",
                   "install-codex-island-hooks.py", "island-day-report.py"]
    .map((f) => pkgPath(f));
  for (const abs of [...islandFiles, ...scripts]) {
    const s = fs.readFileSync(abs, "utf8");
    assert.doesNotMatch(s, TEAM, `hard-coded Team ID in ${path.relative(PKG, abs)}`);
  }

  // The island needs NO per-machine configuration (the group name has no Team
  // prefix, identical for everyone, and Xcode doesn't sign). So the public
  // package must contain no .xcconfig at all — that layer belongs to the
  // mother repo's signing side.
  const xcc = fs.readdirSync(PKG).filter((f) => f.endsWith(".xcconfig"));
  if (PKG === ROOT) {
    assert.deepEqual(xcc, [], `no xcconfig belongs in the public package: ${xcc.join(", ")}`);
  } else {
    // Upstream layout: a template file still lives here, and the real-value
    // file must be blocked by gitignore
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.match(ignore, /apps\/mac-widget\/Config\.xcconfig/, "the real-value file must be gitignored");
  }

  // Info.plist and the entitlements are two declarations of one fact and must
  // name the same group — diverge and the island can't reach its container
  // while the UI looks perfectly fine
  const ent = fs.readFileSync(islandPath("Perch.entitlements"), "utf8");
  const plist = fs.readFileSync(islandPath("Info.plist"), "utf8");
  const group = plist.match(/<key>AppGroupID<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(group && group.startsWith("group."), `Info.plist's AppGroupID should look like group.xxx, got ${group}`);
  assert.ok(ent.includes(`<string>${group}</string>`), "entitlements and Info.plist disagree on the App Group");

  // Swift reads Info.plist and crashes on misconfiguration — an island
  // without its App Group is a silent husk: no socket, no events, UI looking
  // fine. Better to crash than to pretend.
  const mon = fs.readFileSync(islandPath("AppGroup.swift"), "utf8");
  assert.match(mon, /Bundle\.main\.object\(forInfoDictionaryKey: "AppGroupID"\)/);
  assert.match(mon, /fatalError/);

  // The installer must check before installing; an app without the
  // entitlement must never be installed with a success report. What gets
  // checked is WHAT THE SIGNATURE CARRIES — "the container path resolves"
  // proves nothing, that API returns a path even for made-up ids.
  const inst = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  assert.match(inst, /codesign", "-d", "--entitlements"/, "must check the signed entitlements before install");
  assert.match(inst, /com\.apple\.security\.application-groups" not in out/);
  assert.match(inst, /raise SystemExit/);

  // No project-generator recipes: one xcodegen run rebuilds the project from
  // a stale recipe and wipes weeks of changes.
  for (const f of ["project.yml", "Project.swift", "project.yaml"]) {
    assert.ok(!fs.existsSync(pkgPath(f)), `${f} must not exist`);
  }

  // All four scripts must require the group.xxx shape and reject truncated/empty values on the spot
  for (const f of ["install-island-app.py", "install-island-hooks.py",
                   "install-codex-island-hooks.py", "island-day-report.py"]) {
    const s = fs.readFileSync(pkgPath(f), "utf8");
    assert.match(s, /not out\.startswith\("group\."\) or not out\.removeprefix\("group\."\)/,
      `${f}: validation not strict enough`);
  }
  // Same check on the Swift side
  assert.match(mon, /value\.hasPrefix\("group\."\), value\.count > "group\."\.count/);
  // The Team prefix must not come back: it stamps into the shipped binary and
  // creates a folder named after it on every user's machine
  assert.doesNotMatch(ent, /\$\(DEVELOPMENT_TEAM\)/, "no Team prefix in the entitlements");
  assert.doesNotMatch(plist, /\$\(DEVELOPMENT_TEAM\)/, "no Team prefix in Info.plist");
});

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
  const vm = fs.readFileSync(islandPath("IslandViewModel.swift"), "utf8");
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

test("persistent 'project · source' caption right of the wave, rotating when several run", () => {
  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(label.length > 0, "ActiveProjectLabel not found");

  // Rotate only what is RUNNING: green is over, shouldn't keep being announced (and removes itself in 15 min)
  const strip = view.match(/private struct AgentActivityStrip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(strip, /\.status == \.working \|\| \$0\.status == \.waiting/);
  assert.doesNotMatch(strip.match(/var activeProjects[\s\S]*?\n    \}/)?.[0] ?? "", /\.done/);
  // With nothing running the label disappears entirely, width back to the wave
  assert.match(strip, /if !activeProjects\.isEmpty/);

  // The ticker must be @State: the parent redraws every second; a plain let would replace the 3s clock before it completes
  assert.match(label, /@State private var ticker = Timer\.publish/);
  // Fixed width, or varying text re-lays-out the width-derived wave on every rotation
  assert.match(label, /private static let width: CGFloat = \d+/);
  assert.match(label, /\.frame\(width: Self\.width/);
  // Out-of-range normalizes via modulo — projects leave at any time; slot can't be assumed valid
  assert.match(label, /active\[slot % active\.count\]/);
  // Don't blink when only one is running
  assert.match(label, /guard active\.count > 1 else \{ return \}/);
});

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

// 2. Record two normally
let r1 = CareRecord(date: "2026-07-28", moveId: "neck-rolls", category: .neck, sets: 1, seconds: 40, source: "island", at: "2026-07-28T09:00:00+08:00")
let r2 = CareRecord(date: "2026-07-28", moveId: "eyes-blink", category: .eyes, sets: 1, seconds: 20, source: "island", at: "2026-07-28T10:00:00+08:00")
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

test("yellow survives the 15-min sweep, no silent container fallback, screen changes recompute, closing unmounts the card", () => {
  // Strip comments before asserting: banned words legitimately appear in
  // comments (e.g. "don't add .help()"), and unstripped they collide.
  const code = (s) => s.replace(/\/\/.*$/gm, "");
  const read = (name) => code(fs.readFileSync(islandPath(name), "utf8"));

  // ② Yellow's expiry policy has its OWN real-behavior test (see "stale
  //    policy runs real behavior" below). Here only the call site: pruneStale
  //    must go through StalePolicy, and the ViewModel keeps no duration constants.
  const vm = read("IslandViewModel.swift");
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

test("island sources split into 5 duty groups, never flattened back into one layer", () => {
  // Directories are the map for humans. **This is the repo's ONLY assertion
  // about "where files live"** — every other test finds files by name via
  // islandPath(), so moving directories means editing exactly this one.
  // ①→②→③→④ is also the island's running order: receive events → compute the
  // notch position → draw → offer care while you wait.
  const WHERE = {
    ".":            ["PerchApp.swift", "AppGroup.swift",
                     "Info.plist", "Perch.entitlements"],
    // StalePolicy belongs here: it answers "how long before an agent event is
    // stale" — event lifecycle, not interface
    "AgentEvents":  ["AgentEventMonitor.swift", "AgentEventLog.swift", "StalePolicy.swift"],
    "Notch":        ["IslandWindowController.swift", "IslandDisplayMetrics.swift",
                     "IslandHoverMonitor.swift", "IslandPresentationPhase.swift",
                     "IslandCapsuleShape.swift", "IslandCardShape.swift"],
    // AgentStatus.swift is pure Foundation on purpose: the closed capsule's
    // tally has to be compilable — and therefore testable — on its own.
    "Interface":    ["AgentStatus.swift", "IslandView.swift", "IslandViewModel.swift"],
    "Care":         ["CareMovePool.swift", "CareSessionClock.swift",
                     "CareSessionRecorder.swift", "CareLedger.swift"],
    "Resources":    ["Assets.xcassets", "BeatTick.aiff", "CompletionChime.aiff"],
  };

  const actual = new Map(islandTree().map((p) => [path.basename(p), path.dirname(p)]));
  for (const [dir, files] of Object.entries(WHERE)) {
    for (const f of files) assert.equal(actual.get(f), dir, `${f} should live in ${dir}/`);
  }

  // The reverse matters too: new files must not slip in unclassified, or in a
  // few months everything is flat again
  const declared = new Set(Object.values(WHERE).flat());
  const stray = [...actual.keys()].filter((f) => !declared.has(f));
  assert.deepEqual(stray, [], `files not registered in any group: ${stray.join(", ")}`);

  // AppGroup stays top-level on purpose: socket / event log / ledger all ask
  // it where the container is; filing it under any one of them is a lie.
  assert.equal(actual.get("AppGroup.swift"), ".", "AppGroup is the shared foundation of all three, must stay top-level");

  // The project must group too: Xcode's navigator shows PBXGroups — grouped
  // on disk but flat in the project is grouped for nobody.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  for (const g of ["AgentEvents", "Notch", "Interface", "Care", "Resources"]) {
    assert.match(pbx, new RegExp(`/\\* ${g} \\*/ = \\{\\n\\t\\t\\tisa = PBXGroup;`), `project is missing the ${g} group`);
  }
});

test("nothing in the public package may locate the author — the scan surface comes from the single manifest", () => {
  // ⚠️ A hand-copied file list is this guard's most dangerous form: lists
  // drift — missing the guard itself, the docs, the dot-directories — and
  // then stay reliably green.
  // "Which files go public" has exactly one source of truth: perch-package.json.
  // It lists ROOTS, not file names; the scan expands over the real file
  // system, dotfiles included — hand-copying misses, walking doesn't.
  const manifest = JSON.parse(
    fs.readFileSync(pkgPath("perch-package.json"), "utf8"));

  // ⚠️ Must be a SINGLE-PASS replace. Four chained replaces go wrong: after
  // step three turns `**` into `.*`, step four's `*` -> `[^/]*` rewrites that
  // freshly made `.*`, and `**/.omc/**` matches only one path level — deep
  // files inside .omc slip through.
  const globToRe = (g) => new RegExp("^" + g.replace(
    /\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/g,
    (m) => ({ "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*" }[m] ?? "\\" + m)) + "$");
  const neverCopy = Object.keys(manifest.neverCopy).map(globToRe);

  // The walk skips NOTHING that starts with a dot — dot-directories are
  // exactly where machine paths hide
  const walk = (abs, rel, out) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const [a, r] = [path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name];
      e.isDirectory() ? walk(a, r, out) : out.push(r);
    }
    return out;
  };

  // First prove the walker really sees dotfiles (make a temporary one; don't bet the repo happens to have one)
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "perch-dotwalk-"));
  fs.mkdirSync(path.join(probe, ".hidden"));
  fs.writeFileSync(path.join(probe, ".hidden", "x.txt"), "x");
  assert.deepEqual(walk(probe, "", []), [".hidden/x.txt"], "the walker cannot see dot directories — such a guard cannot be trusted");
  fs.rmSync(probe, { recursive: true, force: true });

  const all = [];
  for (const root of manifest.include) {
    const abs = path.join(ROOT, root);
    assert.ok(fs.existsSync(abs), `${root} from the manifest does not exist; the manifest drifted`);
    fs.statSync(abs).isDirectory() ? walk(abs, root, all) : all.push(root);
  }
  const skipped = all.filter((f) => neverCopy.some((re) => re.test(f)));
  const scanned = all.filter((f) => !neverCopy.some((re) => re.test(f)));

  // ⚠️ In the extracted package the check must run BOTH ways. Manifest → disk
  // alone cannot see a file that appeared AFTER the copy: a .pyc dropped by a
  // test run, an editor's scratch file, a downloaded asset. Those never sit
  // under a manifest root, so the walk above never reaches them — and they are
  // exactly the files that carry an absolute home path.
  //
  // Whatever is present in the extracted package IS what ships, so:
  //   · a neverCopy match EXISTING here is itself the alarm — the export never
  //     copies those, so anything matching was written afterwards, and a
  //     manual copy or a zip would carry it off even though git ignores it;
  //   · anything the manifest does not account for must not be here at all.
  // Only meaningful in the package layout: the mother repo is full of files
  // that are legitimately none of this package's business.
  if (PKG === ROOT) {
    const onDisk = walk(ROOT, "", []).filter((f) => !f.startsWith(".git/"));
    const covered = (rel) => manifest.include.some((r) => rel === r || rel.startsWith(r + "/"));
    const litter = onDisk.filter((f) => neverCopy.some((re) => re.test(f)));
    assert.deepEqual(litter, [], `litter the extraction never copied: ${litter.join(", ")}`);
    const unaccounted = onDisk.filter((f) => !covered(f));
    assert.deepEqual(unaccounted, [], `present on disk but absent from the manifest: ${unaccounted.join(", ")}`);
  }

  // Control group: the scan surface must not collapse. The most dangerous
  // failure is "scanned nothing, then all green".
  assert.ok(scanned.length >= 40, `only ${scanned.length} files in the scan surface; the manifest is probably broken`);
  assert.ok(scanned.includes("tests/island.test.js"), "the guard must scan itself — missing itself is the easiest false green");

  // git assertions run only inside a git repo: the extracted package is not a
  // repo before `git init`, and "human eyeballs before init" is the designed
  // process — not a defect.
  let inGit = true;
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "pipe" }); }
  catch { inGit = false; }

  // Anything in neverCopy that actually exists must be gitignored, or it can
  // enter the repo at any time. (The export script never copies them; in a
  // clean extracted package this list should be empty.)
  if (!inGit) {
    assert.deepEqual(skipped, [], `not in a git repo, yet neverCopy-matching files exist: ${skipped.join(", ")}`);
  }
  for (const f of inGit ? skipped : []) {
    const r = execFileSync("git", ["check-ignore", f], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
    assert.equal(r, f, `${f} is in neverCopy but not blocked by gitignore`);
  }

  // Banned terms: whatever the machine can derive, derive; historical values
  // it can't derive live in tests/.private-terms, which never enters the repo.
  // The username derives on ANY machine, so the guard really scans on
  // contributor/CI machines too — it never idles.
  // The floor must not be hard-coded at 2: on machines without local private
  // material that forces people to edit this test, and editing a guard's test
  // is the easiest way to edit the guard away.
  const terms = [[os.userInfo().username, "the local username"]];
  const cfg = pkgPath("Config.xcconfig");
  if (fs.existsSync(cfg)) {
    const team = fs.readFileSync(cfg, "utf8").match(/DEVELOPMENT_TEAM\s*=\s*(\S+)/)?.[1];
    if (team && team !== "YOUR_TEAM_ID") terms.push([team, "the machine's real Team ID"]);
  }
  // Two kinds of line live in that file. Plain lines are identity terms,
  // matched literally, everywhere. `history:` lines are upstream working
  // vocabulary and are read as PATTERNS, not literals — one of them has to
  // say "this prefix followed by a digit", and a literal there fires on
  // ordinary identifiers that merely start the same way. They also get the
  // manifest exemption below, because the upstream manifest legitimately
  // contains them.
  const priv = path.join(ROOT, "tests", ".private-terms");
  const historyNeedles = [];
  if (fs.existsSync(priv)) {
    for (const l of fs.readFileSync(priv, "utf8").split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#")) continue;
      if (t.startsWith("history:")) historyNeedles.push(new RegExp(t.slice("history:".length).trim()));
      else terms.push([t, "a historical private term (see tests/.private-terms)"]);
    }
  }
  // On machines where the private files exist (= the author's), a term list
  // collapsed to just the username means loading broke — that must ring
  if (fs.existsSync(cfg) || fs.existsSync(priv)) {
    assert.ok(terms.length >= 2, "private files exist but no terms loaded — check Config.xcconfig and tests/.private-terms");
  }
  assert.ok(terms.length >= 1, "the banned-term list is empty");

  // The history vocabulary is deliberately NOT listed in this file. A
  // hard-coded list of the words that must not leak is itself a description of
  // the repo they come from — and this file ships. It lives in
  // tests/.private-terms instead, so the author's machine scans exactly as
  // before while the public copy carries no such list. A contributor machine
  // ends up with an empty list, which is correct: it cannot produce upstream
  // vocabulary in the first place.
  // Setting up only half of it must ring, or the guard quietly loses teeth.
  if (fs.existsSync(priv)) {
    assert.ok(historyNeedles.length >= 1,
      "tests/.private-terms exists but defines no history: lines — the development-history scan is off");
  }
  const patterns = [[/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "an email address"], [/\/Users\/[a-z]/i, "an absolute home path"]];

  let sawKnownContent = false;
  for (const rel of scanned) {
    const buf = fs.readFileSync(path.join(ROOT, rel));     // read as bytes: binaries count too
    if (buf.includes("IslandCardShape")) sawKnownContent = true;
    for (const [t, why] of terms) {
      assert.ok(!buf.includes(t), `${rel} contains ${why}`);
    }
    const text = buf.toString("latin1");
    for (const [re, why] of patterns) {
      assert.ok(!re.test(text), `${rel} contains ${why}: ${text.match(re)?.[0]}`);
    }
    const utf8 = buf.toString("utf8");
    for (const re of historyNeedles) {
      // Sole exemption: the manifest in the upstream layout is that repo's own
      // record; the export script strips that section, and in package layout
      // everything is checked.
      if (PKG !== ROOT && path.basename(rel) === "perch-package.json") continue;
      assert.ok(!re.test(utf8), `${rel} carries upstream vocabulary (it does not ship): ${utf8.match(re)?.[0]}`);
    }
  }
  assert.ok(sawKnownContent, "control group failed: even a guaranteed string was not seen — nothing was actually read");

  // The term list itself must never enter the repo — it holds exactly what must not leak
  if (inGit) {
    assert.equal(execFileSync("git", ["ls-files", "tests/.private-terms"], { cwd: ROOT, encoding: "utf8" }).trim(),
      "", "tests/.private-terms is in version control");
  }
});

test("hook installers recognize their own entries: no amnesia on container change, no friendly fire", () => {
  // This test watches BOTH failure directions:
  //   Too narrow — the current App Group as identity: after a container
  //                change the old entries go unrecognized, old and new
  //                coexist, every hook runs twice.
  //   Too wide  — path-only bridge.sock matching: **another app using the
  //                same file name in ITS OWN App Group gets recognized as
  //                ours**, and reinstalling deletes their hook.
  // Both "path" and "wire-protocol signature" must hold. No grepping — the
  // real matcher function runs.
  for (const script of ["install-island-hooks.py", "install-codex-island-hooks.py"]) {
    const py = [
      "import json, pathlib, sys",
      "sys.path.insert(0, 'tests')",
      "from installer_marker import load_marker",
      `ok = load_marker(${JSON.stringify(pkgPath(script))})['is_perch_command']`,
      // Take our real command from the local config, never assemble one — an
      // assembled command may differ from what is actually installed.
      // Machines without the hooks installed (contributors/CI, where a blind
      // read would FileNotFoundError) skip the two positive assertions; the
      // negative ones still run — "no friendly fire" is verifiable anywhere.
      "cfg = pathlib.Path.home() / '.claude/settings.json'",
      "verdict = 'ok'",
      "if cfg.exists():",
      "    real = json.loads(cfg.read_text())",
      "    mine = next((h['command'] for gs in real.get('hooks', {}).values() for g in gs",
      "                 for h in g.get('hooks', []) if 'bridge.sock' in h.get('command', '')), None)",
      "    if mine is not None:",
      "        assert ok(mine), 'our own real command not recognized'",
      "        assert ok(mine.replace('io.github.mossfinch.perch', 'com.whatever.old')), \\",
      "            'a changed App Group is no longer recognized as ours — the amnesia this guards against'",
      "    else:",
      "        verdict = 'ok-not-installed'",
      "else:",
      "    verdict = 'ok-not-installed'",
      "foreign = 'nc -U \"$HOME/Library/Group Containers/AB12CD34EF.group.com.someoneelse.app/bridge.sock\"'",
      "assert not ok(foreign), 'a same-named bridge.sock in a foreign container was recognized as ours — their hook would get deleted'",
      "assert not ok('sh -c \\'[ -x \"$HOME/.some-tool/bin/some-tool-bridge\" ] && x\\''), 'another tool\\'s bridge script was misrecognized'",
      "assert not ok('echo hello'), 'the matcher is too wide'",
      "print(verdict)",
    ].join("\n");
    const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
    assert.ok(out === "ok" || out === "ok-not-installed", `${script}'s ownership marker is broken: ${out}`);
    const src = fs.readFileSync(pkgPath(script), "utf8");
    assert.doesNotMatch(src, /^\w*MARK\w* = APP_GROUP$/m,
      "no changeable value as identity — the shape is banned, not one name");
  }
});

test("ledger migration after a container change: source named by a human, four dangers all refused", () => {
  // Changing the App Group = changing the folder. Without the move the island
  // starts from an empty ledger, and the first session writes a new one with
  // ONE record — looking like dozens of history entries vanished. So
  // migration must be a procedure, not a one-off manual copy.
  //
  // The source must be named by a human (--migrate-from), never scanned for:
  // with no Team prefix (a Team ID is real-name information; this package
  // carries none), a prefix scan matches every app's shared container on the
  // machine. Everything below runs the REAL migration function, no grepping.
  const py = [
    "import sys, tempfile, pathlib, json, shutil, os, inspect",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    "def fresh(shutil_impl=shutil):",
    `    ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))},`,
    "                        ['ledger_records', 'migrate_ledger'],",
    "                        {'Path': pathlib.Path, 'shutil': shutil_impl, 'json': json, 'os': os,",
    "                         'LEDGER_NAME': 'care-ledger.json'})",
    "    return ns['migrate_ledger']",
    "mig = fresh()",
    "NEW, OLD = 'group.new', 'group.old'",
    // Fixtures must be REAL records: the migration validates the whole
    // contract, so a ledger of `{'i': 0}` placeholders would (rightly) be
    // refused and this test would prove nothing about the happy path.
    "def record(i):",
    "    return {'date': '2026-07-30', 'moveId': 'chin-tuck', 'category': 'neck',",
    "            'sets': 1, 'seconds': 34, 'source': 'island',",
    "            'at': '2026-07-30T09:00:00+08:00'}",
    "def setup(files):",
    "    r = pathlib.Path(tempfile.mkdtemp())",
    "    for g, n in files.items():",
    "        (r/g).mkdir(parents=True)",
    "        (r/g/'care-ledger.json').write_text(json.dumps({'version':1,'records':[record(i) for i in range(n)]}))",
    "    return r",
    "def count(r, g):",
    "    f = r/g/'care-ledger.json'",
    "    return len(json.loads(f.read_text())['records']) if f.exists() else None",
    "def refuses(fn, why):",
    "    try:",
    "        fn(); raise AssertionError('did not refuse: ' + why)",
    "    except SystemExit as e:",
    "        return str(e)",
    // ① The normal move: copy only, never delete
    "r = setup({OLD: 39}); mig(OLD, NEW, r)",
    "assert count(r, NEW) == 39, 'the old ledger should have been moved over'",
    "assert count(r, OLD) == 39, 'copy only — the source must stay untouched'",
    // ② Target already has data -> refuse, and the error must give both counts so a human can judge
    "r = setup({OLD: 39, NEW: 1})",
    "msg = refuses(lambda: mig(OLD, NEW, r), 'target already has a ledger')",
    "assert count(r, NEW) == 1, 'overwrote a target that already had a ledger — that is data loss'",
    "assert '1 records' in msg and '39 records' in msg, 'the refusal must state both counts: ' + msg",
    // ③ Target is a symlink -> refuse, and the linked-to file must keep every byte
    "r = setup({OLD: 39}); (r/NEW).mkdir()",
    "victim = r/'someone-elses.json'; victim.write_text('untouched')",
    "(r/NEW/'care-ledger.json').symlink_to(victim)",
    "refuses(lambda: mig(OLD, NEW, r), 'target is a symlink')",
    "assert victim.read_text() == 'untouched', 'data was written through the symlink to somewhere else'",
    // ④ Source is a symlink -> refuse the same way
    "r = setup({OLD: 39}); (r/'group.link').mkdir()",
    "(r/'group.link'/'care-ledger.json').symlink_to(r/OLD/'care-ledger.json')",
    "refuses(lambda: mig('group.link', NEW, r), 'source is a symlink')",
    // ⑤ Source does not parse -> refuse (moved over, the island could not read it — the reader side's standing invariant)
    "r = setup({OLD: 39}); (r/OLD/'care-ledger.json').write_text('{broken')",
    "refuses(lambda: mig(OLD, NEW, r), 'source is broken JSON')",
    "assert count(r, NEW) is None, 'a broken ledger was moved over'",
    // ⑤b JSON-legal but the WRONG SHAPE -> refuse. A count-only check waves
    //     this through, and then the island throws on its next launch: the
    //     failure would have been relocated, not avoided.
    "r = setup({OLD: 39})",
    "(r/OLD/'care-ledger.json').write_text(json.dumps({'version': 1, 'records': [{'date': '2026-07-30'}]}))",
    "msg = refuses(lambda: mig(OLD, NEW, r), 'records are missing their fields')",
    "assert 'missing' in msg, 'the refusal should say what is missing: ' + msg",
    "assert count(r, NEW) is None, 'a schema-invalid ledger was moved over'",
    "(r/OLD/'care-ledger.json').write_text(json.dumps({'version': 1, 'records': [dict(record(0), sets=True)]}))",
    "refuses(lambda: mig(OLD, NEW, r), 'sets is a boolean, not a count')",
    "(r/OLD/'care-ledger.json').write_text(json.dumps({'records': [record(0)]}))",
    "refuses(lambda: mig(OLD, NEW, r), 'no version at the top level')",
    // ⑥ Source missing / source equals target -> refuse, never pass silently
    "r = setup({})",
    "refuses(lambda: mig(OLD, NEW, r), 'source does not exist at all')",
    "refuses(lambda: mig(NEW, NEW, r), 'source and target are the same')",
    // ⑦ Atomicity: dying halfway must leave the target NONEXISTENT — a half-file would block every retry forever
    "class HalfWay:",
    "    def __init__(self):",
    "        self.dst = None",
    "    def copy2(self, src, dst):",
    "        self.dst = str(dst)",
    "        pathlib.Path(dst).write_text('{\"version\":1,\"reco')",
    "        raise OSError('disk full')",
    "r = setup({OLD: 39}); impl = HalfWay(); half = fresh(impl)",
    "try:",
    "    half(OLD, NEW, r); raise AssertionError('the fake copy2 was never called; this case tested nothing')",
    "except OSError:",
    "    pass",
    "assert impl.dst and impl.dst.endswith('.migrating'), 'the copy went straight at the real ledger path'",
    "assert count(r, NEW) is None, 'a truncated care-ledger.json was left at the target; once it exists the move can never run again'",
    "assert not list((r/NEW).glob('*.migrating')), 'the failed staging file was left behind — it would block every retry'",
    // ⑧ The source must have NO default: the machine never guesses, only the caller names it
    "p = inspect.signature(mig).parameters",
    "assert list(p)[:2] == ['source_group','target_group'], 'the first two parameters should be source and target'",
    "assert p['source_group'].default is inspect.Parameter.empty, 'the source must have no default; the machine must not guess'",
    "print('ok')",
  ].join("\n");
  assert.equal(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim(), "ok");

  const inst = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  // Migration must run BEFORE the island starts: a running island may record
  // at any moment, and once the target file exists the move can never run again.
  // Capture to the trailing `if __name__`, never treat a blank line as the
  // function's end — blank lines inside main would make this falsely red
  const main = inst.match(/def main\(\)[\s\S]*?\nif __name__/)?.[0] ?? "";
  assert.ok(main.indexOf("migrate_ledger(") > 0 &&
            main.indexOf("migrate_ledger(") < main.indexOf("install_launch_agent()"),
    "migration must come before install_launch_agent()");
  // The container scan that misfires on other apps must not come back
  assert.doesNotMatch(inst, /glob\(\s*f?["'][^"']*care-ledger/,
    "no guessing which ledger is old by scanning containers");
});

test("after a rename, the completion bell installed under the OLD name must still be recognized, or every turn pushes twice", () => {
  // The bell block locates itself, and its comment title carries the product
  // name — names change. Find by name and the block already installed on the
  // machine can't be found after a rename: old and new coexist, codex pushes
  // twice per finished turn. Same trap as "App Group as identity".
  // This runs the real our_tail_span, no grepping.
  const py = [
    "import sys, pathlib, re",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `src = pathlib.Path(${JSON.stringify(pkgPath("install-codex-island-hooks.py"))}).read_text()`,
    "ns = {'re': re}",
    "a = src.index('OWN_ARTIFACTS = '); b = src.index('WIRE_PATTERN = ')",
    "exec(src[a:src.index(chr(10), b)], ns)",
    `ns = load_functions(${JSON.stringify(pkgPath("install-codex-island-hooks.py"))}, ['our_tail_span'], ns)`,
    "find = ns['our_tail_span']",
    "SOCK = 'Group Containers/group.io.github.mossfinch.perch/bridge.sock'",
    "SIG  = 'printf \"complete\\\\t%s\\\\t%s-$$\\t' + 'codex\"'",   // a real tab, same as in the script
    "OTHER = '# --- somebody else\\'s block ---\\necho hi\\n'",
    "def ours(title):",
    "    return '# --- ' + title + ' ---\\nsock=\"$HOME/Library/' + SOCK + '\"\\n' + SIG + '\\n'",
    // ① A title written under an OLD name must still be recognized — the rename gate.
    // The title is deliberately a name totally unlike the current NOTIFY_MARK —
    // what's verified is "independent of the title", not one particular
    // historical name (that would cover one rename and need patching for the next)
    "old = OTHER + ours('any old name whatsoever (bell)')",
    "span = find(old)",
    "assert span is not None, 'the block installed under an old name went unrecognized — a rename would make every turn push twice'",
    "start, end = span",
    "assert old[start:].startswith('# --- any old name whatsoever'), 'located the wrong block: ' + repr(old[start:start+30])",
    "assert start > 0 and OTHER in old[:start], 'swallowed somebody else\\'s block too'",
    "assert end == len(old), 'nothing follows here, so the span should reach the end'",
    // ② The current name is of course recognized as well
    "assert find(OTHER + ours('Perch (bell)')) is not None",
    // ③ Path only, no protocol signature -> not ours, must never be touched (another tool may have a bridge.sock too)
    "assert find(OTHER + '# --- someone else also uses bridge.sock ---\\nx=\"$HOME/Library/' + SOCK + '\"\\n') is None, \\",
    "    'claimed ownership on the path alone — that deletes other people\\'s work'",
    // ④ Signature only, no own-artifact path -> also not ours
    "assert find(OTHER + '# --- signature only ---\\n' + SIG + '\\n') is None",
    // ⑤ A clean file -> never installed
    "assert find('# --- someone else ---\\necho hi\\n') is None",
    // ⑥ Somebody appended their own block AFTER ours. The span must stop at
    //    their header — reinstalling replaces our lines and leaves theirs
    //    alone. "From our start to the end of the file" would delete them.
    "AFTER = '# --- another tool, added later ---\\necho later\\n'",
    "sandwich = OTHER + ours('Perch (bell)') + AFTER",
    "start, end = find(sandwich)",
    "assert sandwich[:start] == OTHER, 'the span begins too early'",
    "assert sandwich[end:] == AFTER, 'the span swallows what follows it — reinstalling would delete their block'",
    "print('ok')",
  ].join("\n");
  assert.equal(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim(), "ok");

  // The title takes no part in matching: NOTIFY_MARK only writes the human-readable header
  const src = fs.readFileSync(pkgPath("install-codex-island-hooks.py"), "utf8");
  const finder = src.match(/def our_tail_span[\s\S]*?\n\ndef /)?.[0] ?? "";
  assert.ok(finder.length > 0, "our_tail_span not found");
  assert.doesNotMatch(finder, /NOTIFY_MARK/, "self-location must not use the product name — names change");
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

// Yellow (isWaiting=true): **it must still be there after a meal** — the whole point of the rule
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

test("perch renders every care move through one two-state guided card", () => {
  const view = fs.readFileSync(ISLAND_VIEW_SWIFT, "utf8");

  assert.match(view, /struct GuidedCareCard: View/);
  assert.match(view, /struct CareFrameStrip: View/);
  assert.match(view, /struct CategoryDock: View/);
  assert.match(view, /ForEach\(move\.frames\)/);
  assert.match(view, /viewModel\.currentFrameIndex/);
  assert.match(view, /viewModel\.completedReps/);
  assert.match(view, /CareMovePool\.selectableCategories/);
  assert.match(view, /isHighlighted \? 1 : 0\.45/);
  // The bar under the current frame fades with the beat: its duration is
  // driven by that frame's beat length, gone exactly at the switch. A static
  // highlight can only say "this one is current", never foretell the switch.
  // Only "fade follows beat length" is guarded; the easing curve is free.
  assert.match(view, /beatDuration: move\.frameDuration\(at: index\)/);
  assert.match(view, /withAnimation\(\.\w+\(duration: beatDuration\)\)/);

  assert.doesNotMatch(view, /NeckRollsGuidedCard/);
  assert.doesNotMatch(view, /NeckRollsMovementStrip/);
  assert.doesNotMatch(view, /move\.id == "neck-rolls"/);
  assert.doesNotMatch(view, /legacyIdleCard|legacyActiveCard/);
  assert.doesNotMatch(view, /Complete a set|Complete set/);
  assert.doesNotMatch(view, /targetRepCount/);
});

// Deliberately NOT ~40 pinned source strings (contentHorizontalInset=36,
// mainAreaHeight=148, min(92, slotWidth*1.28) and other layout magic
// numbers). Pinned literals are no visual gate: layout can render broken and
// stay green, while the numbers they lock are exactly what a layout fix must
// change — blocking the right edits. Structural invariants only: guard
// architecture, data flow, and fixed bugs; lock no tunable layout number.

test("perch guided card stays responsive, data-driven, and state-consistent", () => {
  const view = fs.readFileSync(ISLAND_VIEW_SWIFT, "utf8");

  // Adaptive card sizing, not a pinned pixel height (a pinned height leaves a dead zone at the card's bottom)
  assert.match(view, /GeometryReader/);
  assert.doesNotMatch(view, /mainAreaHeight/, "no pinned height for the main area, or the bottom dead zone returns");

  // Frame size computed from frame count by one formula (a card takes 2/3/4 frames), not hard-coded per move
  assert.match(view, /slotWidth/);
  assert.match(view, /move\.frames\.count/);

  // Session highlight = brighten + enlarge the current frame, growth riding
  // the beat (guard "highlighted and breathing"; the exact factor and easing stay tunable)
  assert.match(view, /isHighlighted \? [\d.]+ : [\d.]+/);
  assert.match(view, /breath/);

  // The wave reads the same real source as the dots (projects); never
  // agentStatus, or the panel opens to "green dot + white still-moving wave".
  assert.match(view, /struct AgentActivityStrip: View/);
  assert.match(view, /AgentActivityStrip\(projects: viewModel\.projects/);
  assert.doesNotMatch(view, /AgentActivityStrip\([^)]*viewModel\.agentStatus/, "the wave must not read agentStatus");

  // Anti-regression: no return of the neck-rolls-only card / legacy text card / two-column leftovers
  assert.doesNotMatch(view, /NeckRollsGuidedCard|NeckRollsMovementStrip/);
  assert.doesNotMatch(view, /controlColumnWidth|controlAreaWidth/);
  assert.doesNotMatch(view, /\.lineLimit\(2\)/);
});

