#!/usr/bin/env python3
"""Wire codex into Perch: blue (working) / yellow (waiting on you) / green (done).

Why ~/.codex/hooks.json rather than config.toml's notify:
  · codex's hooks system has events with the same names and meanings as
    Claude Code's, and all three states are available; notify fires only once
    per finished turn — at best a completion bell.
  · The notify slot is often chained through by other tools — messy, but not
    ours to touch.

Three iron rules (not tidiness — breaking them breaks OTHER PEOPLE'S hooks):
  1. **Append at the end of the array only; never insert, never reorder.**
     codex stores a `trusted_hash` per hook keyed by event+position (see the
     `state` section of hooks.json and `[hooks.state]` in config.toml). Shift
     a position and someone else's hash no longer matches — codex may refuse
     to run their hook.
  2. **On reinstall, replace our own entry in place — never delete-then-add.**
     Deletion shifts every later entry forward, wrecking their hashes the
     same way.
  3. **Touch no entry that is not Perch's.** This file usually also houses
     other tools' entries (bridge scripts, other frameworks' native hooks),
     and their order is tied to their trust hashes.

After installing, codex's next launch may ask "trust this new hook?" — that
click must come from the user; a script cannot answer it.

Transport: identical to the Claude side, one line pushed to the Unix socket in
the App Group container: `<event>\t<projectDir>\t<nonce>\t<source>`. The 4th
field (source) lets the island split codex and Claude into two rows (and fixes
"same directory, both agents fighting over one dot"). If the island is not
running, the connect fails and the hook exits 0 (fail-open) — codex is
unaffected.
"""
from __future__ import annotations   # so `X | None` annotations parse on macOS's stock python 3.9

import json
import re
import os
import shutil
import subprocess
import time

HOOKS = os.path.expanduser("~/.codex/hooks.json")


def app_group_id() -> str:
    """Read the App Group from the INSTALLED app's own Info.plist. Never
    hard-coded — a Team ID links to the registrant's real name.

    Read the installed app rather than source/config: the hooks push to the
    island that is actually running, and only its Info.plist is authoritative.
    If the island is not installed, error out — installing hooks that point at
    a nonexistent container installs a dud, and **the push failure is silent**
    (fail-open), nearly impossible to debug after the fact.
    """
    plist = "/Applications/Perch.app/Contents/Info.plist"
    if not os.path.exists(plist):
        raise SystemExit(
            f"{plist} not found. First run python3 install-island-app.py (same directory) "
            "to install the island, then install the hooks — the hook's socket path is "
            "read from the installed app."
        )
    out = subprocess.run(["/usr/libexec/PlistBuddy", "-c", "Print :AppGroupID", plist],
                         capture_output=True, text=True).stdout.strip()
    # Two shapes are accepted, mirroring AppGroup.swift:
    #   group.<suffix>            — the repo default, prefix-free
    #   <TeamID>.group.<suffix>   — install-island-app.py stamped a signing Team
    #                               ID into this machine's build so the faceless
    #                               desktop widget can read the container on
    #                               macOS 15+ (containermanagerd's TCC rule).
    # The socket lives in whichever container the installed app actually uses,
    # so the full value (prefix included) is what we return. A Team ID never
    # appears here as a literal — it rides in from the installed plist.
    # Strip an optional "<TeamID>." prefix, then the core must be group.<suffix>.
    core = out[out.index("group."):] if ".group." in out and not out.startswith("group.") else out
    if not core.startswith("group.") or not core.removeprefix("group."):
        raise SystemExit(f"Bad App Group in the installed app (got {out!r}); rebuild and reinstall.")
    return out


def container(group: str | None = None) -> str:
    """The App Group container directory.

    Resolved lazily, NOT at import time: the tests import this module to
    exercise the real matcher and upsert functions, and reading the installed
    app during import would make them depend on whether this machine happens
    to have Perch installed.
    """
    return os.path.expanduser(f"~/Library/Group Containers/{group or app_group_id()}")


def socket_path(group: str | None = None) -> str:
    return os.path.join(container(group), "bridge.sock")


def lastrun_path(group: str | None = None) -> str:
    return os.path.join(container(group), "codex-hook.lastrun")


