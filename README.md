# Perch

Your neck, shoulders and eyes pay for the screen every day.

You know you should look up now and then — roll your neck, let your eyes focus
on something far away. The trouble is that most break reminders arrive while
you are concentrating. They ask you to stop what you are doing, so you dismiss
them.

But when you work with a coding agent, some pauses are already there. The task
is handed off, the agent is running, and all you need to know is when it wants
your approval and when it is done. **That pause doesn't ask you to stop
anything — you have already stopped.**

Perch lives in that pause.

![Perch collapsed in the notch: one count per state](perch-status-key.svg)

A bird sits in your Mac's notch and watches the agent for you: blue while it
runs, yellow when it needs you, green when it finishes. You don't have to keep
an eye on the terminal, so you can safely look up and spend 30 seconds rolling
your neck, loosening your shoulders, or letting your eyes leave close range.

Every move comes with an illustration and a beat, and leaves a line in a local
log when you finish it. You don't have to carve out a separate block of time to
look after your body — the agent has already left you these gaps.

## How it works

**1 · Perch takes over the watching.** Hooks in Claude Code and codex tell it
when a run starts, when it needs you, and when it ends. Collapsed, it reports
one number per state; hover the notch and it unfolds into one row per project.

**2 · You look away.** That is what the lights are for. Nothing is slipping
past you while your head is up — the yellow number is what calls you back.

**3 · You get a 30-second move.** Neck, shoulders, or eyes. Illustrated, paced
by a beat, and logged when you finish it, so over time you can see what you
actually did rather than what you meant to do.

<table>
  <tr>
    <td align="center" width="33%"><img src="Perch/Resources/Assets.xcassets/CareMoveSideNeckTiltLeft.imageset/CareMoveSideNeckTiltLeft.png" width="190" alt="Side neck tilt"><br><sub>neck</sub></td>
    <td align="center" width="33%"><img src="Perch/Resources/Assets.xcassets/CareMoveTrapLeft.imageset/CareMoveTrapLeft.png" width="190" alt="Trapezius release"><br><sub>shoulders</sub></td>
    <td align="center" width="33%"><img src="Perch/Resources/Assets.xcassets/CareMoveEyeOrbitalUnder.imageset/CareMoveEyeOrbitalUnder.png" width="190" alt="Orbital massage"><br><sub>eyes</sub></td>
  </tr>
</table>

These are ordinary stretches and micro-movements for people who sit at a
screen. Perch is not a medical device and makes no health claims — if
something hurts, see someone who can actually look at you.

## Agents

**Claude Code** works as soon as you run its installer.

**codex** delivers the finish signal out of the box, through its notify script.
The running and waiting states go through `~/.codex/hooks.json`, and codex only
runs hooks you have trusted in its own `/hooks` panel — so if the green number
moves but blue and yellow never do, that trust is what is missing.

## Local by construction

Everything stays on your machine: one Unix socket inside an App Group
container. `AF_UNIX` sockets cannot reach the network — that is enforced by the
operating system, not by the code being polite. No accounts, no telemetry, and
no network code anywhere in this package.

One thing worth knowing: the agent event log records the **full path of every
project** you ran an agent in. It never leaves your disk, but it is the file to
delete if you would rather not keep that history — see [Uninstall](#uninstall).

## Install

You need:

- **macOS 15 or newer** — the app is built against the 15.0 SDK
- **Xcode** with a Swift 6 toolchain. Free, and **no Apple developer account**:
  the app is built unsigned and ad-hoc signed on your own machine
- **python3** for the installers. macOS's built-in `/usr/bin/python3` (3.9) is
  enough — nothing to install
- an account that can write to `/Applications` (the usual admin account; no
  `sudo` anywhere)
- **Node** only if you want to run the test suite — tested on 22

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
(`agent-events/*.jsonl`) — the one that carries your project paths.

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
