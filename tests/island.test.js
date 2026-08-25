// This is the whole-package regression suite for the Perch island.
// It reads the source and the release manifest, compiles Swift fixtures in a
// temporary directory, and runs the Python scripts.
// It covers behaviour, source structure, privacy boundaries, and the working
// repo's guard against a wrong push.
// It never performs a real install, a full export, or a push to a public repo.
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
// Most view guards assert what the whole layer DOES, never which file a type
// sits in.
// The seven view files are joined before they are scanned, so moving a type
// inside the layer cannot dodge a guard.
// The few tests that must pin ownership read their own file directly.
//
// ⚠️ Side effect worth knowing: every `doesNotMatch` against this sweeps the
// whole layer rather than one file, which makes it strictly harder to pass.
const ISLAND_VIEW_FILES = ["IslandView.swift", "IslandPalette.swift", "ProjectCaption.swift",
                           "GuidedCareCard.swift", "AgentActivityStrip.swift",
                           "TopWeekRow.swift", "WeekPerch.swift"];
const islandViews = () =>
  ISLAND_VIEW_FILES.map((f) => fs.readFileSync(islandPath(f), "utf8")).join("\n\n");
const ISLAND_VIEW_SWIFT = islandPath("IslandView.swift");
// ⚠️ The view model is its own file plus its extensions. Every guard about what
// the view model DOES must read ALL of them, or a rule is dodged by moving the
// code one file sideways — which is exactly what happened to `refreshWeek`.
//
// ⚠️ DERIVED from the tree, never a hand-written list: a list of two is a list
// that a third `IslandViewModel+*.swift` walks straight past, taking every
// `doesNotMatch` rule with it.
const viewModelFiles = () =>
  islandTree().map((p) => path.basename(p))
    .filter((b) => b.startsWith("IslandViewModel") && b.endsWith(".swift")).sort();
const viewModelSource = () => {
  const files = viewModelFiles();
  // Control: the scan really found the extension too, or every guard below is
  // reading half the subject and cannot say so.
  assert.ok(files.length >= 2 && files.includes("IslandViewModel.swift"),
    `control: only ${files.length} view-model file(s) found — the scan surface collapsed`);
  return files.map((f) => fs.readFileSync(islandPath(f), "utf8")).join("\n\n");
};
const SOURCE_HEALTH_SWIFT = islandPath("SourceHealth.swift");
// The ledger needs the container location; the container id is read from
// Info.plist (AppGroup.swift). Compiling the ledger requires it.
const APP_GROUP_SWIFT = islandPath("AppGroup.swift");
const CARE_MOVE_POOL_SWIFT = islandPath("CareMovePool.swift");
const CARE_SESSION_CLOCK_SWIFT = islandPath("CareSessionClock.swift");
const CARE_SESSION_RECORDER_SWIFT = islandPath("CareSessionRecorder.swift");

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


