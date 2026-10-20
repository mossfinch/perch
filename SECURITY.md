# Security

## Reporting a vulnerability

Please report privately rather than in a public issue: open a
[security advisory](https://github.com/mossfinch/perch/security/advisories/new)
on this repository. That channel is private until an advisory is published.

Expect a reply within a week. If a fix is needed, it lands before the advisory
goes public.

## What is worth reporting

Perch runs on your own machine, has no accounts and no server, so the
interesting surface is narrow but real:

- Anything that lets data leave the machine. There is no networking code in
  this package by design; a path that reaches the network is a bug of the
  highest order here.
- Anything that lets another account on the Mac read or write
  `~/.perch/island`, which holds your agent event log — including the full path
  of every project you ran an agent in.
- Anything in the installers that writes outside its own entries, replaces a
  file it did not create, or leaves a config half-written.
- Anything that gets Perch's Terminal script to do more than select a tab and
  bring its window forward: type into a tab, run a command, or act on any app
  but Terminal. What arrives from a hook is only ever a parameter to that fixed
  script, never part of it.
- Anything that gets `perch-hook.sh` to do more than pass the event, the project
  folder, the host app and its session or Terminal tab to Perch's local socket. It
  runs inside your agent, outside Perch's sandbox, so nothing but its own code
  keeps it to that.
- Anything that gets `install.sh` to install something other than the release it
  names, to run with more than the user's own rights, or to touch anything besides
  `/Applications/Perch.app`. Its checksum guards the download; it cannot guard
  against the GitHub account that publishes both the script and the release being
  taken over, and that is documented, not a finding.
- Anything that puts identifying information into the published package. The
  export refuses on the ones it knows about; a shape it does not know about is
  worth telling us.

## What is not a vulnerability here

- The app is unsigned and ad-hoc signed on your own machine. That is the
  documented install path, not an oversight.
- The event log records project paths in plain text on your own disk. That is
  documented in the README, and deleting it is one command.
