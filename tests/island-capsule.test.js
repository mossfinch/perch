// The closed island and the strip along it: the bird, the wave, the status dots, the tally,
// and the caption that rotates when several projects run.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandViews, viewModelSource, islandPath, pkgPath } = require("./island-paths");

test("the closed island shows a bird for the machine, and it stands on nothing", () => {
  const view = islandViews();

  // The closed mark uses Perch's own perched-bird asset, not a generic symbol.
  const mark = view.match(/struct ClosedIslandMark[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(mark, /Image\("PerchBird"\)/, "the closed mark is the app's own bird, the one on the icon");
  assert.doesNotMatch(mark, /"leaf\.fill"/, "the leaf belonged to the old name");
  // Not the system symbol: `bird.fill` is mid-flight with raised wings, a
  // different creature from the one perched on the icon.
  assert.doesNotMatch(mark, /systemName: "bird/, "the system bird is flying; ours is perched");
  assert.match(mark, /renderingMode\(\.template\)/, "template, or the status colour stops applying");

  // The upright asset needs enough height to retain its silhouette inside the wing.
  const height = Number(mark.match(/\.frame\(height: (\d+)\)/)?.[1] ?? 0);
  assert.ok(height >= 20 && height <= 30,
    `perched bird needs ~20-30pt to read, got ${height}`);

  // The breathing scale stays close to 1 so the bird moves without inflating.
  const swell = Math.max(...[...mark.matchAll(/scale = (1\.\d+)/g)].map((m) => Number(m[1])));
  assert.ok(swell > 1 && swell <= 1.2, `a perched bird breathes, it does not grow (got ${swell})`);

  // The wing holds the bird directly. A wrapper or stacked marker changes the
  // closed silhouette and consumes the space reserved for status counts.
  const capsule = view.match(/private func capsule\([\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(capsule, "capsule() not found");
  assert.match(capsule, /ClosedIslandMark\(status: viewModel\.agentStatus\)/,
    "the wing must hold the bird itself, not a wrapper around it");
  assert.doesNotMatch(capsule, /VStack/,
    "nothing may be stacked under the bird — it floats, by its owner's own answer");

  // ③ Left wing — the right one holds the counts, up to three digits inside a
  //    fixed 44pt. And the closed capsule passes no tap handler: that panel
  //    ignores the mouse so clicks reach the menu bar behind it.
  assert.ok(capsule.indexOf("ClosedIslandMark") < capsule.indexOf("statusCounts"),
    "left wing, not into the counts' fixed width");
  assert.doesNotMatch(capsule, /ClosedIslandMark\([^)]*onTap/,
    "nothing to press in the closed capsule — it does not take mouse events");

  // The top row belongs to agent activity; presence UI must not re-enter it.
  const strip = view.match(/struct AgentActivityStrip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(strip, "AgentActivityStrip not found");
  assert.doesNotMatch(strip, /presence/i,
    "the top row is the wave's, and no presence instrument may reach into it");
});

test("one black for both states, and the wave's dim end is derived from it", () => {
  // Open and closed states share a pure-black ground. The dim wave alpha is
  // pinned with it because changing either alone can make the wave unreadable.
  const view = islandViews();
  const rgb = (name) => {
    const m = view.match(
      new RegExp(`static let ${name} = Color\\(red: ([\\d.]+), green: ([\\d.]+), blue: ([\\d.]+)\\)`));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };

  // ① Pure black, all three components.
  const capsuleColor = rgb("capsule");
  assert.ok(capsuleColor, "IslandPalette.capsule is no longer a literal Color(red:green:blue:)");
  assert.deepEqual(capsuleColor, [0, 0, 0],
    `the island's ground drifted off the notch's black (got ${capsuleColor})`);

  // ② Control: the same probe must still read a colour that is NOT black, or
  //    ① passes on a regex that stopped matching rather than on a real value.
  const paper = rgb("paper");
  assert.ok(paper, "control: the probe cannot read IslandPalette.paper at all");
  assert.ok(paper.some((c) => c > 0.9), `control: paper should be near-white, got ${paper}`);

  // ②b ONE ground, both states. Giving the open card its own lifted grey to
  //     rescue the wave was rejected outright: both states owe the same depth,
  //     so the wave was brightened instead.
  assert.ok(!/static let card\b/.test(view),
    "IslandPalette.card is back — its owner asked for one depth, not two");
  // The two GROUND call sites only — IslandPalette.accent / .cue also back
  // pills inside the card, and sweeping those in would make this pass for the
  // wrong reason.
  const closedGround = view.match(/\.background\(IslandPalette\.(\w+), in: IslandCapsuleShape/)?.[1];
  const openGround = view.match(/\.background\(IslandPalette\.(\w+), in: surfaceShape\)/)?.[1];
  assert.ok(closedGround && openGround,
    `could not read both grounds (closed=${closedGround}, open=${openGround})`);
  assert.equal(closedGround, openGround,
    `the closed island and the open card draw different grounds again: ${closedGround} vs ${openGround}`);
  assert.equal(closedGround, "capsule", "the grounds moved off IslandPalette.capsule");

  // ②c ⚠️ The ground and the wave's dim alpha are ONE decision, and getting it
  //     wrong is easy: a black ground plus an alpha tuned against a lifted grey
  //     is an invisible wave. Pinned together, so moving either alone goes red.
  const sense = fs.readFileSync(islandPath("FlowSense.swift"), "utf8");
  const dim = Number(sense.match(/static let dimAlpha = ([\d.]+)/)?.[1]);
  const full = Number(sense.match(/static let fullAlpha = ([\d.]+)/)?.[1]);
  assert.equal(dim, 0.23,
    "dimAlpha moved off the value derived for a pure-black ground (see FlowSense's own note)");
  // Control: the probe reads real numbers, not a regex matching nothing.
  assert.equal(full, 1.0, "control: fullAlpha should read 1.0");
  // …and the reading survives the brightening. Out of flow must stay far below
  // full flow, or the wave stops saying anything by being bright all the time.
  assert.ok(dim < full / 3,
    `the dim end crept up on full flow (${dim} vs ${full}) — the gap IS the reading`);

  // ③ The number must carry its reason. The capsule was the ONE value in the
  //    palette with no comment above it, which is exactly how it drifted in
  //    unnoticed — every other colour here explains itself.
  assert.match(view, /\/\/\/[^\n]*\n(?:\s*\/\/\/[^\n]*\n)*\s*static let capsule = Color\(/,
    "IslandPalette.capsule is a bare number — the last time that happened nobody could say why it was warm");
  assert.match(sense, /\/\/\/[^\n]*\n(?:\s*\/\/\/[^\n]*\n)*\s*static let dimAlpha = /,
    "dimAlpha is a bare number — it only makes sense next to the ground it was derived against");

  // ④ Mutation, ammunition counted before firing.
  const shots = [
    ["static let capsule = Color(red: 0, green: 0, blue: 0)",
     "static let capsule = Color(red: 0.12, green: 0.10, blue: 0.095)",
     (s) => !/static let capsule = Color\(red: 0, green: 0, blue: 0\)/.test(s),
     "the warm grey came back and the value guard stayed quiet"],
    ["    static let paper = Color(red: 0.998, green: 0.996, blue: 0.991)",
     "    static let paper = Color(red: 0, green: 0, blue: 0)",
     (s) => !/static let paper = Color\(red: 0\.998/.test(s),
     "control mutation: paper went black and the control assertion stayed quiet"],
    // The failure mode this guards: the open card gets its own ground again.
    ["            .background(IslandPalette.capsule, in: surfaceShape)",
     "            .background(IslandPalette.card, in: surfaceShape)",
     (s) => s.match(/\.background\(IslandPalette\.(\w+), in: IslandCapsuleShape/)?.[1]
            !== s.match(/\.background\(IslandPalette\.(\w+), in: surfaceShape\)/)?.[1],
     "the open card took a different ground and the one-depth guard stayed quiet"],
  ];
  for (const [anchor, replacement, fired, message] of shots) {
    const hits = view.split(anchor).length - 1;
    assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1: ${anchor}`);
    assert.ok(fired(view.split(anchor).join(replacement)), `mutation: ${message}`);
  }
});

test("island capsule has a distinct persistent done state + retained chime", () => {
  const vm = viewModelSource();
  const status = fs.readFileSync(islandPath("AgentStatus.swift"), "utf8");
  assert.match(status, /enum IslandAgentStatus[\s\S]*?case done/);
  assert.match(vm, /return \.done/);   // done is reachable (agentStatus comes from aggregateStatus())
  assert.doesNotMatch(vm, /playChime\(\)[\s\S]{0,200}agentStatus = \.idle/);   // completion never self-resets to idle
  assert.match(vm, /private let completionSound/);
  assert.match(vm, /CompletionChime/);   // audio read from the app bundle (sandbox-safe)
  assert.match(vm, /func hoverEntered\(\)[\s\S]*?\.done/);

  const view = islandViews();
  assert.match(view, /repeatForever/);   // continuous pulse animation while working
});

test("status dots split into rows by agent source, claude above codex", () => {
  const monitor = fs.readFileSync(islandPath("AgentEventMonitor.swift"), "utf8");
  // Source is the later-added 4th field; older hooks push three fields, and a
  // three-field message must count as claude — or sessions still running with
  // an old hook (hooks are read once at session start) lose their row on upgrade.
  assert.match(monitor, /let rawSource = field\(3\)/);
  assert.match(monitor, /rawSource\.isEmpty \? "claude" : rawSource/);

  const vm = viewModelSource();
  assert.match(vm, /let source: String/);
  // The unique key must include the source: the same directory open in two
  // agents is two lines of work — keyed by directory alone they fight over
  // one dot and overwrite each other.
  assert.match(vm, /static func key\(source: String, dir: String\)[\s\S]{0,80}\\\(source\)/);
  assert.match(vm, /ProjectStatus\.key\(source: source, dir: dir\)/);

  const view = islandViews();
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
  // ⚠️ Old expectation: each installer's source text contained the wire
  // format `%s-$$\\t<source>`. The push itself now lives in one launcher
  // script — a hook command whose text never changes cannot cost the owner
  // the owner another Trust click), so the format is asserted where it is,
  // and each installer is checked for the only thing it still decides: which
  // source token it hands the launcher.
  const launcher = fs.readFileSync(pkgPath("perch-hook.sh"), "utf8");
  assert.match(launcher, /printf '%s\\t%s\\t%s-%s\\t%s'/,
    "the launcher's push is no longer the four-field wire format");
  assert.match(launcher, /"\$event" "\$dir" "\$\(date \+%s\)" "\$\$" "\$source"/,
    "the four fields are no longer event, project, nonce, source");
  for (const [f, src] of [["install-island-hooks.py", "claude"], ["install-codex-island-hooks.py", "codex"]]) {
    const script = fs.readFileSync(pkgPath(f), "utf8");
    assert.match(script, new RegExp(`\\{launcher or LAUNCHER\\}' \\{event\\} ${src}`),
      `${f}'s hooks must tell the launcher they are ${src}`);
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

// THE WHOLE POINT: however many projects run, the capsule shows at most
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

test("the wave's flow look runs 0.23 to full, 0.3 to 1.6, and never leaps", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-flow-look-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "flow-look-check");
  fs.writeFileSync(main, `
import Foundation

func row(_ xs: [Double]) -> String {
    "[" + xs.map { String(format: "%.9f", $0) }.joined(separator: ",") + "]"
}
// Beyond both ends on purpose: a level is only ever 0…1, and anything outside
// it must clamp rather than run the wave darker than dark or faster than fast.
let levels = stride(from: -0.5, through: 1.5, by: 0.05).map { $0 }
let alphas = levels.map { FlowSense.opacity(for: $0) }
let factors = levels.map { FlowSense.tempoMultiplier(for: $0) }

let t0 = Date(timeIntervalSince1970: 1_700_000_000)
let rising = FlowSense.Transition(from: 0, to: 1, since: t0, clockAtSince: 0)
// One second at the island's own 30fps: half of it is the crossing, half of it
// is after — so both the ramp and the settled rate get sampled.
let frames = (0...30).map { t0.addingTimeInterval(Double($0) / 30.0) }
let ramp = frames.map { rising.level(at: $0) }
let clock = frames.map { rising.waveClock(at: $0) }
// The control: what the wave clock would do if the flow factor simply scaled
// the wall clock, the way the agent tempo always has.
let naive = frames.map { $0.timeIntervalSinceReferenceDate * FlowSense.tempoMultiplier(for: rising.level(at: $0)) }

// A verdict that flips back mid-crossing must pick up from where the crossing
// had got to — in the look AND in the phase. Restarting either is the jump
// this whole arrangement exists to avoid.
let mid = t0.addingTimeInterval(0.25)
let falling = rising.retarget(to: 0, at: mid)
precondition(abs(falling.level(at: mid) - rising.level(at: mid)) < 1e-12,
             "a reversal must start from the level the crossing had reached")
precondition(abs(falling.waveClock(at: mid) - rising.waveClock(at: mid)) < 1e-12,
             "a reversal must not move the wave's phase")
precondition(falling.to == 0 && falling.from > 0 && falling.from < 1,
             "the reversal must aim back at 0 from somewhere in between")
// Re-asserting the verdict already in force changes nothing: a judgment that
// keeps agreeing with itself must not restart the crossing every 15 seconds.
precondition(rising.retarget(to: 1, at: mid) == rising,
             "the same verdict again must leave the crossing alone")

print("{\\"alphas\\":\\(row(alphas)),\\"clock\\":\\(row(clock)),\\"factors\\":\\(row(factors)),"
      + "\\"levels\\":\\(row(levels)),\\"naive\\":\\(row(naive)),\\"ramp\\":\\(row(ramp))}")
`);
  execFileSync("swiftc", [islandPath("FlowMath.swift"), islandPath("FlowSense.swift"), main, "-o", binary],
    { stdio: "pipe" });
  const r = JSON.parse(execFileSync(binary, { encoding: "utf8" }));
  const at = (level) => r.levels.findIndex((l) => Math.abs(l - level) < 1e-9);
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} vs ${b}`);

  // ① The two ends. Out of flow the wave FADES rather than shrinking: short
  //    bars read as broken.
  //
  //    ⚠️ The dim end is ground-dependent. On pure black, 0.23 preserves a
  //    visible mid-height bar; this value and IslandPalette's ground are one
  //    decision, so the palette test pins them together.
  near(r.alphas[at(0)], 0.23, "out of flow the wave must sit at 0.23");
  near(r.alphas[at(1)], 1.0, "in flow the wave must be at full strength");
  near(r.factors[at(0)], 0.3, "out of flow the wave must run at 0.3");
  near(r.factors[at(1)], 1.6, "in flow the wave must run at 1.6");
  // ⚠️ An island that stops moving looks like it crashed. The slow end is slow,
  //    never still.
  assert.ok(r.factors[at(0)] > 0, "the wave must keep moving even out of flow");
  // ② Monotone, and clamped outside 0…1 rather than extrapolated.
  for (const [name, xs] of [["alpha", r.alphas], ["tempo factor", r.factors]]) {
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] >= xs[i - 1], `${name} goes backwards between level ${r.levels[i - 1]} and ${r.levels[i]}`);
    }
    near(xs[0], xs[at(0)], `${name} below 0 must clamp, not extrapolate`);
    near(xs[xs.length - 1], xs[at(1)], `${name} above 1 must clamp, not extrapolate`);
  }
  assert.ok(r.alphas[at(1)] > r.alphas[at(0)] && r.factors[at(1)] > r.factors[at(0)],
    "control: the two ends must actually differ, or monotonicity is trivially true");

  // ③ The crossing: about half a second, eased, and finished afterwards. The
  //    values in between are the crossing itself, not places to rest.
  near(r.ramp[0], 0, "the crossing starts where it was");
  near(r.ramp[15], 1, "half a second in, the crossing is done");
  near(r.ramp[30], 1, "and it stays done");
  assert.ok(r.ramp[7] > 0 && r.ramp[7] < 1, "a quarter of the way in it must be somewhere in between");
  for (let i = 1; i <= 15; i++) {
    assert.ok(r.ramp[i] >= r.ramp[i - 1], `the crossing goes backwards at frame ${i}`);
  }

  // ④ The phase must never jump. The bar heights are sin(time × frequency),
  //    and one frame of a scaled WALL clock moves that by ~10⁸ radians when the
  //    factor shifts — the row stops reading as bars and starts reading as
  //    static. The wave clock integrates the factor instead, so the rate
  //    changes while the phase stays put.
  //    ⚠️ The tolerance is 1e-5, not 1e-9: a Date around 2026 holds only about
  //    1e-7 of a second of resolution, so the frame spacing itself wobbles at
  //    that scale before any of this arithmetic runs. Still ten orders of
  //    magnitude tighter than the leap it is here to catch.
  const steps = (xs) => xs.slice(1).map((x, i) => x - xs[i]);
  const ours = steps(r.clock);
  assert.ok(Math.min(...ours) > 0, "the wave clock must never stop or run backwards");
  assert.ok(Math.max(...ours) <= 1.6 / 30 + 1e-5,
    `the wave clock leapt ${Math.max(...ours)} in one frame — that is the phase jump this exists to prevent`);
  assert.ok(Math.abs(ours[ours.length - 1] - 1.6 / 30) < 1e-5,
    "once the crossing is over the clock must run at the full factor");
  // Control: the naive version really does leap, so the bound above is a
  // measurement and not a truism.
  assert.ok(Math.max(...steps(r.naive)) > 1e6,
    "control: scaling the wall clock is supposed to leap — if it does not, this assertion proves nothing");
});

// This test COMPILES AND RUNS CarouselClock, which imports no SwiftUI.
// A text pin cannot prove a formula executes, so entry, boundaries, wrapping
// and a clock behind the origin all go through behaviour.
test("the carousel clock really turns: entry, boundaries, wrap, and a clock behind the origin", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-carousel-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "carousel-check");
  fs.writeFileSync(main, `
import Foundation
let t0 = Date(timeIntervalSince1970: 1000)
func at(_ s: TimeInterval, _ count: Int, _ slot: TimeInterval) -> Int {
    CarouselClock.slot(now: t0.addingTimeInterval(s), origin: t0, count: count, seconds: slot)
}
// Entry sits on slot zero, and stays there for one whole page.
precondition(at(0, 2, 3) == 0)
precondition(at(2.9, 2, 3) == 0, "the page turned early")
// Each boundary turns the page exactly on time, and after the last page the
// cycle wraps back to slot zero.
precondition(at(3, 2, 3) == 1, "the page did not turn at its boundary")
precondition(at(5.9, 2, 3) == 1)
precondition(at(6, 2, 3) == 0, "the cycle does not wrap")
// A three-slot cycle must be able to reach its last slot.
precondition(at(29, 3, 30) == 0)
precondition(at(30, 3, 30) == 1)
precondition(at(60, 3, 30) == 2, "the third slot is unreachable")
precondition(at(90, 3, 30) == 0)
// Anything before the origin answers slot zero.
// -0.5s passes by accident, truncated toward zero; -3.5s is what catches a
// missing guard against a negative index.
precondition(at(-0.5, 2, 3) == 0)
precondition(at(-3.5, 2, 3) == 0, "a clock a full page behind the origin crashed or went negative")
// An empty list or a zero cadence answers 0 instead of dividing by nothing.
precondition(at(10, 0, 3) == 0)
precondition(at(10, 2, 0) == 0)
print("ok")
`);
  execFileSync("swiftc", [islandPath("CarouselClock.swift"), main, "-o", binary], { stdio: "pipe" });
  assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "ok");

  // Both rotations — resting and hover — must ride this tested clock, never an
  // inlined formula of their own.
  const cellSrc = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  assert.match(cellSrc, /CarouselClock\.slot\(now: now, origin: carouselOrigin/,
    "the resting rotation stopped using the tested clock");
  assert.match(cellSrc, /CarouselClock\.slot\(now: now, origin: inspectOrigin/,
    "the hover rotation stopped using the tested clock");
  assert.doesNotMatch(cellSrc.replace(/\/\/.*$/gm, ""), /timeIntervalSince\((carouselOrigin|inspectOrigin)\)/,
    "a rotation keeps its own inline copy of the clock arithmetic beside the tested one");

  // CarouselClock must be in the app's compiled sources, or the shipped
  // product is missing the implementation.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  const sources = pbx.match(/00A1CE00000000000000002C \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(sources.includes("CarouselClock.swift"),
    "CarouselClock.swift is not compiled into the island");
});

// The week is recomputed from the log, so it must be refreshed when the panel
// is opened, and again when a panel left open crosses into a new day.
// Read only in `init`, a long-running app keeps showing yesterday.

// The week is recomputed from the log, so it must be refreshed when the panel
// is opened, and again when a panel left open crosses into a new day.
// Read only in `init`, a long-running app keeps showing yesterday.

test("persistent 'project · source' caption right of the wave, rotating when several run", () => {
  const view = islandViews();
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(label.length > 0, "ActiveProjectLabel not found");

  // ⚠️ Four of this test's assertions were rewritten, not relaxed. What each
  //    old expectation assumed, and why it stopped being true:
  //
  //    · "rotate working AND waiting together" — this was the bug, not the
  //      rule. Cycling both meant a project stuck waiting scrolled past every
  //      three seconds like any other, and yellow is the only one of the four
  //      states that needs someone to act. Now yellow takes the label and pins
  //      it.
  //    · "the caller pre-filters, the label renders what it is handed" — the
  //      picking moved INTO the label, so "yellow wins" is written in exactly
  //      one place. `activeProjects` had no other caller and was deleted
  //      rather than left sitting there.
  //    · "the label owns a fixed width of its own" — it still must not
  //      self-size (the reason below is unchanged), but the width now comes
  //      from the shared right column so the two top rows line up as a grid.
  //      Same constraint, one owner instead of two.
  //    · "hide the label when nothing is running" — the cell is now dots AND
  //      name together; the dots stay whatever happens, so there is no width
  //      to give back.
  const strip = view.match(/struct AgentActivityStrip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(strip, /activeProjects/,
    "the pre-filtered list came back — 'yellow wins' must live in one place only");
  assert.match(label, /\$0\.status == \.working/, "the label no longer picks the running ones");

  // Green is over and must not keep being announced: it never enters either list.
  assert.doesNotMatch(label.match(/private var running[\s\S]*?\n    \}/)?.[0] ?? "", /\.done/);
  assert.doesNotMatch(label.match(/private var waiting[\s\S]*?\n    \}/)?.[0] ?? "", /\.done/);

  // The ticker must be @State: the parent redraws every second; a plain let would replace the 3s clock before it completes
  assert.match(label, /@State private var ticker = Timer\.publish/);
  // Varying text must not resize the width-derived wave on every rotation.
  // The band owns this shared column geometry; neither row owns it.
  assert.match(strip, /\.frame\(width: GuidedCareLayout\.rightColumnWidth/);
  assert.doesNotMatch(label, /private static let width: CGFloat/,
    "the label grew a second, private copy of the column width");
  // Out-of-range normalizes via modulo — projects leave at any time; slot can't be assumed valid
  assert.match(label, /shown\[slot % shown\.count\]/);
  // Don't blink when only one is showing, and don't rotate at all while pinned
  assert.match(label, /guard waiting\.isEmpty, shown\.count > 1 else \{ return \}/);
});
