// One shared way for the tests to resolve paths, in the mother repo and in the extracted
// Perch repo alike.
// This file only locates the package and its sources; which duty directory a source belongs
// to is verified by the structure assertions in tests/island-release.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ⚠️ Since the 2026-08-31 split the working repo and the extracted package have the SAME
// flat layout, so there is nothing to detect any more: the package root is the repo root in
// both. PKG survives as a name because every guard reads paths through it — collapsing it
// into ROOT everywhere would be a rename touching a hundred call sites for no gain.
const PKG = ROOT;

// Is this the working repo, or the extracted package? Since the split the two have the
// same flat layout, so the old `PKG === ROOT` test no longer separates them. `docs/` does:
// the exporter never copies it, and the manifest declares it excluded on purpose.
// ⚠️ One owner. Two guards ask this question and they must not answer it differently.
const WORKING = fs.existsSync(path.join(ROOT, "docs"));
// Joins relative segments onto the detected package root and returns an absolute path.
const pkgPath = (...p) => path.join(PKG, ...p);

const ISLAND_DIR = pkgPath("Perch");

// Lists a directory's contents recursively, always relative to ISLAND_DIR. Dot-entries are
// skipped; an .xcassets bundle is returned as a single asset directory rather than having
// its contents enumerated.
function islandTree(dir = ISLAND_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith(".xcassets")) out.push(...islandTree(full));
    else out.push(path.relative(ISLAND_DIR, full));
  }
  return out;
}

// Looks a file up by name and returns its absolute path. Both absence and duplicate names
// throw, so an assertion can never quietly read the wrong file.
function islandPath(name) {
  const hits = islandTree().filter((p) => path.basename(p) === name);
  if (hits.length !== 1) {
    throw new Error(`island lookup for ${name}: ${hits.length} hits (expected 1)${hits.length ? ": " + hits.join(", ") : ""}`);
  }
  return path.join(ISLAND_DIR, hits[0]);
}


// ── The named sources the guards read ──────────────────────────────────────
// These sat in island.test.js while the suite was one file. They moved here when it
// split: six files each keeping their own copy is six chances to drift, and a guard
// reading a stale path is a guard that passes without looking.
// ⚠️ Every one resolves through islandPath, which throws on absence and on a duplicate
// name — so a rename surfaces here instead of as a quiet green.
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

module.exports = {
  ISLAND_DIR, PKG, WORKING, pkgPath, islandTree, islandPath,
  ISLAND_CARE_LEDGER_SWIFT, ISLAND_CATALOG, ISLAND_VIEW_FILES, islandViews, ISLAND_VIEW_SWIFT,
  viewModelFiles, viewModelSource, SOURCE_HEALTH_SWIFT, APP_GROUP_SWIFT,
  CARE_MOVE_POOL_SWIFT, CARE_SESSION_CLOCK_SWIFT, CARE_SESSION_RECORDER_SWIFT,
};
