// The care card that opens under the island: the guided two-state card, the category ring,
// and what may sit above it.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { islandViews, CARE_MOVE_POOL_SWIFT } = require("./island-paths");

test("opened panel stacks nothing above the care card", () => {
  const view = islandViews();
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

test("selected category ring shows how many moves and which one, continuously", () => {
  const pool = fs.readFileSync(CARE_MOVE_POOL_SWIFT, "utf8");
  assert.match(pool, /static func moves\(in category: CareCategory\)/);
  assert.match(pool, /static func index\(of moveID: String, in category: CareCategory\)/);

  const view = islandViews();
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

// Deliberately NOT ~40 pinned source strings (contentHorizontalInset=36,
// mainAreaHeight=148, min(92, slotWidth*1.28) and other layout magic
// numbers). Pinned literals are no visual gate: layout can render broken and
// stay green, while the numbers they lock are exactly what a layout fix must
// change — blocking the right edits. Structural invariants only: guard
// architecture, data flow, and fixed bugs; lock no tunable layout number.

// Deliberately NOT ~40 pinned source strings (contentHorizontalInset=36,
// mainAreaHeight=148, min(92, slotWidth*1.28) and other layout magic
// numbers). Pinned literals are no visual gate: layout can render broken and
// stay green, while the numbers they lock are exactly what a layout fix must
// change — blocking the right edits. Structural invariants only: guard
// architecture, data flow, and fixed bugs; lock no tunable layout number.

// Deliberately NOT ~40 pinned source strings (contentHorizontalInset=36,
// mainAreaHeight=148, min(92, slotWidth*1.28) and other layout magic
// numbers). Pinned literals are no visual gate: layout can render broken and
// stay green, while the numbers they lock are exactly what a layout fix must
// change — blocking the right edits. Structural invariants only: guard
// architecture, data flow, and fixed bugs; lock no tunable layout number.

// Deliberately NOT ~40 pinned source strings (contentHorizontalInset=36,
// mainAreaHeight=148, min(92, slotWidth*1.28) and other layout magic
// numbers). Pinned literals are no visual gate: layout can render broken and
// stay green, while the numbers they lock are exactly what a layout fix must
// change — blocking the right edits. Structural invariants only: guard
// architecture, data flow, and fixed bugs; lock no tunable layout number.

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
