#!/usr/bin/env python3
"""Install the notch island as an everyday app: double-clickable in
/Applications, back automatically after every reboot.

Without this step the island only lives in a DerivedData debug build — gone on
reboot, startable only by running xcodebuild in a terminal and `open`ing the
product. That is not an inconvenience: without an installed form, the island
simply does not exist after a restart.

Three things happen here:
  1. Release build, signing, and a check that the app-group entitlement really
     made it into the signature. Signing takes one of two paths: with a
     DEVELOPMENT_TEAM in the gitignored Config.xcconfig the build is stamped
     with the Team-prefixed App Group and signed by that team's certificate;
     without one it is ad-hoc + prefix-free. The two paths name DIFFERENT
     containers, which is the whole reason the choice matters here. The Team ID
     lives only in Config.xcconfig, never in this script.
  2. Install into /Applications/Perch.app (admin-writable, no sudo)
  3. Write a LaunchAgent under ~/Library/LaunchAgents, start one now, and
     verify the island actually bound its socket

Why the signature check: without the entitlement in the signature the app
still runs, but the sandbox denies it the container — every event the hooks
push into the socket falls into the void, and the island sits there alive but
never changing color. That silent failure must be caught at install time.

Uninstall (three commands, no script needed):
  launchctl bootout gui/$UID/io.github.mossfinch.perch
  rm ~/Library/LaunchAgents/io.github.mossfinch.perch.plist
  rm -rf /Applications/Perch.app
"""
from __future__ import annotations   # so `X | None` annotations parse on macOS's stock python 3.9

import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

# Every path resolves relative to THE SCRIPT'S OWN DIRECTORY; never guess where
# the repo root is: this directory IS the root in the Perch repo, and it may be
# nested at any depth inside another repo — parents[N]-style level counting
# points into outer space the moment the layout changes.
HERE = Path(__file__).resolve().parent
# Build with the island's own project file. Other project files may sit right
# next to it — not this script's business.
PROJECT = HERE / "Perch.xcodeproj"
SCHEME = "Perch"
# The one file that may hold a signing Team ID — .gitignore blocks it. The
# Team ID never appears in this script; it is read from here at run time and
# used only to stamp a local build. Absent (or the template placeholder) means
# "public user, no Apple account" and the build stays ad-hoc + prefix-free.
CONFIG = HERE / "Config.xcconfig"
def app_group_of(app: Path) -> str:
    """Read the App Group from the built product's own Info.plist.

    Read the product, not the source: the value in the product is the one that
    got built and code-signed — the same one the app will use at runtime.
    Reading the source only proves "what I intended to use".
    """
    out = subprocess.run(
        ["/usr/libexec/PlistBuddy", "-c", "Print :AppGroupID",
         str(app / "Contents" / "Info.plist")],
        capture_output=True, text=True,
    ).stdout.strip()
    # Must look like group.<something>, with NO Team ID prefix: the Team ID
    # gets stamped into the shipped binary via the entitlement, and creates a
    # folder named after it on every user's machine.
    if not out.startswith("group.") or not out.removeprefix("group."):
        raise SystemExit(
            f"Bad App Group in the built product (got {out!r}).\n"
            "It should look like group.xxx; see AppGroupID in Perch/Info.plist."
        )
    return out
BUILD_DIR = Path("/tmp/perch-release")
APP_NAME = "Perch.app"
EXEC_SUBPATH = "Contents/MacOS/Perch"
INSTALLED = Path("/Applications") / APP_NAME
LABEL = "io.github.mossfinch.perch"   # same as the bundle id (LaunchAgent convention)
AGENTS_DIR = Path.home() / "Library" / "LaunchAgents"
PLIST = AGENTS_DIR / f"{LABEL}.plist"
RECONCILER_LABEL = "io.github.mossfinch.perch.reconcile"
RECONCILER_PLIST = AGENTS_DIR / f"{RECONCILER_LABEL}.plist"
RECONCILER_SOURCE = HERE / "perch-reconcile.py"
RECONCILER_BINARY = Path.home() / ".perch" / "bin" / "perch-reconcile"
DOMAIN = f"gui/{os.getuid()}"
PROCESS_PATTERN = f"{APP_NAME}/{EXEC_SUBPATH}"


def stale_agents() -> list[tuple[str, Path]]:
    """Which LaunchAgents on this machine, besides the current one, point at
    this app. Returns `(label, file)` pairs.

    **Recognized by what they POINT AT, not by name** — labels can be renamed,
    and a hard-coded list of old names both misses even older versions and
    keeps the old names in the source forever.

    **The real file path travels with the label.** A plist's file name and its
    internal `Label` need not match, so rebuilding the path as
    `<Label>.plist` can delete a stranger's file or silently miss the one that
    actually needs removing. Only paths that came from this glob — direct
    children of LaunchAgents, symlinks skipped — are ever unlinked.

    ⚠️ What happens if these are not cleaned up: two LaunchAgents pointing at
    the same app make launchd start one copy each; one of them hits the
    single-instance guard, kills itself, gets relaunched — a start→exit→start
    flap.
    """
    out = []
    for plist in sorted(AGENTS_DIR.glob("*.plist")):
        if plist == PLIST or plist.is_symlink():
            continue
        try:
            with open(plist, "rb") as f:
                spec = plistlib.load(f)
        except Exception:
            continue   # someone else's unparsable plist is not our business
        args = spec.get("ProgramArguments") or []
        if args and str(args[0]).startswith(str(INSTALLED)):
            out.append((spec.get("Label") or plist.stem, plist))
    return out


