#!/usr/bin/env python3
"""Additively install Perch's Claude Code hooks.

The installer backs up ~/.claude/settings.json, then installs only Perch's
hooks. Existing hooks, other tools' included, are left intact.

Transport: each hook runs the launcher (`perch-hook.sh`, installed as
~/.perch/bin/perch-hook), which pushes one tab-delimited line
"<event>\t<projectDir>\t<nonce>\t<source>" to the island's Unix domain socket
in the App Group container with `nc -U`. projectDir = ${CLAUDE_PROJECT_DIR:-$PWD}
so the island can track each project on its own status dot.
UserPromptSubmit→working (blue), PermissionRequest→waiting (yellow, waiting
for your choice or approval), PostToolUse→working (blue: you approved it or no
approval was needed, work continues), Stop→complete (green). If the island is
not running the connect fails and the hook exits 0 (fail-open).

PostToolUse also pushes working because yellow would otherwise never end.
Approving a tool emits no event, and UserPromptSubmit only fires when a person
types, so "asked once" would mean "yellow until the turn ends": you approve,
the agent works for 20 minutes, and the dot stays yellow as if something still
awaited review. PostToolUse is the only signal that proves nothing is stuck: a
tool finished, so nothing is waiting on a person. Without approval the tool
never runs, there is no PostToolUse, and yellow stays yellow, as it should.

Migration-safe: a Perch hook is any command that runs the launcher, or that
points at one of our own artifacts inside a Group Container (bridge.sock,
agent-event.txt), so re-running removes a prior Perch hook (the old
file-writer, an earlier socket version, or one written for a different App
Group) before installing the current one. Recognition is by shape, not by the
current group id: a changeable value used as identity misses the old entries
the day the container changes (see the ARTIFACT_PATTERN comment).
"""
from __future__ import annotations   # so `X | None` annotations parse on macOS's stock python 3.9

import json
import re
import os
import shutil
import subprocess
import time

SETTINGS = os.path.expanduser("~/.claude/settings.json")


def app_group_id() -> str:
    """Read the App Group from the installed app's own Info.plist. Never
    hard-coded: a Team ID links to the registrant's real name.

    The installed app, not the source or config: the hooks push to the island
    that is actually running, and only its Info.plist is authoritative. With no
    island installed this errors out, because hooks pointing at a nonexistent
    container fail silently (fail-open), which is nearly impossible to debug
    after the fact.
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
    # Two shapes are accepted, as in AppGroup.swift:
    #   group.<suffix>            the repo default, prefix-free
    #   <TeamID>.group.<suffix>   install-island-app.py stamped a signing Team ID
    #                             into this machine's build (containermanagerd's
    #                             TCC rule on macOS 15 and later; see AppGroup.swift)
    # The socket lives in whichever container the installed app uses, so the
    # full value, prefix included, is what we return. A Team ID never appears
    # here as a literal; it comes from the installed plist.
    # Strip an optional "<TeamID>." prefix, then the core must be group.<suffix>.
    core = out[out.index("group."):] if ".group." in out and not out.startswith("group.") else out
    if not core.startswith("group.") or not core.removeprefix("group."):
        raise SystemExit(f"Bad App Group in the installed app (got {out!r}); rebuild and reinstall.")
    return out


def socket_path() -> str:
    """Where the island listens.

    Resolved lazily, not at import time: the tests import this module to
    exercise the real matcher functions, and reading the installed app during
    import would make them depend on whether this machine happens to have
    Perch installed.
    """
    return os.path.expanduser(
        f"~/Library/Group Containers/{app_group_id()}/bridge.sock"
    )


# Ownership is recognized by shape, not by the current App Group.
#
# Never use a changeable value (like the current group id) as identity: the
# moment the container changes, old commands still carry the old id, stop
# being recognized as ours, and cannot be removed. Old and new then coexist,
# every hook runs twice, and one of the two can never connect, because nobody
# listens on the old socket any more.
#
# The island's own artifact names are stable across container changes, and
# other tools' commands never touch them (their bridge scripts live in their
# own home directories and never enter Group Containers).
OWN_ARTIFACTS = ("bridge.sock", "agent-event.txt")
ARTIFACT_PATTERN = re.compile(
    r"Group Containers/[^\"'\s]*/(?:" + "|".join(re.escape(a) for a in OWN_ARTIFACTS) + ")"
)
# The path alone is not enough. `bridge.sock` is as ordinary as file names get:
# another tool could use the same name inside its own App Group, and
# reinstalling our hooks would delete theirs.
# So a second condition: the command must also carry our wire-protocol
# signature, the `-$$\t claude|codex` slice of
# `<event>\t<projectDir>\t<nanos-$$>\t<source>`.
# Both must hold to count as ours: paths can collide, the protocol signature
# cannot.
# Both spellings count: hook commands live in JSON, where the tab is an escaped
# `\\t`, and the completion-bell block is shell script, where the tab is a real
# tab character. Accept only one and the installer fails to recognize its own
# entries in the other.
WIRE_PATTERN = re.compile("-\\$\\$(?:\\\\t|\\t)(?:claude|codex)")


# The launcher's own path identifies every command this installer writes. It
# is ours by construction (no other tool runs a binary out of `~/.perch/bin`),
# so it needs no second condition the way an inline `bridge.sock` does.
LAUNCHER = os.path.expanduser("~/.perch/bin/perch-hook")
LAUNCHER_PATTERN = re.compile(r"\.perch/bin/perch-hook")


def is_perch_command(command: str) -> bool:
    """Recognizes both shapes, and must keep doing so. Older commands carry the
    socket inline; if a reinstall stopped recognizing those, it would leave
    them in place and append the new ones beside them, so every hook would
    fire twice, one of the two pushing at a socket nobody listens on."""
    if LAUNCHER_PATTERN.search(command):
        return True
    return bool(ARTIFACT_PATTERN.search(command) and WIRE_PATTERN.search(command))


def install_launcher(source: str | None = None, target: str | None = None) -> str:
    """Put `perch-hook` at its fixed path, executable.

    Written atomically: this file is invoked by every hook, and a half-written
    launcher would break the agent's own tool calls, not just ours.
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