# Ownership marker: **recognized by shape, not by the current App Group.**
#
# ⚠️ Never use a changeable value (like the current group id) as identity: the
# moment the container changes, old commands still carry the old id, stop
# being recognized as "ours", and can't be removed — old and new coexist,
# every hook runs twice, and one of the two can never connect (nobody listens
# on the old socket anymore).
#
# The island's own artifact names are stable across container changes; and
# other tools' commands never touch them (their bridge scripts live in their
# own home directories and never enter Group Containers).
OWN_ARTIFACTS = ("bridge.sock", "agent-event.txt", "codex-hook.lastrun", "codex-notify.lastrun")
ARTIFACT_PATTERN = re.compile(
    r"Group Containers/[^\"'\s]*/(?:" + "|".join(re.escape(a) for a in OWN_ARTIFACTS) + ")"
)
# ⚠️ The path alone is NOT enough. `bridge.sock` is as ordinary as file names
# get — another tool could use the same name inside ITS OWN App Group, and
# reinstalling our hooks would delete theirs.
# So a second condition: the command must also carry OUR wire-protocol
# signature. Both must hold to count as ours: paths can collide, the protocol
# signature cannot.
# Both spellings count: hook commands live in JSON where the tab is an escaped
# `\\t`; the completion-bell block is shell script where the tab is a REAL tab
# character. Same protocol signature, different host file format — accept only
# one and you fail to recognize yourself in the other.
WIRE_PATTERN = re.compile("-\\$\\$(?:\\\\t|\\t)(?:claude|codex)")


# The launcher's own path is the identity of every command written from now
# on. It is ours by construction — no other tool invokes a binary out of
# `~/.perch/bin` — so it needs no second condition the way an inline
# `bridge.sock` did.
LAUNCHER = os.path.expanduser("~/.perch/bin/perch-hook")
LAUNCHER_PATTERN = re.compile(r"\.perch/bin/perch-hook")


def is_perch_command(command: str) -> bool:
    """⚠️ Recognizes BOTH shapes, and must keep doing so. Commands written
    before the launcher carry the socket inline; if a reinstall stopped
    recognizing those it would leave them in place and append the new ones
    beside them — every hook firing twice, one of the two pushing at a socket
    nobody listens on. On this side that would also shift positions and break
    other tools' trust hashes."""
    if LAUNCHER_PATTERN.search(command):
        return True
    return bool(ARTIFACT_PATTERN.search(command) and WIRE_PATTERN.search(command))


def install_launcher(source: str | None = None, target: str | None = None) -> str:
    """Put `perch-hook` at its fixed path, executable.

    Written atomically: this file is invoked by every hook, and a half-written
    launcher would break codex's own tool calls, not just ours.
    """
    src = source or os.path.join(os.path.dirname(os.path.abspath(__file__)), "perch-hook.sh")
    dst = target or LAUNCHER
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(src, encoding="utf-8") as f:
        text = f.read()
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o755)
    os.replace(tmp, dst)
    return dst

# PostToolUse also pushes working: yellow would otherwise never exit —
# approving emits NO event, and UserPromptSubmit only fires when the human
# types, so "asked once" would mean "yellow until the turn ends".
# PostToolUse is the only signal that DISPROVES "something is stuck": a tool
# finished, therefore nothing waits on a human. Without approval the tool
# never runs, there is no PostToolUse, and yellow stays — as it should.
# It pushes the same word as UserPromptSubmit because they say the same thing:
# "running".
#
# ⚠️ Adding this entry makes codex flag it "needs review" — trust it once.
# **The other three commands are byte-identical, their hashes still match, no
# re-trust needed** (the trust hash is keyed by event+position; adding a new
# event moves nobody else's position).
EVENTS = {
    "UserPromptSubmit": "working",
    "PermissionRequest": "waiting",
    "PostToolUse": "working",
    "Stop": "complete",
}

# The script at the end of the notify chain. The hooks.json route requires
# codex's persistent trust, which only codex's own review UI can grant — until
# granted, the hook is SILENTLY skipped. The notify chain has no such gate, so
# the completion bell goes here. The cost: notify fires only at end of turn,
# so "started" and "waiting on you" are unavailable on this route.
NOTIFY_SCRIPT = os.path.expanduser("~/.codex/hooks/codex-notify-sound.sh")
NOTIFY_MARK = "Perch"


def hook_command(event: str, launcher: str | None = None) -> str:
    """Build one hook command.

    ⚠️ **This string must never change again, and that is the whole point of
    this shape.** codex records trust per command TEXT, so while the socket
    path lived inline, every container rename turned all four hooks into
    unrecognized commands and the owner had to approve them by hand — over and
    over, for our convenience. Worse, an inline path is fixed at install time:
    when the island moved to a Team-prefixed container, these hooks were the
    writer nobody remembered to reinstall, and codex's events went nowhere for
    a day without a single error anywhere.

    Everything variable — the socket, the flight recorder — now lives inside
    the launcher and is resolved at run time. `launcher` is a seam for tests.
    """
    return f"'{launcher or LAUNCHER}' {event} codex"


