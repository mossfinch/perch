#!/usr/bin/env python3
"""Copy Perch out of the internal working repo into a standalone source
directory fit for public release.

It exports only what the manifest allows, and finishes the tests and the
privacy checks before anything is handed over.
The script does not modify the source repo, and takes no part in running Perch.
It accepts exactly one command-line argument: an empty target directory.
The script copies include as perch-package.json lists it, excludes neverCopy,
strips whole-line agent notes, and rebases apps/mac-widget/ as the root of the
public package.
Once the copy is done, the script first runs the JavaScript and Python tests
inside the package.
Only after the tests does it scan what is finally on disk, which the tests
themselves may have written to.
The scan refuses neverCopy residue, surviving agent notes, and local identity.
Two control groups keep an empty scan or a dead matcher from printing a false
green.

Whole-directory copying is not an option: files outside the manifest can carry
local paths.
Once they are committed to public git history, deleting them later cannot undo
the leak.
The script uploads nothing and never runs git init.
The result is initialized as a repo only after a human has inspected it.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# In the working repo the script sits in apps/mac-widget; in the public package
# it sits at the repo root.
HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "perch-package.json"
# include paths are relative to the working repo's root; dropping that prefix
# yields the path inside the public package.
STRIP = "apps/mac-widget/"


def glob_to_re(g: str) -> re.Pattern:
    """Turn a manifest glob into a regex matching the whole relative path,
    with support for *, ** and **/.

    Never rewrite this as chained replaces: a later star substitution reworks
    what an earlier one produced, and double-star patterns end up matching only
    one level.
    """
    out = re.sub(r"\*\*/|\*\*|\*|[.+^${}()|[\]\\]",
                 lambda m: {"**/": "(?:.*/)?", "**": ".*", "*": "[^/]*"}.get(m.group(0), "\\" + m.group(0)),
                 g)
    return re.compile("^" + out + "$")


# The tag is kept in pieces so this file does not trip its own residue check
# inside the public package.
AIDEV = "AIDEV"
# Both the strip and the residue scan ignore case; a different case is not a
# licence to ship.
NOTE_LINE = re.compile(r"\s*(#|//)\s*" + AIDEV + r"-(NOTE|TODO|QUESTION)\b", re.I)


def strip_notes(text: str):
    """Drop whole-line agent notes; return the new text and how many lines went.

    The notes belong to the working repo alone. A note sharing a line with code
    cannot be trimmed safely, so it survives into the scan below and fails the
    export.
    """
    lines = text.split("\n")
    kept = [l for l in lines if not NOTE_LINE.match(l)]
    return "\n".join(kept), len(lines) - len(kept)


# Searching for this machine's username and home path is not enough.
# The general patterns must also recognise macOS user paths and addresses from
# other clones.
PRIVATE_PATTERNS = [
    re.compile(rb"/Users/[a-z]", re.I),
    re.compile(rb"[\w.+-]+@[\w-]+\.[a-z]{2,}", re.I),
    # An Apple Team ID identifies a paid developer-program membership, not a
    # person — but it is stable and account-bound, so publishing one links this
    # source to a private membership. That is why it belongs with the username
    # and the home path rather than with the build settings.
    # Only an ASSIGNED one counts: a bare ten-character token is far too common
    # to refuse, and the tests deliberately carry fake ones (ABCDE12345) to
    # prove a team-prefixed group id is tolerated. This shape is the one that
    # arrives without anyone typing it — Xcode writes it into the project the
    # moment automatic signing is switched on.
    re.compile(rb"DEVELOPMENT_TEAM\s*=\s*[\"\']?[A-Z0-9]{10}"),
]


def local_team_ids(root: Path) -> list:
    """The Team ID this project is locally configured to build with, to be
    refused by exact match.

    `Config.xcconfig` is where the real one lives, and it is already on the
    neverCopy list — but a copy of the value can reach a file that IS shipped
    (a project stamped by Xcode, a plist), and then no pattern above would know
    it from any other ten characters. Reading it here turns the configured team
    into a term, exactly like the username.

    Missing file, or a template with no team, yields nothing: an installer that
    builds ad-hoc has no Team ID to leak.
    """
    cfg = root / "Config.xcconfig"
    if not cfg.exists():
        return []
    found = []
    for line in cfg.read_text(errors="replace").splitlines():
        if line.lstrip().startswith("//"):
            continue
        key, sep, value = line.partition("=")
        if sep and key.strip() == "DEVELOPMENT_TEAM":
            team = value.strip().strip('"\'')
            if team:
                found.append(team)
    return found


def private_hit(buf: bytes, terms):
    """Return the first thing in these bytes that must never ship; None when
    nothing hits.

    terms carries this machine's exact username and home path.
    The general patterns additionally recognise macOS user paths and addresses.
    Kept a pure function so the control group can hand it assembled bytes and
    prove every matching branch really does refuse its input.
    """
    for t in terms:
        if t and t.encode() in buf:
            return f"local identity ({t})"
    for p in PRIVATE_PATTERNS:
        m = p.search(buf)
        if m:
            return repr(m.group(0)[:60])
    return None


def scan_for_leaks(target: Path, landed, terms, matcher=private_hit):
    """Scan every landed file and run both control groups; return the failure
    message or None.

    landed must list file paths relative to target.
    matcher receives a file's bytes and terms.
    The controls belong to the same call as the scan, so the scan cannot be kept
    while the controls are dropped.
    matcher is a test seam: handed a matcher that recognises nothing, the bite
    control must fail.
    """
    saw_known = False
    for f in landed:
        buf = (target / f).read_bytes()
        if b"IslandCardShape" in buf:
            saw_known = True
        hit = matcher(buf, terms)
        if hit:
            return f"Leak: {f} contains {hit}"
        # Any complete note marker must be refused, because a note sharing a
        # line with code escapes the whole-line strip.
        # It is not folded into matcher: a note is not identity, and the failure
        # message is a different one.
        if re.search((AIDEV + "-").encode(), buf, re.I):
            return (f"Leak: {f} carries an unstripped {AIDEV} note — "
                    "notes must sit on their own line to be stripped")
    # Control A proves the scan really read a file in the package. Rename the
    # required symbol and this probe must move with it.
    if not saw_known:
        return ("Control group failed: even a string that must exist was not seen — the scan "
                "never read the contents, so this green cannot be trusted.")
    # Control B proves the matcher really refuses, with one planted sample per
    # matching branch.
    # The samples must be assembled, because the privacy guard scans this file
    # too and no complete identity shape may land here as a literal.
    probes = [b"x " + b"/Users" + b"/someone/y",
              b"x someone" + b"@" + b"example.com y",
              b"DEVELOPMENT" + b"_TEAM = " + b"A1B2C3D4E5",
              (terms[0] or "?").encode()]
    for probe in probes:
        if matcher(probe, terms) is None:
            return (f"Control group failed: the scan let {probe[:40]!r} through. It is not "
                    "detecting anything, so its silence on the real files means nothing.")
    return None


def ran_count(output: str) -> int:
    """Parse how many tests actually ran out of the unittest summary; -1 when
    there is no summary.

    unittest discover can exit 0 having found nothing, so the return code cannot
    tell "the tests passed" from "no test was executed".
    """
    m = re.search(r"^Ran (\d+) tests? in ", output, re.M)
    return int(m.group(1)) if m else -1


USAGE = """Usage: python3 {name} <empty target directory>

