#!/usr/bin/env python3
"""Install the notch island as an everyday app: double-clickable in
/Applications, back automatically after every reboot.

Without this step the island only lives in a DerivedData debug build: gone on
reboot, startable only by running xcodebuild in a terminal and `open`ing the
product. Without an installed form, the island does not exist after a restart.

Three things happen here:
  1. Release build, ad-hoc signing (the same as a download), and a check of
     what the signature really carries.
  2. Install into /Applications/Perch.app (admin-writable, no sudo)
  3. Write a LaunchAgent under ~/Library/LaunchAgents, start one now, and
     verify the island actually bound its socket

Why the signature check: without the socket rule in the signature the app
still runs, but the sandbox refuses the bind. Every event the hooks push is
lost. The card says so, but only to someone looking at it, so it is caught
here at install time.

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

# Every path resolves relative to the script's own directory; never guess where
# the repo root is. This directory is the root in the Perch repo, and it may be
# nested at any depth inside another repo, where parents[N]-style level counting
# points into outer space the moment the layout changes.
HERE = Path(__file__).resolve().parent
# Build with the island's own project file. Other project files may sit right
# next to it; they are not this script's business.
PROJECT = HERE / "Perch.xcodeproj"
SCHEME = "Perch"
# Everything the island keeps: socket, event log, care ledger, day scores.
# Perch/DataHome.swift names the same folder, and says why it is not an App
# Group container; perch-hook.sh and island-day-report.py hard-code it too.
ISLAND_DIR = Path.home() / ".perch" / "island"
SOCKET = ISLAND_DIR / "bridge.sock"
# The App Group the island used to live in, `<TeamID>.` prefixed on a machine
# that signed with a team. Only the migration below still looks for it.
OLD_GROUP = "group.io.github.mossfinch.perch"
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

    Recognized by what they point at, not by name: labels can be renamed, and
    a hard-coded list of old names both misses even older versions and keeps
    the old names in the source forever.

    The real file path travels with the label. A plist's file name and its
    internal `Label` need not match, so rebuilding the path as `<Label>.plist`
    can delete a stranger's file or silently miss the one that needs removing.
    Only paths that came from this glob (direct children of LaunchAgents,
    symlinks skipped) are ever unlinked.

    Left in place, two LaunchAgents pointing at the same app make launchd
    start one copy each; one hits the single-instance guard, kills itself and
    is relaunched, a start→exit→start flap.
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


def ledger_records(path: Path) -> list:
    """Parse a ledger the way the island's decoder will, and return its records.

    Counting `records` is not enough. A JSON-legal file with the wrong shape
    would migrate cleanly and then make the island throw on its next launch
    (the reader deliberately refuses to treat "unreadable" as "empty"), so a
    count-only check just moves the failure into the new home. Validate
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


MIGRATED = ("care-ledger.json", "day-scores.jsonl", "agent-events", "flow-corrections")


def old_containers(root: Path | None = None) -> list[Path]:
    """The App Group containers this island used to live in that still hold data.

    Matched on the island's own group id, bare or with any `<TeamID>.` in
    front, so no Team ID is written here and no other app's container matches.
    """
    root = root or (Path.home() / "Library" / "Group Containers")
    if not root.is_dir():
        return []
    found = []
    for entry in sorted(root.iterdir()):
        if entry.is_symlink() or not entry.is_dir():
            continue
        if entry.name != OLD_GROUP and not entry.name.endswith("." + OLD_GROUP):
            continue
        if any((entry / name).exists() for name in MIGRATED):
            found.append(entry)
    return found


