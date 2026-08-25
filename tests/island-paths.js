// One shared way for the tests to resolve paths, in the mother repo and in the extracted
// Perch repo alike.
// This file only locates the package and its sources; which duty directory a source belongs
// to is verified by the structure assertions in island.test.js.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// The mother repo keeps the package under apps/mac-widget/, while the public repo has the
// package itself as its root. Detect the layout first, so the tests resolve everything from
// PKG and never depend on how deep the mother repo's directories go.
const PKG = fs.existsSync(path.join(ROOT, "apps", "mac-widget", "Perch"))
  ? path.join(ROOT, "apps", "mac-widget")
  : ROOT;
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

module.exports = { ISLAND_DIR, PKG, pkgPath, islandTree, islandPath };