def load_hooks() -> dict:
    if not os.path.exists(HOOKS):
        return {}
    with open(HOOKS, encoding="utf-8") as f:
        return json.load(f)


def backup_to(path: str) -> str:
    """Copy `path` aside before we touch it, never overwriting an earlier
    backup: two runs in the same second must not destroy the copy that shows
    the config as it was before Perch ever touched it."""
    stem = f"{path}.perch-backup-{int(time.time())}"
    dest, n = stem, 1
    while os.path.exists(dest):
        dest, n = f"{stem}-{n}", n + 1
    shutil.copy2(path, dest)
    return dest


def backup() -> str | None:
    return backup_to(HOOKS) if os.path.exists(HOOKS) else None


def write_atomic(path: str, text: str) -> None:
    """Write through a temp file in the same directory, then rename.

    These files belong to the user, not to us: a truncate-then-write would
    leave a half-written config (or a half-written shell script) behind on a
    full disk or a power cut, and that breaks their whole tool. `os.replace`
    on the same filesystem either fully lands or leaves the original
    untouched. The mode is carried over because the notify script must stay
    executable. (Deliberately duplicated in the Claude installer: each
    installer must run standalone, with no sibling module to import.)
    """
    tmp = f"{path}.perch-tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


def is_perch(group: dict) -> bool:
    """Does this group hold at least one hook of ours (used to FIND ours)."""
    return any(is_perch_command(h.get("command", "")) for h in group.get("hooks", []))


def is_purely_perch(group: dict) -> bool:
    """Is every hook in this group ours (used to decide what may be REMOVED).

    ⚠️ A group can be mixed: ours plus somebody else's, side by side. Removing
    or replacing a mixed group wholesale deletes their hook — so only a purely
    ours group is ever safe to drop.
    """
    hooks = group.get("hooks", [])
    return bool(hooks) and all(is_perch_command(h.get("command", "")) for h in hooks)


def perch_addresses(groups: list) -> list[tuple[int, int]]:
    """Every address `(group index, hook index)` holding a hook of ours."""
    return [(i, j)
            for i, g in enumerate(groups)
            for j, h in enumerate(g.get("hooks", []))
            if is_perch_command(h.get("command", ""))]


def upsert(hooks_root: dict, event_name: str, command: str) -> tuple[str, bool]:
    """Update our hook in place if present, else append a new group at the
    end. Neither move changes any other hook's address.

    Returns (description, needs-retrust). **An unchanged command needs no
    re-trust** — the trust hash covers the command itself, so an identical one
    is still trusted. This boolean must be truthful: the installer uses it to
    tell the user which entries to click; over-reporting sends people hunting
    for buttons that don't exist, under-reporting leaves hooks silently
    skipped.

    ⚠️ Everything here works at the **hook** level, never the group level. One
    group can hold our hook AND somebody else's, side by side; replacing such
    a group wholesale would delete theirs.
    """
    groups = hooks_root.setdefault("hooks", {}).setdefault(event_name, [])
    hook = {"command": command, "timeout": 5, "type": "command"}

    # Sweep duplicates left behind by past installs — but only a trailing
    # group that is ENTIRELY ours.
    #
    # **Pop from the tail only.** Removing anything earlier shifts every later
    # hook's address, and codex keys trust by
    # `<file>:<event>:<group index>:<hook index>` — one shift and other
    # people's hooks lose trust and silently stop running. That invariant
    # outranks "clean up every duplicate": a duplicate stuck in the middle
    # stays put and gets reported instead.
    dropped = 0
    while groups and is_purely_perch(groups[-1]) and len(perch_addresses(groups)) > 1:
        groups.pop()
        dropped += 1

    addresses = perch_addresses(groups)
    if addresses:
        i, j = addresses[0]
        hooks = groups[i]["hooks"]
        unchanged = hooks[j] == hook
        hooks[j] = hook          # only our own hook object; siblings keep their place
        stuck = len(addresses) - 1
        # Re-trust depends only on whether THE COMMAND changed: dropping later
        # duplicates does not move the kept hook, so its hash still matches.
        # Over-reporting sends people hunting for buttons that don't exist.
        return (f"updated in place (group {i}, hook {j})"
                + (", command unchanged" if unchanged else ", command changed")
                + (f", swept {dropped} duplicate group(s)" if dropped else "")
                + (f", ⚠️ {stuck} duplicate(s) left untouched — they sit among other"
                   " people's hooks, and moving those would break their trust" if stuck else ""),
                not unchanged)
    groups.append({"hooks": [hook]})
    return f"appended at the end (group {len(groups) - 1}), new", True


