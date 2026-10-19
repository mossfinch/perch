// Getting onto the machine and staying recognised: the app target, the installers, the
// hooks, the launchd job, and the folder the ledger lives in.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together; a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = require("node:path").resolve(__dirname, "..");
const { islandPath, pkgPath } = require("./island-paths");

test("perch target is wired as an LSUIElement notch app", () => {
  // No project.yml (XcodeGen recipe) here: a generator recipe never tracks
  // the pbxproj, and one run of xcodegen would rebuild the project from the
  // stale recipe, wiping weeks of changes.
  // The invariant: the island must be a standalone target with its own
  // bundle id, and the project file itself is the single source of truth.
  const pbx = fs.readFileSync(pkgPath("Perch.xcodeproj", "project.pbxproj"), "utf8");
  assert.match(pbx, /\/\* Perch \*\/ = \{\s*isa = PBXNativeTarget;/);

  // No literal bundle id is pinned here; that would be over-specification.
  // The invariant is "the island has its own bundle id, identical in Debug
  // and Release", never "it must be called some particular name"; a pinned
  // literal turns every rename into "edit the tests".
  // (The counterpart, "must not collide with anything else on the same
  // machine", lives outside this package: it has to name what it checks
  // against, and that name doesn't ship.)
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
  // No App Group. A download is ad-hoc signed, and macOS treats an ad-hoc app's group
  // container as another app's data: a prompt on every launch, and after "Don't Allow"
  // no event ever arrives. Everything lives in ~/.perch/island (DataHome.swift).
  assert.doesNotMatch(ent, /application-groups/);
  assert.doesNotMatch(plist, /AppGroupID/);

  const controller = fs.readFileSync(islandPath("IslandWindowController.swift"), "utf8");
  assert.match(controller, /NSPanel\(/);
  assert.match(controller, /\.borderless/);
  assert.match(controller, /safeAreaInsets\.top/);
  assert.match(controller, /auxiliaryTopLeftArea/);

  const app = fs.readFileSync(islandPath("PerchApp.swift"), "utf8");
  assert.match(app, /setActivationPolicy\(\.accessory\)/);
});

test("island is single-instance and installable as a real app", () => {
  const app = fs.readFileSync(islandPath("PerchApp.swift"), "utf8");
  assert.match(app, /NSRunningApplication\.current/);
  assert.match(app, /bundleIdentifier == bundleID && \$0\.processIdentifier != me\.processIdentifier/);
  assert.match(app, /NSApp\.terminate/);
  // The real invariant: the yield check must precede window creation. One
  // step later and the newcomer steals the socket from the incumbent first:
  // two panels stacked, with events delivered to the one that just started.
  const guardAt = app.search(/anotherInstanceIsRunning/);
  const windowAt = app.search(/IslandWindowController\(\)/);
  assert.ok(guardAt >= 0 && windowAt >= 0 && guardAt < windowAt,
    "the single-instance yield must happen before IslandWindowController");

  const installer = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  assert.match(installer, /Path\("\/Applications"\) \/ APP_NAME/);   // installed into /Applications, double-clickable
  assert.match(installer, /LaunchAgents/);                            // starts at login
  assert.match(installer, /"RunAtLoad": True/);
  // Restart after an unclean exit only: a plain KeepAlive stacked on the single-instance guard
  // (which exits cleanly) becomes a start→exit→restart flap, and no KeepAlive at all leaves the
  // notch empty after macOS kills the app itself
  assert.match(installer, /"KeepAlive": \{"SuccessfulExit": False\}/);
  // Every build is ad-hoc, the installed one as much as a download: no second signing path.
  assert.doesNotMatch(installer, /DEVELOPMENT_TEAM|signing_identity|inject_team_prefix/);
  assert.match(installer, /sign_adhoc\(built\)\n\s*check_entitlements\(built\)/);
});

test("the installer reads the signature itself, and refuses each wrong shape", () => {
  // Signed for real, then checked: what a signature carries is the only thing that decides
  // what the sandbox allows. Each wrong shape fails silently at run time, so each must be
  // refused here, and the right one must pass, or a check that refuses everything would
  // look just as strict.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-ent-"));
  const py = `
import importlib.util, plistlib, shutil, subprocess, sys, pathlib
spec = importlib.util.spec_from_file_location("inst", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
tmp = pathlib.Path(sys.argv[2]); repo = plistlib.loads(pathlib.Path(sys.argv[3]).read_bytes())
def signed(name, ent):
    app = tmp / name / "Probe.app"; (app / "Contents/MacOS").mkdir(parents=True)
    shutil.copy("/usr/bin/true", app / "Contents/MacOS/Probe")
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "Probe", "CFBundleIdentifier": "io.example.probe"}))
    (tmp / (name + ".ent")).write_bytes(plistlib.dumps(ent))
    subprocess.run(["codesign", "--force", "-s", "-", "--entitlements", str(tmp / (name + ".ent")), str(app)], check=True, capture_output=True)
    return app
import contextlib
def verdict(app):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            m.check_entitlements(app)
        return "pass"
    except SystemExit as e: return str(e)
out = {"repo": verdict(signed("repo", repo))}
out["group"] = verdict(signed("group", {**repo, "com.apple.security.application-groups": ["group.io.example"]}))
out["norule"] = verdict(signed("norule", {k: v for k, v in repo.items() if not k.endswith(".sbpl")}))
out["network"] = verdict(signed("network", {**repo, "com.apple.security.network.client": True}))
out["nosandbox"] = verdict(signed("nosandbox", {k: v for k, v in repo.items() if k != "com.apple.security.app-sandbox"}))
sbpl = "com.apple.security.temporary-exception.sbpl"
out["extrarule"] = verdict(signed("extrarule", {**repo, sbpl: repo[sbpl] + ["(allow network*)"]}))
rw = "com.apple.security.temporary-exception.files.home-relative-path.read-write"
out["extrafolder"] = verdict(signed("extrafolder", {**repo, rw: repo[rw] + ["/Documents/"]}))
out["extrakey"] = verdict(signed("extrakey", {**repo, "com.apple.security.files.user-selected.read-write": True}))
import json; print(json.dumps(out))
`;
  const out = JSON.parse(execFileSync("python3", ["-B", "-c", py, pkgPath("install-island-app.py"), tmp,
    islandPath("Perch.entitlements")], { encoding: "utf8" }));
  assert.equal(out.repo, "pass", "the repo's own entitlements do not pass the installer's check");
  assert.match(out.group, /App Group/);
  assert.match(out.norule, /socket bind/);
  // Present is not enough; the set must be exact, or one added rule undoes the sandbox.
  assert.match(out.extrarule, /not exactly the one/);
  assert.match(out.extrafolder, /not exactly ~\/\.claude/);
  assert.match(out.extrakey, /nothing here expects: com\.apple\.security\.files\.user-selected\.read-write/);
  assert.match(out.network, /network access: com\.apple\.security\.network\.client/);
  assert.match(out.nosandbox, /sandbox is off/);
});

test("the app installer keeps the scanner outside the sandbox and publishes through Perch", () => {
  const py = [
    "import pathlib, plistlib, sys",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))}, ['reconciler_launch_agent_spec'], {'Path': pathlib.Path})`,
    "spec = ns['reconciler_launch_agent_spec'](pathlib.Path('/tmp/perch-owner'))",
    "assert spec['Label'] == 'io.github.mossfinch.perch.reconcile'",
    "assert spec['RunAtLoad'] is True",
    "assert spec['StartInterval'] == 1800",
    "assert spec.get('KeepAlive') is not True",
    "args = spec['ProgramArguments']",
    "assert args[0] == '/usr/bin/python3'",
    "assert args[1] == '-B'",
    "assert '/tmp/perch-owner/.perch/bin/perch-reconcile' in args",
    "assert args[args.index('--lookback-days') + 1] == '7'",
    "assert '--hook-ledger' not in args, 'the hook ledger comes over the bridge, from the island that owns it'",
    "assert args[args.index('--out-dir') + 1] == '/tmp/perch-owner/.perch/reconciliation'",
    "assert args[args.index('--bridge-socket') + 1] == '/tmp/perch-owner/.perch/island/bridge.sock'",
    "assert all('perch-hook' not in value for value in args), 'reconciler must not rewrite or depend on the trusted hook launcher'",
    "print('ok')",
  ].join("\n");
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out, "ok");
});

test("the island's own launchd job has somewhere to put what it says", () => {
  // Without these the island's stderr goes nowhere: a crash, a refused write or
  // a failed precondition leaves no trace anyone can read afterwards. The
  // reconciler beside it has both.
  const py = [
    "import pathlib, sys",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    `ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))}, ['island_launch_agent_spec'], {'Path': pathlib.Path})`,
    "spec = ns['island_launch_agent_spec'](pathlib.Path('/tmp/Perch.app'), pathlib.Path('/tmp/perch-owner'))",
    "logs = '/tmp/perch-owner/Library/Logs/Perch'",
    "assert spec['StandardOutPath'] == logs + '/perch.log', spec.get('StandardOutPath')",
    "assert spec['StandardErrorPath'] == logs + '/perch-error.log', spec.get('StandardErrorPath')",
    "assert spec['StandardOutPath'] != spec['StandardErrorPath'], 'one file cannot say which stream said it'",
    "assert spec['RunAtLoad'] is True",
    "assert spec['KeepAlive'] == {'SuccessfulExit': False}, 'restart after a kill; a clean exit (quit, the single-instance guard) must stay down or the guard flaps'",
    "assert spec['ProcessType'] == 'Interactive'",
    "assert spec['ProgramArguments'] == ['/tmp/Perch.app/Contents/MacOS/Perch'], spec['ProgramArguments']",
    "assert spec['Label'] == 'io.github.mossfinch.perch'",
    "print('ok')",
  ].join("\n");
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out, "ok");

  // The spec spells the label and the executable out so it can be lifted out
  // and inspected alone; the install path around it still reaches for the
  // module constants when it unloads the old job. Two spellings of one fact:
  // let them drift and the plist names one job while `launchctl bootout` names
  // another, which uninstalls nothing and leaves two islands racing.
  const installer = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  const label = installer.match(/^LABEL = "([^"]+)"/m)?.[1];
  const exec = installer.match(/^EXEC_SUBPATH = "([^"]+)"/m)?.[1];
  assert.ok(label && exec, "control: the installer's own constants could not be read");
  assert.ok(installer.includes(`"Label": "${label}"`),
    `the launch-agent spec spells a different label than LABEL (${label})`);
  assert.ok(installer.includes(`str(app / "${exec}")`),
    `the launch-agent spec spells a different executable path than EXEC_SUBPATH (${exec})`);
});

test("the installer's socket check waits for a real connection, never for the file", () => {
  // What this guards against: a socket file may be the leftover of the
  // instance the installer just killed (pkill gives it no chance to unlink
  // its own), so "the file is there" says nothing about anyone listening.
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
    "verify(pathlib.Path('/nonexistent/bridge.sock'), lambda: next(answers), nap)",
    "assert len(naps) == 2, 'it stopped retrying the connect; waited only %d time(s)' % len(naps)",
    "def refuses(sock, why):",
    "    try:",
    "        verify(sock, lambda: 1, nap)",
    "        raise AssertionError('did not fail: ' + why)",
    "    except SystemExit as e:",
    "        return str(e)",
    // ② Never accepts and no socket file -> the island never bound
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

test("codex island hooks install additively, never reordering foreign hooks", () => {
  const s = fs.readFileSync(pkgPath("install-codex-island-hooks.py"), "utf8");
  assert.match(s, /\.codex\/hooks\.json/);                    // rides the hooks system, never config.toml's notify chain
  assert.match(s, /"UserPromptSubmit": "working"/);
  assert.match(s, /"PermissionRequest": "waiting"/);
  assert.match(s, /"Stop": "complete"/);
  assert.match(s, /perch-backup/);                          // backup before writing
  assert.match(s, /trusted_hash/);             // the reason lives in the code, not in word of mouth
  // Replacement must happen at the hook level. Assigning a whole group is the
  // bug the A4 case below exists for: it takes somebody else's hooks down
  // together with ours, and a group-level self-check cannot see the damage.
  // Behavior is proven below; this bans the shape, which behavior cannot.
  assert.doesNotMatch(s, /^\s*groups\[[^\]]*\] = /m,
    "a whole-group assignment deletes any foreign hook sharing that group");

  // Two assertions are deliberately not written the obvious way:
  //
  // ① `assert.match(s, /PERCH_MARK = APP_GROUP/)`: that pattern is itself a
  //    bug (a changeable value as identity: change the App Group and old
  //    entries stop being recognized); recognition is by shape instead. And
  //    literal-matching assertions collide with comments: matching the comment
  //    that explains them still turns green. So the literal is banned instead.
  //
  // ② `assert.doesNotMatch(s, /groups\.pop\(/)`: that bans a word, while the
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
    // A command must carry both an own-artifact path inside the container and
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
    // A4: a mixed group, our hook sitting in the same group as someone
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
    // A5: and the pre-write self-check must see that foreign hook. Keyed by
    // group, a mixed group drops out of the comparison altogether, so losing
    // their hook inside one would read as perfectly clean. Keyed by address,
    // it is visible.
    "seen = ns['foreign_hooks']({'Stop': [mixed]})",
    "assert list(seen.values()) == [{'command': FOREIGN}], 'the self-check is blind to a foreign hook inside a mixed group'",
    "assert list(seen)[0] == ('Stop', 0, 0), 'foreign hooks must be keyed by exact address, not merely by group'",
    "print('ok')",
  ].join("\n");
  assert.equal(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim(), "ok");

  // A failed self-check must abort before the write, not report afterwards
  const check = s.match(/# Self-check before writing[\s\S]*?write_atomic\(HOOKS/)?.[0] ?? "";
  assert.ok(check.length > 0, "the self-check no longer sits between the edits and the write");
  assert.match(check, /raise SystemExit/);
  // The user's config is replaced by rename, never truncated in place: a
  // half-written hooks.json breaks their whole tool.
  assert.match(s, /os\.replace\(tmp, path\)/, "config writes must land atomically");
});

test("hook installers recognize their own entries: no amnesia on container change, no friendly fire", () => {
  // This test watches both failure directions:
  //   Too narrow: the current App Group as identity. After a container change
  //               the old entries go unrecognized, old and new coexist, and
  //               every hook runs twice.
  //   Too wide:   path-only bridge.sock matching. Another app using the same
  //               file name in its own App Group is recognized as ours, and
  //               reinstalling deletes their hook.
  // Both "path" and "wire-protocol signature" must hold. No grepping: the real
  // matcher function runs.
  for (const script of ["install-island-hooks.py", "install-codex-island-hooks.py"]) {
    const py = [
      "import json, pathlib, sys",
      "sys.path.insert(0, 'tests')",
      "from installer_marker import load_marker",
      `ok = load_marker(${JSON.stringify(pkgPath(script))})['is_perch_command']`,
      // Take our real command from the local config, never assemble one: an
      // assembled command may differ from what is actually installed.
      // Machines without the hooks installed (contributors or CI, where a blind
      // read would raise FileNotFoundError) skip the two positive assertions;
      // the negative ones still run, since "no friendly fire" is verifiable
      // anywhere.
      // Both shapes, always asserted: these do not depend on this machine.
      // The legacy one is not history: commands written before the launcher
      // are still sitting in people's configs, and a reinstall that stopped
      // recognizing them would append the new hooks beside the old ones instead
      // of replacing them. Every event would then fire twice, one of the two
      // pushing at a socket nobody listens on.
      "LEGACY = ('/bin/sh -c \\'printf \"working\\\\t%s\\\\t%s-$$\\\\tclaude\" \"$d\" \"$(date +%s)\" | '",
      "          'nc -U -w 1 \"$HOME/Library/Group Containers/group.io.github.mossfinch.perch/bridge.sock\"\\'')",
      "assert ok(LEGACY), 'a pre-launcher command is no longer recognized — reinstalling would duplicate it, not replace it'",
      "assert ok(LEGACY.replace('io.github.mossfinch.perch', 'com.whatever.old')), \\",
      "    'a changed App Group is no longer recognized as ours — the amnesia this guards against'",
      "assert ok(\"'/somewhere/.perch/bin/perch-hook' working claude\"), 'the launcher command is not recognized as ours'",
      // And the real installed command, whichever shape this machine has.
      // It is found by "is it ours" rather than by a substring: matching on
      // 'bridge.sock' finds nothing once the launcher is installed, and a
      // skipped assertion looks exactly like a passing one.
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

test("moving out of the old container: source named by a human, every danger refused, all or nothing", () => {
  // The island used to keep its history in an App Group container and now keeps it in
  // ~/.perch/island. Without the move it starts from an empty folder, which looks
  // exactly like the history vanishing. So the move is a procedure, not a manual copy.
  //
  // The source is named by a person (--migrate-from). A machine can hold two old
  // containers with data (a team-signed one and a bare one from an ad-hoc run) and only
  // the person knows which is theirs. Everything below runs the real functions.
  const py = [
    "import sys, tempfile, pathlib, json, shutil, os, inspect",
    "sys.path.insert(0, 'tests')",
    "from installer_marker import load_functions",
    "def fresh(shutil_impl=shutil, os_impl=os):",
    `    ns = load_functions(${JSON.stringify(pkgPath("install-island-app.py"))},`,
    "                        ['ledger_records', 'migrate_island_data', 'old_containers'],",
    "                        {'Path': pathlib.Path, 'shutil': shutil_impl, 'json': json, 'os': os_impl,",
    "                         'OLD_GROUP': 'group.io.github.mossfinch.perch',",
    "                         'MIGRATED': ('care-ledger.json', 'day-scores.jsonl', 'agent-events', 'flow-corrections')})",
    "    return ns",
    "ns = fresh(); mig = ns['migrate_island_data']",
    // Fixtures satisfy the real ledger contract, or the test only proves that invalid input is refused.
    "def record(i):",
    "    return {'date': '2026-07-30', 'moveId': 'chin-tuck', 'category': 'neck',",
    "            'sets': 1, 'seconds': 34, 'source': 'island',",
    "            'at': '2026-07-30T09:00:00+00:00'}",
    "def old(n=39):",
    "    r = pathlib.Path(tempfile.mkdtemp()); src = r/'TEAM.group.io.github.mossfinch.perch'",
    "    (src/'agent-events').mkdir(parents=True); (src/'flow-corrections').mkdir()",
    "    (src/'care-ledger.json').write_text(json.dumps({'version':1,'records':[record(i) for i in range(n)]}))",
    "    (src/'day-scores.jsonl').write_text('{}\\n')",
    "    (src/'agent-events'/'2026-10-12.jsonl').write_text('a\\n'); (src/'agent-events'/'2026-10-13.jsonl').write_text('b\\n')",
    "    (src/'flow-corrections'/'x.jsonl').write_text('c\\n')",
    "    (src/'bridge.sock').write_text(''); (src/'reconciliation').mkdir()",
    "    return r, src, r/'island'",
    "def refuses(fn, why):",
    "    try:",
    "        fn(); raise AssertionError('did not refuse: ' + why)",
    "    except SystemExit as e:",
    "        return str(e)",
    "def landed(island):",
    "    return sorted(p.name for p in island.iterdir()) if island.exists() else []",
    // ① The normal move: the four history items, copied, the source untouched; the socket
    //    and the regenerable reconciliation cache stay behind.
    "r, src, island = old(); msg = mig(src, island)",
    "assert landed(island) == ['agent-events', 'care-ledger.json', 'day-scores.jsonl', 'flow-corrections'], landed(island)",
    "assert sorted(p.name for p in (island/'agent-events').iterdir()) == ['2026-10-12.jsonl', '2026-10-13.jsonl']",
    "assert len(json.loads((island/'care-ledger.json').read_text())['records']) == 39",
    "assert (src/'care-ledger.json').exists() and (src/'agent-events'/'2026-10-12.jsonl').exists(), 'copy only: the source must stay'",
    "assert '39 records' in msg, msg",
    "assert oct(island.stat().st_mode & 0o777) == '0o700', 'the moved history is readable by other accounts: ' + oct(island.stat().st_mode & 0o777)",
    // ② Anything already at the target -> refuse, and copy nothing, not even the other items
    "r, src, island = old(); island.mkdir(); (island/'day-scores.jsonl').write_text('mine\\n')",
    "refuses(lambda: mig(src, island), 'target already has day scores')",
    "assert landed(island) == ['day-scores.jsonl'] and (island/'day-scores.jsonl').read_text() == 'mine\\n', landed(island)",
    // ③ A target item that is a symlink -> refuse; the linked-to file keeps every byte
    "r, src, island = old(); island.mkdir(); victim = r/'someone-elses.json'; victim.write_text('untouched')",
    "(island/'care-ledger.json').symlink_to(victim)",
    "refuses(lambda: mig(src, island), 'target is a symlink')",
    "assert victim.read_text() == 'untouched', 'data was written through the symlink'",
    // ④ A source item that is a symlink -> refuse
    "r, src, island = old(); (src/'day-scores.jsonl').unlink(); (src/'day-scores.jsonl').symlink_to(r/'elsewhere')",
    "refuses(lambda: mig(src, island), 'source item is a symlink')",
    "assert landed(island) == [], landed(island)",
    // ④b A link inside a folder: copied as-is it keeps pointing at the old place, or dangles
    "r, src, island = old(); (src/'agent-events'/'2026-10-14.jsonl').symlink_to(src/'agent-events'/'2026-10-13.jsonl')",
    "assert 'symbolic link' in refuses(lambda: mig(src, island), 'a link inside agent-events'); assert landed(island) == []",
    // ④c The target folder itself is a link: nothing may be written through it
    "r, src, island = old(); elsewhere = r/'elsewhere'; elsewhere.mkdir(); island.symlink_to(elsewhere)",
    "refuses(lambda: mig(src, island), 'target folder is a symlink'); assert list(elsewhere.iterdir()) == []",
    // ⑤ The ledger does not parse, or has the wrong shape -> refuse, nothing copied
    "r, src, island = old(); (src/'care-ledger.json').write_text('{broken')",
    "refuses(lambda: mig(src, island), 'ledger is broken JSON'); assert landed(island) == []",
    "(src/'care-ledger.json').write_text(json.dumps({'version': 1, 'records': [{'date': '2026-07-30'}]}))",
    "assert 'missing' in refuses(lambda: mig(src, island), 'records lack fields'); assert landed(island) == []",
    "(src/'care-ledger.json').write_text(json.dumps({'version': 1, 'records': [dict(record(0), sets=True)]}))",
    "refuses(lambda: mig(src, island), 'sets is a boolean'); assert landed(island) == []",
    // ⑥ Nothing to move / not a directory -> refuse, never pass silently
    "empty = pathlib.Path(tempfile.mkdtemp())",
    "refuses(lambda: mig(empty, empty/'island'), 'source holds nothing')",
    "refuses(lambda: mig(empty/'missing', empty/'island'), 'source does not exist')",
    // ⑦ All or nothing: the copy dies on the third item -> no item at the target, no staging left
    "class DiesLate:",
    "    calls = 0",
    "    def copy2(self, a, b):",
    "        DiesLate.calls += 1",
    "        if DiesLate.calls == 2: pathlib.Path(b).write_text('{\"version\":1,\"reco'); raise OSError('disk full')",
    "        shutil.copy2(a, b)",
    "    def copytree(self, a, b, symlinks=False): shutil.copytree(a, b, symlinks=symlinks)",
    "    def rmtree(self, p, ignore_errors=False): shutil.rmtree(p, ignore_errors=ignore_errors)",
    "r, src, island = old(); half = fresh(DiesLate())['migrate_island_data']",
    "try:",
    "    half(src, island); raise AssertionError('the fake copy never failed; this case tested nothing')",
    "except OSError:",
    "    pass",
    "assert DiesLate.calls == 2, DiesLate.calls",
    "assert landed(island) == [], 'a partial move was left behind; the rerun would refuse it: %s' % landed(island)",
    // ⑦b The second rename fails: what already landed is taken back, nothing is left behind,
    //     and a rerun goes through
    "class FlakyOS:",
    "    calls = 0",
    "    def __getattr__(self, name): return getattr(os, name)",
    "    def replace(self, a, b):",
    "        FlakyOS.calls += 1",
    "        if FlakyOS.calls == 2: raise OSError('rename failed')",
    "        os.replace(a, b)",
    "r, src, island = old(); flaky = fresh(os_impl=FlakyOS())['migrate_island_data']",
    "try:",
    "    flaky(src, island); raise AssertionError('the fake rename never failed; this case tested nothing')",
    "except OSError:",
    "    pass",
    "assert landed(island) == [], 'a partial set was left after a failed rename: %s' % landed(island)",
    "mig(src, island); assert len(landed(island)) == 4, 'the rerun after a failed rename did not go through'",
    // ⑧ The source has no default: the machine never guesses
    "p = inspect.signature(mig).parameters",
    "assert list(p)[0] == 'source' and p['source'].default is inspect.Parameter.empty",
    // ⑨ The hint lists only this island's old containers that hold data, bare or prefixed
    "root = pathlib.Path(tempfile.mkdtemp())",
    "for name, data in [('group.io.github.mossfinch.perch', True), ('ABCDE12345.group.io.github.mossfinch.perch', True),",
    "                   ('XYZ.group.io.github.mossfinch.perch', False), ('group.io.github.mossfinch.perchling', True),",
    "                   ('ABCDE12345.group.com.example.other', True)]:",
    "    (root/name).mkdir()",
    "    if data: (root/name/'care-ledger.json').write_text('{}')",
    "assert [c.name for c in ns['old_containers'](root)] == ['ABCDE12345.group.io.github.mossfinch.perch', 'group.io.github.mossfinch.perch']",
    "print('ok')",
  ].join("\n");
  assert.equal(execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim(), "ok");

  const inst = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  // Migration runs before the island starts: a running island may write at any moment,
  // and once a target exists the move refuses.
  const main = inst.match(/def main\(\)[\s\S]*?\nif __name__/)?.[0] ?? "";
  assert.ok(main.indexOf("migrate_island_data(") > 0 &&
            main.indexOf("migrate_island_data(") < main.indexOf("install_launch_agent()"),
    "migration must come before install_launch_agent()");
  // Without the flag the installer only points at old data; it never moves it on a guess.
  assert.equal((main.match(/migrate_island_data\(/g) ?? []).length, 1);
  assert.match(main, /if opts\.migrate_from:\s*\n[^\n]*\n[^\n]*\n[^\n]*migrate_island_data\(opts\.migrate_from\)/);
});

test("after a rename, the completion bell installed under the old name must still be recognized, or every turn pushes twice", () => {
  // The bell block locates itself, and its comment title carries the product
  // name, and names change. Find by name and the block already installed on the
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
      // ① A title written under an old name must still be recognized: the rename gate.
      // The title is deliberately a name totally unlike the current NOTIFY_MARK:
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
      // ⑥ Somebody appended their own block after ours. The span must stop at
      //    their header: reinstalling replaces our lines and leaves theirs
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

// Files in ~/.perch/island can outlive the feature that wrote them. The manifest maps
// every allowed entry to a current writer so readable but abandoned residue
// cannot remain silently.
const ISLAND_WRITERS = {
  "agent-events": "the island, on every agent pickup",
  "care-ledger.json": "the island, when a care session is recorded",
  "day-scores.jsonl": "the island, when a day is scored",
  "record-cache.json": "the island, once the Record has measured past weeks",
  "flow-corrections": "the island, when a flow verdict is corrected",
  "reconciliation": "the history rebuild, handed over the island's socket",
  "bridge.sock": "the island, for as long as it runs",
  "claude-hook.lastrun": "the Claude hook, on every run",
  "codex-hook.lastrun": "the Codex hook, on every run",
  "codex-notify.lastrun": "the Codex completion bell, on every finished turn",
};

// What a retired feature used to write. Still being here is residue, not health.
const RETIRED_ISLAND_ENTRIES = {
  "today-summary.json": "the desktop widget it fed was retired",
  "presence": "presence collection was retired",
  "presence-corrections": "presence collection was retired",
};

// Why an entry does not belong, or null when it does. Split out from the sweep
// so its three answers stay provable on a machine that has no ~/.perch/island at all.
const islandEntryFault = (entry) => {
  if (RETIRED_ISLAND_ENTRIES[entry]) return `residue: ${RETIRED_ISLAND_ENTRIES[entry]}`;
  if (!ISLAND_WRITERS[entry]) return "nothing in this manifest claims to write it";
  return null;
};

test("the ~/.perch/island manifest separates a live entry, residue, and a stranger", () => {
  assert.equal(islandEntryFault("agent-events"), null);
  assert.equal(islandEntryFault("presence"), "residue: presence collection was retired");
  // Control: an entry nobody has ever declared must not pass as live.
  assert.equal(islandEntryFault("a-name-invented-for-this-control"),
    "nothing in this manifest claims to write it");
});

test("nothing sits in ~/.perch/island that nothing writes", (t) => {
  // The folder DataHome.swift names.
  assert.match(fs.readFileSync(islandPath("DataHome.swift"), "utf8"), /"\.perch\/island"/,
    "DataHome.swift moved; this sweep would be looking at the wrong folder");
  const dir = path.join(os.homedir(), ".perch", "island");
  if (!fs.existsSync(dir)) {
    // Announced, never a silent pass: a sweep that quietly finds nothing to
    // sweep reads exactly like a sweep that found everything in order.
    t.skip("no ~/.perch/island on this machine; nothing to sweep");
    return;
  }
  for (const entry of fs.readdirSync(dir).filter((n) => !n.startsWith("."))) {
    const fault = islandEntryFault(entry);
    assert.equal(fault, null,
      `${entry} is in ~/.perch/island but ${fault}. Either add it here with what writes it, ` +
      `or move it out — a file whose writer is gone still reads like live data.`);
  }
});

test("a download opens at login, and a source install is never started twice", () => {
  const login = fs.readFileSync(islandPath("LoginItem.swift"), "utf8").replace(/\/\/.*$/gm, "");
  // The ordinary login item. A launchd job shipped in the app is pinned by macOS to the
  // binary it first saw; an ad-hoc signed update is a new binary, and the job is refused.
  assert.match(login, /private static var service: SMAppService \{ \.mainApp \}/,
    "an agent job inside an ad-hoc app breaks at the first update");
  assert.doesNotMatch(login, /SMAppService\.agent|\.agent\(plistName/);
  assert.ok(!fs.existsSync(path.join(path.dirname(islandPath("LoginItem.swift")), "Library")),
    "a LaunchAgents folder is back inside the app");

  // Two starts at login can both step aside and leave no Perch, so every road to
  // registering goes through the source-install check.
  const set = login.match(/static func set\(_ on: Bool\) throws \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(set, /^\s*static func set[^\n]*\n\s*guard !installedFromSource else \{ return \}/m,
    "turning it on must refuse on a source install");
  const first = login.match(/static func defaultOnFirstLaunch\(\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(first, /!installedFromSource/, "the first-launch default must skip source installs");
  assert.match(first, /Bundle\.main\.bundlePath == HookSetup\.installedApp/, "registering outside Applications points at an app about to move");
  assert.match(login, /XPC_SERVICE_NAME"\] == installerLabel/);
  assert.match(login, /\/\.perch\/bin\/perch-reconcile/);
  // The installer really does leave that sign behind, under the label the app checks.
  const installer = fs.readFileSync(pkgPath("install-island-app.py"), "utf8");
  assert.match(installer, /RECONCILER_BINARY = Path\.home\(\) \/ "\.perch" \/ "bin" \/ "perch-reconcile"/,
    "the installer no longer leaves the helper where the app looks for it");
  assert.match(installer, /"Label": "io\.github\.mossfinch\.perch",/);
});