Copies the public Perch package out of this working repository into a fresh
directory: the files the manifest lists, agent notes stripped, tests run inside
the copy, and a scan that refuses anything carrying local identity.

It never runs `git init` and never publishes. Look at the result yourself, then
put it wherever it is going.
"""


def main() -> None:
    name = Path(sys.argv[0]).name
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help", "help"):
        print(USAGE.format(name=name))
        return
    if len(args) != 1:
        raise SystemExit(USAGE.format(name=name))
    # ⚠️ Anything option-shaped is refused rather than taken literally. Without
    # this, `--help` was not a request for help — it was a directory named
    # `--help`, created and filled, which is the least expected thing a script
    # can do to somebody reading it for the first time.
    if args[0].startswith("-"):
        raise SystemExit(f"{name}: '{args[0]}' looks like an option, not a directory.\n"
                         f"Run `python3 {name} --help` for what this does, or pass a path "
                         f"that does not start with '-'.")
    target = Path(args[0]).resolve()
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"Target directory is not empty; refusing to pour into it: {target}\n"
                         "Extraction must start from an empty directory — with stray files mixed in, "
                         "nobody can promise the package holds only what the manifest lists.")
    root = HERE if (HERE / "Perch").is_dir() else None
    if root is None or not MANIFEST.exists():
        raise SystemExit("Perch/ or perch-package.json not found — this script must sit next to them.")
    # In the working-repo layout the include roots live two levels up; in the
    # public package the current root is used directly.
    src_root = root.parent.parent if (root.parent.parent / "tests").is_dir() and root.name == "mac-widget" else root

    man = json.loads(MANIFEST.read_text())
    never = [glob_to_re(g) for g in man["neverCopy"]]

    copied, dropped, noted = [], [], 0
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
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, ValueError):
                pass                     # a binary file carries no text notes
            else:
                text, went = strip_notes(text)
                if went:
                    out.write_text(text, encoding="utf-8")
                    noted += went
            copied.append(str(out.relative_to(target)))

    # The public manifest must work as-is in the rebased directory, so include
    # paths lose the working-repo prefix.
    # It keeps the public preamble, include and neverCopy; excludedOnPurpose is
    # a working-repo note and not part of the public contract.
    # The guards decide the file boundary from include and neverCopy alone; the
    # underscore field is for humans to read.
    man_out = target / "perch-package.json"
    man_new = {
        "_": ["The single manifest of the Perch public package: the privacy guard scans everything",
              "include expands to (dotfiles count), and export-perch.py copies by it. To keep something",
              "out of the scan, the only way is an explicit neverCopy entry with a reason."],
        "include": sorted(i[len(STRIP):] if i.startswith(STRIP) else i for i in man["include"]),
        "neverCopy": man["neverCopy"],
    }
    man_out.write_text(json.dumps(man_new, ensure_ascii=False, indent=2) + "\n")

    # Self-check 1: run the tests in the public-package layout first. The tests
    # may write files, so they must come before the final scan.
    # PYTHONDONTWRITEBYTECODE keeps Python from caching; the scan below still
    # checks everything on disk at scan time.
    print(f"Copied {len(copied)} files; neverCopy blocked {len(dropped)}; stripped {noted} agent notes.")
    print("Running the tests inside the copied directory...")
    import os
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run(["node", "--test", "tests/island.test.js"], cwd=target, env=env)
    if r.returncode != 0:
        raise SystemExit("Tests fail in the copied package — this directory is unusable; fix and extract again.")

    # Both the JavaScript and the Python suite must run after extraction, or the
    # package can keep a failing test nobody ever executes.
    # Python is discovered by the *_test.py pattern, so a new test is not missed
    # for being absent from a hardcoded filename.
    # unittest rather than a third-party runner keeps the public package
    # dependency-free; -B keeps this verification from leaving caches behind.
    r = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover",
                        "-s", "tests", "-p", "*_test.py"],
                       cwd=target, env=env, capture_output=True, text=True)
    # unittest writes its summary to stderr, so both streams are forwarded
    # verbatim.
    sys.stderr.write(r.stderr)
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        raise SystemExit("Python tests fail in the copied package — this directory is unusable; fix and extract again.")
    ran = ran_count(r.stderr)
    if ran < 1:
        raise SystemExit(
            f"The python suite reported {ran} tests — a green that means nothing. "
            "Discovery found no test file in tests/, so this gate just waved the package "
            "through without checking anything. Fix the manifest or the pattern, then extract again.")
    print(f"Python suite really ran {ran} tests.")

    # Self-check 2: re-walk what is on disk now, so no neverCopy residue
    # survives what the tests wrote.
    # The copy-time bookkeeping may not be reused, because it cannot see files
    # added afterwards.
    landed = sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_file())
    bad = [f for f in landed if any(p.search(f) or p.match(f) for p in never)]
    if bad:
        raise SystemExit("neverCopy hits in the landed result; extraction failed:\n  " + "\n  ".join(bad))

    # Self-check 3: scan for local identity and surviving agent notes, and run
    # the read and match controls.
    import getpass
    terms = [getpass.getuser(), str(Path.home())] + local_team_ids(HERE)
    problem = scan_for_leaks(target, landed, terms)
    if problem:
        raise SystemExit(problem)
    print(f"Landed {len(landed)} files; zero neverCopy residue; zero private-term hits (control group passed).")

    print(f"\nDone: {target}")
    print("Next step (manual; this script never does it): eyeball the result -> then git init yourself.")


if __name__ == "__main__":
    main()
