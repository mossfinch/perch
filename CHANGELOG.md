# Changelog

Notable changes to Perch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mossfinch/perch/compare/v2.1...HEAD
[2.1]: https://github.com/mossfinch/perch/compare/v2.0...v2.1
[2.0]: https://github.com/mossfinch/perch/compare/v1.0...v2.0
[1.0]: https://github.com/mossfinch/perch/releases/tag/v1.0
