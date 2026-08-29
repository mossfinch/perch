// Getting onto the machine and staying recognised: the app target, the installers, the
// hooks, the launchd job, and the container the ledger lives in.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

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

test("the island's own launchd job has somewhere to put what it says", () => {
  // Without these the island's stderr goes nowhere: a crash, a refused write or
  // a failed precondition leaves no trace anyone can read afterwards. The
  // reconciler beside it has had both since day one.
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
    "assert spec['KeepAlive'] is False, 'KeepAlive turns the single-instance guard into a start/exit flap'",
    "assert spec['ProcessType'] == 'Interactive'",
    "assert spec['ProgramArguments'] == ['/tmp/Perch.app/Contents/MacOS/Perch'], spec['ProgramArguments']",
    "assert spec['Label'] == 'io.github.mossfinch.perch'",
    "print('ok')",
  ].join("\n");
  const out = execFileSync("python3", ["-B", "-c", py], { encoding: "utf8", cwd: ROOT }).trim();
  assert.equal(out, "ok");

  // ⚠️ The spec spells the label and the executable out so it can be lifted out
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

// App Group files can outlive the feature that wrote them. The manifest maps
// every allowed entry to a current writer so readable but abandoned residue
// cannot remain silently.
const CONTAINER_WRITERS = {
  "agent-events": "the island, on every agent pickup",
  "care-ledger.json": "the island, when a care session is recorded",
  "day-scores.jsonl": "the island, when a day is scored",
  "flow-corrections": "the island, when a flow verdict is corrected",
  "reconciliation": "the history rebuild, handed over the island's socket",
  "bridge.sock": "the island, for as long as it runs",
  "claude-hook.lastrun": "the Claude hook, on every run",
  "codex-hook.lastrun": "the Codex hook, on every run",
  "Library": "macOS",
};

// What a retired feature used to write. Still being here is residue, not health.
const RETIRED_CONTAINER_ENTRIES = {
  "today-summary.json": "the desktop widget it fed was retired",
  "presence": "presence collection was retired",
  "presence-corrections": "presence collection was retired",
};

// Why an entry does not belong, or null when it does. Split out from the sweep
// so its three answers stay provable on a machine that has no container at all.

// Why an entry does not belong, or null when it does. Split out from the sweep
// so its three answers stay provable on a machine that has no container at all.
const containerEntryFault = (entry) => {
  if (RETIRED_CONTAINER_ENTRIES[entry]) return `residue: ${RETIRED_CONTAINER_ENTRIES[entry]}`;
  if (!CONTAINER_WRITERS[entry]) return "nothing in this manifest claims to write it";
  return null;
};

test("the container manifest separates a live entry, residue, and a stranger", () => {
  assert.equal(containerEntryFault("agent-events"), null);
  assert.equal(containerEntryFault("presence"), "residue: presence collection was retired");
  // Control: an entry nobody has ever declared must not pass as live.
  assert.equal(containerEntryFault("a-name-invented-for-this-control"),
    "nothing in this manifest claims to write it");
});

test("nothing sits in the container that nothing writes", (t) => {
  const plist = fs.readFileSync(islandPath("Info.plist"), "utf8");
  const group = plist.match(/<key>AppGroupID<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(group, "Info.plist declares no AppGroupID to look the container up by");
  const base = path.join(os.homedir(), "Library", "Group Containers");
  // A signed install prefixes the container with a Team ID and an ad-hoc one
  // does not; matching the suffix covers both without naming a team here.
  const dirs = !fs.existsSync(base) ? []
    : fs.readdirSync(base).filter((n) => n === group || n.endsWith("." + group));
  if (dirs.length === 0) {
    // Announced, never a silent pass: a sweep that quietly finds nothing to
    // sweep reads exactly like a sweep that found everything in order.
    t.skip("no Perch container on this machine; nothing to sweep");
    return;
  }
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(path.join(base, dir)).filter((n) => !n.startsWith("."))) {
      const fault = containerEntryFault(entry);
      assert.equal(fault, null,
        `${entry} is in the container but ${fault}. Either add it here with what writes it, ` +
        `or move it out of the container — a file whose writer is gone still reads like live data.`);
    }
  }
});
