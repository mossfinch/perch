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

# The wire format the island parses: event, project, nonce, source, host,
# session. The nonce keeps two pushes in the same second distinguishable. The
# host is the app the agent runs in (Terminal, iTerm, a code editor, the Claude
# app), which macOS names in __CFBundleIdentifier for everything started from an
# app; pressing a project's name on the card brings that app forward. The session
# is the app's own id for the session: the Claude app puts its id in the agent's
# environment, and the Codex app's conversation comes in what codex hands the
# hook (below). With it, the same press opens that session. Empty anywhere else.
# Each goes last, so an older island reading fewer fields never sees it.
#
# Hooks start in the project directory, so $PWD is usually right — but Claude
# Code states the project explicitly and its hooks do not always run there.
# Prefer what the agent says over where the process happens to stand; codex
# does not set the variable, so it falls through to $PWD unchanged.
dir=${CLAUDE_PROJECT_DIR:-$PWD}
host=$(printf '%s' "${__CFBundleIdentifier:-}" | tr -cd 'A-Za-z0-9.-')
session=${CLAUDE_CODE_HOST_SESSION_ID:-}
# The Codex app starts its agent without __CFBundleIdentifier; it says who it is in its own
# variable instead ("Codex Desktop"). Its conversation is the session_id in the JSON codex
# hands every hook on stdin, read only here: the first one, since a tool's input or output
# later in that JSON may quote another.
#
# The agent waits for this hook, so stdin is read in a way that cannot wait on it: one read,
# which returns with whatever codex has written (it writes that JSON at once, session_id
# first), and given up after a second if nothing comes and the pipe stays open. No id then,
# and the press only brings the app forward.
if [ -z "$host" ]; then
    case "${CODEX_INTERNAL_ORIGINATOR_OVERRIDE:-}" in
    Codex*)
        host=com.openai.codex
        # A command put in the background reads /dev/null unless told otherwise, so the
        # hook's stdin is handed to it explicitly.
        session=$( {
            dd bs=65536 count=1 <&3 2>/dev/null &
            reader=$!
            ( sleep 1; kill "$reader" ) >/dev/null 2>&1 &
            timer=$!
            wait "$reader"
            kill "$timer" 2>/dev/null
        } 3<&0 | grep -o '"session_id" *: *"[A-Za-z0-9_-]*"' | head -n 1 | sed 's/.*"\([A-Za-z0-9_-]*\)"$/\1/')
        ;;
    esac
fi
session=$(printf '%s' "$session" | tr -cd 'A-Za-z0-9_-')
printf '%s\t%s\t%s-%s\t%s\t%s\t%s' "$event" "$dir" "$(date +%s)" "$$" "$source" "$host" "$session" |
    /usr/bin/nc -U -w 1 "$sock" 2>/dev/null
rc=$?

# Flight recorder. The hook runs inside the agent with no visible output; when
# something breaks this single line is the only thing separating "the agent
# never called it" from "called, but the push failed". Overwritten each time,
# so it never grows.
printf '%s %s %s rc=%s\n' "$(date +%H:%M:%S)" "$event" "$PWD" "$rc" \
    > "$dir_island/${source}-hook.lastrun" 2>/dev/null

exit 0
