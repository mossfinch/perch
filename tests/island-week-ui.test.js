// The week on its branch: the top band's two rows, the day cells, how a level is painted,
// pressing a day, and every page of text fitting the cell that prints it.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandViews, viewModelSource, islandPath, pkgPath } = require("./island-paths");

// The week is recomputed from the log, so it must be refreshed when the panel
// is opened, and again when a panel left open crosses into a new day.
// Read only in `init`, a long-running app keeps showing yesterday.

// The week is recomputed from the log, so it must be refreshed when the panel
// is opened, and again when a panel left open crosses into a new day.
// Read only in `init`, a long-running app keeps showing yesterday.
test("the week is recomputed when it is looked at, and when the date rolls over", () => {
  const vm = viewModelSource();
  // ⚠️ Brace-matched, never a fixed window. A `slice(at, at + N)` spills into
  //    whatever function comes next, so an assertion "this call is inside
  //    hoverEntered" passes when the call has been moved to the function BELOW
  //    it — including `hoverExited`, which runs when the panel closes. That is
  //    the shipped bug back again, green.
  // ⚠️ Comments stripped first. Without it a call that has been commented out
  //    still satisfies every assertion below — and "commented out while
  //    debugging, never put back" is the likeliest way any of this dies.
  const code = vm.replace(/\/\/.*$/gm, "");
  const body = (name) => {
    const at = code.indexOf(`func ${name}(`);
    assert.ok(at > 0, `control: ${name} is not in the view model any more`);
    const open = code.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
    }
    assert.fail(`control: braces never balanced inside ${name}`);
  };

  // Brace-match an arbitrary block, given the text that opens it. Same reason as
  // `body`: a character window spills, and here the whole if/else is ~130 chars
  // so a 600-char window covers BOTH branches.
  const block = (src, opener) => {
    const at = src.indexOf(opener);
    assert.ok(at >= 0, `control: \`${opener}\` is not there any more`);
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    assert.fail(`control: braces never balanced after \`${opener}\``);
  };

  // ① Refresh on every OPEN TRANSITION, not only hover, so all entry paths show
  //    the current day after rollover.
  const presentation = body("refreshPresentation");
  const openBranch = block(presentation, "if target == .opened");
  assert.match(openBranch, /refreshWeek\(\)/,
    "the week must be recomputed where the card becomes visible, not on one of the four paths in");
  //    ⚠️ …and NOWHERE ELSE in that function. Anchoring on the literal `} else {`
  //    instead lets the call move into a reshaped closing branch
  //    (`} else if target == .closed {`) while a dead copy stays behind in the
  //    opening one: the week recomputed only as the card disappears, green.
  //    So: subtract the opening branch and nothing may remain.
  assert.doesNotMatch(presentation.replace(openBranch, ""), /refreshWeek\(\)/,
    "refreshWeek appears outside the opening branch — it may be firing on close");
  // ② …and midnight, for a card left open.
  assert.match(body("startFlowTimer"), /refreshWeekIfDayChanged/,
    "the rollover check is not on the tick, so it can only fire by accident");
  assert.match(body("refreshWeekIfDayChanged"),
    /DayScore\.dayFormatter\.string\(from: now\) != todayKey/,
    "the rollover check must compare against the SAME day key the branch is drawn from");
  // ③ The week's log read measures about 0.8s, so it must run inside the
  //    detached closure.
  //    Sitting inside an `await MainActor.run`, it blocks the opening
  //    animation all the same.
  const refresh = body("refreshWeek");
  const detached = block(refresh, "Task.detached");
  assert.match(detached, /DayFlow\.read\(/,
    "the week read is not inside the detached task — that is 0.8s on the main actor");
  const landing = block(detached, "await MainActor.run");
  assert.doesNotMatch(landing, /DayFlow\.read\(/,
    "the week read sits inside the hop back to the main actor, so it runs there anyway");
  //    The detached stage may not hop back to the main queue by hand either.
  assert.doesNotMatch(detached, /DispatchQueue\.main/,
    "the detached task hops to the main queue — the 0.8s read is back on the main thread");
  // ④ Only the newest generation of the read may publish, so a slow one cannot
  //    land over a fast one.
  //    `todayKey` is already written forward, so a stale overwrite cannot be
  //    left for the next rollover check to correct.
  assert.match(landing, /guard self\.weekGeneration == generation else \{ return \}/,
    "nothing sequences two overlapping reads: a stale week can land over a fresh one");
  //    The counter must be incremented BEFORE it is captured.
  //    Without the increment a stale result is let through; captured first,
  //    nothing is ever published again.
  const bump = refresh.indexOf("weekGeneration &+= 1");
  const capture = refresh.indexOf("let generation = weekGeneration");
  assert.ok(bump > 0, "the generation is never incremented — the gate is always true and does nothing");
  assert.ok(capture > bump,
    "the generation is captured before it is incremented — the gate is never true and the week never publishes");
  // ⑤ The result of the read must land in BOTH `week` and `weekCorrections`.
  //    Pinning only the read and its ordering cannot see the result being
  //    thrown away.
  assert.match(landing, /self\.week = read\.days/,
    "the week is read and then dropped on the floor — the branch never updates from disk");
  assert.match(landing, /self\.weekCorrections = read\.corrections/,
    "corrections are read and then dropped — a corrected day redraws as the machine's own reading");
  // ⑥ A correction must invalidate the SNAPSHOT half of a read already in
  //    flight, or an older snapshot lands over the correction just written.
  //    Corrections invalidate only their captured snapshot; `weekGeneration`
  //    would also discard seven still-valid measured days.
  const correct = body("correctDay");
  assert.match(correct, /correctionGeneration &\+= 1/,
    "a press does not invalidate an in-flight read: the correction is wiped ~0.8s later");
  //    The invalidation must complete synchronously, before this function
  //    returns; deferred by even one turn, an in-flight read still lands first.
  assert.doesNotMatch(correct, /Task\s*[{(]|DispatchQueue|await /,
    "the invalidation is deferred to a later turn, so an in-flight read can still land before it");

  // Control: the extractor really is bounded, or ① proves nothing. `hoverExited`
  // sits directly below `hoverEntered`; its body must not contain the other's.
  assert.doesNotMatch(body("hoverExited"), /refreshWeek\(\)/,
    "control: the body extractor is spilling into the next function");
  // Control: the stripper works — it drops a comment and keeps the code beside it.
  assert.equal("let x = 1 // refreshWeek()".replace(/\/\/.*$/gm, "").trim(), "let x = 1",
    "control: the comment stripper is not stripping, so a commented-out call would pass");
  // ⚠️ `body()` takes the FIRST `func <name>(`. A decoy overload declared above
  //    the real one lets every assertion above read a function nobody calls.
  //    Every target needs this, not just `refreshWeek`.
  for (const name of ["refreshWeek", "refreshWeekIfDayChanged", "refreshPresentation",
                      "startFlowTimer", "hoverExited", "correctDay"]) {
    const declared = (vm.match(new RegExp(`func ${name.replace("+", "\\+")}\\(`, "g")) || []).length;
    assert.equal(declared, 1,
      `${name} is declared ${declared} times — the assertions above may be reading a decoy`);
  }
});

test("the week you have had lives on a branch in the top band, and never floats again", () => {
  // The week belongs to the branch in the top band's layout, not to a badge
  // floating in a corner.
  // The branch shares the product's own vocabulary with Perch's bird, and the
  // same colour language.
  const view = islandViews();
  const vm = viewModelSource();
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");

  // ① The branch stays visible during sessions because it owns row 1 of the top
  //    band, outside the exercise strip. It must never float as an overlay.
  assert.doesNotMatch(view, /if !isActiveSession \{[\s\S]{0,200}WeekPerch\(/,
    "the branch is hiding during a session again — its owner asked for it to stay");
  assert.doesNotMatch(view, /\.overlay\([^)]*\)\s*\{[\s\S]{0,300}WeekPerch\(/,
    "the branch became an overlay again — it must be a row of the layout");
  assert.match(view, /TopWeekRow\(viewModel: viewModel\)\s*\n\s*\.frame\(height: GuidedCareLayout\.topRowHeight\)/,
    "the branch is not mounted as row 1 of the top band");

  // ② The bird is the island's own asset, at its documented floor.
  //    ⚠️ 20pt is not a preference: ClosedIslandMark records that this bird is
  //    3:4 upright and collapses into a sliver below it.
  const perch = view.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(perch, "WeekPerch not found");
  assert.match(perch, /Image\("PerchBird"\)/, "the branch grew a bird that is not Perch's bird");
  assert.match(perch, /birdHeight: CGFloat = 20/, "the bird dropped below the 20pt floor");
  // …and no hand-rolled bird crept in from the prototypes.
  assert.doesNotMatch(perch, /Path\s*\{|<svg|ellipse\(/,
    "a hand-drawn bird came back — the prototype's generic SVG must not ship");

  // ③ A segment's FILL is purely its own reading. Hue says whether the day
  //    happened, alpha says how much of it was spent in flow, and nothing else
  //    — not a correction, not the cursor — may reach into that fill, because
  //    the fill IS the number on screen.
  //
  //    One continuous piece of wood carries the seven painted days; separate
  //    capsules would read as page dots rather than a week.
  assert.match(perch, /\.fill\(tint\(index\)\)/,
    "a day's fill stopped being purely its own reading");
  // Hue depends on whether the day has a reading, not merely whether its date
  // is in the past; an unjudged day must stay unpainted.
  assert.match(perch, /guard paints\(index\) else \{ return IslandPalette\.paper \}/,
    "lived and unlived days stopped being told apart by hue");
  assert.match(perch, /private func paints\([\s\S]{0,400}!isFuture\(index\)/,
    "the future is no longer part of what decides a day's hue");
  // ⚠️ Opacity over pure-black ground is brightness and bottoms out at black;
  //    level 1 would reach only 1.14:1 against unlived wood.
  //
  //    So two things are load-bearing and both are pinned. The paint goes ON
  //    TOP OF WOOD, which gives the low end a floor that is always visible
  //    (measured: level 1 at 1.89:1 against the wood, range 5.72× across the
  //    five). And it fades into the GROUND, not into the wood — fading into
  //    neutral wood drains the hue on the way down and level 1 arrives a muddy
  //    warm grey, where scaling against the ground keeps every level the same
  //    coral, genuinely one colour becoming more transparent.
  assert.match(perch, /private static func composited\(level: Int\) -> Color/,
    "the paint is not being blended against the ground — it will pick up the wood's grey");

  // ③a ONE branch, not seven pills: a single capsule carries the whole week
  //     and the days are painted onto it.
  assert.match(perch, /Capsule\(\)\s*\n\s*\.fill\(IslandPalette\.paper\.opacity\(Self\.unlived\)\)\s*\n\s*\.frame\(width: width/,
    "the branch stopped being one continuous piece of wood");
  // ⚠️ Nothing paints the card ground back into the branch. On a 6pt branch
  //    over black, any background-coloured divider is a visible hole; days
  //    differ by paint only.
  assert.match(perch, /IslandPalette\.paper\.opacity\(Self\.unlived\)/,
    "control: cannot see palette references inside WeekPerch at all");
  assert.doesNotMatch(perch, /IslandPalette\.capsule/,
    "the card's ground is painted into the branch again — that is a hole, not grain");
  assert.doesNotMatch(perch, /let notch|Self\.notch/,
    "the notch came back");
  assert.doesNotMatch(perch, /HStack\(spacing: Self\.gap\)/,
    "the days were spaced apart again");

  // ③b A correction and the cursor each get their OWN overlay, drawn over the
  //     colour rather than changing the fill that IS the reading.
  //
  //     A correction shows as words on the same line, never as a 1pt
  //     near-white hairline on a thin rod.
  //     Such a line takes too much of the wood's height and reads as a
  //     rendering fault; one step along neighbouring corals is not enough on
  //     its own to confirm the press.
  const inspectCell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(inspectCell, /corrections\[day\.date\] \?\? day\.level/,
    "your voice no longer shows anywhere on the day you argued with");
  assert.doesNotMatch(perch, /IslandPalette\.paper\.opacity\(0\.75\)/,
    "the correction hairline came back — it reads as a glitch, not as authorship");
  assert.match(perch, /let lit = hovering == index \|\| focused == index/,
    "hover/focus no longer drives its own channel");

  // ④ Position is the weekday: no letters, no dates on the island.
  assert.doesNotMatch(perch, /"Mon"|"Tue"|"M T W"|dateFormat/,
    "the branch started spelling out weekdays — position is the weekday");

  // ④b ⚠️ …and that only works because the seven positions ARE Monday…Sunday.
  //     A rolling seven-day window puts today at the right-hand end every day
  //     and therefore says nothing — it reads instantly as the bird standing in
  //     the wrong place. A fixed week is what makes position mean the weekday.
  const flow = fs.readFileSync(islandPath("DayFlow.swift"), "utf8");
  // ⚠️ `DayFlow.week` asks for the day MINUS ONE SECOND, and that only works
  //    while the event log writes whole seconds. Add `.withFractionalSeconds` to
  //    the writer and the last second of every day falls into no day at all.
  //    The two are one decision and nothing else holds them together.
  assert.match(flow, /dayEnd\.addingTimeInterval\(-1\)/,
    "the day window no longer stops short of midnight — every day re-reads the next day's file");
  assert.doesNotMatch(fs.readFileSync(islandPath("AgentEventLog.swift"), "utf8"),
    /withFractionalSeconds/,
    "the event log gained fractional seconds — DayFlow's one-second day boundary now drops data");
  assert.match(flow, /let mondayOffset = \(weekday \+ 5\) % 7/,
    "the week stopped being anchored to Monday");
  assert.doesNotMatch(flow, /value: -offset, to: startOfToday/,
    "the rolling seven-day window came back — today would sit at the end every day");
  // Control: the probe can see the anchor it is checking for.
  assert.match(flow, /calendar\.component\(\.weekday, from: startOfToday\)/,
    "control: cannot read the weekday computation at all");

  // ⑤ Only hand corrections are written to disk; the machine's reading is
  //    always recomputed from the event log.
  assert.match(vm, /DayScore\.record\(date: date, field: \.flow, value: value\)/,
    "a correction no longer lands in the ledger");
  assert.doesNotMatch(vm, /DayScore\.record\([^)]*machine|record[^)]*auto/i,
    "the island started filing its own verdict as if you had said it");
  // ⚠️ Comments stripped: a comment naming the call satisfies a raw match while
  //    the branch under the bird is permanently blank.
  assert.match(vm.replace(/\/\/.*$/gm, ""), /DayFlow\.read\(now: now\)/,
    "the week stopped being recomputed from the log");

  // ⑥ Compiled into the island, or it ships nothing.
  const sources = pbx.match(/00A1CE00000000000000002C \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(sources.length > 0, "control: the island's Sources phase could not be read at all");
  assert.ok(sources.includes("DayFlow.swift"), "DayFlow.swift is not compiled into the island");
  // ⚠️ The extension too. The drift gate only notices when the two Xcode projects
  //    DISAGREE — drop a file from BOTH and everything stays green while the week
  //    silently stops being maintained at all.
  assert.ok(sources.includes("IslandViewModel+Week.swift"),
    "IslandViewModel+Week.swift is not compiled into the island — the week has no maintainer");

  // ⑦ Mutation, ammunition counted first.
  const load = (src, anchor, wanted = 1) => {
    const hits = src.split(anchor).length - 1;
    assert.equal(hits, wanted, `mutation anchor is stale — matched ${hits} times, wanted ${wanted}: ${anchor}`);
    return (replacement) => src.split(anchor).join(replacement);
  };
  // m1 — make the branch hide during a session: ① must fire. The counted anchor
  //      ensures the mutation still reaches the intended branch.
  const m1 = load(view, "                TopWeekRow(viewModel: viewModel)")(
    "                if !isActiveSession { WeekPerch(days: []) }");
  assert.match(m1, /if !isActiveSession \{[\s\S]{0,200}WeekPerch\(/,
    "mutation: the branch went back to hiding during a session and the probe stayed quiet");
  // m2 — the bird shrinks below its floor: ② must fire.
  const m2 = load(view, "birdHeight: CGFloat = 20")("birdHeight: CGFloat = 11");
  assert.doesNotMatch(m2.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "",
    /birdHeight: CGFloat = 20/, "mutation: the bird shrank and the floor guard stayed quiet");
  // m3 — hover starts driving brightness: ③ must fire.
  const m3 = load(view, ".fill(tint(index))")(
    ".fill(hovering == index ? IslandPalette.paper : tint(index))");
  assert.ok(!/\.fill\(tint\(index\)\)/.test(m3),
    "mutation: hover reached into the reading and the probe stayed quiet");
  // m4 — the ground gets painted back into the branch as a hairline slit: ③a
  //      must fire. This is the exact defect 1.0.33 shipped, re-injected.
  const m4 = load(view, "                .clipShape(Capsule())")(
    "                .overlay(Rectangle().fill(IslandPalette.capsule).frame(width: 0.8))\n                .clipShape(Capsule())");
  assert.match(m4.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "",
    /IslandPalette\.capsule/,
    "mutation: the ground was painted into the branch and the wood guard stayed quiet");
});

test("the top of the card is two rows, and the card grew to hold them", () => {
  // The top band is a two-row, two-column grid: row 1 is the week's branch
  // (whose bird must have nothing at all above it), row 2 is the wave.
  //
  // The card grows to hold it, and that is not a preference: the frame strip
  // carries 44pt of slack, the new row takes 36 of it, and without the growth
  // the three figures would sit flush against the title and the card's bottom
  // edge. The card grows rather than the figures shrinking — the figures are
  // what a person is actually looking at while they move.
  const wc = fs.readFileSync(islandPath("IslandWindowController.swift"), "utf8");
  // ⚠️ A witness value, not a target: it moves whenever the top band does
  //    (260 → 276 for the second row, → 296 to unsqueeze the figures, → 298
  //    when the rod thickened). What it is really guarding is that every one
  //    of those additions was PAID FOR by the card rather than taken out of
  //    the three figures — so when this number is updated, check that the
  //    strip's slack went up and not down.
  assert.match(wc, /static let openedResultHeight: CGFloat = 298/,
    "the card did not grow — the new top row will be taken out of the figures");

  const view = islandViews();
  // 26 = a 20pt bird standing on 6pt of wood. (It was 24 while the rod was
  // 4pt; the rod thickened because colour needs area to be judged and five
  // corals could not be told apart on a 4pt bar.)
  assert.match(view, /static let topRowHeight: CGFloat = 26/, "row 1 has no height");
  assert.match(view, /static let topRowSpacing: CGFloat = 12/, "the two rows have no gap");

  // ⚠️ The branch belongs to a row, not a bottom-corner overlay. An overlay has
  //    no grid ownership and collides with the frame strip's territory.
  assert.doesNotMatch(view, /\.overlay\(alignment: \.bottomTrailing\)[\s\S]{0,400}WeekPerch\(/,
    "the branch went back to being an overlay — it must be a row of the layout");
  // Control: the probe can still see WeekPerch in this file at all, and the
  // branch now has a home in the top band. (That the branch is CONSTRUCTED
  // inside that home is pinned by the top-right-cell test, where the code
  // doing the constructing lives.)
  assert.match(view, /struct WeekPerch: View/,
    "control: WeekPerch cannot be found in the file");
  assert.match(view, /TopWeekRow\(viewModel: viewModel\)/,
    "the branch has no row to live in");
});

test("the branch fills its column, and the days are told apart by a gap in the PAINT", () => {
  const view = islandViews();
  const perch = view.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(perch, "WeekPerch is gone");

  // ① The width comes from outside now. The branch is a member of the top
  //    band's left column, sized by the layout exactly like the wave beside
  //    it — it no longer multiplies its own width out of a fixed day size.
  assert.match(perch, /let width: CGFloat/, "the branch still hard-codes its own width");
  assert.doesNotMatch(perch, /CGFloat\(days\.count\) \* Self\.dayWidth/,
    "the old fixed-width computation is still there");

  // ② ⚠️ The gap is cut into the COLOUR, not into the wood.
  //
  //    At full width the branch read as a progress bar. But what looks like a
  //    progress bar is the unbroken RUN OF CORAL, not the wood — so the coral
  //    is what gets cut, the wood stays continuous underneath, and what shows
  //    through the gap is wood.
  //
  //    ⚠️ This does not reverse the decision that removed the last divider.
  //    That one was drawn in the CARD'S GROUND COLOUR: background punched
  //    through wood is a hole, and six holes turned the branch into seven
  //    dashes on sight. No honest divider was possible then because there was
  //    no second material to draw one with. There is now — the unlived days'
  //    dim white IS the wood, and the coral is painted on top of it.
  assert.match(perch, /static let dayGap: CGFloat = 1\.5/, "the paint gap has no width");
  assert.doesNotMatch(perch, /IslandPalette\.capsule/,
    "the card's ground is being painted into the branch again — that is a hole, not a gap");
  // Control: the probe can see palette references inside WeekPerch at all.
  assert.match(perch, /IslandPalette\.paper\.opacity\(Self\.unlived\)/,
    "control: cannot see any palette reference inside WeekPerch");

  // ③ Mutation, ammunition counted first: paint the gap with the ground and
  //    the guard must go red.
  const hits = perch.split("static let dayGap: CGFloat = 1.5").length - 1;
  assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1`);
  const mutant = perch.replace("private var dayWidth: CGFloat",
    "private static let grain = IslandPalette.capsule\n    private var dayWidth: CGFloat");
  assert.match(mutant, /IslandPalette\.capsule/,
    "mutation: the ground was painted into the branch and the probe stayed quiet");
});

test("the top-right cell reads today's flow, and can name a project that finished", () => {
  const view = islandViews();
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(cell, "TodayFlowCell was not written");

  // ① Zero new data: the words and the branch's fill must read the SAME
  //    existing number.
  //    Showing it may not produce a new computation or a new ledger record.
  assert.match(cell, /week\.first\(where: \{ \$0\.date == todayKey \}\)/,
    "the cell is not reading today out of the week the branch already draws");
  assert.doesNotMatch(view, /DayScore\.record\([^)]*flowSeconds|record\([^)]*todaySeconds/,
    "today's reading is being filed to the ledger — the machine's verdicts never land on disk, only your corrections do");

  // ② ⚠️ Before there are five pickups this cell says NOTHING, and it must not
  //    say "0m". DayFlow.seconds returns 0 when it has fewer than
  //    FlowSense.window pickups to judge on, and that zero means "no reading
  //    yet", not "zero flow today". Printing 0m first thing in the morning is
  //    passing missing data off as a result.
  assert.match(cell, /static func label\(seconds: TimeInterval\) -> String\?/,
    "label must be able to return nil — with no reading the cell stays empty");
  assert.match(cell, /guard seconds > 0 else \{ return nil \}/,
    "no-reading does not return nil, so the cell will print 0m");

  // ③ A finished project takes the cell over, and its life is measured from
  //    the moment it finished (ProjectStatus.updatedAt), on the wall clock.
  //    That works because the signal is two-tier: the collapsed island's right
  //    wing already shows a green COUNT (kept 15 minutes by StalePolicy) that
  //    says "something finished"; this cell is the detail that says which.
  // Finished projects join the fair queue; this test pins only that the cell
  // can name them and preserve completion order.
  assert.match(cell, /\$0\.status == \.done/, "the cell never looks for a finished project");
  assert.match(cell, /updatedAt/, "finished projects are no longer ordered by when they finished");

  // ④ The word "focus" may not appear in anything this card prints. What the
  //    number measures is how fast an agent gets picked back up, not attention.
  //    ⚠️ String literals only, and ONE LINE at a time: WeekPerch has
  //    .focusable() and @State focused, so a bare /focus/ would shoot them —
  //    and `[^"]*` alone crosses newlines in JS, so it happily spans from one
  //    quote, through a comment mentioning `focused`, to a quote pages later.
  //    Excluding \n is what makes this a string-literal probe rather than a
  //    whole-file one.
  assert.doesNotMatch(view, /"[^"\n]*[Ff]ocus[^"\n]*"/,
    "the card prints the word focus — this number does not measure attention");
  // Control: the same probe does fire on a real literal.
  assert.match('let s = "in focus today"', /"[^"\n]*[Ff]ocus[^"\n]*"/,
    "control: the string-literal probe cannot see the word it is looking for");

  // ⑤ The branch is actually constructed in its row, with the column's width.
  const row = view.match(/struct TopWeekRow[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(row, "TopWeekRow is gone");
  // Pin semantic ownership, not source distance: the branch width comes from
  // the column regardless of how large the closure becomes.
  assert.match(row, /width: geo\.size\.width/,
    "the branch is not being given the column's width");
  assert.match(row, /WeekPerch\(/, "the branch is not constructed in its row");
  assert.match(row, /TodayFlowCell\(/, "row 1 has no right-hand cell");
});

test("a project waiting on you stops the rotation instead of being scrolled past", () => {
  const view = islandViews();
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(label, "ActiveProjectLabel is gone");

  // Waiting is the only state that asks the person to act, so it pins the label
  // until cleared instead of rotating behind merely running projects.
  assert.match(label, /\$0\.status == \.waiting/, "waiting is not picked out on its own");
  assert.match(label, /waiting\.isEmpty \? running : waiting/,
    "waiting does not take the label over");
  assert.match(label, /guard waiting\.isEmpty/, "waiting does not stop the rotation");
  assert.doesNotMatch(label, /\.status == \.working \|\| \$0\.status == \.waiting/,
    "working and waiting are back in one rotation list");

  // The right-hand cell is a few dots and ONE name. No "running"/"waiting"
  // words: the colour is already saying it, so the word is a second copy.
  assert.doesNotMatch(view, /"\d* ?running"|"\d* ?waiting"|"\d* ?approval"/,
    "the card started spelling out the statuses again — the colour already says it");

  // Both rows' right-hand cells share one width, or the two columns do not
  // line up and the grid stops being a grid.
  const strip = view.match(/struct AgentActivityStrip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(strip, /GuidedCareLayout\.rightColumnWidth/,
    "row 2's right cell does not use the band's shared column width");
  assert.match(strip, /AgentStatusDots\(projects: projects\)[\s\S]{0,200}ActiveProjectLabel\(/,
    "the dots and the name are not in one cell — apart, they were two weak signals");

  // Mutation, ammunition counted first: put waiting back in the rotation and
  // the guard must go red.
  const hits = label.split("waiting.isEmpty ? running : waiting").length - 1;
  assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1`);
  const mutant = label.replace("waiting.isEmpty ? running : waiting", "running + waiting");
  assert.doesNotMatch(mutant, /waiting\.isEmpty \? running : waiting/,
    "mutation: waiting rejoined the rotation and the probe stayed quiet");
});

test("green never mixes into the wave's row — finished belongs to the row above", () => {
  const view = islandViews();
  const dots = view.match(/private struct AgentStatusDots[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(dots, "AgentStatusDots is gone");

  // ⚠️ The two rows split by TIME, and the colours have to obey that split.
  //    Row 1 is the week and what just finished; row 2 is what is happening
  //    right now. Green means finished — it already has a home in row 1's cell,
  //    where the completed project's name is shown. Letting a green dot sit
  //    beside the wave puts one status in two places and blurs what row 2 is
  //    for: green and the wave's blue stay apart.
  assert.match(dots, /\$0\.status == \.working \|\| \$0\.status == \.waiting/,
    "the wave's row is showing every status — green belongs to the row above");
  // Control: the probe can see a status comparison in this view at all.
  assert.match(dots, /status/, "control: cannot read any status handling in AgentStatusDots");

  // …and row 1 really is where green lives.
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(cell, /IslandPalette\.statusDone/,
    "row 1 stopped showing the finished project — then green has nowhere to live");

  // Mutation, ammunition counted first.
  const hits = dots.split(".status == .working || $0.status == .waiting").length - 1;
  assert.equal(hits, 1, `mutation anchor is stale — matched ${hits} times, wanted 1`);
  const mutant = dots.replace(".filter { $0.status == .working || $0.status == .waiting }", "");
  assert.doesNotMatch(mutant, /\$0\.status == \.working \|\| \$0\.status == \.waiting/,
    "mutation: the filter came off and the probe stayed quiet");
});

test("row 1's cell sits on the branch's own line, and every name says which agent", () => {
  const view = islandViews();
  const row = view.match(/struct TopWeekRow[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(row, "TopWeekRow is gone");

  // ① The right-hand cell is centred on the ROD, not on the row.
  //    Row 1 is 24pt tall because the bird needs 20 of them above 4pt of wood,
  //    so centring the cell in the row floats it ~10pt above the branch and
  //    the two halves of the row stop reading as one line. Its owner: "keep
  //    the green dot on the same horizontal line as the branch."
  assert.match(row, /HStack\(alignment: \.bottom/,
    "row 1 stopped aligning on its bottom edge — the cell will float above the wood");
  assert.match(row, /\.alignmentGuide\(\.bottom\)[\s\S]{0,160}WeekPerch\.segment\.height \/ 2/,
    "the cell is not centred on the rod's own centreline");

  // ② Every name says which agent ran it. One format, both rows — they sit in
  //    one column and two spellings would read as two different things.
  assert.match(view, /static func caption\(_ project: ProjectStatus\) -> String/,
    "there is no single place that spells a project's caption");
  // ⚠️ Brackets were tried and rejected on sight — the middle dot is the
  //    card's own separator and it was already there. What survives from that
  //    round is the part that mattered: ONE place spells this, and the agent
  //    is always part of the name.
  assert.match(view, /"\\\(project\.name\) · \\\(project\.source\)"/,
    "the caption is not `project · agent`");
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  // ⚠️ No trailing paren in the pattern: both call sites pass the function by
  //    reference (`.map(ProjectCaption.caption)`), which is the point — one
  //    spelling, referred to, not two spellings that happen to agree today.
  assert.match(cell, /ProjectCaption\.caption/,
    "the finished project's name skips the shared caption — the two rows would drift apart");
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(label, /ProjectCaption\.caption/,
    "the running project's name skips the shared caption");
  // …and the old hand-rolled spelling is gone from both.
  // A second spelling must not creep back in beside the shared one.
  const spellings = (view.match(/\\\(\w+\.name\)/g) ?? []).length;
  assert.equal(spellings, 1,
    `a project name is spelled in ${spellings} places — it must be exactly 1`);
});

test("both cells in the right column are set in exactly one size", () => {
  // Its owner caught this on sight: "why do the blue project name and the
  // finished one look like different sizes?" They shipped at 10 and 11.
  // Stacked in one column a 1pt difference does not read as slightly smaller,
  // it reads as a different KIND of thing — and two literals in two views is
  // precisely how it happened.
  const view = islandViews();
  assert.match(view, /static let font = Font\.system\(size: 11, weight: \.medium\)/,
    "the shared caption font is gone");
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  for (const [name, src] of [["TodayFlowCell", cell], ["ActiveProjectLabel", label]]) {
    assert.match(src, /\.font\(ProjectCaption\.font\)/, `${name} does not use the shared size`);
    assert.doesNotMatch(src, /\.font\(\.system\(size:/, `${name} still hard-codes a size of its own`);
  }
  // Control: the probe can see a hard-coded font elsewhere in the file, so a
  // clean result means these two are clean — not that the pattern never matches.
  assert.match(view, /\.font\(\.system\(size: \d+/,
    "control: cannot see any hard-coded font in the file at all");
});

test("pressing a day says what it just became, in words", () => {
  const view = islandViews();
  const perch = view.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "";
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";

  // Pressing a day must show the new level at once, in the words on that same
  // line.
  // Neighbouring corals are not enough on their own to confirm the change, and
  // the fill may not be exaggerated to be seen — the colour IS the reading.
  assert.match(perch, /let onInspect: \(DayFlow\.Day\?\) -> Void/,
    "the branch does not tell anyone which day the cursor is on");
  assert.match(cell, /let inspecting: DayFlow\.Day\?/,
    "the cell cannot show the day being pointed at");
  assert.match(cell, /corrections\[day\.date\]/,
    "the cell does not show your own answer for a day you corrected");

  // ① Hover outranks everything and never falls through: an empty day may not
  //    fall back to a finished project or to today.
  //    Point at a day, get that day.
  assert.match(cell, /inspecting\.map \{ self\.inspected\(\$0, at: context\.date\) \}/,
    "hover can fall through again: an empty day shows today's number wearing the hovered day's name");
  assert.doesNotMatch(cell, /inspecting\.flatMap/,
    "inspected went optional again — nil re-opens the fall-through this exists to close");
  // ② Flow time and "agents ran" each wear their own name — on the resting
  //    carousel AND on the hovered day's pages.
  //    A bare number turns "no flow" and "did not work" into one message.
  assert.match(cell, /"in flow \\\(flow\)"/,
    "today's flow number is bare again — it will be read as hours worked");
  assert.match(cell, /"agents ran \\\(ran\)"/,
    "the agents-ran reading lost its name or left the carousel");
  assert.match(cell, /label\(seconds: day\.workSeconds\)/,
    "the hovered day's second page does not read the WORK duration — two names, one number");
  //    Reading "agents ran" is not showing it: the page must actually be
  //    APPENDED to the carousel.
  assert.match(cell, /pages\.append\("\\\(name\) agents ran \\\(ran\)"\)/,
    "the hovered day's agents-ran page is read but never shown");
  assert.match(cell, /label\(seconds: today\.workSeconds\)/,
    "the resting carousel does not read the WORK duration");
  // ③ Hover pages turn every 3 seconds, and the clock restarts ONLY on
  //    entering the branch from outside.
  //    Sliding across the seven days keeps the page, so one measure can be
  //    read straight along the week.
  assert.match(cell, /hoverSlotSeconds: TimeInterval = 3/,
    "hover pages lost their own faster cadence");
  // ④ The hover shape is wider than the 24pt layout box, so a slight drift off
  //    the wood does not snap the cell back mid-read.
  //    Only the hit shape may grow: growing the FRAME would push row 1 and row
  //    2 apart.
  const perchView = fs.readFileSync(islandPath("WeekPerch.swift"), "utf8");
  assert.match(perchView, /contentShape\(Rectangle\(\)\.inset\(by: -8\)\)/,
    "the hover hit area shrank back to the layout box — drifting off the wood drops the reading");
  assert.match(perchView, /hitHeight: CGFloat = 24/,
    "the layout box grew instead of the hit shape — rows drift apart");
  const topRow = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  assert.match(topRow, /if inspecting == nil, day != nil \{ inspectOrigin = Date\(\) \}/,
    "the page clock lost its restart-on-entry — or restarts on every day change again, "
      + "which makes the agents page need three unbroken seconds while flow returns instantly");
  // ⑤ ONE format for every day with a reading: "Mon 2/5 · 2h47m". The score is
  //    corrections-else-machine and the duration stays the machine's
  //    measurement; a press changes the number, never the format.
  assert.match(cell, /corrections\[day\.date\] \?\? day\.level/,
    "the score is not corrections-else-machine — either a press stops showing, or the machine never prints");
  assert.match(cell, /\\\(level\)\/5 · \\\(time\)/,
    "score and duration split into two formats again — a corrected day hides its measurement");
  // ⑥ No reading says so: missing, never zero, never another day's number.
  assert.match(cell, /"\\\(name\) —"/,
    'a day with no reading must answer "—" itself');

  // ⑦ The white hairline is gone. It was meant to say "you changed this one"
  //    and read as a rendering fault instead: 1pt of near-white is a large
  //    fraction of a thin rod's height. A correction shows up as words now.
  assert.doesNotMatch(perch, /IslandPalette\.paper\.opacity\(0\.75\)/,
    "the correction hairline came back — it reads as a glitch, not as authorship");

  // ⑧ A correction still never overwrites the machine's reading: only
  //    corrections are filed, and the week is recomputed from the log.
  const vm = viewModelSource();
  // ⚠️ Comments stripped: a comment naming the call satisfies a raw match while
  //    the branch under the bird is permanently blank.
  assert.match(vm.replace(/\/\/.*$/gm, ""), /DayFlow\.read\(now: now\)/,
    "the week stopped being recomputed from the log");
  assert.match(vm, /DayScore\.record\(date: date, field: \.flow, value: value\)/,
    "a correction no longer lands in the ledger");
});

test("the five levels are far enough apart, and a finished project waits its turn", () => {
  const view = islandViews();
  const perch = view.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "";
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";

  // ① Level 1 must stay clearly apart from a day that never happened, and
  //    level 5 must reach the full paint.
  //    Level 1 measures 1.89:1 against the wood; below about 1.5:1 a lived day
  //    starts reading as one that never happened.
  assert.match(perch, /static let alphas: \[Double\] = \[0\.45, /,
    "level 1's floor moved — it is measured against the wood (1.89:1), not chosen");
  assert.match(perch, /, 1\.0\]/, "level 5 no longer reaches the full paint");
  assert.match(perch, /static let paint = Color\(red: 1\.000, green: 0\.800, blue: 0\.720\)/,
    "the coral being painted on moved");

  // ② Colour needs AREA to be judged, and 4pt was not enough to tell five
  //    corals apart. The second lever, used together with the first.
  assert.match(perch, /static let segment = CGSize\(width: 18, height: 6\)/,
    "the rod went back to being too thin to read a colour off");

  // ③ A finished project TAKES ITS TURN, and every slot holds the same 30
  //    seconds.
  //    A completion may not cut in the moment it happens, nor hold the cell
  //    for five minutes.
  assert.match(cell, /static let slotSeconds: TimeInterval = 30/, "the slot is not 30 seconds");
  assert.doesNotMatch(cell, /doneLifetime/,
    "the five-minute takeover is back — a completion may not hold the cell on its own terms");
  assert.match(cell, /CarouselClock\.slot\(now: now, origin: carouselOrigin/,
    "the cell is not cycling through its slots via the tested clock");
  // Whether a completion is still eligible is StalePolicy's business, never a
  // second timer of our own.
  assert.match(cell, /\$0\.status == \.done/, "the cell no longer looks for finished projects");
  const stale = fs.readFileSync(islandPath("StalePolicy.swift"), "utf8");
  assert.match(stale, /15/, "control: StalePolicy no longer holds the window this relies on");
});

test("looking away from the branch lands on today's reading, not on a completion", () => {
  const view = islandViews();
  const cell = view.match(/private struct TodayFlowCell[\s\S]*?\n\}/)?.[0] ?? "";
  const row = view.match(/struct TopWeekRow[\s\S]*?\n\}/)?.[0] ?? "";

  // The resting carousel restarts when the cursor leaves the branch, so slot
  // zero reliably tells you about today.
  // Keyed to absolute time, leaving can land straight on a completion, which
  // reads as the finished project cutting in.
  assert.match(cell, /let carouselOrigin: Date/, "the cycle has no origin to restart from");
  assert.match(cell, /origin: carouselOrigin/,
    "the cycle is still keyed to absolute time — leaving hover lands anywhere");
  assert.match(row, /carouselOrigin = Date\(\)/, "nothing restarts the cycle when you look away");
  assert.match(row, /if day == nil, inspecting != nil/,
    "the cycle restarts on every hover event instead of only when you leave");
});

test("a day's level is how much coral got painted onto the wood, not five separate colours", () => {
  const view = islandViews();
  const perch = view.match(/struct WeekPerch[\s\S]*?\n\}/)?.[0] ?? "";

  // ⚠️ One coral at five opacities — transparency, not brightness.
  //
  //    Two separate things make that true, and both are pinned. The paint is
  //    laid ON TOP OF WOOD rather than straight onto the ground: opacity over
  //    pure black IS brightness (coral at 30% over black is arithmetically the
  //    same pixels as a darker coral at 100%) and bottoms out at black, which
  //    left level 1 indistinguishable from an unlived day at 1.14:1 — anything
  //    under about 1.5 reads as "this day never happened", a lie about the data.
  //    Over wood the floor is the wood itself, always visible.
  //
  //    And the coral's own colour is scaled against the GROUND, not blended
  //    into the wood: blending into neutral wood drains the hue on the way down
  //    and level 1 arrives a muddy warm grey. Measured with the shipped ladder:
  //    level 1 at 1.89:1 above the wood, 5.72× of emitted light across the five.
  assert.match(perch, /static let paint = Color\(red: 1\.000, green: 0\.800, blue: 0\.720\)/,
    "the single coral being painted on is gone");
  assert.match(perch, /static let alphas: \[Double\] = \[0\.45, 0\.5875, 0\.725, 0\.8625, 1\.0\]/,
    "the five levels are no longer five opacities");
  assert.match(perch, /Color\(red: 1\.000 \* a, green: 0\.800 \* a, blue: 0\.720 \* a\)/,
    "a level is not the one coral scaled — the hue will drift as it fades");
  assert.doesNotMatch(perch, /static let ladder/,
    "the five hand-mixed colours are still here — two ways to say a level is one too many");

  // The wood must still be UNDER the paint, or partial opacity composites onto
  // the card's black instead and the whole argument collapses.
  assert.match(perch, /Capsule\(\)\s*\n\s*\.fill\(IslandPalette\.paper\.opacity\(Self\.unlived\)\)\s*\n\s*\.frame\(width: width/,
    "the wood is no longer drawn underneath — partial opacity would land on black");
});

test("the top band's two rows share a column geometry that belongs to neither of them", () => {
  // Both rows share the band's 152pt right column and 16pt gutter; neither row
  // owns geometry that the other must reach through it to use.
  const view = islandViews();
  assert.match(view, /static let rightColumnWidth: CGFloat = 152/,
    "the shared column width is not on the band's own layout");
  assert.match(view, /static let columnGutter: CGFloat = 16/,
    "the shared gutter is not on the band's own layout");
  assert.doesNotMatch(view, /TopWeekRow\.rightWidth|TopWeekRow\.gutter/,
    "row 2 is reaching into row 1 again for geometry neither of them owns");
});

test("only a corrected day is told it was corrected, and told how to undo", () => {
  const row = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  const pageLine = row.match(/pages\.insert\("[^"]*"[^)]*\)/)?.[0];
  assert.ok(pageLine, "the hover pages no longer carry an inserted page at all");
  assert.match(pageLine, /✎/, "the mark that says a score was edited by hand is gone");
  assert.match(pageLine, /right-click/,
    "the page marking a hand-edited score no longer says how to take it back");
  assert.match(pageLine, /\\\(level\)\/5/,
    "the page a press lands on stopped carrying the score — the press confirms nothing in words");

  // The insert must sit INSIDE the correction test. Comments may stand between
  // them, so the block is matched rather than the two lines being required to
  // touch — a guard that pins formatting goes red for a comment and teaches
  // people to loosen it.
  const block = row.match(/if corrections\[day\.date\] != nil \{([\s\S]*?)\n        \}/)?.[1];
  assert.ok(block && /pages\.insert/.test(block),
    "the edited-mark page is no longer conditioned on the day carrying a correction");

  const perch = fs.readFileSync(islandPath("WeekPerch.swift"), "utf8");
  const clearBody = perch.match(/private func clear\(_ index: Int\?\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(clearBody, "WeekPerch no longer has a path that takes a correction back");
  assert.doesNotMatch(clearBody, /onCorrect/,
    "taking a correction back writes a level — undo is walking the ladder again");
  assert.match(clearBody, /onClear/, "the undo path stopped calling out to take the correction back");

  // Undoing has to be visible where the day speaks. Without restarting the
  // pages the cell rolls on to its own clock and the press answers nothing.
  const pressed = row.match(/onCorrect: \{ date, value in([\s\S]*?)\n                          \},/)?.[1];
  assert.ok(pressed && /inspectOrigin = Date\(\)/.test(pressed),
    "pressing a day no longer restarts the hover pages — the new score arrives whenever the rotation feels like it");

  const wired = row.match(/onClear: \{ date in([\s\S]*?)\n                          \},/)?.[1];
  assert.ok(wired, "the undo is wired straight through again — nothing tells the cell to speak");
  assert.match(wired, /clearDay/, "the undo stopped reaching the ledger");
  assert.match(wired, /inspectOrigin = Date\(\)/,
    "undoing no longer restarts the hover pages — the press lands with nothing on screen changing");
});

test("every hover page fits the cell that has to print it", () => {
  // Correct strings and conditions are insufficient if the final word clips
  // inside the 152pt column.
  const row = fs.readFileSync(islandPath("TopWeekRow.swift"), "utf8");
  const card = fs.readFileSync(islandPath("GuidedCareCard.swift"), "utf8");
  const caption = fs.readFileSync(islandPath("ProjectCaption.swift"), "utf8");

  const column = Number(card.match(/rightColumnWidth: CGFloat = (\d+)/)?.[1]);
  const size = Number(caption.match(/Font\.system\(size: (\d+), weight: \.(\w+)\)/)?.[1]);
  const weight = caption.match(/Font\.system\(size: \d+, weight: \.(\w+)\)/)?.[1];
  assert.ok(column && size && weight, "control: the column width or the caption font could not be read");
  // The row is a 6pt dot and a 6pt gap before the text starts.
  const available = column - 12;

  // Longest strings the cell can be asked to print: the fixed instruction, and
  // the widest shapes the two templates can take.
  const literal = row.match(/pages\.insert\("([^"]+)"/)?.[1];
  assert.ok(literal, "the inserted page is gone");
  // The literal interpolates the level; measure it with a real one in place,
  // never with the source's own `\(level)` spelled out — that is 7 characters
  // the cell never prints and would make this guard measure a string nobody sees.
  const samples = [literal.replace(/\\\(level\)/g, "4"), "Wed 4/5 · 12h46m", "Wed agents ran 12h07m"];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-caption-width-"));
  const main = path.join(tmp, "main.swift");
  const binary = path.join(tmp, "run");
  fs.writeFileSync(main, `
import AppKit
let f = NSFont.systemFont(ofSize: ${size}, weight: .${weight})
let out = CommandLine.arguments.dropFirst().map {
    Double(($0 as NSString).size(withAttributes: [.font: f]).width)
}
print(String(data: try! JSONSerialization.data(withJSONObject: Array(out)), encoding: .utf8)!)
`);
  execFileSync("swiftc", [main, "-o", binary], { stdio: "pipe" });
  const widths = JSON.parse(execFileSync(binary, samples, { encoding: "utf8" }));

  // Control: the ruler must be able to say "too wide", or a pass means nothing.
  const overlong = JSON.parse(execFileSync(binary, ["x".repeat(60)], { encoding: "utf8" }))[0];
  assert.ok(overlong > available, "control: the measurement never exceeds the cell, so it measures nothing");

  for (const [i, w] of widths.entries()) {
    assert.ok(w <= available,
      `"${samples[i]}" is ${w.toFixed(1)}pt in a ${available}pt cell — it prints with its end cut off`);
  }

  // ⚠️ Fitting is not the test. A string measured at 139.9pt in a 140pt cell
  // passes "it fits" and is still a coin toss: this ruler and the one the view
  // lays out with are different pieces of code, and nothing here has ever
  // checked that they agree to a tenth of a point.
  // The bound that needs no invented constant: no page may be wider than the
  // widest page this cell is ALREADY shipping. Whatever margin that one has is
  // the margin the design has been living on.
  const [addedWidth, ...shippedWidths] = widths;
  const widestShipped = Math.max(...shippedWidths);
  assert.ok(addedWidth <= widestShipped,
    `the added page is ${addedWidth.toFixed(1)}pt, wider than the ${widestShipped.toFixed(1)}pt ` +
    `page this cell already prints — it may fit today and truncate on another machine`);
});

// Which lines in a Swift file are agent notes that detach the doc block above
// them. One function, used both on the real sources and on the fixtures below —
// a control that calls something else proves nothing about what runs.
//
// ⚠️ Case-insensitive and whole-line, exactly as export-perch.py's NOTE_LINE is:
// the publishing step strips a lower-case note too, so one of those detaches
// the docs in this tree and then vanishes from the package. A guard that only
// saw upper case would never hear about it.
