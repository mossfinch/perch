// The care card that opens under the island: the guided two-state card, the category ring,
// and what may sit above it.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together; a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandViews, viewModelSource, islandPath, CARE_MOVE_POOL_SWIFT } = require("./island-paths");

test("opened panel stacks nothing above the care card", () => {
  const view = islandViews();
  const opened = view.match(/private func openedPlaceholder[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(opened.length > 0, "openedPlaceholder not found");
  assert.match(opened, /return GuidedCareCard\(/);
  // The frame height is fixed, so one extra sibling above the card pushes the
  // whole card down and shrinks it by the same amount, and "auto-peek" and
  // "hover open" would no longer look like the same place (the extra content
  // would also sit behind the notch, invisible anyway). What this guards: the
  // card is the opened panel's only content.
  assert.doesNotMatch(opened, /VStack|HStack|ZStack/);
});

test("selected category ring shows how many moves and which one, continuously", () => {
  const pool = fs.readFileSync(CARE_MOVE_POOL_SWIFT, "utf8");
  assert.match(pool, /static func moves\(in category: CareCategory\)/);
  assert.match(pool, /static func index\(of moveID: String, in category: CareCategory\)/);

  const view = islandViews();
  const dock = view.match(/private struct CategoryDock[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(dock.length > 0, "CategoryDock not found");

  // The ring appears only when there is something to flip through; eyes has 1 move, so no ring
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

test("perch renders every care move through one two-state guided card", () => {
  const view = islandViews();

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

// No pinned layout literals here (contentHorizontalInset=36, mainAreaHeight=148,
// min(92, slotWidth*1.28) and the like). A pinned literal is no visual gate:
// layout can render broken and stay green, while the numbers it locks are
// exactly what a layout fix must change, so it blocks the right edits.
// Structural invariants only: guard architecture, data flow and fixed bugs, and
// lock no tunable layout number.

test("perch guided card stays responsive, data-driven, and state-consistent", () => {
  const view = islandViews();

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

test("the completion chime has one switch, in the corner under the figures, and it is remembered", () => {
  const vm = viewModelSource();
  // Remembered across launches: a switch that springs back every morning
  // reads as broken, not as remembered.
  assert.match(vm, /@Published var chimeMuted: Bool = UserDefaults\.standard\.bool\(forKey: chimeMutedKey\)/);
  assert.match(vm, /UserDefaults\.standard\.set\(chimeMuted, forKey: Self\.chimeMutedKey\)/);
  assert.match(vm, /func toggleChime\(\) \{ chimeMuted\.toggle\(\) \}/);

  // Muted means silent, and it reaches the chime only. The beat is the move's
  // clock (the head is turned away during the side-neck and levator
  // stretches, so only sound keeps up), and the switch must not touch it.
  const chime = vm.match(/private func playChime\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(chime, "playChime not found");
  assert.match(chime, /guard !chimeMuted else \{ return \}/, "muted must mean silent");
  const beat = vm.match(/private func playBeat\(\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(beat, "playBeat not found");
  assert.doesNotMatch(beat, /chimeMuted/, "the beat is the move's clock, not a notification");

  // The switch lives in the corner under the figures: an overlay, in no row.
  const view = islandViews();
  const card = view.match(/struct GuidedCareCard: View[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(card, "GuidedCareCard not found");
  assert.match(card, /\.overlay\(alignment: \.bottomTrailing\) \{ chimeToggle \}/,
    "the switch is an overlay in the bottom-trailing corner: no height, nothing moved");
  assert.match(card, /viewModel\.toggleChime\(\)/);
  assert.match(card, /speaker\.slash\.fill/);
  assert.match(card, /speaker\.wave/);
  // A glyph of 12pt cannot be pressed; the button needs a real hit area.
  assert.match(card, /\.frame\(width: 24, height: 24\)[\s\S]{0,80}\.contentShape\(Rectangle\(\)\)/);

  // The three instrument rows carry readings, never a switch.
  const band = card.match(/VStack\(spacing: GuidedCareLayout\.topRowSpacing\)[\s\S]*?\.padding\(\.top, GuidedCareLayout\.activityTopPadding\)/)?.[0] ?? "";
  assert.ok(band, "the top band was not found");
  assert.doesNotMatch(band, /chime/i, "the instrument rows must not carry the switch");
  const controls = card.match(/private var topControls: some View[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(controls, "topControls not found");
  assert.doesNotMatch(controls, /chime/i, "the move's controls must not carry the switch");
});

// ── Which move the card offers ────────────────────────────────────────────────
// The catalog is walked in order, across categories, picking up after the last move the
// ledger saw. Compiled and run against the real catalog, not read.
test("the card offers the move after the last one recorded, in catalog order, wrapping at the end", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-care-rotation-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "care-rotation-check");
  fs.writeFileSync(main, `
let all = CareMovePool.all
precondition(all.count >= 3, "control: the catalog is too small to show rotation")
// A ledger with nothing in it starts at the top.
precondition(CareMovePool.next(after: nil) == all[0], "empty ledger")
// Otherwise the one after the last recorded, in catalog order, category lines and all …
for i in 0..<(all.count - 1) {
    precondition(CareMovePool.next(after: all[i].id) == all[i + 1], "after \\(all[i].id)")
}
let lastNeck = all.lastIndex { $0.category == .neck }!
precondition(all[lastNeck + 1].category != .neck, "control: the catalog has a category boundary to cross")
// … wrapping to the top at the end …
precondition(CareMovePool.next(after: all[all.count - 1].id) == all[0], "wrap")
// … and a move id the catalog no longer carries starts over rather than crashing.
precondition(CareMovePool.next(after: "no-such-move") == all[0], "unknown id")
print("ok")
`);
  execFileSync("swiftc", [CARE_MOVE_POOL_SWIFT, islandPath("CareLedger.swift"), islandPath("AppGroup.swift"), main,
                          "-o", binary], { stdio: "pipe" });
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "ok");
});

test("the card is handed the next move at launch and after every move the ledger took", () => {
  const vm = viewModelSource();
  // One place answers "what comes next", off one read of the ledger.
  const seed = vm.match(/func seedMoveFromLedger\(\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(seed, "seedMoveFromLedger not found");
  assert.equal((seed.match(/CareLedgerStore\.load\(/g) ?? []).length, 1, "the ledger must be read once");
  assert.match(seed, /currentMove = CareMovePool\.next\(after: \w+\.records\.last\?\.moveId\)/,
    "the move after the ledger's last record must land on the card");
  // Launch: the card opens on the rotation, not on the catalog's first move.
  const init = vm.match(/\n    init\(\) \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(init, "init not found");
  assert.match(init, /seedMoveFromLedger\(\)/, "launch must show the next move, not the catalog's first");
  // After a move: only once the ledger has taken it. A failed save leaves the session
  // paused on the card, waiting to be saved again. Swapping the move then would show one
  // move and save another.
  const persist = vm.match(/private func persistCareSession\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(persist, "persistCareSession not found");
  const [success, failure] = persist.split("} catch {");
  assert.ok(failure !== undefined, "persistCareSession lost its catch");
  assert.match(success, /CareLedgerStore\.append\([\s\S]*seedMoveFromLedger\(\)/,
    "a move the ledger took must advance the card, after it is written");
  assert.doesNotMatch(failure, /seedMoveFromLedger/, "a failed save must keep its move on the card");
  // Nothing else sets the move: the rotation, and a category picked by hand.
  assert.equal((vm.match(/\bcurrentMove = /g) ?? []).length, 2, "only the rotation and a hand-picked category set the move");
});

// ── The stretch nudge: when the card suggests a real break ────────────────────
// Compiled and run, not read: the rule is pure Foundation, so its boundaries can be
// exercised against the real code. FlowMath supplies the turn type and the plausible
// ceiling; AgentStatus supplies the line states the hand-off is read from.
function runStretchNudge(mainBody) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-stretch-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "stretch-check");
  fs.writeFileSync(main, `import Foundation
let t0 = Date(timeIntervalSince1970: 1_700_000_000)
func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }
func turn(_ a: Double, _ b: Double, _ p: String = "/x/a") -> FlowMath.Turn {
    FlowMath.Turn(start: at(a), end: at(b), project: p, source: "claude", truncated: false)
}
func secs(_ d: Date?) -> String { d.map { String(Int($0.timeIntervalSince(t0))) } ?? "null" }
// The island refreshes every 15 seconds, with the machine awake: uptime runs with the clock.
func tick(_ n: inout StretchNudge, from: Double, through: Double, busy: Bool = false,
          turns: (Double) -> [FlowMath.Turn]) {
    var t = from
    while t < through { n.refresh(turns: turns(t), busy: busy, now: at(t), uptime: t); t += 15 }
    n.refresh(turns: turns(through), busy: busy, now: at(through), uptime: through)
}
${mainBody}
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("AgentStatus.swift"),
                          islandPath("StretchNudge.swift"), main, "-o", binary], { stdio: "pipe" });
  return JSON.parse(execFileSync(binary, { encoding: "utf8" }));
}

test("a stretch holds across a pause of exactly five minutes and breaks one second past it", () => {
  const got = runStretchNudge(`
func start(_ turns: [FlowMath.Turn]) -> String { secs(StretchNudge.latest(in: turns)?.start) }
// The live end: work that stopped at the hour is still a stretch going until the pause passes.
func dueAt(_ now: Double) -> Bool {
    var n = StretchNudge()
    tick(&n, from: 0, through: now) { t in [turn(0, min(t, StretchNudge.after))] }
    return n.due
}
// A line working quietly, watched every 15 seconds, keeps its stretch whatever the events say.
var quiet = StretchNudge()
tick(&quiet, from: 100, through: 5000, busy: true) { _ in [turn(0, 100)] }
// A machine asleep (the clock moves on, uptime stands still) is a pause, whatever a line is
// still marked as. Checked at exactly the pause and one second more. Only the time asleep
// counts: exactly the pause asleep plus a second awake is still one stretch.
func slept(_ s: Double, awake: Double = 0) -> String {
    var n = StretchNudge()
    n.refresh(turns: [turn(0, 100)], busy: true, now: at(100), uptime: 100)
    n.refresh(turns: [turn(0, 100)], busy: true, now: at(100 + s + awake), uptime: 100 + awake)
    return secs(n.watched?.start)
}
// Awake, a refresh the system held back changes nothing: the line was working all along.
var held = StretchNudge()
held.refresh(turns: [turn(0, 100)], busy: true, now: at(100), uptime: 100)
held.refresh(turns: [turn(0, 100)], busy: true, now: at(5000), uptime: 5000)
var fresh = StretchNudge()
fresh.refresh(turns: [], busy: true, now: at(50), uptime: 50)
var idle = StretchNudge()
idle.refresh(turns: [], busy: false, now: at(50), uptime: 50)
let parts: [String] = [
    "\\"weldAtPause\\":\\(start([turn(0, 100), turn(400, 500)]))",
    "\\"breakPastPause\\":\\(start([turn(0, 100), turn(401, 500)]))",
    "\\"parallelLines\\":\\(start([turn(0, 1000), turn(200, 300, "/x/b"), turn(1200, 1300)]))",
    "\\"implausibleDropped\\":\\(start([turn(0, 7200), turn(7300, 7400)]))",
    "\\"noTurns\\":\\(start([]))",
    "\\"dueAtPause\\":\\(dueAt(StretchNudge.after + StretchNudge.pause))",
    "\\"duePastPause\\":\\(dueAt(StretchNudge.after + StretchNudge.pause + 1))",
    "\\"busyExtends\\":\\(secs(quiet.watched?.start))",
    "\\"lidAtPause\\":\\(slept(StretchNudge.pause))",
    "\\"lidPastPause\\":\\(slept(StretchNudge.pause + 1))",
    "\\"lidAtPauseThenAwake\\":\\(slept(StretchNudge.pause, awake: 1))",
    "\\"heldTimer\\":\\(secs(held.watched?.start))",
    "\\"emptyBusy\\":\\(secs(fresh.watched?.start))",
    "\\"emptyIdle\\":\\(secs(idle.watched?.start))",
]
print("{" + parts.joined(separator: ",") + "}")
`);
  assert.deepEqual(got, {
    // A gap of exactly the pause still counts as continuous, as in the daily report. One
    // second more starts a new stretch.
    weldAtPause: 0, breakPastPause: 401,
    // Parallel lines merge: the short line inside the long one must not end the stretch early.
    parallelLines: 0,
    // A turn at the plausible ceiling is a sleeping machine, not two hours of work.
    implausibleDropped: 7300, noTurns: null,
    // The same rule at the live end: the stretch is still going until the pause has passed.
    dueAtPause: true, duePastPause: false,
    // A quiet tool can run for minutes without an event; a line still working is not a pause…
    busyExtends: 0,
    // …and so is a refresh the system held back while awake. A machine asleep is different:
    // longer than the pause is a pause, whatever a line is still marked as.
    heldTimer: 0, lidAtPause: 0, lidPastPause: 401, lidAtPauseThenAwake: 0,
    // Work that has only just started is a stretch that begins now.
    emptyBusy: 50, emptyIdle: null,
  });
});

test("the break is asked for once per stretch, at a hand-off, and only once the stretch is due", () => {
  const got = runStretchNudge(`
// The threshold is a decision, so the boundaries are read from it rather than copied.
let due = StretchNudge.after
let working: (Double) -> [FlowMath.Turn] = { t in [turn(0, t)] }
var n = StretchNudge()
tick(&n, from: 0, through: due - 1, turns: working)
let early = n.statusChanged(from: .done, to: .working, moving: false, at: at(due - 1))
tick(&n, from: due - 1, through: due, turns: working)
let toolCall = n.statusChanged(from: .working, to: .working, moving: false, at: at(due))
let notWorking = n.statusChanged(from: .done, to: .waiting, moving: false, at: at(due))
let midMove = n.statusChanged(from: .done, to: .working, moving: true, at: at(due))
let newLine = n.statusChanged(from: nil, to: .working, moving: false, at: at(due))
let asking = n.asking
let second = n.statusChanged(from: .done, to: .working, moving: false, at: at(due))
n.moved()
let afterMove = n.asking
// Ten quiet minutes, then a new stretch that runs its own hour.
let back = due + 600
tick(&n, from: due, through: back + due) { t in t < back ? [turn(0, due)] : [turn(0, due), turn(back, t)] }
let nextStretch = n.statusChanged(from: .waiting, to: .working, moving: false, at: at(back + due))

var early2 = StretchNudge()
tick(&early2, from: 0, through: due / 2, turns: working)
early2.moved()
tick(&early2, from: due / 2, through: due, turns: working)
let moveBeforeDue = early2.statusChanged(from: .done, to: .working, moving: false, at: at(due))

var late = StretchNudge()
tick(&late, from: 0, through: due, turns: working)
late.moved()
let moveWhileDue = late.statusChanged(from: .done, to: .working, moving: false, at: at(due))

var paused = StretchNudge()
tick(&paused, from: 0, through: due, turns: working)
_ = paused.statusChanged(from: .done, to: .working, moving: false, at: at(due))
tick(&paused, from: due, through: due + 600) { _ in [turn(0, due)] }
let keptByShortQuiet = paused.asking

print("{" + [
    "\\"early\\":\\(early)", "\\"toolCall\\":\\(toolCall)", "\\"notWorking\\":\\(notWorking)",
    "\\"midMove\\":\\(midMove)", "\\"newLine\\":\\(newLine)", "\\"asking\\":\\(asking)",
    "\\"second\\":\\(second)", "\\"afterMove\\":\\(afterMove)", "\\"nextStretch\\":\\(nextStretch)",
    "\\"moveBeforeDue\\":\\(moveBeforeDue)", "\\"moveWhileDue\\":\\(moveWhileDue)",
    "\\"keptByShortQuiet\\":\\(keptByShortQuiet)",
].joined(separator: ",") + "}")
`);
  assert.deepEqual(got, {
    // One second short of the threshold is not yet due.
    early: false,
    // Every tool an agent runs arrives as another `working`; only a line that was not
    // working starting to work is a person handing work off.
    toolCall: false, notWorking: false,
    // Someone already doing a move is not interrupted to be told to move.
    midMove: false,
    // A hand-off exactly at the threshold asks, and the card's line starts asking.
    newLine: true, asking: true,
    // Once per stretch: later hand-offs in the same stretch stay quiet.
    second: false,
    // Finishing a move answers the request; the line goes back to its readings.
    afterMove: false,
    // A real pause starts a new stretch, which may ask again. Answering an approval prompt
    // counts as a hand-off too.
    nextStretch: true,
    // A move early in the stretch does not excuse the rest of it...
    moveBeforeDue: true,
    // ...but a move once the stretch is due answers it, even before the card asked.
    moveWhileDue: false,
    // A quiet spell is not an answer: reading at the desk looks exactly like a pause to the
    // island, so an open request survives it.
    keptByShortQuiet: true,
  });
});

// Replayed at the island's own pace: a refresh on every event (before the line's status
// changes, as applyProjectEvent orders it), one every 15 seconds, and none while the lid is
// shut. A single unit call cannot show these timings: what the stretch looked like between
// refreshes, and what the island never saw.
test("replayed at the island's pace, the ask survives a quiet tool, a rest between refreshes, and a shut lid", () => {
  const got = runStretchNudge(`
struct Island {
    var events: [FlowMath.Event] = []
    var lines: [String: IslandAgentStatus] = [:]
    var nudge = StretchNudge()
    var clock = 0.0
    var asleep = 0.0
    var asks: [Int] = []
    mutating func refresh(_ t: Double) {
        let turns = FlowMath.settle(events)
        nudge.refresh(turns: turns, busy: lines.values.contains(.working), now: at(t), uptime: t - asleep)
    }
    mutating func run(to t: Double) { while clock + 15 <= t { clock += 15; refresh(clock) } }
    mutating func event(_ t: Double, _ kind: String, _ line: String) {
        run(to: t)
        events.append(FlowMath.Event(time: at(t), event: kind, project: line, source: "claude"))
        events.removeAll { at(t).timeIntervalSince($0.time) > FlowMath.maxTurn }
        refresh(t)
        let after: IslandAgentStatus = kind == "working" ? .working : kind == "waiting" ? .waiting : .done
        if nudge.statusChanged(from: lines[line], to: after, moving: false, at: at(t)) { asks.append(Int(t)) }
        lines[line] = after
    }
    /// A line handed work at \`from\`, running a tool every minute through \`to\`.
    mutating func work(_ line: String, from: Double, through: Double) {
        var t = from
        while t <= through { event(t, "working", line); t += 60 }
    }
    mutating func move(_ t: Double) { run(to: t); nudge.moved() }
    /// Lid shut until \`t\`: no refresh at all in between.
    mutating func sleep(until t: Double) { asleep += t - clock; clock = t }
    /// Awake, but no refresh until \`t\`, as when the system holds a timer back.
    mutating func stall(until t: Double) { clock = t }
}
let H = StretchNudge.after

// ① 55 minutes of tool calls on /a, then a tool that runs quietly for ten (/a still working),
//    then work handed to /b at 65 minutes.
var quietTool = Island()
quietTool.work("/a", from: 0, through: 3300)
quietTool.run(to: 3900)
quietTool.event(3900, "working", "/b")

// ② Asked at 60 minutes and answered. Everything completes at 3607, and work resumes 5:01
//    later. The one second with no stretch (3907 to 3908) falls between the refreshes at
//    3900 and 3915. The new stretch reaches the hour at 7508.
var shortRest = Island()
shortRest.work("/a", from: 0, through: 3540)
shortRest.event(3600, "working", "/b")
shortRest.move(3605)
shortRest.event(3607, "complete", "/a")
shortRest.event(3607, "complete", "/b")
shortRest.work("/a", from: 3908, through: 3908 + H - 60)
shortRest.event(3908 + H, "working", "/b")

// ③ Asked at 60 minutes, left open; everything completes at 3610 and the lid shuts at 3615,
//    before the island has noticed any quiet. An hour later: the first refresh on waking,
//    or work handed off the moment the lid opens.
func askedThenLidShut() -> Island {
    var i = Island()
    i.work("/a", from: 0, through: 3540)
    i.event(3600, "working", "/b")
    i.event(3610, "complete", "/a")
    i.event(3610, "complete", "/b")
    i.run(to: 3615)
    i.sleep(until: 3615 + 3600)
    return i
}
var woke = askedThenLidShut()
woke.run(to: 3615 + 3600 + 15)
var backToWork = askedThenLidShut()
backToWork.event(3615 + 3600, "working", "/a")

// ④ The lid shuts while /a is still marked working (no complete ever came), for an hour;
//    on waking the first refresh still sees /a working, then work is handed to /b.
var lidOnWork = Island()
lidOnWork.work("/a", from: 0, through: 3000)
lidOnWork.sleep(until: 6600)
lidOnWork.run(to: 6615)
lidOnWork.event(6630, "working", "/b")

// ⑤ A tool is running on /a when the lid shuts; on waking an hour later its turn completes at
//    once, so the log's turn now runs straight across the hour. Then work is handed to /b.
var toolAcrossLid = Island()
toolAcrossLid.work("/a", from: 0, through: 3000)
toolAcrossLid.sleep(until: 6600)
toolAcrossLid.event(6605, "complete", "/a")
toolAcrossLid.event(6630, "working", "/b")

// ⑥ The same with the lid shut for ten minutes, not an hour: a tool starts at 55 minutes,
//    the lid shuts, and the turn completes the moment it opens at 3915.
var tenMinuteLid = Island()
tenMinuteLid.work("/a", from: 0, through: 3300)
tenMinuteLid.sleep(until: 3910)
tenMinuteLid.event(3915, "complete", "/a")
tenMinuteLid.event(3930, "working", "/b")

// ⑦ Asked at 60 minutes and answered; /a keeps working, then goes quiet on a long tool at 4200
//    while the machine stays awake but the island's timer is held back for ten minutes. The
//    same stretch runs on, and work is handed to /b an hour after the stall.
var heldTimer = Island()
heldTimer.work("/a", from: 0, through: 3540)
heldTimer.event(3600, "working", "/b")
heldTimer.move(3605)
heldTimer.event(3620, "complete", "/b")
heldTimer.work("/a", from: 3660, through: 4200)
heldTimer.stall(until: 4800)
heldTimer.work("/a", from: 4800, through: 8400)
heldTimer.event(8410, "working", "/b")

// ⑧ The same, held back right after a hand-off: /a is done, work is handed to /c at 3700 (so
//    no line was working when that event arrived), /c goes quiet at once and the timer is held
//    back until 4300. /c works on; /b is handed work more than an hour after 4300.
var heldAfterHandOff = Island()
heldAfterHandOff.work("/a", from: 0, through: 3540)
heldAfterHandOff.event(3600, "working", "/b")
heldAfterHandOff.move(3605)
heldAfterHandOff.event(3620, "complete", "/b")
heldAfterHandOff.event(3630, "complete", "/a")
heldAfterHandOff.event(3700, "working", "/c")
heldAfterHandOff.stall(until: 4300)
heldAfterHandOff.work("/c", from: 4300, through: 7900)
heldAfterHandOff.event(7910, "working", "/b")

let wokeStretch = [woke.nudge.watched?.start, woke.nudge.watched?.end].map(secs)
print("{\\"quietTool\\":\\(quietTool.asks),\\"shortRest\\":\\(shortRest.asks),\\"wokeAsking\\":\\(woke.nudge.asking),\\"wokeStretch\\":\\(wokeStretch),\\"backToWorkAsking\\":\\(backToWork.nudge.asking),\\"lidOnWork\\":\\(lidOnWork.asks),\\"toolAcrossLid\\":\\(toolAcrossLid.asks),\\"tenMinuteLid\\":\\(tenMinuteLid.asks),\\"heldTimer\\":\\(heldTimer.asks),\\"heldAfterHandOff\\":\\(heldAfterHandOff.asks)}")
`);
  assert.deepEqual(got, {
    // A tool running quietly is still work: the stretch that began at 0 is due at the hour,
    // and the hand-off at 65 minutes asks.
    quietTool: [3900],
    // A rest longer than the pause starts a new stretch whether or not a refresh happened
    // to land inside it, so the new stretch asks at its own hour.
    shortRest: [3600, 7508],
    // An hour with the lid shut is an hour away: the open ask goes, however late the island
    // looks and whether it wakes to quiet or straight to work.
    wokeAsking: false, backToWorkAsking: false,
    // Waking to quiet leaves the stretch as it was. The quiet is measured from its end.
    wokeStretch: ["0", "3610"],
    // A line left marked working across the lid proves nothing about the time it was shut,
    // and neither does a turn the log stretches across it. The island only counts work it
    // saw, so no stretch runs through a sleep. Ten minutes asleep is a pause too.
    lidOnWork: [], toolAcrossLid: [], tenMinuteLid: [],
    // A timer held back while the machine is awake is not a sleep: the line never stopped
    // working, so it is still the stretch that was already asked about, and nothing asks twice.
    heldTimer: [3600], heldAfterHandOff: [3600],
  });
});

test("the view model asks the stretch at every line change, with the status from before the change", () => {
  const vm = viewModelSource();

  // ① Hand-offs need the line's status from before this event. Read after the update,
  //    `before` would always equal the new status and no hand-off would ever be seen. The
  //    card would never ask, and nothing else would look wrong.
  const apply = vm.match(/private func applyProjectEvent\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(apply, "applyProjectEvent not found");
  const readsBeforeUpdate = (body) => {
    const call = body.match(/if stretch\.statusChanged\(from: (\w+), to: status, moving: sessionPhase != \.idle, at: now\) \{\s*peekOpen\(\)/);
    if (!call) return "no hand-off question that opens the card";
    const captured = body.indexOf(`let ${call[1]} = `);
    const updated = body.indexOf("projects[idx].status = status");
    if (captured < 0 || updated < 0) return "the prior status is not captured";
    return captured < updated ? "ok" : "the prior status is read after the update";
  };
  // Control: the checker catches the mistake it exists for.
  const misordered = [
    "if let idx = projects.firstIndex(where: { $0.key == key }) {",
    "    projects[idx].status = status",
    "}",
    "let before = projects.first { $0.key == key }?.status",
    "if stretch.statusChanged(from: before, to: status, moving: sessionPhase != .idle, at: now) { peekOpen() }",
  ].join("\n");
  assert.equal(readsBeforeUpdate(misordered), "the prior status is read after the update",
    "control: the ordering check cannot see a status read after the update");
  assert.equal(readsBeforeUpdate(apply), "ok");
  // The card must open already saying it: the answer is handed over in the same breath,
  // not at the next 15-second refresh, which is long after a 3.5-second peek has closed.
  assert.match(apply, /peekOpen\(\)\s*\n\s*shakeSoon\(\)\s*\n\s*\}\s*\n\s*publishStretch\(\)\s*\n[\s\S]*switch status/);

  // ② The stretch is refreshed wherever the verdict is, from the same settled turns, so the
  //    two always describe the same moment. Only a working line keeps it alive. An approval
  //    nobody answers usually means nobody is there, which is how the settle layer reads it.
  const refresh = vm.match(/func refreshFlow\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(refresh, "refreshFlow not found");
  assert.match(refresh, /let turns = FlowMath\.settle\(recentEvents\)/);
  assert.match(refresh, /FlowSense\.inFlow\(turns: turns, now: now\)/);
  assert.match(refresh, /refreshStretch\(turns: turns, now: now\)/);
  const stretch = vm.match(/func refreshStretch\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(stretch, "refreshStretch not found");
  assert.match(stretch, /stretch\.refresh\(turns: turns, busy: projects\.contains \{ \$0\.status == \.working \}, now: now,\s*uptime: ProcessInfo\.processInfo\.systemUptime\)/);
  assert.doesNotMatch(stretch, /\.waiting/, "a waiting line must not keep a stretch alive");
  assert.match(stretch, /publishStretch\(\)/);
  // Published only when it changes: the refresh runs every 15 seconds.
  const publish = vm.match(/func publishStretch\(\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(publish, "publishStretch not found");
  assert.match(publish, /if stretchNudge != stretch\.asking \{ stretchNudge = stretch\.asking \}/);
  assert.equal((vm.match(/(?<!var )\bstretchNudge = /g) ?? []).length, 1, "the answer is published from one place only");

  // ③ A finished move answers the request only when its save succeeds.
  const persist = vm.match(/private func persistCareSession\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(persist, "persistCareSession not found");
  const success = persist.split("} catch {")[0];
  assert.match(success, /stretch\.moved\(\)\s*\n\s*publishStretch\(\)/);
});

test("the card's first line asks for the break while the island is asking, and a hovered day still wins", () => {
  const row = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  // The row hands the cell the island's answer.
  assert.match(row, /TodayFlowCell\([\s\S]*?nudge: viewModel\.stretchNudge[\s\S]*?\)/);
  // At rest, the ask replaces the cycle. It is shown as a reading, in the readings' colour.
  const resting = row.match(/private func restingSlot\(at now: Date\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(resting, "restingSlot not found");
  assert.match(resting, /if nudge \{ return \(StretchNudge\.line, true\) \}/);
  // Hovering a day keeps strict priority over anything at rest, the ask included.
  assert.match(row, /let text = inspecting\.map \{ self\.inspected\(\$0, at: context\.date\) \} \?\? resting\?\.text/);
});

test("the break line fits the caption cell with room to spare", () => {
  // Measured with the caption's own font, read from the source rather than copied, so a
  // longer sentence or a bigger font fails here instead of losing its last word on screen.
  const nudge = fs.readFileSync(islandPath("StretchNudge.swift"), "utf8");
  const line = nudge.match(/static let line = "([^"]+)"/)?.[1];
  assert.ok(line, "StretchNudge.line not found");
  const caption = fs.readFileSync(islandPath("ProjectCaption.swift"), "utf8");
  const font = caption.match(/static let font = Font\.system\(size: ([\d.]+), weight: \.(\w+)\)/);
  assert.ok(font, "the caption font was not found");
  const card = fs.readFileSync(islandPath("GuidedCareCard.swift"), "utf8");
  const column = Number(card.match(/static let rightColumnWidth: CGFloat = ([\d.]+)/)?.[1]);
  assert.ok(column > 0, "rightColumnWidth not found");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-stretch-width-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "width");
  fs.writeFileSync(main, `import AppKit
let f = NSFont.systemFont(ofSize: ${font[1]}, weight: .${font[2]})
func w(_ s: String) -> Double { Double(NSAttributedString(string: s, attributes: [.font: f]).size().width) }
print("{\\"line\\":\\(w(${JSON.stringify(line)})),\\"long\\":\\(w("time to stretch your wings"))}")
`);
  execFileSync("swiftc", [main, "-o", binary], { stdio: "pipe" });
  const got = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
  // The text gets the column minus the 6pt dot and the 6pt gap before it.
  const room = column - 12;
  // Control: the measurement can fail. The longer sentence does not fit.
  assert.ok(got.long > room, `control: "time to stretch your wings" measured ${got.long}pt against ${room}pt`);
  // 10pt of margin: two text-measuring paths can disagree by a fraction of a point.
  assert.ok(got.line <= room - 10, `"${line}" is ${got.line}pt in a ${room}pt cell`);

  // At the top of its stretch the line still fits the narrowest tab: the narrowest notch the
  // island accepts plus its two wings, less 16pt at each side. The dot grows with the breath.
  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const spread = Number(view.match(/static let stretchSpread: CGFloat = ([\d.]+)/)?.[1]);
  assert.ok(spread > 0, "stretchSpread not found");
  const wc = fs.readFileSync(islandPath("IslandWindowController.swift"), "utf8");
  const minNotch = Number(wc.match(/return max\((\d+), screen\.frame\.width - leftArea\.width/)?.[1]);
  const wing = Number(wc.match(/static let topWingWidth: CGFloat = (\d+)/)?.[1]);
  assert.ok(minNotch > 0 && wing > 0, "the notch geometry was not found");
  const main2 = path.join(tmp, "stretched.swift");
  const binary2 = path.join(tmp, "stretched");
  fs.writeFileSync(main2, `import AppKit
let f = NSFont.systemFont(ofSize: ${font[1]}, weight: .${font[2]})
print(Double(NSAttributedString(string: ${JSON.stringify(line)}, attributes: [.font: f, .kern: ${spread}]).size().width))
`);
  execFileSync("swiftc", [main2, "-o", binary2], { stdio: "pipe" });
  const stretched = Number(execFileSync(binary2, { encoding: "utf8" }));
  const narrowestTab = minNotch + 2 * wing;
  assert.ok(stretched > got.line, "control: the spread must actually widen the line");
  assert.ok(6 * 1.4 + 6 + stretched <= narrowestTab - 32,
    `stretched "${line}" is ${stretched}pt plus its dot, in a ${narrowestTab}pt tab`);
});

test("while the island is asking, a tab hangs under the closed capsule and the pointer can reach it", () => {
  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  // Drawn behind the capsule, not inside it, so the bird stays alone in its wing. The tab
  // exists only while the island is asking.
  assert.match(view, /\} else \{\s*\n\s*capsule\(display: display\)\s*\n\s*\.background\(alignment: \.top\) \{\s*\n\s*if viewModel\.stretchNudge \{ stretchTab\(display: display\) \}/);
  const tab = view.match(/private func stretchTab\(display: IslandDisplayMetrics\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(tab, "stretchTab not found");
  // The same words, dot, font and colour as the card's own caption line.
  assert.match(tab, /Text\(StretchNudge\.line\)/);
  assert.match(tab, /\.font\(ProjectCaption\.font\)/);
  assert.match(tab, /Circle\(\)\s*\.fill\(IslandPalette\.cue\)\s*\.frame\(width: 6, height: 6\)/);
  assert.match(tab, /height: display\.closedHeight \+ Self\.stretchTabHeight/);

  // Closed, the window lets clicks through everywhere except the hover zone. A tab outside
  // the zone looks like the island while clicks go to the app underneath, so the zone grows
  // with it. It uses the value just published; reading the property then would be stale.
  const wc = fs.readFileSync(islandPath("IslandWindowController.swift"), "utf8");
  assert.match(wc, /viewModel\.\$stretchNudge[\s\S]{0,200}updateHoverZones\([^)]*nudging: nudging/);
  const zone = wc.match(/private func closedSurfaceRect\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(zone, "closedSurfaceRect not found");
  assert.match(zone, /nudging \? IslandView\.stretchTabHeight : 0/);
});

test("the card shakes once when it opens to ask, and routine peeks stay still", () => {
  const vm = viewModelSource();
  // Only the ask shakes: the bump sits inside the hand-off answer and nowhere else.
  assert.match(vm, /if stretch\.statusChanged\(from: before, to: status, moving: sessionPhase != \.idle, at: now\) \{\s*peekOpen\(\)\s*shakeSoon\(\)\s*\}/);
  assert.equal((vm.match(/stretchShake \+= 1/g) ?? []).length, 1, "the shake has exactly one trigger");
  // The card does not exist until the peek has opened it; a trigger that changes before the
  // view is there is never seen, so the bump waits for the card.
  const soon = vm.match(/private func shakeSoon\(\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(soon, "shakeSoon not found");
  assert.match(soon, /DispatchQueue\.main\.asyncAfter\([\s\S]*stretchShake \+= 1/);

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const opened = view.match(/private func openedPlaceholder[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(opened, "openedPlaceholder not found");
  assert.match(opened, /\.keyframeAnimator\(initialValue: CGFloat\.zero, trigger: viewModel\.stretchShake\)/);
  // Someone who asked the system for less motion gets the card without the shake.
  assert.match(view, /@Environment\(\\\.accessibilityReduceMotion\) private var reduceMotion/);
  assert.match(opened, /reduceMotion \? 0 : /);
});

test("an unanswered ask pulses ever more often: every 5 minutes, then 2, then every minute", () => {
  const got = runStretchNudge(`
let A = StretchNudge.after
var n = StretchNudge()
tick(&n, from: 0, through: A) { t in [turn(0, t)] }
let quiet = n.pulseDue(now: at(A + 10_000))
_ = n.statusChanged(from: .done, to: .working, moving: false, at: at(A))
// Asked at A. Probe each second that matters; a pulse moves the next one on.
var fired: [Int] = []
for s in [299, 300, 599, 600, 719, 720, 840, 960, 1080, 1200, 1259, 1260, 1320, 1500, 1501] {
    if n.pulseDue(now: at(A + Double(s))) { fired.append(s) }
}
n.moved()
let afterMove = n.pulseDue(now: at(A + 5000))
var p = StretchNudge()
tick(&p, from: 0, through: A) { t in [turn(0, t)] }
_ = p.statusChanged(from: .done, to: .working, moving: false, at: at(A))
tick(&p, from: A, through: A + 100) { _ in [turn(0, A)] }
let duringQuiet = p.pulseDue(now: at(A + 300))
tick(&p, from: A + 100, through: A + StretchNudge.away) { _ in [turn(0, A)] }
let afterAway = p.pulseDue(now: at(A + 10_000))
// A pause ends the stretch; the next ask starts the slow end of the schedule again.
let B = A + 6000
tick(&n, from: A, through: B + A) { t in t < B ? [turn(0, A)] : [turn(0, A), turn(B, t)] }
_ = n.statusChanged(from: .done, to: .working, moving: false, at: at(B + A))
let freshTooSoon = n.pulseDue(now: at(B + A + 299))
let freshOnTime = n.pulseDue(now: at(B + A + 300))
print("{\\"quiet\\":\\(quiet),\\"fired\\":\\(fired),\\"afterMove\\":\\(afterMove),\\"duringQuiet\\":\\(duringQuiet),\\"afterAway\\":\\(afterAway),\\"freshTooSoon\\":\\(freshTooSoon),\\"freshOnTime\\":\\(freshOnTime)}")
`);
  assert.deepEqual(got, {
    // Nothing is asked yet, so nothing pulses however long it has been.
    quiet: false,
    // 5 min, 10 min, then every 2 min to 20 min, then every minute. Each gap counts from the
    // pulse that fired, so a late tick cannot bunch pulses up: a refresh two minutes late
    // (1500) fires once, and the next pulse is a full gap after it.
    fired: [300, 600, 720, 840, 960, 1080, 1200, 1260, 1320, 1500],
    // Answered: the tab is gone, and so is its schedule.
    afterMove: false,
    // A quiet spell keeps the tab breathing on schedule; being away long enough ends it.
    duringQuiet: true, afterAway: false,
    // A fresh ask starts slow again rather than inheriting the old urgency.
    freshTooSoon: false, freshOnTime: true,
  });
});

test("the tab breathes when the schedule says so, and only while it is actually showing", () => {
  const vm = viewModelSource();
  const stretch = vm.match(/func refreshStretch\([\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(stretch, "refreshStretch not found");
  // The pulse uses the existing 15-second refresh instead of a new timer. It only fires
  // while the tab is on screen, which means while the card is closed.
  assert.match(stretch, /if stretch\.pulseDue\(now: now\), presentationPhase == \.closed \{ stretchPulse \+= 1 \}/);
  assert.equal((vm.match(/stretchPulse \+= 1/g) ?? []).length, 1, "the breath has exactly one trigger");

  const view = fs.readFileSync(islandPath("IslandView.swift"), "utf8");
  const tab = view.match(/private func stretchTab\(display: IslandDisplayMetrics\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
  assert.ok(tab, "stretchTab not found");
  // The breath is a stretch: the words ease apart and settle back. Letter spacing only exists
  // on Text, so the animator builds the row from each value rather than modifying a placeholder.
  assert.match(tab, /KeyframeAnimator\(initialValue: Breath\(\), trigger: viewModel\.stretchPulse\)/);
  assert.match(tab, /\.tracking\(still \? 0 : breath\.spread\)/);
  assert.match(tab, /CubicKeyframe\(Self\.stretchSpread, duration: [\d.]+\)/);
  assert.match(tab, /let still = reduceMotion/);
});

test("an open ask outlasts quiet spells and is dropped only after twenty minutes away", () => {
  const got = runStretchNudge(`
let due = StretchNudge.after
func asked() -> StretchNudge {
    var n = StretchNudge()
    tick(&n, from: 0, through: due) { t in [turn(0, t)] }
    _ = n.statusChanged(from: .done, to: .working, moving: false, at: at(due))
    return n
}
// "Away" counts the whole silence since the last work seen.
var a = asked()
tick(&a, from: due, through: due + StretchNudge.away - 1) { _ in [turn(0, due)] }
let almostAway = a.asking
tick(&a, from: due + StretchNudge.away - 1, through: due + StretchNudge.away) { _ in [turn(0, due)] }
let away = a.asking
// Work resuming before that restarts the quiet clock.
var b = asked()
let resume = due + 900
tick(&b, from: due, through: resume + StretchNudge.away - 1) { t in
    t < resume ? [turn(0, due)] : [turn(0, due), turn(resume, resume)]
}
let clockRestarted = b.asking
// While the old ask is still open, the next stretch reaching the threshold does not ask again.
var c = asked()
let next = due + 360
tick(&c, from: due, through: next + due) { t in t < next ? [turn(0, due)] : [turn(0, due), turn(next, t)] }
let askedTwice = c.statusChanged(from: .done, to: .working, moving: false, at: at(next + due))
print("{\\"almostAway\\":\\(almostAway),\\"away\\":\\(away),\\"clockRestarted\\":\\(clockRestarted),\\"askedTwice\\":\\(askedTwice),\\"stillAsking\\":\\(c.asking)}")
`);
  assert.deepEqual(got, {
    // One second short of twenty minutes of silence, the tab is still there.
    almostAway: true,
    // Twenty minutes with no agent moving: someone who was away does not come back to it.
    away: false,
    // A quiet spell that work interrupts does not count towards being away.
    clockRestarted: true,
    // The tab is already asking, so a second stretch reaching the threshold adds no second peek.
    askedTwice: false, stillAsking: true,
  });
});