# Order = write order; has no behavioral meaning (Claude's side has no
# position-based trust hash like codex's).
# PostToolUse and UserPromptSubmit push the same word (working): both mean
# "running", and they differ only in who says it first.
EVENTS = {
    "UserPromptSubmit": "working",
    "PermissionRequest": "waiting",
    "PostToolUse": "working",
    "Stop": "complete",
}


def hook_command(event: str, launcher: str | None = None) -> str:
    """Build one hook command.

    This string must never change. A command carrying the socket path inline
    changes with every container rename: on the codex side each change means
    approving the hooks again by hand (trust is recorded per command text),
    and on both sides a writer nobody remembered to reinstall keeps pushing,
    silently, at a socket that moved.

    Everything variable lives inside the launcher, which resolves the socket
    at run time. `launcher` is a seam for tests only.
    """
    return f"'{launcher or LAUNCHER}' {event} claude"


def load_settings() -> dict:
    if not os.path.exists(SETTINGS):
        return {}
    with open(SETTINGS, encoding="utf-8") as f:
        return json.load(f)


def remove_perch_hooks(settings: dict, event_name: str) -> bool:
    """Drop only Perch-owned hook objects; keep everything else (other tools')."""
    entries = settings.get("hooks", {}).get(event_name, [])
    removed = False
    kept_entries = []
    for entry in entries:
        hooks = entry.get("hooks", [])
        kept_hooks = [h for h in hooks if not is_perch_command(h.get("command", ""))]
        if len(kept_hooks) != len(hooks):
            removed = True
        if kept_hooks or not hooks:
            entry["hooks"] = kept_hooks
            kept_entries.append(entry)
        # else: entry held only Perch hooks -> drop the now-empty entry
    if entries:
        settings["hooks"][event_name] = kept_entries
    return removed


def add_hook(settings: dict, event_name: str, command: str) -> None:
    hooks = settings.setdefault("hooks", {})
    entries = hooks.setdefault(event_name, [])
    entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command}]})


def backup_settings() -> str | None:
    if not os.path.exists(SETTINGS):
        return None
    stem = f"{SETTINGS}.perch-backup-{int(time.time())}"
    backup, n = stem, 1
    # Two runs within the same second must not overwrite the first backup: it
    # is the only copy of the config as it was before we touched it.
    while os.path.exists(backup):
        backup, n = f"{stem}-{n}", n + 1
    shutil.copy2(SETTINGS, backup)
    return backup


def write_atomic(path: str, text: str) -> None:
    """Write through a temp file in the same directory, then rename.

    This file belongs to the user, not to us: a truncate-then-write would
    leave a half-written settings.json behind on a full disk or a power cut,
    and a broken settings.json breaks their whole tool. `os.replace` on the
    same filesystem either fully lands or leaves the original untouched.
    (Deliberately duplicated in the codex installer: each installer must run
    standalone, with no sibling module to import.)
    """
    tmp = f"{path}.perch-tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main() -> None:
    socket = socket_path()   # resolve once, up front: no island installed = stop before touching anything
    launcher = install_launcher()   # before the hooks reference it, never after
    settings = load_settings()
    backup = backup_settings()
    if backup:
        print("backed up ->", backup)

    for event_name, event in EVENTS.items():
        remove_perch_hooks(settings, event_name)   # clear any prior Perch hook first (file-writer or older socket version)
        add_hook(settings, event_name, hook_command(event))

    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    write_atomic(SETTINGS, json.dumps(settings, indent=2) + "\n")

    print("installed hooks ->", launcher)
    print("  it resolves the socket itself; right now that is", socket)


if __name__ == "__main__":
    main()
