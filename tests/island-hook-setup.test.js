// Connecting the agents from inside the app: the Swift port of the two hook installers,
// held byte for byte to the Python scripts it was ported from.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together; a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { islandPath, pkgPath, viewModelSource } = require("./island-paths");

// One compiled harness for the whole file: the port, driven from the command line.
let harness;
function swift(...args) {
  if (!harness) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-hook-setup-"));
    const main = path.join(tmp, "main.swift");
    fs.writeFileSync(main, `
import Foundation
let a = CommandLine.arguments
let paths = HookSetup.Paths(home: a[2], launcherTarget: a[3])
switch a[1] {
case "status":
    print(HookSetup.status(paths, appPath: a[4]))
case "connect":
    do {
        let report = try HookSetup.connect(paths, now: Date(timeIntervalSince1970: Double(a[4])!))
        print(report.codexNeedsTrust ? "trust" : "no-trust")
    } catch {
        print("refused: \\(error)")
    }
default:
    fatalError()
}
`);
    harness = path.join(tmp, "hook-setup");
    execFileSync("swiftc", [islandPath("OrderedJSON.swift"), islandPath("HookSetup.swift"), main, "-o", harness],
      { stdio: "pipe" });
  }
  return execFileSync(harness, args, { encoding: "utf8" }).trim();
}

// The reference: both Python installers run for real against a fixture home. Only the App
// Group lookup is replaced, because it reads the app installed on this machine.
function python(home) {
  const run = (script) => execFileSync("python3", ["-B", "-c", `
import importlib.util, io, contextlib
spec = importlib.util.spec_from_file_location("installer", ${JSON.stringify(pkgPath(script))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.app_group_id = lambda: "group.example.perch"
with contextlib.redirect_stdout(io.StringIO()):
    m.main()
`], { env: { ...process.env, HOME: home }, stdio: "pipe" });
  if (fs.existsSync(path.join(home, ".claude"))) run("install-island-hooks.py");
  if (fs.existsSync(path.join(home, ".codex"))) run("install-codex-island-hooks.py");
}

// The link's target. The real one sits inside the installed app; any runnable copy of the
// script will do here, and this one ships beside the tests.
const TARGET = pkgPath("perch-hook.sh");
const EPOCH = "1760000000";

function makeHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "perch-home-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(home, rel);
    fs.mkdirSync(text === null ? full : path.dirname(full), { recursive: true });
    if (text !== null) fs.writeFileSync(full, text);
  }
  return home;
}

// Every file under a home, with its bytes and modification time.
function snapshot(home) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(home, full);
      if (e.isDirectory()) walk(full);
      else if (e.isSymbolicLink()) out[rel] = "-> " + fs.readlinkSync(full);
      else out[rel] = fs.readFileSync(full, "utf8") + " @" + fs.statSync(full).mtimeMs;
    }
  };
  walk(home);
  return out;
}

const read = (home, rel) => fs.readFileSync(path.join(home, rel), "utf8");

// Someone else's tools, our own older hooks in both historical shapes, and the formatting
// Python will rewrite: four-space indents, non-ASCII text, floats, a large integer.
const OLD_INLINE = (source) =>
  `printf 'working\\t%s\\t%s-$$\\t${source}' "$PWD" "$(date +%s)" | nc -U "$HOME/Library/Group Containers/group.old/bridge.sock"`;
const CLAUDE_SETTINGS = JSON.stringify({
  model: "opus",
  "statusLine": { type: "command", command: "~/bin/status é 中 😀" },
  hooks: {
    Stop: [
      { matcher: "*", hooks: [{ type: "command", command: OLD_INLINE("claude") },
                              { type: "command", command: "other-tool notify" }] },
      { matcher: "*", hooks: [{ type: "command", command: "'$HOME/.perch/bin/perch-hook' complete claude" }] },
      { matcher: "Bash" },
    ],
    PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint --fix" }] }],
    UserPromptSubmit: [],
  },
  cleanupPeriodDays: 30,
  ratio: 0.1,
  tiny: 1e-7,
  huge: 1e16,
  whole: 100.0,
  big: 12345678901234567890,
  env: { NOTE: "tab\there \"quoted\" back\\slash" },
}, null, 4)
  // JavaScript prints these as integers or in its own notation; written out by hand they
  // are floats. Between 2^53 and 1e16 Swift and Python lay a float out differently
  // (9.5e+15 against 9500000000000000.0), which is the difference the writer exists to close.
  .replace('"whole": 100', '"whole": 100.0')
  .replace('"huge": 10000000000000000', '"huge": 9500000000000000.0, "negativeZero": -0.0');

