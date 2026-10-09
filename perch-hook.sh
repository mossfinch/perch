#!/bin/sh
# Perch's hook launcher: push one agent event to the island.
#
#     perch-hook <event> <source>          e.g. perch-hook working codex
#
# **Why this file exists at all.** The hook commands used to carry the socket's
# absolute path inline. Two things followed from that, and both bit:
#
#   · codex records trust per command TEXT, so every container rename made
#     every hook look like a brand-new command and the owner had to re-approve
#     them by hand — repeatedly, for our convenience.
#   · The path was baked in at install time, so changing the container meant
#     every writer had to be remembered and reinstalled. One was forgotten
#     (codex, when the island moved to a Team-prefixed container) and its
#     pushes failed silently for a day. Nothing reported it: the other writer
#     kept logging, so the log looked alive.
#
# So: the hook command is now a fixed string that never changes again, and the
# socket is resolved HERE, at run time, from the installed app itself. Reinstall
# the island anywhere and the next hook notices and follows. There is no longer
# a list of writers anyone has to remember.
#
# Fail-open throughout: this runs inside the agent's own process. A missing
# island, a stale cache, a broken plist — none of it may cost the user a
# keystroke, so every path ends in exit 0.

event=$1
source=$2
[ -n "$event" ] && [ -n "$source" ] || exit 0

plist=/Applications/Perch.app/Contents/Info.plist
cache=$HOME/.perch/socket

resolve() {
    group=$(/usr/libexec/PlistBuddy -c 'Print :AppGroupID' "$plist" 2>/dev/null) || return 1
    [ -n "$group" ] || return 1
    mkdir -p "${cache%/*}" 2>/dev/null
    printf '%s' "$HOME/Library/Group Containers/$group/bridge.sock" > "$cache" 2>/dev/null
}

sock=
[ -s "$cache" ] && read -r sock < "$cache"

# Two independent reasons to resolve again, and the second one is the load
# bearing one:
#
#   · the installed app is newer than what we resolved — the ordinary case;
#   · what we resolved is **not a socket file any more** — the container moved.
#
# ⚠️ The mtime comparison alone is not enough: `-nt` is second-accurate and
# strict, so an install landing in the same second as the last resolve would
# never trigger it, and the hook would push at the old container forever
# without a single error. Rare, and precisely the shape of the failure that
# already cost a day of events once.
#
# `-S` is exact here: a socket file survives the island being stopped (it is a
# filesystem entry, not the process), so a merely idle island does not send us
# back to PlistBuddy. It goes false only when the path itself is wrong.
if [ -z "$sock" ] || [ "$plist" -nt "$cache" ] || [ ! -S "$sock" ]; then
    resolve && read -r sock < "$cache"
fi
[ -n "$sock" ] || exit 0

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
    > "${sock%/bridge.sock}/${source}-hook.lastrun" 2>/dev/null

exit 0
