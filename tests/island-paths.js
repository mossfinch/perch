// The island's sources are split by duty (AgentEvents / Notch / Interface /
// Care / Resources).
//
// Files are found BY NAME here, never by pinned location — what tests care
// about was never "where a file sits" but "what it contains". Directory
// membership is guarded by the one "island sources split into 5 duty groups"
// test: moving directories means editing that single test, and no other
// assertion budges.
//
// A separate file because both test files need it; two copies would drift.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Dual layout: the same tests run in two worlds —
//   mother-repo layout: the package lives under apps/mac-widget/ (that
//   directory later becomes the new repo's root)
//   Perch layout: after extraction, the package IS the repo root
// Tests always reach into the package via PKG/pkgPath and never count "how
// many levels up is the repo root".
const PKG = fs.existsSync(path.join(ROOT, "apps", "mac-widget", "Perch"))
  ? path.join(ROOT, "apps", "mac-widget")
  : ROOT;
const pkgPath = (...p) => path.join(PKG, ...p);

const ISLAND_DIR = pkgPath("Perch");

/// Relative paths of everything in the island. Does not descend into
/// .xcassets (it counts as one item); skips dot-entries and local litter.
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

/// Absolute path by file name. Ambiguity or absence throws — vaguely
/// returning the first hit lets assertions pass against the wrong file.
function islandPath(name) {
  const hits = islandTree().filter((p) => path.basename(p) === name);
  if (hits.length !== 1) {
    throw new Error(`island lookup for ${name}: ${hits.length} hits (expected 1)${hits.length ? ": " + hits.join(", ") : ""}`);
  }
  return path.join(ISLAND_DIR, hits[0]);
}

module.exports = { ISLAND_DIR, PKG, pkgPath, islandTree, islandPath };
