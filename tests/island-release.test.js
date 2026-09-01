// What may leave: the archive audit, the package's own structure, the READMEs, the
// changelog, and the size limits that keep a file from growing back into a pile.
// One of the island suite's files; `tests/island-roster.js` is what knows they all
// exist. Run them together — a single file run is a partial answer.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = require("node:path").resolve(__dirname, "..");
const { ISLAND_VIEW_FILES, WORKING, islandTree, islandPath, pkgPath } = require("./island-paths");

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

# ⑩ Bytes between the final entry data and the central directory are outside
#    every record and must be refused; archive readers reject this shape.
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
  //    Product comments may name removed types while explaining compatibility,
  //    so comments and docstrings are stripped before scanning code residue.
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
  // ③ DayScore owns the formatter used to read and write ledger day keys.
  const score = fs.readFileSync(islandPath("DayScore.swift"), "utf8");
  assert.match(score, /static let dayFormatter: DateFormatter/,
    "DayScore no longer owns the formatter it borrowed from TodaySummary");
  assert.match(score, /f\.dateFormat = "yyyy-MM-dd"/);
  assert.match(score, /Locale\(identifier: "en_US_POSIX"\)/);
  // ④ FlowMath.flowStretches and FlowMath.runIntervals must remain absent:
  //    the island has no callers. Their Python counterparts remain because
  //    shadow reports still consume them under their legacy meaning.
  const math = fs.readFileSync(islandPath("FlowMath.swift"), "utf8");
  const hasDead = (s) => /static func (flowStretches|runIntervals)\(/.test(s);
  assert.ok(!hasDead(math),
    "FlowMath.flowStretches / runIntervals came back — the island has no caller for either");
  // Control: the probe can see a function that IS there, so the absence above
  // is a real absence and not a regex that stopped matching anything.
  assert.match(math, /static func settle\(/,
    "control: FlowMath.settle must still be here — the island's flow verdict reads it every 15 seconds");
  const report = fs.readFileSync(pkgPath("island-day-report.py"), "utf8");
  assert.match(report, /def flow_stretches\(/, "the old measure's python end is gone — the shadow features read it");
  assert.match(report, /def run_intervals\(/, "the old measure's python end is gone — the shadow features read it");

  // ④b GONE TOO: the two things left standing because that removal's boundary
  //    named functions and nothing else — the constant those functions bridged
  //    with, and the type they returned. Nothing constructs or reads either.
  const hasCorpse = (s) =>
    /static let flowBridge\b/.test(s) || /struct Stretch\b/.test(s);
  assert.ok(!hasCorpse(math),
    "FlowMath.flowBridge / Stretch came back — nothing calls their measure any more");
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

test("the three READMEs cannot drift apart", () => {
  // The translated READMEs must agree on machine-checkable structure, commands,
  // pictures and ladder values; prose equivalence remains a human review.
  const NAMES = ["README.md", "README.zh-CN.md", "README.ja.md"];
  const docs = NAMES.map((n) => [n, fs.readFileSync(pkgPath(n), "utf8")]);

  // Count headings by level; a total alone cannot detect section demotion.
  const headings = (md) => [2, 3].map((n) => (md.match(new RegExp(`^#{${n}} `, "gm")) ?? []).length);
  // Both spellings: the badges and screenshots are markdown, but a centred
  // header needs `<img>`, and a picture the scanner cannot see is a picture
  // that can drift in one language only.
  const images = (md) => [
    ...[...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]),
    ...[...md.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((m) => m[1]),
  ];
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

  // ⚠️ Agreeing with each other is not enough: all three could point at a
  // picture nobody has, and this test would stay green while the published
  // README renders three broken images. So every LOCAL reference must exist on
  // disk AND be carried by the manifest — a file that exists but is not listed
  // never reaches the package, which looks identical to a reader.
  const manifest = JSON.parse(fs.readFileSync(pkgPath("perch-package.json"), "utf8"));
  const shipped = new Set(manifest.include.map((i) => path.basename(i)));
  const local = [...new Set(docs.flatMap(([, md]) => images(md)))]
    .filter((src) => !/^https?:\/\//.test(src));
  assert.ok(local.length >= 4, `only ${local.length} local pictures found — the scan collapsed`);
  for (const src of local) {
    assert.ok(fs.existsSync(pkgPath(src)), `README points at ${src}, which is not in the package directory`);
    assert.ok(shipped.has(path.basename(src)),
      `${src} exists but the manifest does not carry it — it would not reach the published package`);
  }
});

test("the installer reads the product's version instead of naming one", () => {
  // A literal in the installer would create a second version source. The built
  // plist is authoritative, so the installer must read rather than name it.
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

test("the changelog knows about the version that ships", () => {
  // A changelog nobody updates is worse than none: it reads as a complete
  // history right up until the moment it silently stops being one. The version
  // in Info.plist is what actually ships, so that is the one it must name.
  const log = fs.readFileSync(pkgPath("CHANGELOG.md"), "utf8");
  const plist = fs.readFileSync(islandPath("Info.plist"), "utf8");
  const version = plist.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(version, "control: the shipping version could not be read at all");

  const headings = [...log.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
  assert.ok(headings.length >= 2, `only ${headings.length} entries — this scan is reading nothing`);
  assert.equal(headings[0], "Unreleased",
    "the top entry must be Unreleased, so finished work has somewhere to wait");
  assert.ok(headings.includes(version),
    `Info.plist ships ${version} and the changelog has never heard of it: ${headings.join(", ")}`);

  // Newest first, and every released entry dated the way the format asks.
  for (const h of headings.slice(1)) {
    const line = log.match(new RegExp(`^## \\[${h.replace(/\./g, "\\.")}\\][^\n]*`, "m"))[0];
    assert.match(line, /— \d{4}-\d{2}-\d{2}$/,
      `${h} has no ISO date — "3/4" cannot be told from "4/3" by a reader elsewhere`);
  }
  // Control: the date check must be able to fail.
  assert.doesNotMatch("## [9.9] — 25/08/2026", /— \d{4}-\d{2}-\d{2}$/,
    "control: the date shape check accepts anything");

  // Every version heading needs a link definition, or the compare links rot
  // silently and nobody notices until they click one.
  for (const h of headings) {
    assert.ok(log.includes(`[${h}]: https://`), `${h} has no link definition at the bottom`);
  }
});

// A split suite can hide a valid test file if no runner or manifest discovers it.
//
// ⚠️ The rule has ONE implementation, in tests/island-roster.js. The pre-commit hook
// calls the same function. A second copy here would be free to drift from the copy that
// actually runs, which is the failure this whole test is about.
test("no island test file may be invisible: shipped, discovered, and never named by hand", () => {
  const { islandSuiteFiles, islandTestFiles, orphanFaults, allDeclaredTestNames } = require("./island-roster");

  // Controls first: a roster that resolved nothing would report no faults and read
  // exactly like a healthy repo.
  const suite = islandSuiteFiles();
  assert.ok(suite.length >= 7, `control: the roster found only ${suite.length} suite files — discovery collapsed`);
  assert.ok(islandTestFiles().length >= 6, `control: only ${islandTestFiles().length} test files found`);
  assert.ok(allDeclaredTestNames().length > 50,
    `control: only ${allDeclaredTestNames().length} test names read — the roster is reading text it does not understand`);

  assert.deepEqual(orphanFaults(), []);

  // Discover JavaScript tests from the filesystem, as Python tests are; a
  // hard-coded roster can let a newly shipped test go unexecuted.
  // ⚠️ WORKING only. Since 2026-09-01 the exporter does not ship: it serves
  // one direction — this private repo into the public package — and whoever clones the
  // package is already standing on the far side of it, with nothing left to export. Same
  // sentence the manifest uses to keep the publish gate out. These three assertions guard
  // the exporter, so they belong wherever the exporter is, and that is here only.
  if (WORKING) {
    const exporter = fs.readFileSync(pkgPath("export-perch.py"), "utf8");
    assert.match(exporter, /glob\("\*\.test\.js"\)/,
      "the exporter stopped discovering the JS tests by pattern");
    assert.doesNotMatch(exporter, /"tests\/island[-\w]*\.test\.js"/,
      "the exporter names an island test file by hand — the next file added will not run in the package");
    assert.match(exporter, /node_ran_count/,
      "the exporter stopped checking that the JS suite really executed something");
  }
});

// Every command the documents hand a reader must name a file that exists. A document
// telling someone to run a file that was renamed is a check nobody performs and everybody
// believes was performed.
//
// ⚠️ TWO things it deliberately does not do.
// `docs/ops/process/` is the archive: each work order records the commands that were
// really run on a real day, and a command naming a file that has since been renamed is
// TRUE about that day. Rewriting it would be falsifying the record, so the archive is
// excluded — the live documents are the ones a reader acts on today.
// And it is skipped entirely in the extracted package, which carries no docs/ — the same
// shape as the git assertions elsewhere in this suite.
test("no live document tells a reader to run a test file that does not exist", () => {
  const docs = path.join(ROOT, "docs");
  if (!fs.existsSync(docs)) return;   // extracted package: nothing to check

  // Archives, all of them: what they quote was true on the day it was written.
  // `ops/process` is the work-order archive; `ops/archive` is frozen review history;
  // `40-worklog`, `plans` and `superpowers` are finished plans and specs kept for the
  // record. Rewriting any of them to satisfy a guard would be falsifying the record.
  const ARCHIVES = ["ops/process", "ops/archive", "40-worklog", "plans", "superpowers"]
    .map((d) => path.join(docs, ...d.split("/")));
  const ARCHIVE = ARCHIVES[0];
  // ⚠️ Three FILES are frozen too, not directories: AGENTS.md says STATUS.md and
  // REVIEW.md are read for what happened and never for what to do now, and DESIGN.md
  // is the same shape. A frozen file naming a test that has since moved is telling the
  // truth about its own day.
  const FROZEN = ["ops/STATUS.md", "ops/REVIEW.md", "ops/DESIGN.md"]
    .map((f) => path.join(docs, ...f.split("/")));
  // ⚠️ `30-roadmap.md` is excluded too, and the reason is different from the archive's.
  // It is the LEDGER: thousands of lines where an open debt and the closed history of a
  // fixed one sit under sibling headings, sometimes in the same table. "on that day X was
  // found in island.test.js" is a record of a day; "to pick this debt up, look at
  // island.test.js line 2170" is a pointer that must still work. No regex separates them —
  // the ✅ marker covers only half the closed entries — so this is one of the places a
  // human has to read. Do not "fix" it by widening the sweep and rewriting what it finds:
  // that falsifies the record.
  const LEDGER = path.join(docs, "30-roadmap.md");
  const walk = (dir) => ARCHIVES.includes(dir) ? [] :
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith(".md") && path.join(dir, e.name) !== LEDGER
        && !FROZEN.includes(path.join(dir, e.name)) ? [path.join(dir, e.name)] : []);
  const files = walk(docs);
  assert.ok(files.length >= 4, `control: only ${files.length} live documents found — the sweep collapsed`);
  for (const a of ARCHIVES) {
    assert.ok(!files.some((f) => f.startsWith(a + "/")), `control: ${path.relative(docs, a)} leaked into the live sweep`);
  }

  // ⚠️ Commands are not the only way a document points at a test file. The SOP said things
  // like "the nine-case behaviour test in island.test.js" — no command, just a name, and a
  // reader following it lands on a file that no longer exists. The first version of this
  // guard read only `node --test ...` lines and called the sweep clean; codex found six
  // such sentences it had walked straight past. Any tests/ path with an extension counts
  // now, wherever it sits on the line. (This comment deliberately writes that old name
  // WITHOUT its directory: a guard that trips over its own explanation is a guard whose
  // explanation gets deleted.)
  // ⚠️ This started as `tests/…` ONLY, and that hole shipped: on 2026-08-31 the tree was
  // flattened out of `apps/mac-widget/`, and five commands in `docs/10-spine.md` and
  // `docs/20-modules.md` kept pointing at the old location. Every one of them was a path
  // a reader would follow, and every one of them walked straight past this guard because
  // the regex was anchored to one directory name. Same family as the sticky-note guard
  // that only caught one of three shapes: FIXING ONE SHAPE IS NOT WELDING THE CLASS SHUT.
  //
  // So: any path-looking token, then TWO judgements decide whether it is this repo's
  // business. They were tuned by running the widened sweep over the real tree and reading
  // every hit — 125 kinds of noise on the naive version, 9 real ones here.
  const TOKEN = /(?<![\w/.~-])(?!https?:)[A-Za-z_][\w.-]*(?:\/[\w.*-]+)+/g;
  const TOP = new Set(fs.readdirSync(ROOT).filter((n) => !n.startsWith(".")));
  const pathsIn = (line, isDoc) => {
    const out = [];
    for (const m of line.matchAll(TOKEN)) {
      // `<spec/design/decision path>` and `<name>/<source>.md` are template placeholders in
      // the work-order form, not paths. They are the single largest source of noise.
      const before = line[m.index - 1], after = line[m.index + m[0].length];
      if (before === "<" || after === "<" || after === ">") continue;
      const raw = m[0].replace(/[.,;:)]+$/, "");        // prose punctuation, not the path
      if (raw.split("/")[0].includes(".")) continue;    // `github.com/mossfinch/perch` is a URL
      // ① first segment is a real top-level entry ⇒ it names something here, check it.
      // ② first segment is NOT ⇒ the whole directory moved or never existed. Only trusted
      //    in DOCUMENTS: source files legitimately carry synthetic paths as fixtures
      //    (`export_perch_test.py` really does assert on `apps/sub/a.py`), and a guard that
      //    reds on a test's own fixture teaches people to weaken the guard.
      if (TOP.has(raw.split("/")[0]) || (isDoc && raw.split("/").length >= 3)) out.push(raw);
    }
    return out;
  };

  // Absent ON PURPOSE, each with the reason a reader would otherwise come asking for.
  // ⚠️ This list is checked below: if one of these ever comes back, the exemption is stale
  // and must go. An allowlist nobody re-checks is how a guard quietly stops guarding.
  const DELIBERATELY_ABSENT = {
    "docs/60-minimap.md": "no generator exists; the slot stays empty on purpose (in 30-roadmap)",
    "docs/40-worklog": "the five pages here were Formmark's; deleted at the split, kept in training",
    "artifacts/designs/formmark-open-skill-wall-dashboard-2026-07-04.png":
      "a Formmark design file that stayed in training; named by frozen background prose",
  };

  // A heading marked ✅ opens a CLOSED entry: what it quotes is what really happened on
  // the day it was written, filenames of that day included. Live entries above and below
  // it are still checked — only the closed one is left alone.
  const named = [];
  for (const f of files) {
    let closed = false;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (/^#{1,6} /.test(line)) closed = line.includes("✅");
      if (closed) continue;
      for (const raw of pathsIn(line, true)) named.push([path.relative(ROOT, f), raw]);
    }
  }
  assert.ok(named.length > 3, `control: only ${named.length} run commands found in the documents`);

  // ⚠️ The docs/ tree is only HALF the surface. The README, CONTRIBUTING, the PR template
  // and the source comments all SHIP — those are the copies a stranger reads, and a
  // command that names a renamed file wastes their first ten minutes. Sweeping docs/
  // alone was the actual hole this guard shipped with; it is why the shipping half
  // carries its own control below.
  const READABLE = /\.(md|py|js|swift|sh|ya?ml|json)$/;
  const shipping = [];
  const walkShip = (rel) => {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const e of fs.readdirSync(full)) walkShip(path.join(rel, e));
    } else if (READABLE.test(full)) shipping.push([rel, full]);
  };
  for (const rel of JSON.parse(fs.readFileSync(pkgPath("perch-package.json"), "utf8")).include) walkShip(rel);
  assert.ok(shipping.length > 20, `control: only ${shipping.length} readable shipping files reached the sweep`);
  assert.ok(shipping.some(([r]) => r.endsWith("README.md")), "control: the README never reached the sweep");
  assert.ok(shipping.some(([r]) => r.endsWith(".swift")), "control: no Swift source reached the sweep");

  for (const [rel, full] of shipping) {
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      for (const raw of pathsIn(line, false)) named.push([rel, raw]);
    }
  }

  const exists = (raw) => {
    if (!raw.includes("*")) return fs.existsSync(path.join(ROOT, raw));
    // ⚠️ The glob branch used to read `tests/` no matter what the path said, so a glob
    // anywhere else was answered by the wrong directory. Ask the path's own directory.
    const dir = path.join(ROOT, path.dirname(raw));
    if (!fs.existsSync(dir)) return false;
    const re = new RegExp("^" + path.basename(raw).replace(/\*/g, ".*") + "$");
    return fs.readdirSync(dir).some((n) => re.test(n));
  };

  // Control for the exemption list itself: every entry must still be absent. If one comes
  // back, the reason above is a lie and the entry has to go — otherwise this list is a
  // place where a real break can hide forever.
  const resurrected = Object.keys(DELIBERATELY_ABSENT).filter((p) => fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(resurrected, [],
    `these are exempted as "absent on purpose" but exist now — drop the exemption: ${resurrected.join(", ")}`);

  const missing = named.filter(([, raw]) => !exists(raw) && !(raw in DELIBERATELY_ABSENT));
  assert.deepEqual(missing, [],
    `these name a path that no longer exists: ${missing.map(([d, r]) => `${d} → ${r}`).join(", ")}`);

  // ⚠️ And a document may not lie about HOW MANY there are. `docs/10-spine.md` said 90
  // within the same commit that made it 92 — a snapshot table whose number nobody
  // recomputes goes stale on the next test added, and the reader has no way to tell.
  // One fixed phrase, checked everywhere it appears, so stating the count is safe.
  const { allDeclaredTestNames } = require("./island-roster");
  const real = allDeclaredTestNames().length;
  const claims = [];
  for (const [rel, full] of [...files.map((f) => [path.relative(ROOT, f), f]), ...shipping]) {
    for (const m of fs.readFileSync(full, "utf8").matchAll(/岛测试共 (\d+) 条/g)) {
      claims.push([rel, Number(m[1])]);
    }
  }
  assert.ok(claims.length >= 2, `control: only ${claims.length} documents state the island test count — the phrase drifted`);
  assert.deepEqual(claims.filter(([, n]) => n !== real), [],
    `these documents claim the wrong island test count (really ${real}): ${claims.map(([d, n]) => `${d}=${n}`).join(", ")}`);
});

// This cap reports unbounded growth; it does not judge test quality. The 1200-line
// allowance keeps cohesive cross-language flow cases together while still requiring
// another responsibility split before a file becomes a new monolith.
test("no island test file grows back toward the pile", () => {
  const { islandTestFiles, TESTS_DIR } = require("./island-roster");
  const CAP = 1200;

  const sizes = islandTestFiles()
    .map((f) => [f, fs.readFileSync(path.join(TESTS_DIR, f), "utf8").split("\n").length]);

  // Controls: a sweep that found nothing, or found only tiny files, would pass silently.
  assert.ok(sizes.length >= 10, `control: only ${sizes.length} island test files found — discovery collapsed`);
  assert.ok(sizes.some(([, n]) => n > 300), "control: every file came back tiny — the line count is not being read");

  const over = sizes.filter(([, n]) => n > CAP);
  assert.deepEqual(over, [],
    `over ${CAP} lines — split by subject, or say in THIS commit why the cap moved: ${over.map(([f, n]) => `${f} (${n})`).join(", ")}`);
});
