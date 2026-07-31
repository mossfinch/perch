#!/usr/bin/env python3
"""Install the notch island as an everyday app: double-clickable in
/Applications, back automatically after every reboot.

Without this step the island only lives in a DerivedData debug build — gone on
reboot, startable only by running xcodebuild in a terminal and `open`ing the
product. That is not an inconvenience: without an installed form, the island
simply does not exist after a restart.

Three things happen here:
  1. Release build, ad-hoc signing, and a check that the app-group
     entitlement really made it into the signature
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
import shutil
import subprocess
import sys
import time
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
    """
    run(["codesign", "--force", "--sign", "-",
         "--entitlements", str(ENTITLEMENTS), str(app)], check=True)


def check_entitlement(app: Path) -> None:
    """The code signature must actually carry the app-group entitlement, for
    the same group Info.plist declares.

    **This gate blocks silent failure**: with the entitlement missing (or
    diverging from Info.plist), the sandbox denies the island its container —
    the socket bind fails silently in `AgentEventMonitor`, the event log's
    errors are swallowed by `try?`. The island glows as if everything were
    fine while every hook event falls into the void. That failure must be
    stopped at install time.

    ⚠️ **"The container path resolves" proves nothing**: macOS's
    `containerURL(forSecurityApplicationGroupIdentifier:)` does not validate
    membership and returns a path even for a made-up id. The only thing worth
    checking is what the signature actually carries.
    """
    group = app_group_of(app)
    # codesign prints the entitlements to stdout with a binary plist header in
    # the middle; grabbing the text is enough
    out = subprocess.run(["codesign", "-d", "--entitlements", "-", str(app)],
                         capture_output=True, text=True, errors="replace").stdout
    if "com.apple.security.application-groups" not in out:
        raise SystemExit(
            "No app-group entitlement in the signature; installed like this, the island "
            "cannot reach its container and every hook event is lost:\n"
            f"{out[:800]}"
        )
    if group not in out:
        raise SystemExit(
            f"The App Group in the signature does not match Info.plist.\n"
            f"   Info.plist: {group}\n   signature says:\n{out[:800]}"
        )
    print(f"Entitlement check passed, AppGroup={group}")


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


def install_launch_agent() -> None:
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    # Old plists must be deleted; bootout alone is not enough — the file still
    # sits in LaunchAgents and gets loaded again at next login. The path comes
    # from the glob that found it, never rebuilt from the label.
    for _, stale in stale_agents():
        stale.unlink()
        print("Removed an old LaunchAgent pointing at the same app:", stale)
    spec = {
        "Label": LABEL,
        "ProgramArguments": [str(INSTALLED / EXEC_SUBPATH)],
        "RunAtLoad": True,
        # KeepAlive must be False. A manually quit island should stay quit;
        # and the single-instance guard makes a launchd-spawned copy kill
        # itself whenever an instance already runs — KeepAlive would turn that
        # into a start→exit→start flap until someone strangles it.
        "KeepAlive": False,
        "ProcessType": "Interactive",
    }
    with open(PLIST, "wb") as f:
        plistlib.dump(spec, f)
    print("Wrote", PLIST)
    subprocess.run(["launchctl", "bootout", f"{DOMAIN}/{LABEL}"], capture_output=True)
    run(["launchctl", "bootstrap", DOMAIN, str(PLIST)], check=True)   # RunAtLoad starts one right away


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
    sign_adhoc(built)
    check_entitlement(built)   # must re-check after signing: entitlement missing = island glows but receives nothing
    stop_running()
    install_app(built)
    if opts.migrate_from:
        # Must run before the island starts: a running island may write a
        # record at any moment, and once the target file exists the migration
        # can never run again
        print(migrate_ledger(opts.migrate_from, app_group_of(INSTALLED)))
    install_launch_agent()
    verify()
    verify_socket(app_group_of(INSTALLED))   # the process being up proves nothing; the socket does
    print("\nDone. From now on: starts at login; to open manually, double-click Perch in /Applications.")


if __name__ == "__main__":
    main()