def notify_tail(group: str | None = None) -> str:
    """The completion-bell block, rendered for one App Group.

    A function rather than a module constant so importing this file needs no
    installed app (see `container`).
    """
    group = group or app_group_id()
    return f'''
# --- {NOTIFY_MARK} (completion bell) ----------------------------------------
# codex finishes a turn -> push one line to the island's socket; that
# project's dot turns green.
# Why here and not ~/.codex/hooks.json: that route needs codex's persistent
# trust, without which the hook is silently skipped. The notify chain has no
# such gate.
# This block is self-delimiting: reinstalling replaces exactly the span from
# its own header to the next one, so neither what runs above it nor anything
# another tool appended below it is touched.
# Fail-open: island not running = no socket file; log one line and skip,
# never affecting codex or the sound.
#
# The lastrun line is a FLIGHT RECORDER, not log filler: this chain passes
# through several layers of other people's forwarding, and when something
# breaks, "did the chain reach here" is the only way to tell "never
# triggered" from "triggered but the push failed".
# Single file, overwritten each time — never grows.
perch_sock="$HOME/Library/Group Containers/{group}/bridge.sock"
perch_lastrun="$HOME/Library/Group Containers/{group}/codex-notify.lastrun"
perch_dir=$(/usr/bin/python3 -c 'import json,sys,os; d=json.loads(sys.argv[1] or "{{}}"); print(d.get("cwd") or os.getcwd())' "$payload" 2>/dev/null) || perch_dir="$PWD"
[[ -z "$perch_dir" ]] && perch_dir="$PWD"
perch_pushed=skipped
if [[ -S "$perch_sock" ]]; then
  if printf "complete\t%s\t%s-$$\tcodex" "$perch_dir" "$(date +%s)" \
       | /usr/bin/nc -U -w 1 "$perch_sock" >/dev/null 2>&1; then
    perch_pushed=ok
  else
    perch_pushed=push-failed
  fi
else
  perch_pushed=no-socket
fi
printf '%s  dir=%s  push=%s\n' "$(date +%FT%T)" "$perch_dir" "$perch_pushed" \
  > "$perch_lastrun" 2>/dev/null || true
'''


def our_tail_span(text: str) -> tuple[int, int] | None:
    """Character range `(start, end)` of our completion-bell block; None if
    never installed.

    The END matters as much as the start: another tool may have appended its
    own block after ours, and replacing "from our start to the end of the
    file" would delete it.

    **Recognized by shape, not by the title.** The title carries the product
    name, and product names change — find by name and the block already
    installed on the machine can't be found after a rename, so old and new
    coexist and codex pushes twice per finished turn. Same commandment as
    ARTIFACT_PATTERN: **never use a changeable value as identity.**

    Same criteria as `is_perch_command`: WITHIN ONE BLOCK there must be both
    an own-artifact path inside the container and the wire-protocol signature.
    The path alone is not enough (another tool may have its own
    `bridge.sock`); the signature alone is not enough (it is ours, but we
    need to know which block it belongs to).

    Split into blocks at `# ---` comment headers and take the EARLIEST block
    of ours.
    """
    starts = [m.start() + 1 for m in re.finditer(r"\n# ---", text)]
    if text.startswith("# ---"):
        starts.insert(0, 0)
    bounds = starts + [len(text)]
    for i, s in enumerate(starts):
        block = text[s:bounds[i + 1]]
        if ARTIFACT_PATTERN.search(block) and WIRE_PATTERN.search(block):
            return s, bounds[i + 1]
    return None


