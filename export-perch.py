#!/usr/bin/env python3
"""Copy the Perch public package into an empty directory, manifest-driven.
**This is the only sanctioned way to extract the package.**

Why a script and not `cp -R`: copying the include roots wholesale drags along
editor/session droppings (e.g. `.omc/` files) — command replays with full
home-directory paths inside. One `git add .` and they are in public history,
where deleting never really deletes.

It does four things, each failing loudly:
  1. Copy only what `perch-package.json` includes (the single source of
     truth); nothing matching neverCopy touches the disk, not one byte;
  2. Rebase the layout: `apps/mac-widget/` becomes the new repo's root, the
     prefix is stripped, and the copied manifest's paths are rewritten to
     match — so the guard tests scan by the same manifest in the new home;
  3. Self-check after copying: zero neverCopy residue, zero private-term hits
     (with a control group — "scanned nothing, then all green" is exactly the
     false green this guards against);
  4. ACTUALLY run the tests inside the copied directory.

**This script never runs git init.** A human must eyeball the result before
initializing — that step is the process, not an omission.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # = apps/mac-widget/ in the mother repo, or the Perch repo root
MANIFEST = HERE / "perch-package.json"
# include paths are written from the mother repo's root; stripping this prefix
# yields the path inside the new repo
STRIP = "apps/mac-widget/"


def glob_to_re(g: str) -> re.Pattern:
    """The same single-pass translation as the privacy guard
    (tests/island.test.js).
    ⚠️ Never write this as chained replaces: a later step's `*` eats an
    earlier step's `.*` output, and `**/.omc/**` only matches one level."""
    out = re.sub(r"\*\*/|\*\*|\*|[.+^${}()|[\]\\]",
                 lambda m: {"**/": "(?:.*/)?", "**": ".*", "*": "[^/]*"}.get(m.group(0), "\\" + m.group(0)),
                 g)
    return re.compile("^" + out + "$")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: python3 {Path(sys.argv[0]).name} <empty target directory>")
    target = Path(sys.argv[1]).resolve()
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"Target directory is not empty; refusing to pour into it: {target}\n"
                         "Extraction must start from an empty directory — with stray files mixed in, "
                         "nobody can promise the package holds only what the manifest lists.")
    root = HERE if (HERE / "Perch").is_dir() else None
    if root is None or not MANIFEST.exists():
        raise SystemExit("Perch/ or perch-package.json not found — this script must sit next to them.")
    # In the mother-repo layout the include roots live two levels up (tests/,
    # artifacts/ are not in this directory)
    src_root = root.parent.parent if (root.parent.parent / "tests").is_dir() and root.name == "mac-widget" else root

    man = json.loads(MANIFEST.read_text())
    never = [glob_to_re(g) for g in man["neverCopy"]]

    copied, dropped = [], []
    for inc in man["include"]:
        src = src_root / inc
        if not src.exists():
            raise SystemExit(f"{inc} from the manifest does not exist — the manifest drifted; fix it before extracting.")
        dest_rel = inc[len(STRIP):] if inc.startswith(STRIP) else inc
        files = sorted(p for p in src.rglob("*") if p.is_file()) if src.is_dir() else [src]
        for f in files:
            rel = inc + "/" + str(f.relative_to(src)) if src.is_dir() else inc
            if any(p.search(rel) or p.match(rel) for p in never):
                dropped.append(rel)
                continue
            out = target / (dest_rel + ("/" + str(f.relative_to(src)) if src.is_dir() else ""))
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, out)
            copied.append(str(out.relative_to(target)))

    # The copied manifest must work as-is in the new home: include paths lose
    # the prefix. And it ships **only include + neverCopy**: the upstream `_`
    # preamble and excludedOnPurpose are working notes for the repo it came
    # from, not part of this package's contract. The guard reads only include
    # and neverCopy, so the public manifest is complete with those two.
    man_out = target / "perch-package.json"
    man_new = {
        "_": ["The single manifest of the Perch public package: the privacy guard scans everything",
              "include expands to (dotfiles count), and export-perch.py copies by it. To keep something",
              "out of the scan, the only way is an explicit neverCopy entry with a reason."],
        "include": sorted(i[len(STRIP):] if i.startswith(STRIP) else i for i in man["include"]),
        "neverCopy": man["neverCopy"],
    }
    man_out.write_text(json.dumps(man_new, ensure_ascii=False, indent=2) + "\n")

    # ---- Self-check 1: really run the tests in the new home. **Must come
    # BEFORE the scan** — the tests themselves write files into the directory
    # (e.g. python bytecode caches, .pyc, with machine paths embedded); run
    # them after the scan and some of what lands on disk was never scanned.
    # PYTHONDONTWRITEBYTECODE turns the cache off; the scan below still
    # backstops (it scans everything present at scan time).
    print(f"Copied {len(copied)} files; neverCopy blocked {len(dropped)}.")
    print("Running the tests inside the copied directory...")
    import os
    r = subprocess.run(["node", "--test", "tests/island.test.js"], cwd=target,
                       env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    if r.returncode != 0:
        raise SystemExit("Tests fail in the copied package — this directory is unusable; fix and extract again.")

    # ---- Self-check 2: zero neverCopy residue. Re-walk what is on disk AT
    # THIS MOMENT; never trust the copy-time bookkeeping — whatever the
    # previous step wrote into the directory must be seen here. ----
    landed = sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_file())
    bad = [f for f in landed if any(p.search(f) or p.match(f) for p in never)]
    if bad:
        raise SystemExit("neverCopy hits in the landed result; extraction failed:\n  " + "\n  ".join(bad))

    # ---- Self-check 3: private-term scan (with a control group) ----
    import getpass
    terms = [getpass.getuser(), str(Path.home())]
    patterns = [re.compile(rb"/Users/[a-z]", re.I), re.compile(rb"[\w.+-]+@[\w-]+\.[a-z]{2,}", re.I)]
    saw_known = False
    for f in landed:
        buf = (target / f).read_bytes()
        if b"IslandCardShape" in buf:
            saw_known = True
        for t in terms:
            if t.encode() in buf:
                raise SystemExit(f"Leak: {f} contains local identity ({t})")
        for p in patterns:
            m = p.search(buf)
            if m:
                raise SystemExit(f"Leak: {f} contains {m.group(0)[:60]!r}")
    if not saw_known:
        raise SystemExit("Control group failed: even a string that must exist was not seen — the scan "
                         "never read the contents, so this green cannot be trusted.")
    print(f"Landed {len(landed)} files; zero neverCopy residue; zero private-term hits (control group passed).")

    print(f"\nDone: {target}")
    print("Next step (manual; this script never does it): eyeball the result -> then git init yourself.")


if __name__ == "__main__":
    main()
