# Changelog

Notable changes to Perch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8] — 2026-10-21

### Added

- Install or update with one line in Terminal:
  `curl -fsSL https://raw.githubusercontent.com/mossfinch/perch/main/install.sh | sh`.
  The script downloads this release, checks its checksum, puts Perch in
  Applications and opens it. A file downloaded this way skips the "cannot
  verify" warning and the trip to Privacy & Security, so Claude Code or codex
  can install Perch for you too. It asks for no administrator password and
  leaves your agents' settings to Connect. Downloading the zip still works.

### Fixed

- Opened from Downloads before it was moved to Applications, Perch ran from a
  temporary copy macOS makes, and the card told you to move it to
  Applications, where it already was. The card now says it is a temporary
  copy and what to do: quit, open Perch from Applications, and allow it once
  more.
- A project name you can press now carries a faint underline all the time,
  not only under the pointer, so it reads as a link before you find out by
  accident. The Record view's Back is brighter and easier to hit.

## [2.7] — 2026-10-20

### Added

- In Terminal, pressing a project's name now selects the tab its agent runs
  in and brings that window forward, out of the Dock if it was minimized,
  rather than only bringing Terminal forward. The hook names the tab by its
  terminal device, which it finds even when codex runs it detached from the
  tab. Perch sends Apple events for this to Terminal alone, so macOS asks
  once whether Perch may control Terminal; declining keeps the old
  behaviour. What the permission is used for is in the README's privacy
  section. iTerm and editors still bring their app forward.

### Fixed

- A project folder whose name holds a tab or a line break no longer reaches
  the island, where it pushed every later field of the message out of place.
  The island also refuses a message with more fields than it knows.

## [2.6] — 2026-10-19

### Fixed

- Pressing a project's name on the card now opens that project's session in
  the Claude app, or its conversation in the Codex app. In 2.5 it only brought
  the Claude app forward, showing whichever session was open last, so with
  several projects it looked as if the press had missed; a codex line from the
  Codex app did nothing at all. The hook now also passes the app's id for the
  session, as a sixth field an older Perch simply ignores; sessions already
  open pick it up at their next event. Terminal, iTerm and editors still bring
  their app forward.

## [2.5] — 2026-10-19

### Added

- Four new moves, for the shoulders and the back: Shoulder rolls, Chest
  opener, Seated twist and Seated cat-cow, all done sitting down. The circles
  beside Start now choose among four parts: neck, eyes, shoulders and back.
  The move log gains the category `back`; a Perch older than this one cannot
  read a log that holds it, and leaves the file alone rather than starting it
  over.
- A line waiting for your approval or your choice now makes a sound of its own,
  different from the completion chime. Until now the bird only turned yellow,
  and the moment Perch exists for was the quietest one. It is a sound only: the
  card does not open for it. The speaker in the card's corner mutes both.
- A menu, on a right-click anywhere on the open card: the version, Open at
  Login, Disconnect Agents and Quit Perch. Perch has no Dock icon and no menu
  bar, so until now there was no way to quit it, or to see which version was
  running. The branch under the bird keeps its own right-click.
- Disconnect Agents takes Perch's hooks out of Claude Code and codex, by the
  same rules Connect puts them in: a backup beside each file, nobody else's
  hooks touched, and nothing written if a codex hook of Perch's sits in front
  of another tool's, since moving that one would quietly cost it codex's trust.
- **Record**, every week since Perch started listening, in the card itself.
  Press today's `in flow` reading, or choose Record from the right-click menu,
  and the card's lower half turns into it. One week is drawn large on the
  card's own branch, with a dot under each day for every move finished; every
  week sits underneath as a stroke as tall as its flow, and pressing one
  brings it up. A day reads exactly as it does on the top row. Earlier weeks
  are read in the background, this week first, so it opens at once, and they
  are kept in a small file beside the event log, so after a restart only this
  week is read again. Closing
  the card puts the move back.
- Press a project's name on the card to bring forward the app its agent runs
  in: Terminal, iTerm, your editor, or the Claude app. The hook now tells
  Perch which app that is, as a fifth field an older Perch simply ignores.
  Only the app comes forward, not the window or the session.