test("the closed island shows a bird for the machine, and it stands on nothing", () => {
  const view = islandViews();

  // ① The app is called Perch and its icon is a bird on a branch. The leaf
  //    predated the name; nothing should quietly put it back.
  const mark = view.match(/struct ClosedIslandMark[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(mark, /Image\("PerchBird"\)/, "the closed mark is the app's own bird, the one on the icon");
  assert.doesNotMatch(mark, /"leaf\.fill"/, "the leaf belonged to the old name");
  // Not the system symbol: `bird.fill` is mid-flight with raised wings, a
  // different creature from the one perched on the icon.
  assert.doesNotMatch(mark, /systemName: "bird/, "the system bird is flying; ours is perched");
  assert.match(mark, /renderingMode\(\.template\)/, "template, or the status colour stops applying");

  // ①b Size is load bearing, not decoration. This bird stands upright (3:4),
  //     so at the leaf's old 11pt it is ~8pt wide and collapses to a sliver.
  //     Measured: it only reads from about 20pt up, and the wing is 44×38.
  const height = Number(mark.match(/\.frame\(height: (\d+)\)/)?.[1] ?? 0);
  assert.ok(height >= 20 && height <= 30,
    `perched bird needs ~20-30pt to read, got ${height}`);

  // ①c The breath must stay gentle. The leaf used 1.45 because it was tiny;
  //     at this size that reads as inflating, and 24×1.45 nearly fills the wing.
  //     (the largest assignment, not the first — `scale = 1.0` is the reset)
  const swell = Math.max(...[...mark.matchAll(/scale = (1\.\d+)/g)].map((m) => Number(m[1])));
  assert.ok(swell > 1 && swell <= 1.2, `a perched bird breathes, it does not grow (got ${swell})`);

  // ② The bird stands on nothing, and the wing holds it directly.
  //    ⚠️ Four attempts said "is a human at the work" in the closed capsule —
  //    a dot beside the bird, a branch, a branch under the bird, that branch
  //    plus a worded capsule in the open card — and every one failed the same
  //    way: unreadable, and in the end unnoticed. The answer was to delete it
  //    and let the bird float, so no wrapper, no plinth, nothing in between.
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

  // ④ The wave keeps the card's top row to itself. It was written when a
  //    presence instrument sat in the opposite corner and might have crept into
  //    the row; the instrument is gone, and the row is still not a place to put
  //    the next one.
  const strip = view.match(/struct AgentActivityStrip[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(strip, "AgentActivityStrip not found");
  assert.doesNotMatch(strip, /presence/i,
    "the top row is the wave's, and no presence instrument may reach into it");
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

  // The old comment claimed the log is deliberately NOT reloaded. It is now,
  // and a docstring that describes the opposite of the code misleads exactly
  // as far as dead code does.
  assert.ok(!/Kept in memory rather than reloaded from the log/.test(vm),
    "the comment still says the log is never reloaded, and it is");
});

test("one black for both states, and the wave's dim end is derived from it", () => {
  // The ground was #1F1A18 — 31 levels up from black and warm with it (R>G>B)
  // — which read as a warm grey patch sitting beside the bezel. Going pure
  // black fixed that and broke something else: measured, a short wave bar drawn
  // at 0.14 alpha sits 0.011 of emitted luminance above #1F1A18 but only 0.0045
  // above pure black. Same alpha, 2.4× less light, and the dim wave went hard
  // to see.
  //
  // ⚠️ One constant for both surfaces is NOT justified by a seam — there is no
  // seam. `body` swaps closed for open and the card leaves the view tree
  // entirely when closed; two surfaces that never coexist cannot meet at an
  // edge. It is justified by both states owing the viewer the same depth.
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

test("the island neither says where you are nor speaks Chinese", () => {
  // Presence was retired: the island stopped drawing the branch under the bird
  // and the "at the perch · N min" capsule, and the recorder behind them is
  // gone too. What is left to guard is that neither display comes back by
  // accident, and that nothing a person reads on the island is in Chinese.
  const view = islandViews();
  const vm = viewModelSource();

  // ① Neither retired view survives — declaration or call site.
  //    ⚠️ Control group first, and it is a standing rule here: a scan that
  //    finds nothing proves nothing until it has been shown to find something.
  //    Every "suspiciously clean" result in this repo so far turned out to be a
  //    collapsed scan surface rather than a clean file.
  const drawnNames = (swift) => swift.match(/\bPresencePerch\b|\bPresenceReadout\b/g) ?? [];
  const control = [
    "            if let presence, !isStale { PresencePerch(state: presence) }",
    "private struct PresenceReadout: View { var body: some View { Text(label) } }",
    "                PresenceReadout(state: presence, since: viewModel.presenceSince)",
  ].join("\n");
  assert.equal(drawnNames(control).length, 3,
    "control: the name scanner cannot see the two views even when they are right there");
  assert.deepEqual(drawnNames(view), [],
    "the island is drawing presence again — the branch and the readout were both retired");

  // ①b Nothing always-lit may be stacked under the bird in the notch, or the
  //     removed branch comes back under the name of decoration. The week under
  //     the bird lives in the unfolded card and is a different instrument.
  const capsuleFn = (swift) => swift.match(/private func capsule\([\s\S]*?\n    \}/)?.[0] ?? "";
  const wing = capsuleFn(view);
  assert.ok(wing, "capsule() not found");
  assert.match(wing, /ClosedIslandMark\(status: viewModel\.agentStatus\)/,
    "the closed wing must hold the bare bird now, with nothing under it");
  assert.doesNotMatch(wing, /VStack/,
    "nothing may be stacked under the bird: it was asked to float, not to get a new plinth");

  // ①c Neither layer may carry a presence value for a display that is gone.
  assert.doesNotMatch(view, /viewModel\.presence/,
    "the island still reads a presence value it no longer shows");
  assert.doesNotMatch(vm, /@Published var presence/,
    "the view model still publishes presence for nobody");

  // ② Nothing a person reads on the island is in Chinese. The scan used to be
  //    scoped to one control at a time because one readout was a standing
  //    exception; with that readout gone the whole file is scanned instead.
  // Escaped, not literal: two of the six range ends are an ideographic
  // space and unassigned code points, so spelled out they look like damage.
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const literals = (swift) =>
    swift.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
      .match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const plantedWord = literals('        let word = state == .atWork ? "在岗" : "离岗"\n');
  assert.equal(plantedWord.length, 2, "control: the literal scanner sees no string at all");
  assert.ok(plantedWord.every((s) => CJK.test(s)),
    "control: the scanner cannot tell Chinese from anything else");
  assert.equal(literals("// 只有注释\nlet x = 1\n").length, 0,
    "control: the scanner reads the comments it is supposed to skip");
  const shown = literals(view);
  // The floor only has to catch a COLLAPSED scan (zero or one hit), never to
  // pin the file's size — IslandView legitimately shrinks every time an
  // instrument comes off it. Raising this as the file grows would pin the wrong
  // thing; it exists so `for (const s of shown)` can never pass vacuously.
  assert.ok(shown.length >= 12,
    `only ${shown.length} literals found in IslandView — the scan surface collapsed`);
  for (const s of shown) assert.ok(!CJK.test(s), `the island shows Chinese: ${s}`);

  // ③ Mutation, with the ammunition counted BEFORE firing: a replacement string
  //    that matches nothing mutates nothing, the guard stays quiet, and the
  //    green means only that the shot was blank.
  const load = (src, anchor, wanted = 1) => {
    const hits = src.split(anchor).length - 1;
    assert.equal(hits, wanted, `mutation anchor is stale — matched ${hits} times, wanted ${wanted}: ${anchor}`);
    return (replacement) => src.split(anchor).join(replacement);
  };

  // m1 — put the readout back into the card: ① must fire, exactly once.
  //      ⚠️ This anchor has moved once already, when the view it hung off was
  //      removed. The ammunition count caught it rather than firing a blank,
  //      which is the entire reason the count is there.
  const m1 = load(view, "            mainContent")(
    "            PresenceReadout()\n            mainContent");
  assert.equal(drawnNames(m1).length, 1, "mutation: the readout came back and the name scan stayed quiet");

  // m2 — put the Chinese label back: ② must fire, exactly once.
  const m2 = load(view, 'Text("Start")')('Text("在岗")');
  assert.equal(literals(m2).filter((s) => CJK.test(s)).length, 1,
    "mutation: Chinese went back onto the island and the probe stayed quiet");

  // m3 — a plinth under the bird: ①b must fire.
  const m3 = load(view, "ClosedIslandMark(status: viewModel.agentStatus)")(
    "VStack(spacing: 2) { ClosedIslandMark(status: viewModel.agentStatus)\n" +
    "                Capsule().fill(IslandPalette.paper.opacity(0.55)).frame(width: 20, height: 2) }");
  assert.match(capsuleFn(m3), /VStack/, "mutation: the bird got a plinth back and the guard stayed quiet");
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

test("the app installer keeps the scanner outside the sandbox and publishes through Perch", () => {
  const py = [
    "import pathlib, plistlib, sys",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))}, ['reconciler_launch_agent_spec'], {'Path': pathlib.Path})`,
    "spec = ns['reconciler_launch_agent_spec']('TEAM.group.io.github.mossfinch.perch', pathlib.Path('/tmp/perch-owner'))",
    "assert spec['Label'] == 'io.github.mossfinch.perch.reconcile'",
    "assert spec['RunAtLoad'] is True",
    "assert spec['StartInterval'] == 1800",
    "assert spec.get('KeepAlive') is not True",
    "args = spec['ProgramArguments']",
    "assert args[0] == '/usr/bin/python3'",
    "assert args[1] == '-B'",
    "assert '/tmp/perch-owner/.perch/bin/perch-reconcile' in args",
    "assert args[args.index('--lookback-days') + 1] == '7'",
    "assert '--hook-ledger' not in args, 'plain launchd cannot read a Team App Group ledger'",
    "assert args[args.index('--out-dir') + 1] == '/tmp/perch-owner/.perch/reconciliation'",
    "assert args[args.index('--bridge-socket') + 1].endswith('/TEAM.group.io.github.mossfinch.perch/bridge.sock')",
    "assert all('perch-hook' not in value for value in args), 'reconciler must not rewrite or depend on the trusted hook launcher'",
    "print('ok')",
  ].join("\n");
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out, "ok");
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

# ⑪ pack() must write the fixed stamp; a real clock would leak the timezone the
#    archive was packed in.
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

test("no Team ID anywhere in the island's files — it links to the registrant's real name", () => {
  // A Team ID ties back to the registered identity through the developer
  // signature, so no shipped file may carry it as a literal.
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

  // Group validation comes in two families: at build time only `group.x` is
  // accepted, at run time both `group.x` and `TEAMID.group.x` are.
  // A faceless widget on macOS 15 needs the signing Team prefix to reach the
  // protected container.
  // The Team prefix is only ever read at run time, from the installed plist or
  // Config.xcconfig, and may never be written into source.
  // install-island-app.py reads the built product BEFORE the prefix is
  // injected, so it must use the strict rule.
  // The hook installers and the day report read the INSTALLED app, so they
  // must use the rule that tolerates both shapes.
  {
    const s = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
    assert.match(s, /not out\.startswith\("group\."\) or not out\.removeprefix\("group\."\)/,
      "install-island-app.py: validation not strict enough");
  }
  // The tolerant rule must still validate the `group.x` core and refuse a bad
  // value on the spot.
  {
    const s = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
    assert.match(s, /not core\.startswith\("group\."\) or not core\.removeprefix\("group\."\)/,
      "island-day-report.py: no longer validates the group core (group.xxx)");
    assert.match(s, /raise SystemExit\(f"Bad App Group in the installed island/,
      "island-day-report.py: a bad group must error on the spot, never pass silently");
    assert.doesNotMatch(s, /\b[0-9A-Z]{10}\.group\./,
      "island-day-report.py: a Team ID leaked into the group validator");
  }
  for (const f of ["install-island-hooks.py", "install-codex-island-hooks.py"]) {
    const s = fs.readFileSync(pkgPath(f), "utf8");
    assert.match(s, /not core\.startswith\("group\."\) or not core\.removeprefix\("group\."\)/,
      `${f}: no longer validates the group core (group.xxx)`);
    assert.match(s, /raise SystemExit\(f"Bad App Group in the installed app/,
      `${f}: a bad group must error on the spot, never pass silently`);
    assert.doesNotMatch(s, /\b[0-9A-Z]{10}\.group\./,
      `${f}: a Team ID leaked into the group validator`);
  }
  // Same check on the Swift side, now the two-shape guard. ⚠️ The old
  // expectation pinned a single prefix-free shape (a comma-separated guard,
  // `value.hasPrefix("group."), value.count > "group.".count`). That assumed
  // the prefix-free container is reachable on macOS — it is not: a faceless
  // widget is denied a TCC-protected container whose id lacks the signing Team
  // ID, so AppGroup.swift must ALSO accept the locally-injected
  // <TeamID>.group.xxx. The plain shape is still validated the same way; a
  // second clause validates the Team-prefixed shape's core. Neither writes a
  // Team ID literal — the guard names only the two SHAPES.
  assert.match(mon, /value\.hasPrefix\("group\."\) && value\.count > "group\."\.count/,
    "the plain group.xxx shape must still be validated");
  assert.match(mon, /rest\.hasPrefix\("group\."\) && rest\.count > "group\."\.count/,
    "the Team-prefixed <TeamID>.group.xxx shape must be accepted, its core validated");
  assert.match(mon, /guard isPlain \|\| isTeamPrefixed else/,
    "exactly those two shapes pass the guard, nothing else");
  // The Team prefix must not come back INTO THE REPO: committed Info.plist and
  // entitlements stay prefix-free ($(DEVELOPMENT_TEAM) would stamp it into the
  // shipped binary and name a folder after it on every user's machine). The
  // prefix is injected into the built product at install time, never here.
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
  // Measured on a real day: an interrupted turn (no complete) welded to the
  // NEXT session by pure pairing inflated 92 seconds into 3h55m. The settle
  // layer exists to cut exactly that weld — while still trusting a complete
  // across mid-turn silence, because a real 9½-min tool ran 578 quiet seconds
  // and truncating it would halve a genuine turn.
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
const FLOW_CASES = [
  // line A: interrupted at 30s, silent ~4h, new session, complete
  [0, "working", "/x/a", "claude"], [30, "working", "/x/a", "claude"],
  [14000, "working", "/x/a", "claude"], [14100, "complete", "/x/a", "claude"],
  // line B: a 600s turn with a 578s quiet middle — the complete is trusted
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
  // line I: the 578-second nail. A real 9½-min tool ran with nothing to say.
  // The silence sits behind a WORKING event, so the complete stays trusted whole
  // -> line H's rule must never reach in here and halve a genuine turn.
  [60000, "working", "/x/i", "codex"], [60578, "complete", "/x/i", "codex"],
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
    [39, 99, 100, 100, 130, 300, 578, 600, 10800],
    "a complete is trusted across a quiet middle (600s, 578s), a gap of exactly the cutoff does not cut (130s), "
    + "and the 3-hour turn stays a settled turn — it is dropped from flow, not from the record");
  assert.equal(fromPython.stretches.length, 9,
    "parallel lines merge, a 4h silence breaks, and one second past the bridge starts a new stretch");
  assert.equal(fromPython.flow, 2427);

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
  assert.deepEqual([nail.start, nail.end, nail.truncated], [60000, 60578, false],
    "the 578s nail broke: a tool running quietly is still the agent working, and its complete stays trusted");
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
  assert.equal(netSeconds, 2006,
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
// ⚠️ 90s / 5 / 4.5min are PROVISIONAL. One afternoon of checking real logs
// against how the day felt is n=1 — enough to point, not enough to fit. They
// get re-derived from recorded corrections, never nudged by hand.
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
// The word "flow" used to answer two different questions in two places: the
// island's verdict ("in flow RIGHT NOW") and the daily report's older column
// ("how many hours did agents run today, with every gap under five minutes
// welded shut"). One word, two questions — and these columns get laid beside
// hand-written answers, where picking up the wrong one is a mistake nothing
// would announce.
//
// So the report reads the island's verdict, which puts a third cross-language
// pair on the table: `FlowSense.inFlow` ↔ `in_flow()`.
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

  // ④ The column itself. Same day, two measures, and they must not be the same
  //    number — otherwise this whole check could pass with the old wiring in
  //    place. (New: 620s of judged flow. Old: 300s of bridged agent runtime.)
  assert.equal(r.new_total, 620);
  assert.equal(r.old_total, 300);
  const flowLine = r.day_text.split("\n").find((l) => l.trim().startsWith("flow "));
  assert.ok(flowLine, "the day report printed no flow line at all");
  assert.match(flowLine, /flow\s+10m20s across 2 span\(s\)/,
    "the day report's flow column is not the verdict's total");
  // …and it must say what it now means, or the next reader will assume the old
  // column with a suspiciously small number in it.
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
  //    ⚠️ The dim end is only correct FOR ITS GROUND. It was 0.14 while the
  //    ground was the lifted #1F1A18; sRGB is non-linear, so on pure black that
  //    same 0.14 emits 2.4× less light and the wave goes hard to see. 0.23 is
  //    derived so a mid-height bar emits what it used to (98%), not dialled
  //    until it looked nice. This number and the ground in IslandPalette are one
  //    decision, and the palette test pins them together.
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

  // Source health: a line that logged nothing all day is how a half-broken day
  // gets caught — the codex hooks once pointed at a dead socket for a full day
  // and nothing said so.
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

test("the desktop widget is gone, and the island came through the amputation intact", () => {
  // The desktop widget went after three rebuilds of its face failed to change
  // the same verdict: "I can see it, I just don't care what it says". The face
  // was never the problem — it reported HOW THE TIME WENT, and a day is judged
  // by whether anything MOVED. So the WidgetKit extension and the pipeline that
  // existed only to feed it (TodaySummary) are gone: something nobody reads
  // still has to be changed, tested and installed every time the island moves.
  //
  // This test does the two jobs the removal can fail at: leaving a reference
  // behind, and taking something the island needs with it.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  const inst = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");

  // ① Nothing is left holding on. A stale name in the project is a target that
  //    cannot build; in the installer it is a step reaching for a file that no
  //    longer exists — and that one only shows up mid-install, on a real machine.
  //
  //    Comments and docstrings are stripped first: this removal is DESCRIBED in
  //    prose in both the installer and DayScore ("the formatter used to live in
  //    TodaySummary"), and a scan that reads prose goes red on its own
  //    explanation. Same shape as the Chinese and UserDefaults probes.
  const noSlashes = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const noHashes = (s) =>
    s.replace(/"""[\s\S]*?"""/g, "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const GONE = /PerchWidget|TodaySummary|WidgetKit|WidgetCenter|\.appex|pluginkit|widgetkit-extension/;

  // ⚠️ Control group first, the standing rule here: a scan that finds nothing
  // proves nothing until it has been shown to find something — and both
  // strippers have to be shown they still see CODE after stripping.
  assert.ok(GONE.test("        TodaySummary.scheduleRefresh()"),
    "control: the probe cannot see a widget reference at all");
  assert.ok(!GONE.test("        DayScore.dayFormatter.string(from: now)"),
    "control: the probe fires on innocent island code");
  assert.equal(noSlashes("// TodaySummary\nlet x = 1\n"), "let x = 1\n",
    "control: the Swift stripper drops the code or keeps the comment");
  assert.equal(noHashes('"""a docstring naming PerchWidget"""\n# pluginkit\nx = 1\n'), "\nx = 1\n",
    "control: the python stripper drops the code or keeps the prose");

  assert.ok(!fs.existsSync(pkgPath("PerchWidget")), "the extension's source directory is still there");
  assert.doesNotMatch(pbx, GONE, "the project still carries the widget");
  assert.doesNotMatch(noHashes(inst), GONE, "the installer still has a widget step in it");
  const islandSwift = islandTree().filter((f) => f.endsWith(".swift"));
  assert.ok(islandSwift.length >= 20, `only ${islandSwift.length} island sources found — the scan surface collapsed`);
  for (const f of islandSwift) {
    assert.doesNotMatch(noSlashes(fs.readFileSync(pkgPath("Perch", f), "utf8")), GONE,
      `${f} still references the widget`);
  }
  // One target, one product. The Embed App Extensions phase copied the .appex
  // into PlugIns/; left behind with nothing to copy it would fail the build.
  assert.equal((pbx.match(/isa = PBXNativeTarget;/g) ?? []).length, 1,
    "the project has more than one target again");
  assert.doesNotMatch(pbx, /PBXCopyFilesBuildPhase|dstSubfolderSpec = 13/,
    "the embed phase outlived the thing it embedded");

  // ② The island's own compile list is intact. A file that quietly falls out of
  //    the Sources phase still exists on disk and the build stays green — it
  //    just is not in the app any more, which is the failure mode this whole
  //    removal could most easily produce.
  const islandSources = pbx.match(
    /00A1CE00000000000000002C \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(islandSources.length > 0, "control: the island's Sources phase could not be read at all");
  for (const f of ["AgentEventLog.swift", "AgentEventMonitor.swift", "StalePolicy.swift",
                   "FlowMath.swift", "FlowSense.swift", "FlowCorrectionLog.swift", "DayScore.swift",
                   "IslandView.swift", "IslandViewModel.swift", "PerchApp.swift"]) {
    assert.ok(islandSources.includes(f), `${f} is no longer compiled into the island`);
  }
  // ③ The one thing TodaySummary owned that is NOT the widget's: the day
  //    formatter the two stars ask their question about. It moved into
  //    DayScore, which is where every other writer here keeps its own, and the
  //    view reads the day names from there — behaviour identical, source
  //    different. (The behaviour itself is compiled and run below, in the
  //    scoring test; this only pins where it now lives.)
  const score = fs.readFileSync(islandPath("DayScore.swift"), "utf8");
  assert.match(score, /static let dayFormatter: DateFormatter/,
    "DayScore no longer owns the formatter it borrowed from TodaySummary");
  assert.match(score, /f\.dateFormat = "yyyy-MM-dd"/);
  assert.match(score, /Locale\(identifier: "en_US_POSIX"\)/);
  // ⚠️ This used to also count two `DayScore.dayFormatter` reads in the view,
  //    for the two stars' day labels. The stars came off the card, so there is
  //    no caller left to count — the assertion was not loosened, its subject
  //    left the building. The move itself (the formatter into DayScore) is
  //    still pinned, right above.

  // ④ ⚠️ GONE, and it stays gone: FlowMath.flowStretches and
  //    FlowMath.runIntervals. Keeping the Swift halves was once justified by
  //    the cross-language comparison being an anti-drift asset — but that
  //    reason only holds while BOTH ends are alive, and with the widget gone
  //    nothing in the island called either one, so the comparison was watching
  //    a corpse for movement. The python functions stay: the shadow features
  //    read them, under their own names, and they are no longer what this repo
  //    means by "flow".
  const math = fs.readFileSync(islandPath("FlowMath.swift"), "utf8");
  const hasDead = (s) => /static func (flowStretches|runIntervals)\(/.test(s);
  assert.ok(!hasDead(math),
    "FlowMath.flowStretches / runIntervals came back — the island has no caller for either");
  // Control: the probe can see a function that IS there, so the absence above
  // is a real absence and not a regex that stopped matching anything.
  assert.match(math, /static func settle\(/,
    "control: FlowMath.settle must still be here — the island's flow verdict reads it every 15 seconds");
  const report = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
  assert.match(report, /def flow_stretches\(/, "the old measure's python end is gone — 090's shadow features read it");
  assert.match(report, /def run_intervals\(/, "the old measure's python end is gone — 090's shadow features read it");

  // ④b GONE TOO: the two things left standing because that removal's boundary
  //    named functions and nothing else — the constant those functions bridged
  //    with, and the type they returned. Nothing constructs or reads either.
  const hasCorpse = (s) =>
    /static let flowBridge\b/.test(s) || /struct Stretch\b/.test(s);
  assert.ok(!hasCorpse(math),
    "FlowMath.flowBridge / Stretch came back — nothing has called their measure since 097");
  // Control: the same shape of probe must still find what IS alive here, or the
  // absence above is only a regex that stopped matching.
  assert.match(math, /static let maxTurn\b/,
    "control: FlowMath.maxTurn must still be here — settle's callers filter on it");
  assert.match(math, /struct Turn\b/,
    "control: FlowMath.Turn must still be here — it is what settle returns");
  // …and the comment that cited the deleted constant by name stopped citing it.
  // A docstring pointing at something that no longer exists misleads the next
  // reader exactly as far as dead code does.
  const sense = fs.readFileSync(islandPath("FlowSense.swift"), "utf8");
  assert.ok(!/FlowMath\.flowBridge/.test(sense),
    "FlowSense still names FlowMath.flowBridge, and that constant no longer exists");
  assert.match(sense, /never nudged by hand/,
    "control: the discipline sentence itself must survive — only its worked example moved");

  // ⑤ Mutation, with the ammunition counted BEFORE firing: a replacement that
  //    matches nothing mutates nothing, the guard stays quiet, and the green
  //    means only that the shot was blank.
  const load = (src, anchor, wanted = 1) => {
    const hits = src.split(anchor).length - 1;
    assert.equal(hits, wanted, `mutation anchor is stale — matched ${hits} times, wanted ${wanted}: ${anchor}`);
    return (replacement) => src.split(anchor).join(replacement);
  };

  // m1 — the extension goes back into the project: ① must fire, exactly once.
  const m1 = load(pbx, "\t\ttargets = (\n")(
    "\t\ttargets = (\n\t\t\t00A1CE000000000000000063 /* PerchWidget */,\n");
  assert.equal((m1.match(/PerchWidget/g) ?? []).length, 1,
    "mutation: the widget target went back in and the name scan stayed quiet");
  assert.match(m1, GONE, "mutation: the probe does not fire on the reinstated target");

  // m2 — the installer points at the extension's entitlements again (the exact
  //      line the removal took out): ① must fire, and from CODE — the docstrings
  //      describing the removal must not be what turns the probe red.
  const m2 = load(inst, 'ENTITLEMENTS = HERE / "Perch" / "Perch.entitlements"\n')(
    'ENTITLEMENTS = HERE / "Perch" / "Perch.entitlements"\n' +
    'WIDGET_ENTITLEMENTS = HERE / "PerchWidget" / "PerchWidget.entitlements"\n');
  assert.equal((noHashes(m2).match(/PerchWidget/g) ?? []).length, 2,
    "mutation: the widget entitlements went back into the installer and the stripper ate the line");
  assert.match(noHashes(m2), GONE, "mutation: the installer probe stayed quiet on live code");

  // m3 — the scoring file falls out of the island's compile list: ② must fire.
  const m3 = load(pbx, "\t\t\t\t00A1CE000000000000000069 /* DayScore.swift in Sources */,\n")("");
  const m3Sources = m3.match(
    /00A1CE00000000000000002C \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)?.[1] ?? "";
  assert.ok(m3Sources.length > 0, "mutation: the Sources phase became unreadable, so nothing was proved");
  assert.ok(!m3Sources.includes("DayScore.swift"),
    "mutation: DayScore left the compile list and the guard stayed quiet");

  // m4 — the deleted pair creeps back into FlowMath: ④ must fire.
  const m4 = load(math, "    static func settle(")(
    "    static func runIntervals(_ turns: [Turn]) -> [Turn] { turns }\n    static func settle(");
  assert.ok(hasDead(m4), "mutation: runIntervals came back and the absence guard stayed quiet");

  // m5 — the removed constant creeps back: ④b must fire.
  const m5 = load(math, "    static let maxTurn")(
    "    static let flowBridge: TimeInterval = 5 * 60\n    static let maxTurn");
  assert.ok(hasCorpse(m5), "mutation: flowBridge came back and the corpse guard stayed quiet");

  // m6 — the removed type creeps back: ④b must fire on it too, not only on the
  //      constant (one probe covering two names can pass on either half).
  const m6 = load(math, "    /// Cut the events into turns")(
    "    struct Stretch: Equatable { var start: Date }\n    /// Cut the events into turns");
  assert.ok(hasCorpse(m6), "mutation: Stretch came back and the corpse guard stayed quiet");

  // m7 — FlowSense goes back to citing the deleted constant: the comment probe
  //      must fire.
  const m7 = load(sense, "never nudged by hand")("never nudged by hand — see FlowMath.flowBridge");
  assert.ok(/FlowMath\.flowBridge/.test(m7),
    "mutation: the stale citation came back and the comment probe stayed quiet");
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

  // ① The refresh hangs off the OPEN TRANSITION, not off hover. Hover is one of
  //    four ways in — a session starting and the auto-peek open the card too,
  //    and each of those used to show whatever `init` computed hours earlier.
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
  // ⑥ A correction must invalidate a read already in flight, or an older
  //    snapshot lands over the correction just written.
  const correct = body("correctDay");
  assert.match(correct, /weekGeneration &\+= 1/,
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

  // ① ⚠️ THE ONE THIS TEST EXISTS FOR: the branch may never again be pasted on
  //    top of the exercise area. It lives in a row, or it does not live.
  //
  //    This assertion used to read "the branch is not drawn during a session",
  //    and the scar is worth keeping even though the rule around it moved. That
  //    rule existed because the branch hung off the card as a bottom-right
  //    overlay, INSIDE the frame strip's territory, and collided outright with
  //    the coral countdown bar during a session — measured, branch x 418…514
  //    against a bar edge at 451.5 / 468.5, with a 20pt bird standing over it.
  //    Hiding the branch during a session was the cheapest way to keep both.
  //
  //    It expired because the branch is no longer in that corner and no longer
  //    an overlay: it is row 1 of the top band, where the countdown bar cannot
  //    reach it, and it says something worth seeing during a session — how
  //    focused each day of the week was, which has nothing to do with the
  //    movement being performed.
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
  //    ⚠️ These assertions used to pin capsules with stroked rings. They are
  //    gone because the SHAPE changed, not because the rule relaxed: seven
  //    separate capsules read as a row of pills (a shape macOS already uses for
  //    page dots), so the branch became one continuous piece of wood with the
  //    days painted onto it. Same invariants, new geometry.
  assert.match(perch, /\.fill\(tint\(index\)\)/,
    "a day's fill stopped being purely its own reading");
  assert.match(perch, /guard !isFuture\(index\) else \{ return IslandPalette\.paper \}/,
    "lived and unlived days stopped being told apart by hue");
  // ⚠️ This used to ban opacity outright, which was too broad and hid the
  //    actual rule. What fails is opacity over the GROUND: on pure black,
  //    opacity IS brightness (coral at 30% over black is the same pixels as a
  //    darker coral at 100%) and it bottoms out at black, so level 1 lands at
  //    1.14:1 against the unlived wood — a lived day that reads as one that
  //    never happened.
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
  // ⚠️ …and NOTHING paints the card's ground back into it.
  //    A 0.8pt divider filled with `IslandPalette.capsule` once shipped here
  //    under the name "grain". It was not grain: background punched through
  //    wood is a HOLE, and a hole is a gap however narrow it is made. At 2× the
  //    six of them rendered as clean black ticks and the branch read as seven
  //    dashes — the row of pills the rewrite existed to end.
  //    On a 6pt branch over pure black there is no darker wood to draw a
  //    divider WITH, so days are told apart by colour and nothing else.
  //    ⚠️ This guard is why the previous `notch: 0.8` assertion is gone. The
  //    rule did not relax — it got stricter, and stopped pinning a number that
  //    was measuring the wrong thing.
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
  // m1 — the branch goes back to hiding during a session: ① must fire.
  //      ⚠️ The old m1 fired the other way (it REMOVED the hiding). Its anchor
  //      is gone because the rule inverted, and the ammunition count caught
  //      that rather than letting the shot go quietly wide — which is the
  //      whole reason anchors are counted before they are fired.
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

test("the day score came off the card, and its ledger did not move", () => {
  // The score capsule sat bottom-left, floating over the exercise strip, and
  // in use it landed on top of the coral bar under the leftmost frame. That bar
  // is the countdown being watched WHILE the card is in use, so the score was
  // covering the one thing that has to stay visible. It came off, and its
  // replacement is still being designed.
  //
  // ⚠️ What this test now exists for: the DISPLAY left, the LEDGER did not.
  //    Days of answers are on disk, python still reads them, and the
  //    replacement will almost certainly write the same file.
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
  //    ⚠️ There used to be a second stub, a fake `TodaySummary`, because that
  //    was where the day formatter lived and it pulled WidgetKit in with it.
  //    TodaySummary went with the desktop widget and DayScore now carries its
  //    own formatter — so the day names below come from THE REAL ONE, which
  //    makes this run cover the move as well.
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
  // The old rule: last LINE per date wins, so a new answer wipes the old score
  // sitting on the same day.
  mustDie(mutate("var answers = out[date] ?? DayAnswers()", "var answers = DayAnswers()"),
    /Command failed/);
  // Half an answer counted as a whole one: the morning that got as far as
  // "rhythm" would never be asked for the rest.
  mustDie(mutate("rhythm != nil && progress != nil", "rhythm != nil || progress != nil"),
    /Command failed/);
});

test("the report prints both answers, and a pre-split score still shows as legacy", () => {
  // The table is the whole point of the ledger: a hand-written answer beside
  // the derived number. Two answers now, and the old one-number days must keep
  // showing — labelled for what they are, never silently read as one of the two.
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
  // Still must not self-size — varying text would re-lay-out the width-derived
  // wave on every rotation — but the width is the shared column's now.
  // ⚠️ The width used to be read off row 1 (`TopWeekRow.rightWidth`). Same
  //    constraint, new owner: it is the BAND's column, shared by both rows, so
  //    it sits on the band's layout and neither row reaches across for it.
  assert.match(strip, /\.frame\(width: GuidedCareLayout\.rightColumnWidth/);
  assert.doesNotMatch(label, /private static let width: CGFloat/,
    "the label grew a second, private copy of the column width");
  // Out-of-range normalizes via modulo — projects leave at any time; slot can't be assumed valid
  assert.match(label, /shown\[slot % shown\.count\]/);
  // Don't blink when only one is showing, and don't rotate at all while pinned
  assert.match(label, /guard waiting\.isEmpty, shown\.count > 1 else \{ return \}/);
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
    // stale" — event lifecycle, not interface.
    // FlowMath is a reader of the same log: what the day adds up to. It is not
    // "Interface" — the view only draws what it is handed. (TodaySummary used
    // to sit beside it, doing the same job for the desktop widget, and both
    // are gone.)
    // DayScore sits with the flow readers on purpose: the hand-written daily
    // score is the standard answer the flow numbers will one day be fitted
    // against — same ledger family, same container, read side by side.
    // FlowSense reads FlowMath's settled turns and answers one more question
    // about them ("in flow right now"), so it belongs beside them and not in
    // Interface — the wave only draws the answer it is handed.
    // FlowCorrectionLog is that verdict's annotation ledger, so it sits with the
    // verdict it annotates rather than with whatever else writes to disk.
    "AgentEvents":  ["AgentEventMonitor.swift", "AgentEventLog.swift", "SourceHealth.swift", "StalePolicy.swift",
                     "FlowMath.swift", "DayScore.swift",
                     // DayFlow replays FlowSense's verdict across a whole day
                     // and totals it — still a reader of the same log, one
                     // question further out. The branch under the bird only
                     // draws the level it is handed.
                     "FlowSense.swift", "FlowCorrectionLog.swift", "DayFlow.swift"],
    "Notch":        ["IslandWindowController.swift", "IslandDisplayMetrics.swift",
                     "IslandHoverMonitor.swift", "IslandPresentationPhase.swift",
                     "IslandCapsuleShape.swift", "IslandCardShape.swift"],
    // AgentStatus.swift depends on Foundation alone, so the closed capsule's
    // tally can be compiled — and therefore tested — on its own.
    // The view files are split by WHAT EACH DRAWS; IslandPalette and
    // ProjectCaption draw nothing and supply the shared colour and wording.
    // Every type has 0 to 2 dependents apart from IslandPalette, which has 11.
    "Interface":    ["AgentStatus.swift", "IslandView.swift", "IslandViewModel.swift",
                     "IslandViewModel+Week.swift", "CarouselClock.swift",
                     "IslandPalette.swift", "ProjectCaption.swift",
                     "GuidedCareCard.swift", "AgentActivityStrip.swift",
                     "TopWeekRow.swift", "WeekPerch.swift"],
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
  // The release scan takes its only boundary from perch-package.json, expanded
  // recursively from the manifest's roots.
  // A hand-written file list drifts with the directory — missing the guard
  // itself, the docs, the dot-directories — and then stays reliably green.
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
  // ⚠️ Known interaction, left deliberately unpatched: Apple's asset-scale
  // suffix makes a filename match the email pattern — the name becomes the
  // local part, the scale suffix becomes the domain, and the file extension
  // becomes the tld. Asset-catalog filenames are arbitrary (Contents.json is
  // what declares the scale), so those files are spelled with a hyphen here.
  // Loosening the pattern to admit that shape would also admit a real address
  // at a short numeric-looking domain, and this guard is worth more at full
  // strength than a filename is worth in its usual spelling.
  // (This comment cannot spell the example out: the scan reads this file too.)
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
    // In the upstream layout, whole-line agent notes come off first, so what
    // gets scanned is the text that will actually land.
    // In the package layout nothing is stripped, so a surviving note must ring
    // like anything else.
    // Both layouts scan the RAW bytes for identity terms, addresses and local
    // paths.
    // The tag is assembled in pieces in this test, so this file is not itself
    // a residue sample.
    const AIDEV_LINE = new RegExp("^\\s*(\\/\\/|#)\\s*" + "AIDEV" + "-(NOTE|TODO|QUESTION)\\b");
    const shippedText = PKG === ROOT ? utf8
      : utf8.split("\n").filter((l) => !AIDEV_LINE.test(l)).join("\n");
    for (const re of historyNeedles) {
      // The manifest's own upstream record is stripped by the export script;
      // in the package layout there is no such exemption.
      if (PKG !== ROOT && path.basename(rel) === "perch-package.json") continue;
      assert.ok(!re.test(shippedText), `${rel} carries upstream vocabulary (it does not ship): ${shippedText.match(re)?.[0]}`);
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
      // Both shapes, always asserted — these do not depend on this machine.
      // ⚠️ The legacy one is not history: commands written before the
      // launcher are still sitting in people's configs, and a reinstall that
      // stopped recognizing them would append the new hooks beside the old
      // ones instead of replacing them. Every event would then fire twice,
      // one of the two pushing at a socket nobody listens on.
      "LEGACY = ('/bin/sh -c \\'printf \"working\\\\t%s\\\\t%s-$$\\\\tclaude\" \"$d\" \"$(date +%s)\" | '",
      "          'nc -U -w 1 \"$HOME/Library/Group Containers/group.io.github.mossfinch.perch/bridge.sock\"\\'')",
      "assert ok(LEGACY), 'a pre-launcher command is no longer recognized — reinstalling would duplicate it, not replace it'",
      "assert ok(LEGACY.replace('io.github.mossfinch.perch', 'com.whatever.old')), \\",
      "    'a changed App Group is no longer recognized as ours — the amnesia this guards against'",
      "assert ok(\"'/somewhere/.perch/bin/perch-hook' working claude\"), 'the launcher command is not recognized as ours'",
      // And the real installed command, whichever shape this machine has.
      // ⚠️ It is found by "is it ours" rather than by a substring: matching on
      // 'bridge.sock' silently stopped finding anything the moment the
      // launcher landed, and a skipped assertion looks exactly like a passing
      // one.
      "cfg = pathlib.Path.home() / '.claude/settings.json'",
      "verdict = 'ok'",
      "if cfg.exists():",
      "    real = json.loads(cfg.read_text())",
      "    mine = next((h['command'] for gs in real.get('hooks', {}).values() for g in gs",
      "                 for h in g.get('hooks', []) if ok(h.get('command', ''))), None)",
      "    if mine is None:",
      "        verdict = 'ok-not-installed'",
      "else:",
      "    verdict = 'ok-not-installed'",
      "foreign = 'nc -U \"$HOME/Library/Group Containers/AB12CD34EF.group.com.someoneelse.app/bridge.sock\"'",
      "assert not ok(foreign), 'a same-named bridge.sock in a foreign container was recognized as ours — their hook would get deleted'",
      "assert not ok('sh -c \\'[ -x \"$HOME/.some-tool/bin/some-tool-bridge\" ] && x\\''), 'another tool\\'s bridge script was misrecognized'",
      // Nearest miss to the launcher pattern: same shape, someone else's dot
      // directory. If this were claimed, reinstalling would delete their hook.
      "assert not ok(\"'/somewhere/.other-tool/bin/perch-hook-ish' working claude\"), 'a foreign launcher-shaped path was claimed as ours'",
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
    // Migration fixtures must satisfy the real ledger contract, or the test
    // only proves that invalid input is refused.
    "def record(i):",
    "    return {'date': '2026-07-30', 'moveId': 'chin-tuck', 'category': 'neck',",
    "            'sets': 1, 'seconds': 34, 'source': 'island',",
    "            'at': '2026-07-30T09:00:00+00:00'}",
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

  // ⚠️ THE ONE THIS TEST EXISTS FOR: the branch is no longer an overlay.
  //    It used to hang off the whole card at .bottomTrailing, floating INSIDE
  //    the frame strip's territory — the strip's frame ends 14pt from the
  //    bottom and the branch sat at 16pt, a 2pt margin — and on a three-frame
  //    move the bird stood under the third figure's shoulder. What was wrong
  //    was not the corner, it was FLOATING: a badge in a corner belongs to no
  //    structure. Three things have now nearly died in that corner.
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
  // ⚠️ This used to pin "a completion holds the cell for five minutes,
  //    measured from when it finished". That behaviour is gone and it was
  //    wrong, not merely retuned: cutting in the instant something finishes
  //    and then sitting there is a takeover, and its owner named it —
  //    "the finished one always steals the display". The queue is fair now and
  //    is pinned by the "waits its turn" test; what stays here is only that
  //    this cell can still name a finished project at all.
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
  // ⚠️ No distance bound: this once capped the gap at 300 characters and broke
  //    the moment a closure argument grew, which is a guard failing on its own
  //    brittleness rather than on the thing it guards. What matters is that the
  //    branch's width comes from the column, not how far down the call it sits.
  assert.match(row, /width: geo\.size\.width/,
    "the branch is not being given the column's width");
  assert.match(row, /WeekPerch\(/, "the branch is not constructed in its row");
  assert.match(row, /TodayFlowCell\(/, "row 1 has no right-hand cell");
});

test("a project waiting on you stops the rotation instead of being scrolled past", () => {
  const view = islandViews();
  const label = view.match(/private struct ActiveProjectLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(label, "ActiveProjectLabel is gone");

  // ⚠️ THE ONE THIS TEST EXISTS FOR. The old rotation put working and waiting
  //    in one list and cycled it every three seconds, so a yellow project
  //    scrolled past like any other. But yellow means an agent is stuck waiting
  //    on a person — the only one of the four states that needs anyone to do
  //    something — and it must not queue behind projects that are merely still
  //    running. The yellow one pins the label until it clears.
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
  // The right-hand column is 152pt wide with a 16pt gutter, and BOTH rows use
  // it — that is what makes the band read as a grid rather than as two
  // unrelated strips. It used to live on row 1 and row 2 reached across for
  // it, which is one row depending on another for something neither owns.
  const view = islandViews();
  assert.match(view, /static let rightColumnWidth: CGFloat = 152/,
    "the shared column width is not on the band's own layout");
  assert.match(view, /static let columnGutter: CGFloat = 16/,
    "the shared gutter is not on the band's own layout");
  assert.doesNotMatch(view, /TopWeekRow\.rightWidth|TopWeekRow\.gutter/,
    "row 2 is reaching into row 1 again for geometry neither of them owns");
});

test("no interface file grows back into a thousand-line pile", () => {
  // 500 lines is a maintainability smoke alarm, not a design rule.
  // A file over it should be split; if the cap genuinely has to move, say why
  // IN THE SAME COMMIT.
  const CAP = 500;
  // FROZEN is empty and takes no new exceptions: if anything ever needs an
  // entry here, that is the signal to SPLIT the file, not to list it — a
  // frozen size is debt wearing a label, and the label is what lets it sit.
  const FROZEN = {};
  const sizes = islandTree()
    .filter((p) => p.endsWith(".swift"))
    .map((p) => [p, fs.readFileSync(islandPath(path.basename(p)), "utf8").split("\n").length]);
  const oversize = sizes.filter(([p, n]) => n > CAP && !(path.basename(p) in FROZEN));
  assert.deepEqual(oversize, [],
    `over ${CAP} lines: ${oversize.map(([p, n]) => `${p} (${n})`).join(", ")}`);
  for (const [p, n] of sizes) {
    const frozen = FROZEN[path.basename(p)];
    if (frozen === undefined) continue;
    assert.ok(n <= frozen,
      `${p} is a frozen exception at ${frozen} lines and grew to ${n} — split it, do not feed it`);
  }
  // Control: the scanner really is reading sizes, not an empty list.
  assert.ok(sizes.length >= 20 && sizes.every(([, n]) => n > 0),
    `control: only ${sizes.length} swift files measured — the scan surface collapsed`);
});

test("splitting the view layer widened exactly seven types, and not one more", () => {
  // File-scope `private` in Swift means "this file only", so sharing across
  // files widens a type's visibility.
  // Only the seven cross-file types may be widened; every other type lives
  // beside its only user and keeps `private`.
  // When a private type is needed across files, move the type rather than
  // widening it.
  const MAY_BE_WIDE = new Set([
    // Already module-wide before the split and not part of its price:
    // PerchApp constructs this one.
    "IslandView",
    // Widened BY the split, seven of them, each because it is used from
    // another file now.
    "IslandPalette", "ProjectCaption", "GuidedCareCard", "GuidedCareLayout",
    "AgentActivityStrip", "TopWeekRow", "WeekPerch",
  ]);
  const wide = [];
  for (const f of ISLAND_VIEW_FILES) {
    const src = fs.readFileSync(islandPath(f), "utf8");
    for (const m of src.matchAll(/^(struct|enum|final class|class) (\w+)/gm)) wide.push(m[2]);
  }
  const unexpected = wide.filter((n) => !MAY_BE_WIDE.has(n));
  assert.deepEqual(unexpected, [],
    `these went module-wide without being on the list: ${unexpected.join(", ")}`);
  // …and every one on the list is actually there, or the list is fiction.
  const missing = [...MAY_BE_WIDE].filter((n) => !wide.includes(n));
  assert.deepEqual(missing, [], `on the list but not actually declared: ${missing.join(", ")}`);
  // Control: the scanner can see private declarations too, so an empty
  // `unexpected` means they are private — not that nothing was read.
  const privates = ISLAND_VIEW_FILES
    .flatMap((f) => [...fs.readFileSync(islandPath(f), "utf8").matchAll(/^private (struct|enum) (\w+)/gm)])
    .map((m) => m[2]);
  assert.ok(privates.length >= 8,
    `control: only ${privates.length} private types seen across the layer — the scan surface collapsed`);
});

test("the working repo cannot be pushed by accident", () => {
  // The private working repo relies on a pre-push hook to block a wrong push,
  // and this test is what stops that hook from quietly disappearing.
  // The extracted package is meant to be pushed, so the guard runs in the
  // upstream layout only.
  // (PKG === ROOT means package layout, and there this test is skipped.)
  if (PKG === ROOT) return;

  const hook = path.join(ROOT, ".githooks", "pre-push");
  assert.ok(fs.existsSync(hook), "the pre-push guard is gone");
  assert.ok(fs.statSync(hook).mode & 0o111, "the pre-push guard is not executable — git will skip it");

  // …and git must actually be pointed at it. A hook in a directory git never
  // reads is decoration.
  const configured = execFileSync("git", ["-C", ROOT, "config", "core.hooksPath"], { encoding: "utf8" }).trim();
  assert.equal(configured, ".githooks",
    `core.hooksPath is "${configured}" — the hook directory is not the one git reads`);

  // The escape hatch must stay explicit and per-command. If it ever becomes
  // the default, the door is painted on.
  const body = fs.readFileSync(hook, "utf8");
  assert.match(body, /PERCH_ALLOW_PUSH/, "the deliberate-override path is gone");
  assert.match(body, /exit 1/, "the hook no longer refuses anything");
});

test("the three READMEs cannot drift apart", () => {
  // Three files telling one story is the shape that has already gone stale
  // twice in this repository, and a translation goes stale silently: whoever
  // reads it cannot tell. So the parts a machine CAN compare are pinned —
  // structure, the commands, the pictures, the ladder — and the prose is left
  // to the person who approves it.
  const NAMES = ["README.md", "README.zh-CN.md", "README.ja.md"];
  const docs = NAMES.map((n) => [n, fs.readFileSync(pkgPath(n), "utf8")]);

  // Counted BY LEVEL: lumping ## and ### together lets a section be demoted to
  // a subsection without changing the total, which a first draft of this
  // guard let through.
  const headings = (md) => [2, 3].map((n) => (md.match(new RegExp(`^#{${n}} `, "gm")) ?? []).length);
  const images = (md) => [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  // The COMMANDS must be identical; the `#` comment after one is prose and gets
  // translated, and so does a <placeholder> the reader is meant to replace.
  // Comparing raw blocks would refuse a correct translation, which would train
  // the next person to delete the guard rather than fix the drift.
  const blocks = (md) =>
    [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
      .map((m) => m[1]
        .replace(/\s+#.*$/gm, "")        // trailing comment on a command line
        .replace(/^#.*$/gm, "")           // a whole comment line
        .replace(/<[^>\n]*>/g, "<>"));    // <old-app-group-id> and its translations
  // The rungs are the one set of numbers a reader might act on.
  const rungs = (md) => (md.match(/\b(1|2|4|6)\b\s*(?:小时|時間|hour)/g) ?? []).length;

  // Control first: a comparison that cannot see a difference proves nothing.
  const planted = docs[0][1].replace("perch-card.png", "perch-CARD.png");
  assert.notDeepEqual(images(planted), images(docs[0][1]),
    "control: the image scanner cannot see a renamed picture");
  assert.notEqual(blocks(docs[0][1] + "```bash\nrm -rf /\n```").length, blocks(docs[0][1]).length,
    "control: the code-block scanner cannot see an added block");

  const [base, baseText] = docs[0];
  for (const [name, md] of docs.slice(1)) {
    assert.deepEqual(headings(md), headings(baseText),
      `${name} 和 ${base} 的章节结构对不上（[## 数, ### 数]）——有一份没跟上`);
    assert.deepEqual(images(md), images(baseText),
      `${name} 的插图和 ${base} 对不上`);
    // Commands are not translated, so they must be identical byte for byte.
    // This is the rung that catches "the install step changed in one language".
    assert.deepEqual(blocks(md), blocks(baseText),
      `${name} 里的命令和 ${base} 不一致——命令不该被翻译或改写`);
    assert.equal(rungs(md), rungs(baseText),
      `${name} 的打分阶梯数字和 ${base} 对不上`);
  }
});

test("the installer reads the product's version instead of naming one", () => {
  // A version literal in the installer is a second place the product's version
  // lives, and the second place is the one that goes stale — this one shipped
  // `1.0.55` long after the work had been called 2.0 everywhere else, because
  // a working installer is not a thing anybody reads.
  const py = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  const stamped = py.match(/Set :CFBundleShortVersionString ([^"']+)/)?.[1] ?? "";
  assert.ok(stamped, "the version stamp could not be found at all — this scan is reading nothing");
  // Control: the shape being refused must be recognisable when it is there.
  const looksNamed = (t) => /\d+\.\d+/.test(t);
  assert.ok(looksNamed("Set :CFBundleShortVersionString 1.0.{version}".split("String ")[1]),
    "control: the scanner cannot see a hard-coded version even when it is present");
  assert.ok(!looksNamed(stamped),
    `the installer names a version itself (${stamped}) — it must read it from Info.plist`);

  // And the plist is where it actually lives.
  const plist = fs.readFileSync(islandPath("Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>\d+\.\d+<\/string>/,
    "Info.plist does not carry a major.minor version for the installer to read");
});
