# Contributing

Perch is a small, single-purpose app maintained by one person. Issues and pull
requests are welcome; a note about how the project works will save you time.

## Before you open a pull request

Say what you want to change first, in an issue. Perch is opinionated about
what it measures and what it refuses to claim, and a change that crosses one of
those lines is better discussed than discovered at review time. Small fixes —
a typo, a broken path, a wrong number — need no discussion; just send them.

## Running the tests

```bash
node --test tests/island.test.js
```

```bash
python3 -m unittest discover tests
```

Both suites must pass. They are not only about behaviour: several of them pin
promises the README makes to a reader, so a change to what the app does often
needs a change to what the README says, and the tests will tell you which.

## What the tests will refuse

- **A guard with no control group.** A check that has never been shown to fail
  is not evidence. Every scan here plants something it must catch first.
- **A claim the code cannot back.** Comments and README text are held to what
  the implementation actually does; if you loosen a threshold, say so where a
  reader will see it.
- **English-facing strings in another language.** Anything a person reads on
  the island is English; the translated READMEs are the place for other
  languages, and a test keeps the three of them from drifting apart.

## Comments

Write for a stranger reading this file for the first time — not for the next
person to review your diff. Explain why the code has the shape it has, not the
order in which you arrived at it.

## License

By contributing you agree that your contribution is licensed under the MIT
License, the same as the rest of this project.
