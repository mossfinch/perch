#!/usr/bin/env python3
"""Package a built Perch.app into the release zip, and prove the zip is clean.

Why this is a separate script and not a line in the installer: **the zip is
what ships**, and until now every check in this project ran against something
else — the repository, or the bundle. A bundle can be spotless while the
archive beside it carries the debug symbols, because they are siblings on disk
and a check that walks the bundle cannot see them.

So the input here is one `.app` path, never a directory to sweep. Anything that
is not inside that bundle is structurally unable to end up in the archive.

The packaging flags are not decoration. Measured on this machine, against a
bundle carrying quarantine, a custom xattr and a resource fork:

    tar -czf                 ustar header writes the owner's account name
    zip -r                   0x7875 extra carries the numeric uid; the DOS
                             timestamp is local wall time, and subtracting it
                             from a release's public UTC publish time yields
                             the packer's timezone
    ditto -c -k              __MACOSX/._* sidecars, carrying the xattrs whole
    hdiutil (dmg)            all of the above
    TZ=UTC ditto + the flags below   none of it

Run it:

    python3 package-release.py /path/to/Perch.app       # writes ./Perch-<ver>.zip
"""

from __future__ import annotations

import argparse
import calendar
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# A fixed stamp, so the archive says nothing about when — or during which hours
# of which day — it was built. It has to be >= 1980: the zip format's DOS
# timestamp cannot represent anything earlier, and out-of-range values get
# silently clamped rather than rejected.
EPOCH = calendar.timegm((2026, 1, 1, 0, 0, 0, 0, 0, 0))

# Path components that must never appear in a release archive. These are not
# "scan them for secrets" cases — they have no business shipping at all, and
# rejecting by name catches them a step earlier than searching their bytes.
BANNED_COMPONENT_SUFFIX = (".dSYM", ".swiftmodule", ".swiftsourceinfo",
                           ".swiftdoc", ".swiftinterface", ".build")
SIDECAR_PREFIX = "._"
SIDECAR_DIR = "__MACOSX"

# Compressed payloads hide text from a plain byte scan, so an archive inside
# the archive is refused outright rather than opened and searched.
ARCHIVE_MAGIC = (b"PK\x03\x04", b"\x1f\x8b", b"BZh", b"\xfd7zXZ")

BUILD_PATH_ROOT = "/Users/"


def needles() -> list[tuple[bytes, str]]:
    """The same string in every encoding a Mach-O or a plist might store it in.

    A raw `find(b"/Users/")` reads only the ASCII case. UTF-16 is not exotic
    here — plists and some resource formats use it — and it sails straight
    through a byte search written for one encoding.
    """
    return [(BUILD_PATH_ROOT.encode(enc), enc)
            for enc in ("utf-8", "utf-16-le", "utf-16-be")]


def run(cmd: list[str], **kwargs) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kwargs)


def stage(app: Path, into: Path) -> Path:
    """Copy the bundle aside and flatten its timestamps.

    Copied rather than packed in place because the timestamps get rewritten:
    the original stays byte-for-byte untouched, and whatever sits next to it on
    disk stays out of reach.
    """
    dest = into / app.name
    shutil.copytree(app, dest, symlinks=True)
    for root, dirs, files in os.walk(dest, topdown=False):
        for name in files + dirs:
            p = Path(root) / name
            if not p.is_symlink():
                os.utime(p, (EPOCH, EPOCH))
    os.utime(dest, (EPOCH, EPOCH))
    return dest


def pack(app: Path, out: Path) -> None:
    if out.exists():
        out.unlink()
    run(["ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl",
         "--keepParent", str(app), str(out)],
        env=dict(os.environ, TZ="UTC"))


def extra_field_ids(extra: bytes) -> list[int]:
    """Walk the zip extra field's TLVs. 0x7875 is the one that carries uid/gid."""
    ids, at = [], 0
    while at + 4 <= len(extra):
        (kind, size) = struct.unpack("<HH", extra[at:at + 4])
        ids.append(kind)
        at += 4 + size
    return ids


def audit(zip_path: Path) -> None:
    """Everything the archive must not be. Raises SystemExit on the first hit.

    Kept separate from packing so it can run against an archive nobody here
    produced — the point is to check the artifact, not to trust the producer.
    """
    with zipfile.ZipFile(zip_path) as z:
        infos = z.infolist()
        if not any(i.filename.endswith(".app/Contents/MacOS/Perch") for i in infos):
            raise SystemExit(
                f"{zip_path.name} does not contain Perch's executable — "
                "refusing to call an archive clean when it may hold nothing at all")

        for i in infos:
            parts = [p for p in i.filename.split("/") if p]
            for part in parts:
                if part == SIDECAR_DIR or part.startswith(SIDECAR_PREFIX):
                    raise SystemExit(f"{i.filename}: resource-fork sidecar, refusing to ship it")
                if part.endswith(BANNED_COMPONENT_SUFFIX):
                    raise SystemExit(
                        f"{i.filename}: build by-product (debug symbols or Swift module), "
                        "refusing to ship it — these carry the builder's absolute source paths")

            if 0x7875 in extra_field_ids(i.extra):
                raise SystemExit(
                    f"{i.filename}: zip entry carries the packer's numeric uid (0x7875 extra). "
                    "Pack with ditto and the flags in pack(), not with `zip`.")

            if i.is_dir():
                continue
            buf = z.read(i)
            if buf[:6].startswith(ARCHIVE_MAGIC):
                raise SystemExit(
                    f"{i.filename}: a compressed archive inside the archive. Its bytes cannot "
                    "be scanned as text, so it is refused rather than trusted.")
            for needle, enc in needles():
                at = buf.find(needle)
                if at != -1:
                    sample = buf[at:at + 120].decode(enc, "replace").split("\x00")[0]
                    raise SystemExit(
                        f"{i.filename}: carries a build-machine path ({enc}), refusing to ship it:\n"
                        f"  {sample}")

    print(f"Audited {zip_path.name}: no sidecars, no build by-products, no packer identity, "
          "no build-machine paths in any of " + ", ".join(e for _, e in needles()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Package a built Perch.app for release, and audit the result.")
    parser.add_argument("app", type=Path, help="Path to the built Perch.app")
    parser.add_argument("-o", "--out", type=Path, help="Output zip (default: ./<AppName>.zip beside this script)")
    opts = parser.parse_args()

    app = opts.app.resolve()
    if app.suffix != ".app" or not app.is_dir():
        raise SystemExit(f"{app} is not an .app bundle")
    out = (opts.out or Path.cwd() / f"{app.stem}.zip").resolve()

    with tempfile.TemporaryDirectory() as tmp:
        staged = stage(app, Path(tmp))
        pack(staged, out)
    audit(out)
    print(f"\n{out}  ({out.stat().st_size // 1024} KB)")
    print("Upload this file and nothing else: no .dSYM, no .swiftmodule, no build directory.")


if __name__ == "__main__":
    main()