LEDGER_NAME = "care-ledger.json"


def ledger_records(path: Path) -> list:
    """Parse a ledger the way the island's decoder will, and return its records.

    Counting `records` is not enough. A JSON-legal file with the wrong shape
    would migrate cleanly and then make the island throw on its next launch —
    the reader deliberately refuses to treat "unreadable" as "empty" — so a
    count-only check just relocates the failure into the new home. Validate
    the whole contract here: an integer `version`, and every record carrying
    the seven fields with the right types.

    Raises ValueError with a human-readable reason; the caller turns that into
    a refusal.
    """
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("version"), int):
        raise ValueError("no integer `version` at the top level")
    records = data.get("records")
    if not isinstance(records, list):
        raise ValueError("`records` is not a list")
    for n, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"record {n} is not an object")
        missing = [f for f in ("date", "moveId", "category", "sets", "seconds", "source", "at")
                   if f not in record]
        if missing:
            raise ValueError(f"record {n} is missing {', '.join(missing)}")
        for field in ("date", "moveId", "category", "source", "at"):
            if not isinstance(record[field], str):
                raise ValueError(f"record {n}: `{field}` should be text")
        for field in ("sets", "seconds"):
            # bool is a subclass of int in Python; JSON `true` must not pass as a count
            if not isinstance(record[field], int) or isinstance(record[field], bool):
                raise ValueError(f"record {n}: `{field}` should be a whole number")
    return records