- The stretch reminder's hour is now a choice. After a move that answered a
  reminder left waiting more than 15 minutes, the card's title says when the
  next one will come, and the time in that sentence opens the choices: half an hour, 45 minutes, an hour, an hour and a
  half, or never. Answered sooner, or already at the longest wait, the card
  says nothing. The pick is kept across launches; an hour stays the default.
  Stretch Reminders in the right-click menu holds the same choices, and is the
  way back once reminders are off.
- A download now opens at login, switched on the first time it is opened from
  Applications. Built from source, the installer's own launch-at-login job
  stays in charge and the switch only shows it.

### Changed

- A relaunch no longer asks again about a stretch already asked about or
  answered. Until now that was kept in memory only, so the stretch was rebuilt
  from the log, found due, and asked about once more at the next hand-off. An
  ask still open when Perch restarts stays on the tab, without opening the card
  a second time.
- When Perch cannot receive events, the card now says where to quit it.
- A finished project's green dot now stays until you hover the card and see
  it, then goes fifteen minutes later. It used to go fifteen minutes after the
  agent finished, so stepping away for longer brought you back to a bird that
  no longer said which project was done. A dot nobody looks at still goes once
  that session has been quiet for eight hours, as a yellow one does.

## [2.4] — 2026-10-13

### Fixed

- A downloaded Perch no longer asks "Perch would like to access data from other
  apps" every time it starts. Choosing Don't Allow there used to leave Perch
  deaf: the bird sat in the notch and heard nothing from your agents, with no
  word as to why. Perch now keeps its data in `~/.perch/island` instead of an
  App Group container, and asks nothing. A download starts that folder empty;
  built from source, the installer offers to bring the old history over
  (`--migrate-from`).
- If Perch ever cannot open the socket your agents talk to, the card now says
  so instead of sitting still.
- Built from source, Perch now comes back by itself when macOS closes it (it
  does that to apps when it frees disk space). Quitting it yourself still
  keeps it closed.

### Changed

- The island now grows out of the notch. Opening stretches the closed capsule
  into the card on a spring, and the card's contents fade in once there is room
  for them; closing runs the other way. With Reduce Motion on, the outline
  changes at once and only the contents fade.

## [2.3] — 2026-10-09

### Added

- Perch can now connect Claude Code and codex itself. The first time it opens,
  or whenever it finds an agent it cannot hear yet, the card's second row
  offers **Connect**. Nothing is written until you press it. It follows the
  same rules as the Python hook installers and writes the same bytes: a backup
  beside each file first, only Perch's own entries touched, an atomic swap at
  the end. The download from the releases page works on its own now; Xcode is
  only needed to build from source.
- `Perch --demo` runs the island on made-up projects and a made-up week in a
  scratch folder, for recording it without showing your own work. Your own
  data is never opened.

### Changed

- The sandbox now lets the app write to `~/.claude`, `~/.codex` and `~/.perch`,
  and to nothing else outside its own container. Connecting needs those three.
- `~/.perch/bin/perch-hook` written by **Connect** is a link to the script
  inside the app rather than a copy, so updating the app updates the hooks.
  macOS refuses to run a script that a sandboxed app wrote itself.

## [2.2] — 2026-10-07

### Added

- After an hour of steady work with your agents, the card opens once at your
  next hand-off with a small shake and says `stretch your wings`. The words
  then stay on a tab under the notch, stretching their letters now and then,
  until you finish a move or your agents have been quiet for twenty minutes.
  The shake and the stretching are skipped when Reduce Motion is on. Only
  agent activity is read, and time the Mac is asleep counts as a break.
- `island-day-report.py --reading --via-bridge` asks the running island for
  the day's readings over its socket instead of reading the event log out of
  the App Group container. A scheduled job reading that container gets
  macOS's "access data from other apps" prompt on every launch, with nobody
  there to answer it; the socket road gives the same numbers without the
  prompt. Directory reading is unchanged for everything else.
- A switch for the completion chime, in the bottom-right corner of the
  unfolded card: press the speaker to mute the chime, press it again to
  bring it back. The setting is remembered across launches. The beat that
  paces a move is not affected — it is the move's clock, not a notification.
- The history rebuild now notices when it has stopped seeing a provider. Its
  counters could all read healthy while a reshaped log left most rows
  unrecognised, because a row the scanner does not recognise is not counted
  as dropped. The hooks are a second witness: each hook `complete` is now
  matched against a native turn ending beside it, and a window where more
  than a quarter of at least twenty completions have no such turn is reported
  as a `reconstruction_gap` in `source-health.json`. Nothing about it is shown
  on the island.

