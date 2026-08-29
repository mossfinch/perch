// One owner for "which files make up the island suite, and is any of them invisible".
// The suite's own guard and the pre-commit hook both call THIS. A second copy of the
// rule would be free to drift, and drifting is exactly what it exists to catch.
const fs = require("node:fs");
const path = require("node:path");
const { pkgPath } = require("./island-paths");

// The tests sit beside this file in the mother repo and in the extracted package alike.
const TESTS_DIR = __dirname;

// The suite is discovered by SHAPE, never listed. A list is the thing that gets
// forgotten: the whole failure this module guards against is a file that exists, holds
// real tests, and is named by nobody.
const SUITE_FILE = /^island[-.].*\.js$/;

function islandSuiteFiles() {
  return fs.readdirSync(TESTS_DIR).filter((n) => SUITE_FILE.test(n)).sort();
}

function islandTestFiles() {
  return islandSuiteFiles().filter((n) => n.endsWith(".test.js"));
}

// The names the suite DECLARES, read from the text at column 0 so a `test(` sitting
// inside a Swift or Python fixture cannot be counted. A run reports what executed;
// this reports what is written — together they tell a lost test from a skipped one.
const DECLARED = /^test\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;

function declaredTestNames(file) {
  const text = fs.readFileSync(path.join(TESTS_DIR, file), "utf8");
  const out = [];
  for (const line of text.split("\n")) {
    const m = DECLARED.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

function allDeclaredTestNames() {
  const out = [];
  for (const f of islandTestFiles()) out.push(...declaredTestNames(f));
  return out;
}

// ⚠️ Reads the manifest through pkgPath, so it answers about the package that would
// actually ship rather than about whichever copy the caller happens to sit in.
function manifestIncludes() {
  const man = JSON.parse(fs.readFileSync(pkgPath("perch-package.json"), "utf8"));
  return new Set(man.include);
}

// The check the suite and the hook share. Returns human-readable complaints, empty when
// nothing is invisible. It never throws on a healthy repo and never returns a bare
// boolean — a caller that prints the list can say WHICH file is the orphan.
function orphanFaults() {
  const faults = [];
  const files = islandSuiteFiles();

  // Nothing found at all is the loudest possible fault, not a quiet pass. This module
  // reporting "no complaints" about an empty suite is the exact false green it exists
  // to prevent.
  if (!files.length) return ["no island suite file found at all — the discovery itself is broken"];

  const included = manifestIncludes();
  for (const f of files) {
    if (!included.has(`tests/${f}`)) {
      faults.push(`tests/${f} is not in perch-package.json — it would not ship, and the package's own run would never see it`);
    }
  }

  for (const f of islandTestFiles()) {
    if (!declaredTestNames(f).length) {
      faults.push(`tests/${f} declares no test — an empty file that still counts as covered`);
    }
  }

  return faults;
}

module.exports = {
  TESTS_DIR,
  islandSuiteFiles,
  islandTestFiles,
  declaredTestNames,
  allDeclaredTestNames,
  orphanFaults,
};
