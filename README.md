# Perch

A tiny macOS notch companion for people who run AI coding agents.

A bird sits in your notch and watches your agents work. Each project gets one
status light:

- 🟡 **yellow** — an agent is waiting for *your* approval
- 🔵 **blue** — an agent is working
- 🟢 **green** — the run finished

Hover the notch and it unfolds into a small card. While you wait for your agent,
Perch offers short neck / eye / shoulder micro-exercises — half a minute each,
30 to 40 seconds — with illustrated guides and a beat, and keeps a local log of
what you actually did.

Works with **Claude Code** and **codex** out of the box. Everything is local:
one Unix socket in an App Group container, no network, no accounts, no telemetry.

## Install

You need:

- **macOS 15 or newer** — the app is built against the 15.0 SDK
- **Xcode** with a Swift 6 toolchain. Free, and **no Apple developer account**:
  the app is built unsigned and ad-hoc signed on your own machine
- **python3** for the installers. macOS's built-in `/usr/bin/python3` (3.9) is
  enough — nothing to install
- an account that can write to `/Applications` (the usual admin account; no
  `sudo` anywhere)
- **Node 18+** only if you want to run the test suite

```bash
python3 install-island-app.py        # build → /Applications/Perch.app → launch at login
python3 install-island-hooks.py      # wire up Claude Code
python3 install-codex-island-hooks.py  # wire up codex (grant trust once when asked)
```

First launch: macOS will ask you to allow the app once
(System Settings → Privacy & Security → *Open Anyway*). After that it opens
like any other app.

The hook installers only touch their own entries: they back up your config
first, add entries additively, never reorder or remove anything that isn't
theirs — including hooks that happen to share a group with one of ours — and
replace each file by rename, so an interrupted run cannot leave a half-written
config behind. Before writing, they check that every foreign entry is still
byte-identical and still at the same position; if not, they abort and write
nothing.

The app installer refuses to replace an app at `/Applications/Perch.app` that
isn't Perch, moves the old one aside instead of deleting it, and finishes by
connecting to the island's socket for real — a running process proves nothing
if it never managed to bind.

## Uninstall

The app and its auto-start:

```bash
launchctl bootout gui/$UID/io.github.mossfinch.perch
rm ~/Library/LaunchAgents/io.github.mossfinch.perch.plist
rm -rf /Applications/Perch.app
```

The hooks, if you wired them up — they live in your own config files, so they
outlive the app:

- `~/.claude/settings.json` and `~/.codex/hooks.json`: remove the entries whose
  command mentions `bridge.sock`. Both installers left a timestamped
  `.perch-backup-*` copy beside each file, if restoring is easier
- `~/.codex/hooks/codex-notify-sound.sh`: the completion bell is the block
  headed `# --- Perch`

Your data, all in one folder:

```bash
rm -rf ~/Library/Group\ Containers/group.io.github.mossfinch.perch
```

It holds the exercise log (`care-ledger.json`) and the agent event log
(`agent-events/*.jsonl`). The event log records the **full path of every
project** you ran an agent in — so if you care about that, this is the one to
delete.

## If you change the App Group name

The container path follows the group name, so your exercise log stays behind
in the old container. Move it explicitly — the installer refuses to guess:

```bash
python3 install-island-app.py --migrate-from <old-app-group-id>
```

It copies (never deletes), refuses to overwrite an existing log, refuses
symlinks and unreadable ledgers, and writes atomically.

## Development

```bash
xcodebuild -project Perch.xcodeproj -scheme Perch build   # or open in Xcode
node --test tests/island.test.js                          # run the test suite
```

`perch-package.json` is the single manifest of what this package contains;
the test suite includes a privacy guard that scans everything the manifest
covers.

## License

MIT — see [LICENSE](LICENSE).