def migrate_island_data(source: Path, island: Path | None = None) -> str:
    """Copy the island's history out of an old App Group container into
    `~/.perch/island`. A person names the source; the machine guesses nothing,
    because two old containers can both hold data (a team-signed one and a
    bare one from an ad-hoc run) and only the person knows which is theirs.

    Rules:
      1. Anything already at the target: refuse, and copy nothing. Even one
         record there is real data and not ours to overwrite.
      2. A symlink anywhere: the target folder itself, an item, or anything
         inside the two folders. Following one writes data where nobody
         expects it, and a copied link still points at the old place.
      3. A ledger that does not parse: refuse. The island refuses to treat an
         unreadable ledger as empty, so moving one moves the failure.
      4. Copy every item to `<name>.migrating` first, then rename them all,
         and undo the renames if one fails. A failure at either step leaves
         nothing at the target, never a half file the island would read or a
         partial set a rerun would refuse.

    Copies; the source stays where it was. `island` is for tests only.
    """
    island = island or ISLAND_DIR
    if source.is_symlink() or not source.is_dir():
        raise SystemExit(f"Not a container directory: {source}")
    if island.is_symlink():
        raise SystemExit(f"{island} is a symbolic link; refusing to write through it.")
    # is_symlink too: a dangling link's exists() is False, and skipping it
    # quietly would hide exactly the case rule 2 refuses.
    items = [name for name in MIGRATED if (source / name).exists() or (source / name).is_symlink()]
    if not items:
        raise SystemExit(f"Nothing to migrate in {source}")
    for name in items:
        # Inside the two folders too: a copied link points wherever it pointed,
        # so the "copy" would keep writing into the old place, or dangle.
        for path in [source / name, *((source / name).rglob("*") if (source / name).is_dir() else [])]:
            if path.is_symlink():
                raise SystemExit(f"{path} is a symbolic link; refusing to follow it.")
        target = island / name
        if target.is_symlink() or target.exists():
            raise SystemExit(
                f"{target} already exists; not overwriting, and nothing was copied.\n"
                "   Move it aside first if the old container's copy is the one to keep, then rerun.")
        staging = island / (name + ".migrating")
        if staging.is_symlink() or staging.exists():
            raise SystemExit(f"Something is already in the way at {staging}. Remove it and rerun.")
    ledger = source / "care-ledger.json"
    records = None
    if ledger.exists():
        try:
            records = len(ledger_records(ledger))
        except Exception as exc:
            raise SystemExit(
                f"Old ledger does not parse; refusing to move it (the island could not read it either):\n"
                f"   {ledger}\n   {exc}")
    island.mkdir(parents=True, exist_ok=True)
    os.chmod(island, 0o700)   # owner-only, as the island itself keeps it (DataHome.swift)
    # Everything is copied before anything is put in place: a failure halfway
    # through must leave no item at the target, or the rerun would refuse
    # on the items that did land.
    staged = []
    try:
        for name in items:
            staging = island / (name + ".migrating")
            staged.append(staging)
            if (source / name).is_dir():
                shutil.copytree(source / name, staging, symlinks=True)
            else:
                shutil.copy2(source / name, staging)
    except BaseException:
        for staging in staged:
            if staging.is_dir() and not staging.is_symlink():
                shutil.rmtree(staging, ignore_errors=True)
            else:
                staging.unlink(missing_ok=True)
        raise
    # Then put them in place, and take back whatever landed if one rename
    # fails, so a rerun finds nothing in its way.
    placed = []
    try:
        for name in items:
            os.replace(island / (name + ".migrating"), island / name)
            placed.append(name)
    except BaseException:
        for name in placed:
            os.replace(island / name, island / (name + ".migrating"))
        for name in items:
            staging = island / (name + ".migrating")
            if staging.is_dir() and not staging.is_symlink():
                shutil.rmtree(staging, ignore_errors=True)
            else:
                staging.unlink(missing_ok=True)
        raise
    ledger_note = f", ledger {records} records" if records is not None else ""
    return f"Copied {', '.join(items)} (source kept{ledger_note}):\n   {source}\n-> {island}"


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
    `xcodebuild build` never runs the strip phase, so the product keeps a full
    copy anyway, and a DWARF file table is a list of absolute source paths. On
    a builder's machine that is a username and a repo name, printed into every
    binary anyone downloads.

    Stripping edits the executable, so it must run before signing; run after,
    it invalidates the signature just made.

    One Mach-O, because the bundle holds one program: there is no app extension
    in PlugIns/ and nothing here signs one. Anything that still carried those
    paths would be caught by `verify_shipped_bytes`.
    """
    run(["strip", "-S", str(app / EXEC_SUBPATH)], check=True)


def verify_shipped_bytes(app: Path) -> None:
    """No file in the bundle may carry a path from the machine that built it.

    Every other guard here scans the repository: the manifest decides which
    files ship and the privacy test scans those. The compiled bundle is in none
    of that, and it is closer to what a stranger downloads than anything the
    repository holds. So the check lives next to the step that produces it.

    The needle is the shape `/Users/`, never one particular username: someone
    building on their own machine should not ship their path either, and a
    check that a rename defeats is not a check.

    This is the early warning, not the last word. It walks the bundle, and the
    debug symbols that carry those paths live beside the bundle as siblings
    (`Perch.app.dSYM`, `Perch.swiftmodule`), where this cannot reach them. What
    ships is the archive, so the authoritative audit is in `package-release.py`,
    which opens the finished zip. Catching it here means finding out at build
    time instead of at package time.
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

    Every build is signed this way, the one installed here as much as the one
    that ships, so what runs on the builder's Mac is what a download runs. A
    second signing path would be a second thing to drift.

    Xcode only compiles (`CODE_SIGNING_ALLOWED = NO`) and this signs, so
    anyone who wants to hack on the code needs no Apple account configured.

    One signature, because the bundle is one program. An embedded extension
    would have to be signed first, since signing the app seals everything under
    Contents/, PlugIns included.
    """
    run(["codesign", "--force", "--sign", "-",
         "--entitlements", str(ENTITLEMENTS), str(app)], check=True)


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

    Read, never written in here: a literal in this file would be a second place
    the product's version lives, and the second place is the one that goes
    stale, because nobody looks at a working installer.
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
    A counter that goes up lets anyone check afterwards which build is sitting
    in /Applications:

        /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \\
            /Applications/Perch.app/Contents/Info.plist

    It also matters to macOS itself, which caches an app extension's
    descriptor per version: with the version frozen at 1, a widget gallery
    served the previous build's name and sizes.

    Local-only: the committed plist keeps `1`. The number is a plain counter, with no timestamp and nothing that says
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
    """Every other copy of this app that Launch Services still knows about."""
    dump = subprocess.run([LSREGISTER, "-dump"], capture_output=True, text=True).stdout
    found = re.findall(r"^\s*path:\s+(/\S.*?)\s+\(0x[0-9a-f]+\)\s*$", dump, re.MULTILINE)
    if not found:
        # A dump that yields nothing is a broken parse, not a clean machine:
        # the installed bundle is always in there.
        raise SystemExit("Could not read the Launch Services database; "
                         f"check `{LSREGISTER} -dump | grep path:` by hand.")
    ours = str(app.resolve())
    return [Path(p) for p in dict.fromkeys(found)
            if p != ours and Path(p).name == app.name]


def prune_stale_registrations(app: Path) -> None:
    """Unregister every other copy of this app, so the system can only read
    the one just installed.

    Every directory this app was ever built in stays registered (`/tmp/...`
    build roots, Xcode's DerivedData, an old `build/Release`), all carrying the
    same bundle id, and macOS answers questions about "Perch" with whichever
    one it likes. Reinstalling cannot fix that, because the install is not the
    copy being read.

    Unregistering is reversible and touches no files: a copy that is launched
    again registers itself again. It only settles which one the system answers
    with right now, and after an install that has to be /Applications.
    """
    for path in stale_registrations(app):
        subprocess.run([LSREGISTER, "-u", str(path)], check=False)
        print(f"Unregistered an older copy: {path}")


SOCKET_RULE = '(allow network-bind (local unix-socket (subpath (string-append (param "_HOME") "/.perch/island"))))'
# The whole of what the signature may carry. Exact, not "contains": one extra
# sandbox rule such as `(allow network*)` would pass a presence check and quietly
# undo the sandbox.
EXPECTED_ENTITLEMENTS = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.temporary-exception.files.home-relative-path.read-write":
        ["/.claude/", "/.codex/", "/.perch/"],
    "com.apple.security.temporary-exception.sbpl": [SOCKET_RULE],
}


def check_entitlements(app: Path) -> None:
    """What the signature actually carries, not what the repo file says.

    Three ways this goes wrong, each silent at run time:
      · no socket rule: the sandbox refuses the bind, and no hook event
        arrives (the card says so, but only after install);
      · an App Group: the macOS prompt on every launch is back;
      · any network entitlement, or any extra sandbox rule or key: Perch
        promises it never goes online, and the sandbox is what keeps that
        promise. So the whole set is compared, not just the parts we want.
    """
    out = subprocess.run(["codesign", "-d", "--entitlements", "-", "--xml", str(app)],
                         capture_output=True)
    try:
        ent = plistlib.loads(out.stdout)
    except Exception:
        raise SystemExit(f"Could not read the entitlements in {app.name}'s signature:\n"
                         f"{out.stdout[:400]!r}\n{out.stderr[:400]!r}")
    problems = []
    if ent.get("com.apple.security.app-sandbox") is not True:
        problems.append("the sandbox is off")
    if ent.get("com.apple.security.temporary-exception.sbpl") != [SOCKET_RULE]:
        problems.append("the sandbox rules are not exactly the one that lets the socket bind in ~/.perch/island")
    if "com.apple.security.application-groups" in ent:
        problems.append("it still declares an App Group")
    network = [key for key in ent if key.startswith("com.apple.security.network.")]
    if network:
        problems.append("it asks for network access: " + ", ".join(network))
    folders = ent.get("com.apple.security.temporary-exception.files.home-relative-path.read-write")
    if folders != EXPECTED_ENTITLEMENTS["com.apple.security.temporary-exception.files.home-relative-path.read-write"]:
        problems.append(f"the folders it may write are not exactly ~/.claude, ~/.codex and ~/.perch: {folders}")
    extra = sorted(set(ent) - set(EXPECTED_ENTITLEMENTS) - {"com.apple.security.application-groups"}
                   - {key for key in ent if key.startswith("com.apple.security.network.")})
    if extra:
        problems.append("it carries entitlements nothing here expects: " + ", ".join(extra))
    if problems:
        raise SystemExit(f"{app.name}'s signature is wrong: " + "; ".join(problems) + ".")
    print(f"Entitlement check passed for {app.name}")


def stop_running() -> None:
    """Stop everything before installing.

    Swapping the bundle under a running instance crashes it, and the island
    has a single-instance guard: the incumbent stays and the freshly installed
    one kills itself on start, which looks exactly like "installed but nothing
    happened".
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
    """Replace /Applications/Perch.app, moving the old one aside and never
    deleting it first.

    Two rules, both about not destroying something that worked:

    - Ownership. `/Applications/Perch.app` is a name, not a proof; another app
      could hold that path. Compare bundle ids and refuse a stranger rather
      than delete it.
    - Reversibility. A plain delete-then-copy leaves the user with no app if
      the copy fails. Moving aside within the same directory is instant and
      undoable, so a failed copy can put the working app straight back.
      (Later steps, migration and the LaunchAgent, do not need this: by then
      the app is installed and openable, and rerunning the installer fixes
      them.)
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

    The log paths are not a debugging convenience. Without them the island's
    standard error goes nowhere at all: a crash, a refused write, a Swift
    precondition, none of it can be read after the fact, by anyone. The
    reconciler beside it logs to the same place.
    """
    log_dir = owner / "Library" / "Logs" / "Perch"
    return {
        # Literals here, as in the reconciler's spec beside it: a contract that
        # reaches for module state cannot be lifted out and inspected on its own.
        "Label": "io.github.mossfinch.perch",
        "ProgramArguments": [str(app / "Contents/MacOS/Perch")],
        "RunAtLoad": True,
        # Restart only after an unclean exit. macOS kills apps on its own (to
        # purge their caches when the disk runs low, for one), and with no
        # restart the notch stays empty until someone notices. A clean exit
        # is left alone: a manual quit should stay quit, and the
        # single-instance guard exits cleanly when another copy already runs,
        # so a plain KeepAlive would turn it into a start→exit→start flap.
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Interactive",
        "StandardOutPath": str(log_dir / "perch.log"),
        "StandardErrorPath": str(log_dir / "perch-error.log"),
    }


def install_launch_agent() -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    # Old plists must be deleted; bootout alone is not enough, because the file
    # still sits in LaunchAgents and gets loaded again at next login. The path comes
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


def reconciler_launch_agent_spec(owner: Path = Path.home()) -> dict:
    """The independent history job. Pure so tests inspect the real contract."""
    helper = owner / ".perch" / "bin" / "perch-reconcile"
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
            str(owner / ".perch" / "island" / "bridge.sock"),
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


def install_reconciler() -> float:
    """Install and start the non-sandbox provider-history reader.

    This owns only `perch-reconcile` and its separate launchd label. The trusted
    `~/.perch/bin/perch-hook` launcher is intentionally outside every path here.
    """
    if not RECONCILER_SOURCE.is_file():
        raise SystemExit(f"Missing reconciler source: {RECONCILER_SOURCE}")
    if not Path("/usr/bin/python3").is_file():
        raise SystemExit("/usr/bin/python3 is unavailable; cannot schedule Perch history recovery")

    _atomic_install_file(RECONCILER_SOURCE, RECONCILER_BINARY, 0o755)
    spec = reconciler_launch_agent_spec()
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


def verify_reconciler(started_at: float, sleep=time.sleep) -> None:
    """Prove launchd produced a fresh, internally consistent formal cache."""
    output = ISLAND_DIR / "reconciliation"
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


def verify_socket(sock: Path | None = None, probe=None, sleep=time.sleep) -> None:
    """Prove the event path works end to end.

    "A process is running" is not enough. If the bind fails, every hook push
    is lost; the card says so, but only to someone looking at it. This
    installer is the one place that can stop and say it at install time, so
    connect for real.

    Retry the connect, never wait on the file. A socket file may be the
    leftover of the instance we just killed (`pkill` gives it no chance to
    unlink its own), so "the file is there" says nothing about whether anyone
    is listening. Waiting on the file and connecting once fails on the most
    common path: every reinstall, where the fresh island unlinks that leftover
    and rebinds a moment later.

    The probe sends an event name the island does not know. Unknown events are
    ignored by the receiver, so this exercises the whole path (container
    created, socket bound, message delivered) without lighting up a status
    dot or writing a line to the event log.

    `sock` and `probe` are injectable for tests; normal calls pass neither.
    """
    sock = sock or SOCKET
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
            "Every hook event would be lost. The card should say why; "
            "check the socket rule in the signature (check_entitlements) and ~/.perch/island's permissions."
        )
    raise SystemExit(
        f"The socket file is there but nothing accepts connections:\n   {sock}\n"
        "Either the island died right after launch, or the file is a leftover nobody owns. "
        "Check Console.app for Perch, then reinstall."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the notch island, install into /Applications, set up launch-at-login.")
    parser.add_argument(
        "--migrate-from", metavar="OLD_CONTAINER", type=Path,
        help="Copy the island's history (ledger, event log, day scores, corrections) out of this "
             "old App Group container into ~/.perch/island. Only needed once, after upgrading "
             "from a version that kept it there; refuses if ~/.perch/island already has any of it.",
    )
    opts = parser.parse_args()

    built = build()
    strip_debug_symbols(built)  # before signing: stripping the executable invalidates the signature
    # Before signing too: the signature seals Info.plist, and this edits it.
    version = bump_build_version(built)
    sign_adhoc(built)
    check_entitlements(built)   # what the signature carries, not what the repo file says
    verify_shipped_bytes(built)   # no other guard scans the bundle, and the bundle is what ships
    stop_running()
    install_app(built)
    if opts.migrate_from:
        # Must run before the island starts: a running island may write a
        # record at any moment, and once a target exists the migration refuses
        print(migrate_island_data(opts.migrate_from))
    else:
        # Never guessed (see migrate_island_data), but never silent either:
        # an island starting on an empty folder looks like history vanishing.
        left = [c for c in old_containers() if not any((ISLAND_DIR / n).exists() for n in MIGRATED)]
        if left:
            print("\n⚠️  History from an older version is still in:")
            for c in left:
                print("   ", c)
            print("   To bring it over: python3 install-island-app.py --migrate-from <that path>\n")
    install_launch_agent()
    verify()
    verify_socket()      # the process being up proves nothing; the socket does
    reconciler_started_at = install_reconciler()
    verify_reconciler(reconciler_started_at)
    prune_stale_registrations(INSTALLED)     # ...and every build directory this app ever lived in is still on the books
    print(f"Installed build {version}.")
    print("\nDone. From now on: starts at login; to open manually, double-click Perch in /Applications.")


if __name__ == "__main__":
    main()
