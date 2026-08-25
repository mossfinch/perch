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
- Anything that lets another local process read or write Perch's App Group
  container, which holds your agent event log — including the full path of
  every project you ran an agent in.
- Anything in the installers that writes outside its own entries, replaces a
  file it did not create, or leaves a config half-written.
- Anything that puts identifying information into the published package. The
  export refuses on the ones it knows about; a shape it does not know about is
  worth telling us.

## What is not a vulnerability here

- The app is unsigned and ad-hoc signed on your own machine. That is the
  documented install path, not an oversight.
- The event log records project paths in plain text on your own disk. That is
  documented in the README, and deleting it is one command.