const CODEX_HOOKS = JSON.stringify({
  state: { "hooks.json:Stop:0:0": { trusted_hash: "abc" } },
  hooks: {
    Stop: [
      { hooks: [{ command: "other-bridge stop", type: "command" }] },
      { hooks: [{ command: OLD_INLINE("codex"), timeout: 5, type: "command" },
                { command: "mixed-neighbour", type: "command" }] },
      { hooks: [{ command: "'/old/.perch/bin/perch-hook' complete codex", type: "command" }] },
      { hooks: [{ command: "'/old/.perch/bin/perch-hook' complete codex", type: "command" }] },
    ],
    SessionStart: [{ hooks: [{ command: "über-tool start", type: "command" }] }],
  },
}, null, 2);

const FIXTURES = {
  "a fresh Mac with both agents and no config yet": { ".claude": null, ".codex": null },
  "configs full of other tools and our old hooks": {
    ".claude/settings.json": CLAUDE_SETTINGS,
    ".codex/hooks.json": CODEX_HOOKS,
  },
};

test("connecting from the app writes the same bytes the Python installers write", () => {
  // Controls first: a fixture Python leaves unchanged would make "identical" mean nothing.
  const probe = makeHome(FIXTURES["configs full of other tools and our old hooks"]);
  python(probe);
  assert.notEqual(read(probe, ".claude/settings.json"), CLAUDE_SETTINGS, "control: Python changed nothing");
  assert.doesNotMatch(read(probe, ".claude/settings.json"), /group\.old/, "control: the old inline hook survived Python");
  assert.match(read(probe, ".codex/hooks.json"), /mixed-neighbour/, "control: Python dropped a neighbour");

  for (const [name, files] of Object.entries(FIXTURES)) {
    const byPython = makeHome(files);
    const bySwift = makeHome(files);
    python(byPython);
    const report = swift("connect", bySwift, TARGET, EPOCH);
    assert.equal(report, "trust", `${name}: codex hooks changed, so trust must be asked for`);
    for (const rel of [".claude/settings.json", ".codex/hooks.json"]) {
      // The commands carry each home's own path; compare them with that one difference
      // taken out.
      const expected = read(byPython, rel).split(byPython).join("<home>");
      const actual = read(bySwift, rel).split(bySwift).join("<home>");
      assert.equal(actual, expected, `${name}: ${rel} differs from what the Python installer writes`);
    }
    assert.equal(fs.readlinkSync(path.join(bySwift, ".perch/bin/perch-hook")), TARGET,
      `${name}: the launcher must be a link into the app`);
  }
});

