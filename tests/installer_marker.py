"""Extract the ownership-marker pieces from the hook installers' source, so
tests can run the REAL matcher functions.

Why not just import the installer: at module level it reads the installed
app's Info.plist and SystemExits when the island is not installed. Tests must
not depend on "whether this machine has it installed".

Why a separate file: both `install-island-hooks.py` and
`install-codex-island-hooks.py` tests need it; two copies would drift. And
embedding this in a JS template string means nested escaping too brittle to
trust — JS eats one layer of backslashes in `"\\n".join(...)` and silently
turns it into a syntax error.

Cut by LINE, not by regex: the marker's pattern strings contain `)`, and a
non-greedy regex truncates there.
"""
import pathlib
import re


def _block(lines, start):
    """From line `start`, take until the next flush-left (unindented) line —
    one whole function body."""
    out = [lines[start]]
    for line in lines[start + 1:]:
        if line and not line[0].isspace():
            break
        out.append(line)
    return "\n".join(out)


def load_functions(rel_path, names, ns=None):
    """Pull the named top-level functions out of a script and exec them.
    `ns` preloads whatever they depend on."""
    lines = pathlib.Path(rel_path).read_text().split("\n")
    ns = dict(ns or {})
    ns.setdefault("re", re)
    for name in names:
        start = next((i for i, l in enumerate(lines) if l.startswith("def " + name + "(")), None)
        if start is not None:
            # The future import travels with the extracted block: the
            # installers rely on it for `X | None` annotations, and without it
            # here those annotations would be evaluated at def time and fail on
            # macOS's stock python 3.9.
            exec("from __future__ import annotations\n" + _block(lines, start), ns)
    return ns


def load_marker(rel_path):
    """Return a namespace holding the installer's real ownership matcher and
    upsert.

    ⚠️ Every function `upsert` calls has to be listed here too — an extracted
    function only sees this namespace, so a missing helper surfaces as a
    NameError when the test runs it.
    """
    lines = pathlib.Path(rel_path).read_text().split("\n")
    ns = {"re": re}

    a = next(i for i, l in enumerate(lines) if l.startswith("OWN_ARTIFACTS = "))
    b = next(i for i, l in enumerate(lines[a:], a) if l.startswith("WIRE_PATTERN = "))
    exec("\n".join(lines[a:b + 1]), ns)

    return load_functions(
        rel_path,
        ("is_perch_command", "is_perch", "is_purely_perch", "perch_addresses",
         "upsert", "foreign_hooks"),
        ns,
    )
