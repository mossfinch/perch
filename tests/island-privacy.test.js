// Nothing that ships may point at the person who wrote it: no Team ID, no builder path,
// no agent note left standing, no internal work order, and no accidental push.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = require("node:path").resolve(__dirname, "..");
const { WORKING, islandViews, viewModelSource, islandTree, islandPath, pkgPath, PKG } = require("./island-paths");
const { islandTestFiles } = require("./island-roster");

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

  // ② Nothing a person reads on the island is in Chinese, so scan the whole
  //    visible layer rather than selected controls.
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
  if (!WORKING) {
    assert.deepEqual(xcc, [], `no xcconfig belongs in the public package: ${xcc.join(", ")}`);
  } else {
    // Upstream layout: a template file still lives here, and the real-value
    // file must be blocked by gitignore
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.match(ignore, /^Config\.xcconfig$/m, "the real-value file must be gitignored");
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
  if (true) {   // 两种布局都查；分支在 covered() 里
    const onDisk = walk(ROOT, "", []).filter((f) => !f.startsWith(".git/"));
    // ⚠️ Two shapes, one rule each. Since the split this working repo has the same
    // flat layout as the package, so `PKG === ROOT` no longer tells them apart —
    // `docs/` does: the exporter never copies it.
    //
    // In the WORKING repo the manifest's `excludedOnPurpose` entries are SUPPOSED to be
    // on disk; that field exists to say so, and this guard never read it before. In the
    // PACKAGE they must be absent, because the export left them behind — so there the
    // same list is an alarm rather than a pass.
    const working = WORKING;
    const excluded = Object.keys(manifest.excludedOnPurpose || {}).map((k) => k.replace(/\/\*\*$/, ""));
    const inList = (list) => (rel) => list.some((r) => rel === r || rel.startsWith(r + "/"));
    const isExcluded = inList(excluded);
    const covered = working ? (rel) => inList(manifest.include)(rel) || isExcluded(rel)
                            : inList(manifest.include);
    if (!working) {
      const left = onDisk.filter(isExcluded);
      assert.deepEqual(left, [], `the package carries files the manifest excludes on purpose: ${left.join(", ")}`);
    } else {
      // Control: the exclusion list must be doing work here, or this branch is a rubber
      // stamp that would pass on a repo full of undeclared files.
      assert.ok(onDisk.some(isExcluded), "control: nothing on disk matched excludedOnPurpose — the list drifted");
    }
    const litter = onDisk.filter((f) => neverCopy.some((re) => re.test(f)));
    assert.deepEqual(litter, [], `litter the extraction never copied: ${litter.join(", ")}`);
    const unaccounted = onDisk.filter((f) => !covered(f));
    assert.deepEqual(unaccounted, [], `present on disk but absent from the manifest: ${unaccounted.join(", ")}`);
  }

  // Control group: the scan surface must not collapse. The most dangerous
  // failure is "scanned nothing, then all green".
  assert.ok(scanned.length >= 40, `only ${scanned.length} files in the scan surface; the manifest is probably broken`);
  // ⚠️ The guard must scan the suite it lives in. Asking after ALL of the island test
  // files, not just this one, is what makes a seventh file added without a manifest
  // entry go red here instead of shipping unscanned.
  for (const f of islandTestFiles()) {
    assert.ok(scanned.includes(`tests/${f}`),
      `the guard must scan itself — tests/${f} is missing from the scan surface, and missing itself is the easiest false green`);
  }

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
    const shippedText = !WORKING ? utf8
      : utf8.split("\n").filter((l) => !AIDEV_LINE.test(l)).join("\n");
    for (const re of historyNeedles) {
      // The manifest's own upstream record is stripped by the export script;
      // in the package layout there is no such exemption.
      if (WORKING && path.basename(rel) === "perch-package.json") continue;
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

test("the working repo cannot be pushed by accident", () => {
  // The private working repo relies on a pre-push hook to block a wrong push,
  // and this test is what stops that hook from quietly disappearing.
  // The extracted package is meant to be pushed, so the guard runs in the
  // upstream layout only.
  // (In the package layout this test is skipped.)
  if (!WORKING) return;

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

// Which lines in a Swift file are agent notes that detach the doc block above
// them. One function, used both on the real sources and on the fixtures below —
// a control that calls something else proves nothing about what runs.
//
// ⚠️ Case-insensitive and whole-line, exactly as export-perch.py's NOTE_LINE is:
// the publishing step strips a lower-case note too, so one of those detaches
// the docs in this tree and then vanishes from the package. A guard that only
// saw upper case would never hear about it.
function notesDetachingDocs(lines) {
  const note = new RegExp("^\\s*(//|#)\\s*" + "AIDEV" + "-(NOTE|TODO|QUESTION)\\b", "i");
  const out = [];
  lines.forEach((line, i) => {
    if (line.trim().startsWith("///") || !note.test(line)) return;
    // ⚠️ What FOLLOWS is irrelevant. Once a note sits directly after a `///`
    // line the block above is already detached — whether what comes next is
    // more doc, the declaration itself, or an attribute in front of one.
    // Walk back past blank lines and attributes. A note is inside the doc block
    // whether it sits directly under the `///` or behind an attribute that
    // itself follows one — Swift attaches a doc comment to the whole
    // declaration, attributes included, so anything wedged in detaches it.
    // ⚠️ An attribute can span lines (`@available(\n macOS 15,\n *)`). Skipping
    // only lines that START with `@` stopped the walk at the `*)` and let that
    // shape through; parens are counted so the whole attribute is stepped over.
    let j = i - 1;
    let depth = 0;
    while (j >= 0) {
      const t = lines[j].trim();
      if (t === "") { j -= 1; continue; }
      if (t.startsWith("///")) break;
      depth += (t.match(/\)/g) || []).length - (t.match(/\(/g) || []).length;
      if (t.startsWith("@") && depth <= 0) { depth = 0; j -= 1; continue; }
      if (depth > 0) { j -= 1; continue; }
      break;
    }
    if (j >= 0 && lines[j].trim().startsWith("///")) out.push(i);
  });
  return out;
}

test("no agent note is left standing inside a doc comment", () => {
  // ⚠️ A `//` line ENDS a Swift doc comment. Drop a note into the middle of one
  // and everything above it stops documenting the declaration below — the file's
  // purpose, its contracts, its warnings, all detached, in the tree people
  // actually read.
  // The publishing step cannot catch this: it strips the notes, so the halves
  // rejoin and the exported copy looks perfect while the working repo is the one
  // that lost the documentation. It has to be caught here.
  const offenders = [];
  for (const rel of islandTree().filter((p) => p.endsWith(".swift"))) {
    const lines = fs.readFileSync(pkgPath("Perch", rel), "utf8").split("\n");
    for (const i of notesDetachingDocs(lines)) offenders.push(`${rel}:${i + 1}`);
  }
  assert.deepEqual(offenders, [],
    `agent notes sit inside a doc comment and detach everything above them: ${offenders.join(", ")}`);

  // Controls, through the SAME function the sweep just used. Every shape that
  // detaches a doc block must register; nothing else may.
  const tag = "AIDEV" + "-NOTE";
  // ⚠️ Split like everything else that names the marker: the publishing step
  // refuses a file containing it whole, and it matches case-insensitively.
  const noteHere = new RegExp("aidev" + "-", "i");
  const mustFlag = {
    "between two doc lines": ["/// one", `// ${tag}: x`, "/// two", "enum X {"],
    "between doc and declaration": ["/// one", `// ${tag}: x`, "enum X {"],
    "between doc and an attribute": ["/// one", `// ${tag}: x`, "@discardableResult", "func f() {"],
    "lower case, which the exporter also strips": ["/// one", "// " + "aidev" + "-note: x", "enum X {"],
    "blank line between, which Swift does not forgive": ["/// one", "", `// ${tag}: x`, "enum X {"],
    "behind an attribute": ["/// one", "@discardableResult", `// ${tag}: x`, "func f() {"],
    "behind two attributes": ["/// one", "@MainActor", "@discardableResult", `// ${tag}: x`, "func f() {"],
    "behind an attribute spanning three lines":
      ["/// one", "@available(", "  macOS 15,", "  *)", `// ${tag}: x`, "func f() {"],
  };
  for (const [name, lines] of Object.entries(mustFlag)) {
    assert.deepEqual(notesDetachingDocs(lines), [lines.findIndex((l) => noteHere.test(l))],
      `control: a note ${name} no longer registers as an offence`);
  }
  const mustPass = {
    "after ordinary code": ["}", `// ${tag}: x`, "/// one", "enum X {"],
    "after a plain comment": ["// plain", `// ${tag}: x`, "enum X {"],
    "at the top of a file": [`// ${tag}: x`, "/// one", "enum X {"],
    "a doc line that merely mentions the tag": ["/// one", `/// see ${tag}`, "enum X {"],
  };
  for (const [name, lines] of Object.entries(mustPass)) {
    assert.deepEqual(notesDetachingDocs(lines), [],
      `control: a note ${name} is being called an offence`);
  }
});

// Comment lines of one shipping file, python docstrings included. Sticky notes
// are excluded: they are exactly the channel where process history belongs, and
// the publishing step removes them.

// Comment lines of one shipping file, python docstrings included. Sticky notes
// are excluded: they are exactly the channel where process history belongs, and
// the publishing step removes them.
function publicCommentLines(text, kind) {
  const note = new RegExp("^\\s*(//|#)\\s*" + "AIDEV" + "-(NOTE|TODO|QUESTION)\\b", "i");
  const out = [];
  let inDoc = false;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    let isProse;
    if (kind === "prose") {
      // Markdown, YAML, plain text: the whole file is what a stranger reads.
      isProse = true;
    } else if (kind === "python") {
      const quotes = (t.match(/"{3}/g) || []).length + (t.match(/'{3}/g) || []).length;
      const wasDoc = inDoc;
      if (quotes % 2 === 1) inDoc = !inDoc;
      // ⚠️ An even count is not "no docstring": `"""one line."""` opens and
      // closes on the same line and left the toggle untouched, so a whole class
      // of docstring walked past this sweep.
      isProse = wasDoc || inDoc || quotes > 0 || t.startsWith("#");
    } else if (kind === "shell") {
      isProse = t.startsWith("#");
    } else {
      isProse = t.startsWith("//") || t.startsWith("*");
    }
    if (isProse && !note.test(line)) out.push([i + 1, line]);
  });
  return out;
}

// Prose files are scanned in full; code files contribute comment text only.
// Every text format in the shipping manifest must select a reading rule here.
function commentKindFor(rel) {
  if (/\.(md|markdown|ya?ml|txt)$/i.test(rel)) return "prose";
  if (/\.py$/i.test(rel)) return "python";
  if (/\.(sh|bash|zsh)$/i.test(rel)) return "shell";
  if (/\.(swift|js|mjs|cjs)$/i.test(rel)) return "slashes";
  return null;   // binaries, images, plists: nothing to read
}

// A three-digit number used as a REFERENCE — the shape a work-order id takes in
// prose. Not any three-digit number: an angle or a loop bound handed to a call
// is not a reference, and a guard that flagged those would be switched off
// within a week.
// A three-digit number used as a REFERENCE — the shape a work-order id takes in
// prose. Not any three-digit number: an angle or a loop bound handed to a call
// is not a reference, and a guard that flagged those would be switched off
// within a week.
// ⚠️ Built from halves, and named without the word: a sibling guard forbids that
// upstream vocabulary anywhere in a shipping file, and it caught both this
// constant's NAME and the literal inside it.
const WORK_ORDER_REFERENCE = new RegExp(
  "\\b" + "PROCESS" + "_\\d+" +
  "|(?:\\b(?:in|since|until|by|after|before|from)\\s+\\d{3}\\b)" +
  "|\\(\\d{3}\\)" +
  "|\\b\\d{3}'s\\b", "i");

test("nothing that ships names an internal work order", () => {
  // A stranger has no way to look up "096", and it narrates how the code got
  // here rather than what it does — which the sticky-note channel exists for.
  // This guard covers mechanical work-order references only. Semantic provenance,
  // including whether a number came from private observations, still requires
  // human comment review.
  const manifest = JSON.parse(fs.readFileSync(pkgPath("perch-package.json"), "utf8"));
  // Resolve both layouts: manifest paths are rooted at the mother repository,
  // while the extracted package itself becomes the root.
  const files = [];
  const resolve = (rel) => [path.join(ROOT, rel), path.join(PKG, rel)].find((p) => fs.existsSync(p));
  const walk = (rel) => {
    const abs = resolve(rel);
    if (!abs) return;
    if (fs.statSync(abs).isDirectory()) {
      if (abs.endsWith(".xcassets") || abs.endsWith(".xcodeproj")) return;
      for (const e of fs.readdirSync(abs)) walk(path.join(rel, e));
    } else if (commentKindFor(rel)) {
      files.push(rel);
    }
  };
  for (const r of manifest.include) walk(r);
  // Controls on the surface itself: a sweep that quietly resolves nothing reads
  // exactly like a sweep that found nothing wrong.
  assert.ok(files.length > 20, `control: only ${files.length} shipping sources found — the sweep collapsed`);
  assert.ok(files.some((f) => f.endsWith(".swift")), "control: no Swift source reached the sweep");
  for (const f of islandTestFiles()) {
    assert.ok(files.includes(`tests/${f}`),
      `control: tests/${f} never reached the sweep — the shipping test files did not resolve`);
  }
  assert.ok(files.some((f) => f.endsWith(".md")), "control: no prose file reached the sweep");

  const offenders = [];
  for (const rel of files) {
    const text = fs.readFileSync(resolve(rel), "utf8");
    for (const [n, line] of publicCommentLines(text, commentKindFor(rel))) {
      const hit = line.match(WORK_ORDER_REFERENCE);
      if (hit) offenders.push(`${rel}:${n} «${hit[0]}»`);
    }
  }
  assert.deepEqual(offenders, [],
    `shipping comments name internal work orders: ${offenders.join(" · ")}`);

  // Controls, through the same two pieces the sweep just used.
  // ⚠️ The upstream tag is spelled in halves here too: a sibling guard forbids
  // that vocabulary anywhere in a shipping file, and it caught this line once.
  const upstream = "PROCESS" + "_124";
  for (const line of ["// gone (096)", "# it changed in 097", `// see ${upstream}`, "/// 090's features"]) {
    assert.match(line, WORK_ORDER_REFERENCE, `control: "${line}" no longer reads as a work-order reference`);
  }
  for (const line of ["// the 108 cap", "// Seconds from 09:00.", "// half an hour, 30 minutes"]) {
    assert.doesNotMatch(line, WORK_ORDER_REFERENCE, `control: "${line}" is being called a work-order reference`);
  }
  // A parenthesised number in CODE is not a comment, and it is the picker —
  // not the pattern — that keeps such a call out of this. Prove the picker
  // does that job, or the pattern above looks stricter than the sweep is.
  assert.deepEqual(
    publicCommentLines([".degrees(180),", "for _ in range(180):", "// the 108 cap"].join("\n"), "slashes")
      .map((r) => r[0]),
    [3], "control: the sweep is reading code lines, where a (180) means nothing of the kind");
  // …and the picker must actually exclude sticky notes, or this sweep would
  // flag every note in the tree and get itself deleted.
  const sample = ["// " + "AIDEV" + "-NOTE: see " + upstream, "// plain (096)"].join("\n");
  assert.deepEqual(publicCommentLines(sample, "slashes").map((r) => r[0]), [2],
    "control: the sticky-note channel is no longer excluded from the sweep");

  // Exercise every supported comment reader with a reference it must expose.
  assert.deepEqual(publicCommentLines("Historical step (096).", "prose").map((r) => r[0]), [1],
    "control: prose files are being read as if they had comment syntax");
  const oneLineDoc = ['{Q}Historical step (096).{Q}', "x = 1"].join("\n").replace(/{Q}/g, '"'.repeat(3));
  assert.deepEqual(publicCommentLines(oneLineDoc, "python").map((r) => r[0]), [1],
    "control: a docstring that opens and closes on one line is invisible to the sweep");
  assert.deepEqual(publicCommentLines(["# a note", "x = 1"].join("\n"), "shell").map((r) => r[0]), [1],
    "control: shell comments are not being read");
  assert.equal(commentKindFor("README.md"), "prose");
  assert.equal(commentKindFor("a.yml"), "prose");
  assert.equal(commentKindFor("perch-hook.sh"), "shell");
  assert.equal(commentKindFor("logo.png"), null, "control: binaries are being read as text");
});