test("a backup is kept of every config the app rewrites", () => {
  const home = makeHome(FIXTURES["configs full of other tools and our old hooks"]);
  swift("connect", home, TARGET, EPOCH);
  assert.equal(read(home, `.claude/settings.json.perch-backup-${EPOCH}`), CLAUDE_SETTINGS);
  assert.equal(read(home, `.codex/hooks.json.perch-backup-${EPOCH}`), CODEX_HOOKS);
  // A second run in the same second must not overwrite the first backup.
  fs.rmSync(path.join(home, ".perch"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/settings.json"), "{}");
  swift("connect", home, TARGET, EPOCH);
  assert.equal(read(home, `.claude/settings.json.perch-backup-${EPOCH}`), CLAUDE_SETTINGS);
  assert.equal(read(home, `.claude/settings.json.perch-backup-${EPOCH}-1`), "{}");
});

test("nothing is written until Connect is pressed, and nothing twice", () => {
  const home = makeHome(FIXTURES["configs full of other tools and our old hooks"]);
  const before = snapshot(home);
  assert.equal(swift("status", home, TARGET, "/Applications/Perch.app"), "needsConnect");
  assert.equal(swift("status", home, TARGET, "/Volumes/Downloads/Perch.app"), "notInApplications");
  assert.deepEqual(snapshot(home), before, "asking for the status wrote to disk");

  // Once wired, the app leaves the files alone: no rewrite, no fresh backup on every launch.
  swift("connect", home, TARGET, EPOCH);
  const wired = snapshot(home);
  assert.equal(swift("status", home, TARGET, "/Applications/Perch.app"), "ready");
  assert.equal(swift("connect", home, TARGET, String(Number(EPOCH) + 60)), "no-trust");
  assert.deepEqual(snapshot(home), wired, "connecting twice rewrote files");

  // A machine the Python installers already wired counts as wired too, launcher copy and all.
  const viaPython = makeHome(FIXTURES["configs full of other tools and our old hooks"]);
  python(viaPython);
  assert.equal(swift("status", viaPython, pkgPath("perch-hook.sh"), "/Applications/Perch.app"), "ready");
});

test("only agents that are installed get wired, and an unreadable config stops everything", () => {
  const codexOnly = makeHome({ ".codex": null });
  swift("connect", codexOnly, TARGET, EPOCH);
  assert.ok(fs.existsSync(path.join(codexOnly, ".codex/hooks.json")));
  assert.ok(!fs.existsSync(path.join(codexOnly, ".claude")), "created a config for an agent that is not installed");

  const neither = makeHome({});
  assert.equal(swift("status", neither, TARGET, "/Applications/Perch.app"), "ready");
  assert.deepEqual(snapshot(neither), {});

  // A settings file that is not an object: Python would stop with an error too. Here the
  // codex side is fine, and still nothing may be written, not even the launcher.
  const broken = makeHome({ ".claude/settings.json": "[1, 2]", ".codex": null });
  const before = snapshot(broken);
  assert.match(swift("status", broken, TARGET, "/Applications/Perch.app"), /^failed\(/);
  assert.match(swift("connect", broken, TARGET, EPOCH), /^refused: /);
  assert.deepEqual(snapshot(broken), before, "a refused connect still wrote something");
});

test("the sandbox opens exactly the three folders connecting needs, and nothing else", () => {
  const ent = fs.readFileSync(islandPath("Perch.entitlements"), "utf8");
  assert.match(ent, /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/, "the sandbox was switched off");
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [
    "com.apple.security.app-sandbox",
    "com.apple.security.application-groups",
    "com.apple.security.temporary-exception.files.home-relative-path.read-write",
  ]);
  const block = ent.split("home-relative-path.read-write</key>")[1].split("</array>")[0];
  const folders = [...block.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort();
  assert.deepEqual(folders, ["/.claude/", "/.codex/", "/.perch/"]);

  // The launcher link points into the app, so the script has to be in it, and runnable:
  // Xcode copies the file with the mode it has here.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  assert.match(pbx, /perch-hook\.sh in Resources/, "perch-hook.sh is not copied into the app");
  assert.ok(fs.statSync(pkgPath("perch-hook.sh")).mode & 0o111, "perch-hook.sh is not executable");

  // And a copy of the app whose script cannot run refuses to link to it.
  const home = makeHome({ ".claude": null });
  const dead = path.join(home, "perch-hook.sh");
  fs.writeFileSync(dead, "#!/bin/sh\n", { mode: 0o644 });
  assert.match(swift("status", home, dead, "/Applications/Perch.app"), /not executable/);
  assert.match(swift("connect", home, dead, EPOCH), /^refused: /);
  assert.ok(!fs.existsSync(path.join(home, ".perch")), "linked to a script that cannot run");
});

test("only the Connect button connects", () => {
  // Status reads; `connect` writes into the user's own config. The one call to it lives in
  // the view model's connect action, and that action is reached from a button alone.
  const model = viewModelSource();
  assert.equal((model.match(/HookSetup\.connect\(/g) ?? []).length, 1);
  assert.match(model, /func connectAgents\(\)/);
  const card = fs.readFileSync(islandPath("GuidedCareCard.swift"), "utf8");
  assert.match(card, /Button\s*\{\s*viewModel\.connectAgents\(\)\s*\}/);
  const callers = [model, card].join("\n").match(/connectAgents\(\)/g) ?? [];
  assert.equal(callers.length, 2, "connectAgents is called from somewhere other than the button");
});