def install_notify_tail(group: str | None = None) -> str:
    """Install the completion bell into the script at the end of the notify
    chain.

    If already installed, REPLACE our block with the current version — never
    skip: skipping leaves an old version there forever, pushing a
    long-obsolete format. Replacement is **span-based**: only the range from
    our own header to the next block survives the swap, so whatever another
    tool appended after us stays exactly where it was.
    """
    if not os.path.exists(NOTIFY_SCRIPT):
        return f"skipped: {NOTIFY_SCRIPT} does not exist (the notify chain may have changed shape; re-check)"
    text = open(NOTIFY_SCRIPT, encoding="utf-8").read()
    backup_to(NOTIFY_SCRIPT)
    body = notify_tail(group)
    span = our_tail_span(text)
    if span is None:
        write_atomic(NOTIFY_SCRIPT, text.rstrip("\n") + "\n" + body)
        return "appended at the end"
    start, end = span
    head = text[:start].rstrip("\n")
    rest = text[end:]
    write_atomic(NOTIFY_SCRIPT, (head + "\n" if head else "") + body + rest)
    return ("updated in place to the current version"
            + (" (content after our block left untouched)" if rest.strip() else ""))


def foreign_hooks(hooks: dict) -> dict:
    """Every hook that is NOT ours, keyed by its exact address
    `(event, group index, hook index)`.

    Addresses, not groups: codex keys trust by that address, so both the hook
    object and its position must survive untouched. Comparing whole GROUPS
    would be blind to the real damage — a group holding one of our hooks plus
    somebody else's gets excluded from the comparison entirely, so losing
    their hook inside it would look perfectly clean.
    """
    return {(ev, gi, hj): h
            for ev, groups in hooks.items()
            for gi, g in enumerate(groups)
            for hj, h in enumerate(g.get("hooks", []))
            if not is_perch_command(h.get("command", ""))}


def main() -> None:
    group = app_group_id()   # resolve once, up front: no island installed = stop before touching anything
    socket, lastrun = socket_path(group), lastrun_path(group)
    launcher = install_launcher()   # before the hooks reference it, never after
    root = load_hooks()
    hooks_before = json.dumps(root.get("hooks", {}), sort_keys=True)
    foreign_before = foreign_hooks(root.get("hooks", {}))
    state_before = json.dumps(root.get("state"), sort_keys=True)

    path = backup()
    if path:
        print("backed up ->", path)

    needs_trust = []
    for event_name, event in EVENTS.items():
        where, retrust = upsert(root, event_name, hook_command(event))
        print(f"  {event_name:20} -> {event:9} {where}")
        if retrust:
            needs_trust.append(event_name)

    # Self-check before writing: every hook that is not ours must still be
    # byte-identical AND at the same address; the state section must be
    # untouched. One moved position and codex's trusted_hash no longer
    # matches — their hooks would be refused. Better not to write at all.
    foreign_after = foreign_hooks(root["hooks"])
    if foreign_after != foreign_before:
        lost = sorted(set(foreign_before) - set(foreign_after))
        moved = sorted(a for a in set(foreign_before) & set(foreign_after)
                       if foreign_before[a] != foreign_after[a])
        raise SystemExit(
            "Self-check failed: hooks that are not ours were disturbed; aborted, nothing written.\n"
            f"   missing: {lost or 'none'}\n   altered: {moved or 'none'}\n   Backup: {path}"
        )
    if json.dumps(root.get("state"), sort_keys=True) != state_before:
        raise SystemExit(f"Self-check failed: the state section was touched; aborted, nothing written. Backup: {path}")
    if hooks_before == json.dumps(root.get("hooks", {}), sort_keys=True):
        print("(no changes; already up to date)")

    write_atomic(HOOKS, json.dumps(root, indent=2, ensure_ascii=False, sort_keys=True) + "\n")

    print("\nCompletion bell (notify chain, no trust needed):", install_notify_tail(group))
    print("\nWired up ->", launcher)
    print("  it resolves the socket itself; right now that is", socket)
    print("  ⚠️ This is the LAST time these commands change. They no longer carry the")
    print("     container path, so renaming it will never ask for trust again.")
    if needs_trust:
        # Report the entries that ACTUALLY changed this run, never a
        # hard-coded count: unchanged hashes are still trusted, clicking them
        # does nothing.
        print(f"⚠️ These {len(needs_trust)} entr{'y' if len(needs_trust) == 1 else 'ies'} need trust (the rest are byte-identical and stay trusted):")
        for ev in needs_trust:
            print(f"     · {ev}")
        print("   ChatGPT desktop -> Settings -> Coding -> Hooks -> User config -> Trust, then Reload hooks")
        print("   (in the TUI it's the /hooks panel). Untrusted hooks are silently skipped, no warning at all.")
    else:
        print("✓ No command changed; no re-trust needed.")
    print("   The completion bell rides the notify chain, no trust needed; the desktop app may not run notify — it serves the TUI.")


if __name__ == "__main__":
    main()
