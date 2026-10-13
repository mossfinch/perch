#!/bin/sh
# Perch's hook launcher: push one agent event to the island.
#
#     perch-hook <event> <source>          e.g. perch-hook working codex
#
# **Why this file exists at all.** A hook command that carries the socket's
# path inline has two costs:
#
#   · codex records trust per command TEXT, so any change to that path makes
#     every hook look like a brand-new command, to be re-approved by hand.
#   · The path is baked in at install time, so moving it means every writer
#     has to be found and reinstalled. A forgotten one fails silently, and
#     nothing reports it while another writer keeps the log looking alive.
#
# So: the hook command is a fixed string that never changes, and the
# socket sits at one fixed path in the user's home, `~/.perch/island/bridge.sock`,
# the folder the app itself keeps everything in (see `DataHome.swift`). There is
# nothing to resolve and no list of writers anyone has to remember.
#
# Fail-open throughout: this runs inside the agent's own process. A missing
# island or a stale socket file must not cost the user a keystroke, so every
# path ends in exit 0.

event=$1
source=$2
[ -n "$event" ] && [ -n "$source" ] || exit 0

dir_island=$HOME/.perch/island
sock=$dir_island/bridge.sock

# The wire format the island parses: event, project, nonce, source. The nonce
# keeps two pushes in the same second distinguishable.
#
# Hooks start in the project directory, so $PWD is usually right — but Claude
# Code states the project explicitly and its hooks do not always run there.
# Prefer what the agent says over where the process happens to stand; codex
# does not set the variable, so it falls through to $PWD unchanged.
dir=${CLAUDE_PROJECT_DIR:-$PWD}
printf '%s\t%s\t%s-%s\t%s' "$event" "$dir" "$(date +%s)" "$$" "$source" |
    /usr/bin/nc -U -w 1 "$sock" 2>/dev/null
rc=$?

# Flight recorder. The hook runs inside the agent with no visible output; when
# something breaks this single line is the only thing separating "the agent
# never called it" from "called, but the push failed". Overwritten each time,
# so it never grows.
printf '%s %s %s rc=%s\n' "$(date +%H:%M:%S)" "$event" "$PWD" "$rc" \
    > "$dir_island/${source}-hook.lastrun" 2>/dev/null

exit 0