### Changed

- The card no longer always opens on the chin tuck. It offers the move after
  the last one you did, in catalog order; picking a category by hand still
  works.
- The bird on the closed island breathes by a Core Animation layer
  animation instead of a SwiftUI one, avoiding SwiftUI updates on each
  animation frame. The breathing motion and status colours are unchanged.
- The comments beside the three flow thresholds no longer claim they are
  re-derived from your corrections. They are hand-set provisional values; the
  corrections are recorded so that they can be fitted one day, and nothing
  reads them yet.

## [2.1] — 2026-08-25

### Fixed

- A day with no reading is no longer painted as a day with the lowest reading.
  Zero seconds in flow meant two different things wearing one face: a day with
  plenty of handoffs and none of them quick really measured zero, while a day
  with fewer than five pickups was never judged at all. The branch painted the
  second at 1/5 and the text showed `—` on the first, so each half told its own
  lie. Days now carry whether they were judged; an unjudged day stays bare and
  a measured zero reads `0m`.
- Correcting a day no longer discards a week of fresh measurements that a
  background read was about to publish. One counter carried two different
  reasons to throw a landing read away, and only one of them makes its seven
  days stale.
- `export-perch.py --help` prints usage instead of creating a directory called
  `--help` and filling it.

### Changed

- The reconciler's four heaviest entry points state their input contracts,
  output semantics and failure conditions.

### Security

- The release packager refuses a bundle signed by a development team. A local
  install is deliberately team-signed — macOS gives a team-signed app the
  prefixed container the widget needs — but a Team ID is registered to a named
  person, so a published binary must never carry one.
- The README picture guard checks that the pictures exist and ship, not only
  that the three translations agree about them.

## [2.0] — 2026-08-25

### Added

- **The week under the bird.** The top row of the unfolded card is a branch
  running Monday to Sunday with the bird standing on today, each day lit by how
  much of it went by in flow. Hover a day to read it; press a day to say it was
  wrong.
- **Two durations, named apart.** `in flow` and `agents ran` are different
  things and no longer share a label. Parallel agents count once against the
  clock; summing them once reported a twelve-hour day as twenty-two.
- README in English, 简体中文 and 日本語, with a test that refuses to let the
  three drift apart.
- `CONTRIBUTING.md`, `SECURITY.md` and a code of conduct.

### Changed

- The version now lives in one place. The installer reads
  `CFBundleShortVersionString` instead of naming a version itself, which is why
  the island shipped as `1.0.55` long after the work was called 2.0.

### Removed

- **The presence recorder**, in full — sampling, judgement, both ledgers and
  the guards that held them. Its two stated reasons for existing had both
  stopped being true: no downstream tool reads its log, and the blind spot it
  was kept for turned out to be a broken input rather than something presence
  could fill.

## [1.0] — 2026-07-31

### Added

- First public release. Perch shows what your coding agents are doing —
  working, waiting on you, or done — in your Mac's notch, and turns the waiting
  into a minute your neck and eyes get back.
- Hooks for Claude Code and codex.
- Illustrated 30-second moves for neck, shoulders and eyes, paced by a beat and
  logged locally when you finish one.
- A prebuilt, ad-hoc signed app for people who would rather not install Xcode.
  The archive is packed deterministically: fixed timestamps, no extra fields,
  no comments, every byte accounted for.

[Unreleased]: https://github.com/mossfinch/perch/compare/v2.8...HEAD
[2.8]: https://github.com/mossfinch/perch/compare/v2.7...v2.8
[2.7]: https://github.com/mossfinch/perch/compare/v2.6...v2.7
[2.6]: https://github.com/mossfinch/perch/compare/v2.5...v2.6
[2.5]: https://github.com/mossfinch/perch/compare/v2.4...v2.5
[2.4]: https://github.com/mossfinch/perch/compare/v2.3...v2.4
[2.3]: https://github.com/mossfinch/perch/compare/v2.2...v2.3
[2.2]: https://github.com/mossfinch/perch/compare/v2.1...v2.2
[2.1]: https://github.com/mossfinch/perch/compare/v2.0...v2.1
[2.0]: https://github.com/mossfinch/perch/compare/v1.0...v2.0
[1.0]: https://github.com/mossfinch/perch/releases/tag/v1.0
