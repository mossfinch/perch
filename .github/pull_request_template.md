## What this changes, and why

<!-- The problem first. A patch is easier to judge when the reader knows what
     it is for. -->

## How you checked it

<!-- Which tests you ran, and what you saw with your own eyes. "Both suites
     green" is enough for a small fix; a behaviour change wants a sentence
     about what you watched the island actually do. -->

- [ ] `node --test tests/island-*.test.js` passes
- [ ] `python3 -m unittest discover tests` passes

## Does the README still tell the truth?

<!-- Several tests pin promises the README makes. If this changes what the app
     measures, shows, or refuses to claim, the three READMEs need to change
     with it — a test will tell you if you missed one. -->

- [ ] Nothing in the README needs to change
- [ ] The README changed, in all three languages