def migrate_ledger(source_group: str, target_group: str, root: Path | None = None) -> str:
    """Move the care ledger from an old App Group container into the new one.
    **The source is named by a human; the machine guesses nothing.**

    Changing the App Group = changing the folder. Without the move the island
    starts from an empty ledger, and the first session writes a new ledger
    with ONE record — looking exactly like dozens of history entries vanished.
    So this needs a procedure, not a one-off manual copy.

    **Why no auto-discovery**: without a Team prefix the common prefix is just
    `group`, so a prefix scan matches EVERY app's shared container on the
    machine; scanning precisely would require a hard-coded list of old
    container names — exactly the kind of thing that must not live in the
    source. With explicit naming, "which candidate to pick" is not solved, it
    simply DOES NOT EXIST: only someone who changed the App Group name needs a
    migration, and that person knows what they changed it to.

    Four hard rules:
      1. **Target already has a ledger -> refuse.** Even one record is real
         data; not ours to overwrite. The error reports both sides' record
         counts so the human can judge.
      2. **Source or target is a symlink -> refuse.** A dangling symlink's
         `exists()` lies, and `copy2` follows the link — data lands where
         nobody expects it.
      3. **Source does not parse -> refuse.** Moving a broken ledger just
         moves the failure into the new home: the island's `load` throws on
         next launch (the reader side's standing invariant).
      4. **Write to a temp file, then rename.** A copy that dies halfway would
         leave a truncated care-ledger.json that "exists" and blocks every
         retry. A dead temp file is just litter; the target still does not
         exist, rerun and done.

    The root parameter exists only for tests; normal calls don't pass it.
    """
    root = root or (Path.home() / "Library" / "Group Containers")
    # A group id names a container, not a path: anything with a separator in it
    # would resolve somewhere else entirely.
    for name, role in ((source_group, "source"), (target_group, "target")):
        if not name or "/" in name or name in (".", ".."):
            raise SystemExit(f"Invalid {role} App Group name ({name!r}): that is a path, not a container name.")
    source = root / source_group / LEDGER_NAME
    target = root / target_group / LEDGER_NAME

    if source_group == target_group:
        raise SystemExit(f"Source and target are the same container ({target_group}); nothing to move.")
    if source.is_symlink() or target.is_symlink():
        raise SystemExit(
            "A ledger path is a symbolic link; refusing — following a link "
            "writes data where you don't expect it:\n"
            f"   source {source}{'   <- is a symlink' if source.is_symlink() else ''}\n"
            f"   target {target}{'   <- is a symlink' if target.is_symlink() else ''}"
        )
    if not source.is_file():
        raise SystemExit(f"No ledger in the source container: {source}")
    try:
        incoming = len(ledger_records(source))
    except Exception as exc:
        raise SystemExit(
            f"Source ledger does not parse; refusing to move it (the island could not read it either):\n"
            f"   {source}\n   {exc}"
        )
    if target.exists():
        try:
            have = f"{len(ledger_records(target))} records"
        except Exception:
            have = "unreadable"
        raise SystemExit(
            "Target container already has a ledger; not overwriting.\n"
            f"   target {target} ({have})\n"
            f"   source {source} ({incoming} records)\n"
            "   To use the source ledger, move the target one aside first, then rerun."
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(target.name + ".migrating")
    # A leftover (or planted) staging entry must not be written through: a
    # symlink here would send the copy somewhere nobody expects.
    if staging.is_symlink() or staging.exists():
        raise SystemExit(f"Something is already in the way at {staging}. Remove it and rerun.")
    try:
        shutil.copy2(source, staging)
    except BaseException:
        staging.unlink(missing_ok=True)   # half a copy is litter, and leaving it would block every retry
        raise
    os.replace(staging, target)
    return f"Ledger moved (copy only, source kept; {incoming} records):\n   {source}\n-> {target}"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("+", " ".join(cmd))
    return subprocess.run(cmd, **kwargs)


def build() -> Path:
    print("Release build (takes 1-2 minutes)...")
    env = dict(os.environ, DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer")
    result = run(
        ["xcodebuild", "-project", str(PROJECT), "-scheme", SCHEME,
         "-configuration", "Release", "-derivedDataPath", str(BUILD_DIR), "build"],
        env=env, capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.stdout.write(result.stdout[-4000:])
        sys.stderr.write(result.stderr[-4000:])
        raise SystemExit("Release build failed, see output above")
    built = BUILD_DIR / "Build" / "Products" / "Release" / APP_NAME
    if not built.is_dir():
        raise SystemExit(f"Build reported success but the product is not at {built}")
    print("Built ->", built)
    return built


def strip_debug_symbols(app: Path) -> None:
    """Drop the debug symbols, which spell out the builder's own file paths.

    A Release build writes its debug info to a separate .dSYM, but
    `xcodebuild build` never runs the strip phase — so the product keeps a full
    copy anyway, and a DWARF file table is a list of absolute source paths. On
    the author's machine that is a username and a private repo name, printed
    into every binary anyone downloads.

    ⚠️ Order: stripping edits the executable, so it must run BEFORE signing.
    Run it after and the signature it invalidates is the one just made.

    One Mach-O, because the bundle holds one program: there is no app extension
    in PlugIns/ and nothing here signs one. Anything that still carried those
    paths would be caught by `verify_shipped_bytes`.
    """
    run(["strip", "-S", str(app / EXEC_SUBPATH)], check=True)


def verify_shipped_bytes(app: Path) -> None:
    """No file in the bundle may carry a path from the machine that built it.

    Every other guard here scans the repository: the manifest decides which
    FILES ship and the privacy test scans those. **The compiled bundle is in
    none of that** — and it is closer to what a stranger downloads than
    anything the repository holds. So the check lives next to the step that
    produces it.

    The needle is the shape `/Users/`, never one particular username: someone
    building on their own machine should not ship their path either, and a
    check that a rename defeats is not a check.

    ⚠️ This is the early warning, **not the last word**. It walks the bundle,
    and the debug symbols that carry those paths live *beside* the bundle as
    siblings — `Perch.app.dSYM`, `Perch.swiftmodule` — where this cannot reach
    them. What actually ships is the archive, so the authoritative audit is in
    `package-release.py`, which opens the finished zip. Catching it here just
    means finding out at build time instead of at package time.
    """
    needles = [("/Users/".encode(enc), enc)
               for enc in ("utf-8", "utf-16-le", "utf-16-be")]
    for f in sorted(app.rglob("*")):
        if f.is_symlink() or not f.is_file():
            continue
        buf = f.read_bytes()
        for needle, enc in needles:
            at = buf.find(needle)
            if at != -1:
                sample = buf[at:at + 120].decode(enc, "replace").split("\x00")[0]
                raise SystemExit(
                    f"{f.relative_to(app)} carries a build-machine path ({enc}), refusing to ship it:\n"
                    f"  {sample}\n"
                    "Debug symbols are the usual source — check that the strip step ran before signing."
                )
    print("Bundle carries no build-machine path (the archive gets audited again at package time)")


ENTITLEMENTS = HERE / "Perch" / "Perch.entitlements"


def sign_adhoc(app: Path) -> None:
    """Ad-hoc sign the built product, carrying the entitlements.

    Why signing happens here and not in Xcode: as soon as a target declares
    the app-group entitlement, Xcode demands a provisioning profile to build
    at all — there is no build setting that bypasses it. And with a group name
    that carries no Team prefix, that profile cannot be registered in the
    developer portal in the first place.

    So the split is: **Xcode only compiles; the installer signs.** The upside:
    anyone who wants to hack on the code needs zero Apple accounts configured.
    An ad-hoc signature still carries entitlements: sandbox + app-group
    container I/O work, and a signature without the app-group entitlement gets
    denied by the sandbox on the spot.

    One signature, because the bundle is one program. An embedded extension
    would have to be signed FIRST — signing the app seals everything
    under Contents/, PlugIns included — and that ordering rule is gone with it.
    """
    run(["codesign", "--force", "--sign", "-",
         "--entitlements", str(ENTITLEMENTS), str(app)], check=True)


def development_team() -> str | None:
    """The signing Team ID for this machine, or None.

    Read from the gitignored Config.xcconfig at run time — the Team ID is
    never written into this script, because it links to a real developer
    account and this file ships. Returns None when the file is absent or still
    holds the template placeholder: that is the public-user case, and the build
    stays ad-hoc + prefix-free.
    """
    if not CONFIG.is_file():
        return None
    for raw in CONFIG.read_text().splitlines():
        line = raw.split("//", 1)[0].strip()   # xcconfig comments are //
        if line.startswith("DEVELOPMENT_TEAM"):
            _, _, value = line.partition("=")
            value = value.strip()
            if value and value != "YOUR_TEAM_ID":
                return value
    return None


def _certificate_team(pem: str) -> str | None:
    """The Organizational Unit of one PEM certificate — the field codesign
    stamps into the binary as its TeamIdentifier."""
    subject = subprocess.run(["openssl", "x509", "-noout", "-subject"],
                             input=pem, capture_output=True, text=True).stdout
    ou = re.search(r"OU\s*=\s*([A-Z0-9]{10})", subject)
    return ou.group(1) if ou else None


def signing_identity(team: str) -> str:
    """The SHA-1 of a codesigning identity whose certificate BELONGS to `team`.

    ⚠️ Matched on the certificate's Organizational Unit — the field codesign
    turns into the binary's TeamIdentifier, which is what decides the App Group
    container's prefix — NOT on the identity's display name. The name's
    parenthetical can be a different id (an enrolment/agent team); matching it
    would sign with the wrong team and the container would come out under the
    wrong prefix — a fresh, empty folder beside the real one. The Team ID
    arrives from Config.xcconfig; no developer name or certificate hash is
    written here.
    """
    valid = set(re.findall(r"\b[0-9A-F]{40}\b", subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning"],
        capture_output=True, text=True).stdout))
    dump = subprocess.run(
        ["security", "find-certificate", "-a", "-Z", "-p", "-c", "Apple Development"],
        capture_output=True, text=True).stdout
    sha = None
    for block in re.split(r"(?m)^SHA-1 hash:\s*", dump):
        head = re.match(r"([0-9A-F]{40})", block)
        if not head:
            continue
        sha = head.group(1)
        cert = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
                         block, re.S)
        if sha in valid and cert and _certificate_team(cert.group(0)) == team:
            return sha
    raise SystemExit(
        f"Config.xcconfig names DEVELOPMENT_TEAM {team}, but no valid codesigning "
        "certificate for that team is in the keychain.\n"
        "Install the Apple Development certificate for that team, or clear "
        "DEVELOPMENT_TEAM to build ad-hoc — which moves the container to the "
        "prefix-free name (see --migrate-from)."
    )


def set_app_group(bundle_plist: Path, group: str) -> None:
    run(["/usr/libexec/PlistBuddy", "-c", f"Set :AppGroupID {group}",
         str(bundle_plist)], check=True)


def inject_team_prefix(app: Path, group: str) -> None:
    """Stamp the Team-prefixed App Group into the BUILT product's Info.plist.

    ⚠️ Why this is done to the product and not committed: the prefixed id names
    a real developer account. The committed plists stay prefix-free and
    identical for everyone; only this local build carries the prefix, exactly
    like the debug-strip step only touches the product.

    ⚠️ Why prefix at all, when nothing here reads an App Group from outside the
    app any more: a Team-signed build's container IS `<TeamID>.group.…`,
    and that is where this machine's ledger, event log and day scores already
    sit. Point Info.plist at the bare name instead and the island opens a
    different, empty folder — moving between the two shapes is what
    `--migrate-from` is for.
    """
    set_app_group(app / "Contents" / "Info.plist", group)


def _build_number(plist: Path) -> int:
    try:
        data = plistlib.loads(plist.read_bytes())
    except (OSError, plistlib.InvalidFileException):
        return 0
    try:
        return int(str(data.get("CFBundleVersion", "0")).split(".")[0])
    except ValueError:
        return 0


def _marketing_version(plist: Path) -> str:
    """The version a person reads, taken from the plist that was just built.

    Read rather than written in here: a literal in this file is a second place
    the product's version lives, and the second place is the one that goes
    stale. It did — the island shipped as `1.0.55` while everything around it
    had been calling the work 2.0 for weeks, because this function said `1.0.`
    and nobody looks at a working installer.
    """
    try:
        data = plistlib.loads(plist.read_bytes())
    except (OSError, plistlib.InvalidFileException):
        return "0"
    # Major.minor only: the build counter supplies the third component, and a
    # plist that already carries one (a re-read of an installed copy) must not
    # grow a fourth.
    return ".".join(str(data.get("CFBundleShortVersionString", "0")).split(".")[:2])


def bump_build_version(app: Path) -> str:
    """Give this local build a version nobody's macOS has seen before.

    The committed Info.plist says `CFBundleVersion 1` and always will, so
    without this every build on this machine would claim to be the same one.
    A counter that goes up is what lets anyone check afterwards WHICH build is
    sitting in /Applications:

        /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \\
            /Applications/Perch.app/Contents/Info.plist

    ⚠️ It was introduced for a sharper reason, worth keeping written down: macOS
    cached the desktop widget's descriptor per VERSION, so with the version
    frozen at 1 the gallery served the previous build's name and sizes while the
    fresh extension drew today's chart. There is no widget now; the version
    counter stays because "which build is installed" is still a question.

    Local-only, exactly like the Team-prefixed App Group: the committed plist
    keeps `1`. The number is a plain counter — no timestamp, nothing that says
    anything about this machine.
    """
    version = max(_build_number(INSTALLED / "Contents" / "Info.plist"),
                  _build_number(app / "Contents" / "Info.plist")) + 1
    plist = app / "Contents" / "Info.plist"
    marketing = _marketing_version(plist)
    run(["/usr/libexec/PlistBuddy", "-c", f"Set :CFBundleVersion {version}", str(plist)], check=True)
    run(["/usr/libexec/PlistBuddy", "-c", f"Set :CFBundleShortVersionString {marketing}.{version}",
         str(plist)], check=True)
    return f"{marketing}.{version}"


LSREGISTER = ("/System/Library/Frameworks/CoreServices.framework/Frameworks"
              "/LaunchServices.framework/Support/lsregister")


def stale_registrations(app: Path) -> list[Path]:
    """Every OTHER copy of this app that Launch Services still knows about."""
    dump = subprocess.run([LSREGISTER, "-dump"], capture_output=True, text=True).stdout
    found = re.findall(r"^\s*path:\s+(/\S.*?)\s+\(0x[0-9a-f]+\)\s*$", dump, re.MULTILINE)
    if not found:
        # A dump that yields nothing is a broken parse, not a clean machine —
        # the installed bundle is always in there.
        raise SystemExit("Could not read the Launch Services database; "
                         f"check `{LSREGISTER} -dump | grep path:` by hand.")
    ours = str(app.resolve())
    return [Path(p) for p in dict.fromkeys(found)
            if p != ours and Path(p).name == app.name]


def prune_stale_registrations(app: Path) -> None:
    """Unregister every other copy of this app, so the system can only read
    the one just installed.

    ⚠️ This is the bug that cost an afternoon. Every directory this app was ever
    BUILT in stays registered — a dozen `/tmp/...` build roots, Xcode's
    DerivedData, an old `build/Release` — all carrying the same bundle id, and
    macOS answers questions about "Perch" with whichever one it likes.
    Reinstalling could never fix that; the install was not the thing being read.

    Unregistering is reversible and touches no files — a copy that is launched
    again registers itself again. It only settles which one the system answers
    with right now, and after an install that has to be /Applications.
    """
    for path in stale_registrations(app):
        subprocess.run([LSREGISTER, "-u", str(path)], check=False)
        print(f"Unregistered an older copy: {path}")


def _prefixed_entitlements(committed: Path, group: str, into: Path) -> Path:
    """A local copy of `committed`'s entitlements with the app-group set to
    `group`, written into a temp dir — never the repo.

    Exactly like `inject_team_prefix` does to Info.plist: the Team-prefixed
    group names a real developer account, so the prefix touches only this local
    build, and the committed entitlement files stay prefix-free and identical
    for everyone.

    ⚠️ Why the entitlement needs the prefix at all — an earlier version got this
    wrong and it cost a day. The sandbox grants container access by the
    app-group ENTITLEMENT value, NOT by the TeamIdentifier. Sign with a
    prefix-free entitlement while Info.plist resolves the prefixed container and
    the two name different places: the sandbox admits the app to `group.x` while
    the app tries to open `<TeamID>.group.x`, so the socket bind and every write
    are denied — silently, swallowed by `try?`, the island glowing as if fine.
    Measured: prefix-free entitlement → the island cannot bind its socket;
    prefixed entitlement → it binds on the spot.
    """
    ent = plistlib.loads(committed.read_bytes())
    ent["com.apple.security.application-groups"] = [group]
    out = into / committed.name
    out.write_bytes(plistlib.dumps(ent))
    return out


def sign_with_identity(app: Path, identity: str, group: str) -> None:
    """Sign with a real signing identity, carrying entitlements whose app-group
    is `group` — the Team-prefixed container the build actually runs against.

    ⚠️ The entitlement MUST name the prefixed container (see
    `_prefixed_entitlements`); the committed files stay prefix-free for
    anonymity, so the prefixed copies are generated into a temp dir here and
    never committed. Info.plist (via `inject_team_prefix`) and this entitlement
    must name the SAME prefixed container, or the app resolves one place and is
    sandboxed into another.
    """
    with tempfile.TemporaryDirectory() as tmp:
        app_ent = _prefixed_entitlements(ENTITLEMENTS, group, Path(tmp))
        run(["codesign", "--force", "--sign", identity,
             "--entitlements", str(app_ent), str(app)], check=True)


def check_entitlement(app: Path, group: str) -> None:
    """The code signature must actually carry the app-group entitlement, for
    `group` — the id the build will run against (the Team-prefixed one on a
    machine that signs, the prefix-free base otherwise).

    **This gate blocks silent failure**: with the entitlement missing (or
    diverging from `group`), the sandbox denies the island its container —
    the socket bind fails silently in `AgentEventMonitor`, the event log's
    errors are swallowed by `try?`. The island glows as if everything were
    fine while every hook event falls into the void. That failure must be
    stopped at install time.

    ⚠️ **"The container path resolves" proves nothing**: macOS's
    `containerURL(forSecurityApplicationGroupIdentifier:)` does not validate
    membership and returns a path even for a made-up id. The only thing worth
    checking is what the signature actually carries.
    """
    # codesign prints the entitlements to stdout with a binary plist header
    # in the middle; grabbing the text is enough
    out = subprocess.run(["codesign", "-d", "--entitlements", "-", str(app)],
                         capture_output=True, text=True, errors="replace").stdout
    if "com.apple.security.application-groups" not in out:
        raise SystemExit(
            f"No app-group entitlement in {app.name}'s signature; installed like this it "
            "cannot reach its container, and everything that goes through it is lost:\n"
            f"{out[:800]}"
        )
    if group not in out:
        raise SystemExit(
            f"The App Group in {app.name}'s signature is not the one the build runs against.\n"
            f"   expected: {group}\n   signature says:\n{out[:800]}"
        )
    print(f"Entitlement check passed for {app.name}, AppGroup={group}")


def stop_running() -> None:
    """Stop everything before installing.

    Swapping the bundle under a running instance crashes it; and the island
    has a single-instance guard — the incumbent stays, the freshly installed
    one kills itself on start, which looks exactly like "installed but
    nothing happened".
    """
    for label in [LABEL, *(label for label, _ in stale_agents())]:
        subprocess.run(["launchctl", "bootout", f"{DOMAIN}/{label}"], capture_output=True)
    subprocess.run(["pkill", "-f", PROCESS_PATTERN], capture_output=True)
    time.sleep(1)


def bundle_id_of(app: Path) -> str | None:
    out = subprocess.run(
        ["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier",
         str(app / "Contents" / "Info.plist")],
        capture_output=True, text=True,
    ).stdout.strip()
    return out or None


def install_app(built: Path) -> None:
    """Replace /Applications/Perch.app — moving the old one aside, never
    deleting it first.

    Two rules, both about not destroying something that worked:

    · **Ownership.** `/Applications/Perch.app` is a name, not a proof; another
      app could hold that path. Compare bundle ids and refuse a stranger
      rather than delete it.
    · **Reversibility.** A plain delete-then-copy leaves the user with NO app
      if the copy fails. Moving aside within the same directory is instant and
      undoable, so a failed copy can put the working app straight back.
      (Later steps — migration, LaunchAgent — do not need this: by then the app
      is installed and openable, and rerunning the installer fixes them.)
    """
    ours = bundle_id_of(built)
    previous = None
    if INSTALLED.exists():
        existing = bundle_id_of(INSTALLED)
        if existing != ours:
            raise SystemExit(
                f"{INSTALLED} does not belong to us (bundle id {existing!r}, ours is {ours!r}).\n"
                "Refusing to replace someone else's app — move it aside yourself if that path is really free."
            )
        previous = INSTALLED.with_name(INSTALLED.name + ".previous")
        if previous.exists():
            shutil.rmtree(previous)
        os.replace(INSTALLED, previous)
    try:
        # ditto, not a merge copy: leftovers from an older version must not
        # survive inside the new bundle.
        run(["ditto", str(built), str(INSTALLED)], check=True)
    except BaseException:
        if previous is not None:
            if INSTALLED.exists():
                shutil.rmtree(INSTALLED)
            os.replace(previous, INSTALLED)
            print("Install failed; put the previous app back at", INSTALLED)
        raise
    if previous is not None:
        shutil.rmtree(previous)
    print("Installed to", INSTALLED)


def island_launch_agent_spec(app: Path, owner: Path = Path.home()) -> dict:
    """The island's own launchd job. Pure so tests inspect the real contract.

    ⚠️ The log paths are not a debugging convenience. Without them the island's
    standard error goes nowhere at all: a crash, a refused write, a Swift
    precondition — none of it can be read after the fact, by anyone. The
    reconciler beside it has had both paths since the day it was installed, and
    the difference was an oversight rather than a decision.
    """
    log_dir = owner / "Library" / "Logs" / "Perch"
    return {
        # Literals here, as in the reconciler's spec beside it: a contract that
        # reaches for module state cannot be lifted out and inspected on its own.
        "Label": "io.github.mossfinch.perch",
        "ProgramArguments": [str(app / "Contents/MacOS/Perch")],
        "RunAtLoad": True,
        # KeepAlive must be False. A manually quit island should stay quit;
        # and the single-instance guard makes a launchd-spawned copy kill
        # itself whenever an instance already runs — KeepAlive would turn that
        # into a start→exit→start flap until someone strangles it.
        "KeepAlive": False,
        "ProcessType": "Interactive",
        "StandardOutPath": str(log_dir / "perch.log"),
        "StandardErrorPath": str(log_dir / "perch-error.log"),
    }


def install_launch_agent() -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    # Old plists must be deleted; bootout alone is not enough — the file still
    # sits in LaunchAgents and gets loaded again at next login. The path comes
    # from the glob that found it, never rebuilt from the label.
    for _, stale in stale_agents():
        stale.unlink()
        print("Removed an old LaunchAgent pointing at the same app:", stale)
    spec = island_launch_agent_spec(INSTALLED)
    Path(spec["StandardOutPath"]).parent.mkdir(parents=True, exist_ok=True)
    with open(PLIST, "wb") as f:
        plistlib.dump(spec, f)
    print("Wrote", PLIST)
    subprocess.run(["launchctl", "bootout", f"{DOMAIN}/{LABEL}"], capture_output=True)
    run(["launchctl", "bootstrap", DOMAIN, str(PLIST)], check=True)   # RunAtLoad starts one right away


def reconciler_launch_agent_spec(group: str, owner: Path = Path.home()) -> dict:
    """The independent history job. Pure so tests inspect the real contract."""
    helper = owner / ".perch" / "bin" / "perch-reconcile"
    container = owner / "Library" / "Group Containers" / group
    output = owner / ".perch" / "reconciliation"
    log_dir = owner / "Library" / "Logs" / "Perch"
    return {
        # Literal here keeps this pure contract independently inspectable; the
        # install path below uses the matching module constant for launchctl.
        "Label": "io.github.mossfinch.perch.reconcile",
        "ProgramArguments": [
            "/usr/bin/python3",
            "-B",
            str(helper),
            "--out-dir",
            str(output),
            "--bridge-socket",
            str(container / "bridge.sock"),
            "--lookback-days",
            "7",
        ],
        "RunAtLoad": True,
        "StartInterval": 1800,
        "KeepAlive": False,
        "ProcessType": "Background",
        "StandardOutPath": str(log_dir / "reconcile.log"),
        "StandardErrorPath": str(log_dir / "reconcile-error.log"),
    }


def _atomic_install_file(source: Path, target: Path, mode: int) -> None:
    """Replace one Perch-owned file without exposing a half-copied script."""
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(source.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def install_reconciler(group: str) -> float:
    """Install and start the non-sandbox provider-history reader.

    This owns only `perch-reconcile` and its separate launchd label. The trusted
    `~/.perch/bin/perch-hook` launcher is intentionally outside every path here.
    """
    if not RECONCILER_SOURCE.is_file():
        raise SystemExit(f"Missing reconciler source: {RECONCILER_SOURCE}")
    if not Path("/usr/bin/python3").is_file():
        raise SystemExit("/usr/bin/python3 is unavailable; cannot schedule Perch history recovery")

    _atomic_install_file(RECONCILER_SOURCE, RECONCILER_BINARY, 0o755)
    spec = reconciler_launch_agent_spec(group)
    log_dir = Path(spec["StandardOutPath"]).parent
    log_dir.mkdir(parents=True, exist_ok=True)
    RECONCILER_PLIST.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{RECONCILER_PLIST.name}.", dir=str(RECONCILER_PLIST.parent))
    started_at = time.time()
    try:
        with os.fdopen(descriptor, "wb") as handle:
            plistlib.dump(spec, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, RECONCILER_PLIST)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    subprocess.run(
        ["launchctl", "bootout", f"{DOMAIN}/{RECONCILER_LABEL}"], capture_output=True)
    run(["launchctl", "bootstrap", DOMAIN, str(RECONCILER_PLIST)], check=True)
    print("Installed reconciler helper", RECONCILER_BINARY)
    print("Wrote", RECONCILER_PLIST)
    return started_at


def verify_reconciler(group: str, started_at: float, sleep=time.sleep) -> None:
    """Prove launchd produced a fresh, internally consistent formal cache."""
    output = Path.home() / "Library" / "Group Containers" / group / "reconciliation"
    health_path = output / "source-health.json"
    turns_path = output / "canonical-turns.jsonl"
    last_error = "output files did not appear"
    for _ in range(180):
        try:
            health = json.loads(health_path.read_text(encoding="utf-8"))
            generated = health.get("generated_at", "").replace("Z", "+00:00")
            generated_at = datetime.fromisoformat(generated).timestamp()
            if generated_at + 1 < started_at:
                last_error = f"health is stale ({health.get('generated_at')})"
                sleep(0.5)
                continue
            records = [json.loads(line) for line in turns_path.read_text(encoding="utf-8").splitlines()]
            record_ids = [record.get("record_id") for record in records]
            if len(record_ids) != len(set(record_ids)):
                raise ValueError("canonical cache contains duplicate record_id values")
            if any(record.get("reconstructed") is not True for record in records):
                raise ValueError("canonical cache contains a turn not marked reconstructed")
            if set(health.get("sources", {})) != {"codex", "claude"}:
                raise ValueError("health does not carry independent codex and claude sources")
            print(
                "Reconciler verified",
                f"generated_at={health['generated_at']}",
                f"turns={len(records)}",
                f"alerts={len(health.get('alerts', []))}",
            )
            return
        except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            last_error = str(error)
            sleep(0.5)
    raise SystemExit(f"Reconciler did not publish a valid fresh cache: {last_error}")


def verify() -> None:
    time.sleep(2)
    out = subprocess.run(["pgrep", "-f", PROCESS_PATTERN], capture_output=True, text=True)
    pids = out.stdout.split()
    if len(pids) != 1:
        raise SystemExit(f"Expected exactly 1 island running, found {len(pids)}: {pids}")
    exe = subprocess.run(["ps", "-o", "command=", "-p", pids[0]],
                         capture_output=True, text=True).stdout.strip()
    if not exe.startswith(str(INSTALLED)):
        raise SystemExit(f"The running one is not the freshly installed one: {exe}")
    print(f"Running: pid={pids[0]} {exe}")


def verify_socket(group: str, sock: Path | None = None, probe=None, sleep=time.sleep) -> None:
    """Prove the event path works end to end.

    "A process is running" is not enough. Creating the container directory,
    binding, and listening all fail SILENTLY inside the island (a failed bind
    is a bare return), and then every hook push lands in the void while the
    island sits there glowing as if all were well. That is exactly the failure
    this installer exists to catch, so connect for real.

    ⚠️ **Retry the CONNECT, never wait on the file.** A socket file may well be
    the leftover of the instance we just killed — `pkill` gives it no chance to
    unlink its own — so "the file is there" answers nothing about whether
    anyone is listening. Waiting on the file and connecting once fails on the
    single most common path: every reinstall, where the fresh island unlinks
    that leftover and rebinds a moment later.

    The probe sends an event name the island does not know. Unknown events are
    ignored by the receiver, so this exercises the whole path — container
    reachable, socket bound, message delivered — without lighting up a status
    dot or writing a line to the event log.

    `sock` and `probe` are injectable for tests; normal calls pass neither.
    """
    sock = sock or (Path.home() / "Library" / "Group Containers" / group / "bridge.sock")
    probe = probe or (lambda: subprocess.run(
        ["/usr/bin/nc", "-U", "-w", "2", str(sock)],
        input="perch-installer-probe\t/\t0-0\tinstaller",
        text=True, capture_output=True,
    ).returncode)

    for attempt in range(20):          # ~10s, the island binds shortly after launch
        if probe() == 0:
            print("Socket verified", sock)
            return
        sleep(0.5)

    # Out of patience: say which of the two failures it is, because they send
    # you looking in completely different places.
    if not sock.is_socket():
        raise SystemExit(
            f"The island is running but never bound its socket:\n   {sock}\n"
            "So it cannot reach its App Group container, and every hook event would be lost "
            "silently. Check the entitlement in the signature and the container's permissions."
        )
    raise SystemExit(
        f"The socket file is there but nothing accepts connections:\n   {sock}\n"
        "Either the island died right after launch, or the file is a leftover nobody owns. "
        "Check Console.app for Perch, then reinstall."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the notch island, install into /Applications, set up launch-at-login.")
    parser.add_argument(
        "--migrate-from", metavar="OLD_APP_GROUP",
        help="Move the care ledger from this old App Group container into the new one. "
             "Only needed after changing the App Group name, and only once "
             "(refuses if the target already has a ledger; never overwrites).",
    )
    opts = parser.parse_args()

    built = build()
    strip_debug_symbols(built)  # before signing: stripping the executable invalidates the signature
    # Before signing too — the signature seals Info.plist, and this edits it.
    version = bump_build_version(built)

    # `base` — the repo's prefix-free group, read from the product BEFORE any
    # prefix injection (app_group_of still enforces the prefix-free shape). This
    # is the value the entitlement (and thus the signature) carries.
    base = app_group_of(built)
    team = development_team()
    # `container` — the folder the build will actually read and write: on a
    # signing machine the App Group container is `<TeamID>.<base>`. That
    # prefixed name has to appear in BOTH places that decide where the app looks
    # and what the sandbox permits: Info.plist (so AppGroup.swift resolves it)
    # AND the entitlement (so the sandbox admits the app to it). Without a team
    # the container is just `base`. The prefix never appears in the repo — only
    # in this local product's Info.plist and in the temp entitlement used to
    # sign it.
    container = f"{team}.{base}" if team else base

    if team:
        # Sign with the team's certificate and point BOTH Info.plist and the
        # entitlement at the prefixed container. Info.plist decides where
        # AppGroup.swift looks; the entitlement decides where the sandbox lets
        # it in — name different containers and the island resolves one place
        # but is denied it, so the socket never binds and every write is lost.
        identity = signing_identity(team)
        inject_team_prefix(built, container)   # patch the product's Info.plist
        sign_with_identity(built, identity, container)   # and the (temp, uncommitted) entitlement
        print(f"Signed for team {team}; container {container}.")
    else:
        print(
            "\n⚠️  No DEVELOPMENT_TEAM in Config.xcconfig: building ad-hoc, prefix-free.\n"
            "    The menu-bar island works. ⚠️ But its container is then the bare\n"
            f"    {base} rather than <TeamID>.{base} — a DIFFERENT folder,\n"
            "    so a machine that has been running signed builds would start from an\n"
            "    empty ledger. See --migrate-from before switching modes.\n")
        sign_adhoc(built)

    # The signature carries the entitlement for `container` — prefixed on a
    # signing machine, plain `base` ad-hoc (there container == base). Checking
    # `container` is checking that the signature really names the same place
    # Info.plist points at; a mismatch here is precisely the silent-write bug.
    check_entitlement(built, container)   # must re-check after signing: entitlement missing = island glows but receives nothing
    verify_shipped_bytes(built)   # no other guard scans the bundle, and the bundle is what ships
    stop_running()
    install_app(built)
    if opts.migrate_from:
        # Must run before the island starts: a running island may write a
        # record at any moment, and once the target file exists the migration
        # can never run again
        print(migrate_ledger(opts.migrate_from, container))
    install_launch_agent()
    verify()
    verify_socket(container)      # the process being up proves nothing; the socket does
    reconciler_started_at = install_reconciler(container)
    verify_reconciler(container, reconciler_started_at)
    prune_stale_registrations(INSTALLED)     # ...and every build directory this app ever lived in is still on the books
    print(f"Installed build {version}.")
    print("\nDone. From now on: starts at login; to open manually, double-click Perch in /Applications.")


if __name__ == "__main__":
    main()
