#!/usr/bin/env python3
"""Package a built Perch.app into the release zip, and prove the zip is exactly that bundle.

Why this is a separate script and not a line in the installer: **the zip is
what ships**, and until now every check in this project ran against something
else — the repository, or the bundle. A bundle can be spotless while the
archive beside it carries the debug symbols, because they are siblings on disk
and a check that walks the bundle cannot see them.

So the input here is one `.app` path, never a directory to sweep. Anything that
is not inside that bundle is structurally unable to end up in the archive.

**The archive is written here rather than shelled out to a packer.** Measured
on this machine, every packer stamps the archive with something about the
machine that ran it:

    tar -czf                 ustar header writes the owner's account name
    zip -r                   0x7875 extra carries the numeric uid; the DOS
                             timestamp is local wall time, and subtracting it
                             from a release's public UTC publish time yields
                             the packer's timezone
    ditto -c -k              __MACOSX/._* sidecars, carrying the xattrs whole
    ditto with every "clean" flag it has, under TZ=UTC
                             still writes an 0x5855 extra into each **local**
                             header carrying the packer's uid and gid
    hdiutil (dmg)            all of the above

The last row is why this script no longer calls a packer at all. Chasing it
with one more banned field would repeat the mistake that produced it: the old
gate refused 0x7875 because that is what `zip` writes, the packing command
later changed to `ditto`, and the needle stayed pointed at the previous
packer's field. Naming known-bad fields cannot terminate. Declaring the whole
archive can, so every entry below is written with its extra and comment
explicitly empty, and the audit refuses anything it did not declare.

**The audit parses the archive's raw bytes rather than reading it through
zipfile.** `ZipInfo.extra` exposes only the *central directory* copy of an
entry's extra field; the uid above lives only in the *local* header, where that
view structurally cannot reach it — the same shape as the bundle-vs-archive
mistake this file exists to prevent.

Run it:

    python3 package-release.py /path/to/Perch.app       # writes ./Perch-<ver>.zip
"""

from __future__ import annotations

import argparse
import hashlib
import os
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import NamedTuple

# A fixed stamp, so the archive says nothing about when — or during which hours
# of which day — it was built. It has to be >= 1980: the zip format's DOS
# timestamp cannot represent anything earlier, and out-of-range values get
# silently clamped rather than rejected.
EPOCH_DOS = (2026, 1, 1, 0, 0, 0)

EXEC_SUBPATH = "Contents/MacOS/Perch"

# Path components that have no business shipping at all. The manifest already
# excludes the ones that live *beside* the bundle; this catches the day a build
# starts leaving them *inside* it, which is the only way they could get in now.
BANNED_COMPONENT_SUFFIX = (".dSYM", ".swiftmodule", ".swiftsourceinfo",
                           ".swiftdoc", ".swiftinterface", ".build")
SIDECAR_PREFIX = "._"
SIDECAR_DIR = "__MACOSX"

# An opaque compressed payload cannot be read as text, so its bytes would ship
# unscanned. Nothing in the bundle should be one; if a future build adds one,
# stop rather than wave it through.
ARCHIVE_MAGIC = (b"PK\x03\x04", b"\x1f\x8b", b"BZh", b"\xfd7zXZ")

BUILD_PATH_ROOT = "/Users/"

# Zip's fixed-size records. Named here because the audit reads them by hand.
LOCAL_SIG, CENTRAL_SIG, EOCD_SIG = b"PK\x03\x04", b"PK\x01\x02", b"PK\x05\x06"
LOCAL_HEADER_LEN, CENTRAL_HEADER_LEN, EOCD_LEN = 30, 46, 22

# Bit 11 says "the filename is UTF-8". It is the only general-purpose flag an
# archive written here may carry; every other bit means encryption, a data
# descriptor, or a compression option none of which this packer emits.
FLAG_UTF8_NAME = 0x800


class Entry(NamedTuple):
    """One declared member of the archive. `digest` is "" for directories."""
    is_dir: bool
    mode: int
    digest: str


def needles() -> list[tuple[bytes, str]]:
    """The build-path root in every encoding a Mach-O or a plist might use.

    A raw `find(b"/Users/")` reads only the ASCII case. UTF-16 is not exotic
    here — plists and some resource formats use it — and UTF-32 sails past a
    search written for the other two.

    Lowercased, because the buffer is lowercased before searching: `bytes.lower`
    touches only ASCII A-Z, so in every encoding here the padding bytes are left
    alone and one pass covers both casings.
    """
    return [(BUILD_PATH_ROOT.lower().encode(enc), enc)
            for enc in ("utf-8", "utf-16-le", "utf-16-be", "utf-32-le", "utf-32-be")]


def run(cmd: list[str], **kwargs) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kwargs)


def manifest(app: Path) -> dict[str, Entry]:
    """Declare exactly what the archive must contain, read off the real bundle.

    This is the whole point of the redesign: the audit downstream compares the
    archive against this and refuses any difference in either direction, so a
    field, an entry or a byte that nothing here declared cannot ship.
    """
    want: dict[str, Entry] = {}

    def add(p: Path) -> None:
        rel = p.relative_to(app.parent).as_posix()
        if p.is_symlink():
            raise SystemExit(
                f"{rel}: symlink inside the bundle. This packer writes plain files only, "
                "so it would silently ship the link's target instead — refusing rather than guessing.")
        for part in rel.split("/"):
            if part == SIDECAR_DIR or part.startswith(SIDECAR_PREFIX):
                raise SystemExit(f"{rel}: resource-fork sidecar, refusing to ship it")
            if part.endswith(BANNED_COMPONENT_SUFFIX):
                raise SystemExit(
                    f"{rel}: build by-product (debug symbols or Swift module) inside the bundle, "
                    "refusing to ship it — these carry the builder's absolute source paths")
        # The FULL st_mode, file-type bits included, not just the permissions.
        # ditto reads an entry whose mode lacks S_IFREG/S_IFDIR as not-Unix and
        # falls back to 0644, which costs the executable its execute bit and the
        # app its ability to launch. `unzip` honours the permissions either way,
        # so it cannot be the tool this is verified with — see prove_extractable.
        mode = p.lstat().st_mode & 0xFFFF
        if p.is_dir():
            want[rel + "/"] = Entry(True, mode, "")
        else:
            want[rel] = Entry(False, mode, hashlib.sha256(p.read_bytes()).hexdigest())

    add(app)
    for p in sorted(app.rglob("*")):
        add(p)

    if f"{app.name}/{EXEC_SUBPATH}" not in want:
        raise SystemExit(
            f"{app.name} has no {EXEC_SUBPATH} — refusing to call an archive clean "
            "when it may hold nothing that runs")
    return want


def pack(app: Path, out: Path, want: dict[str, Entry]) -> None:
    """Write the archive entry by entry, so nothing gets stamped on it unasked.

    Every field a packer would fill in from the machine is set here instead:
    the timestamp is fixed, the extra and comment fields stay empty, and the
    permission bits are the bundle's own rather than the umask's.
    """
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w") as z:
        for name, e in want.items():
            info = zipfile.ZipInfo(name, date_time=EPOCH_DOS)
            # Unix, or the mode below is ignored on extraction and the
            # executable comes out without its execute bit.
            info.create_system = 3
            info.external_attr = (e.mode & 0xFFFF) << 16
            if e.is_dir:
                info.external_attr |= 0x10          # MS-DOS directory flag
                info.compress_type = zipfile.ZIP_STORED
                z.writestr(info, b"")
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, (app.parent / name).read_bytes())


def _u16(buf: bytes, at: int) -> int:
    return struct.unpack_from("<H", buf, at)[0]


def _u32(buf: bytes, at: int) -> int:
    return struct.unpack_from("<I", buf, at)[0]


def dos_datetime(date: int, time: int) -> tuple[int, int, int, int, int, int]:
    """Decode zip's packed DOS date and time into the tuple EPOCH_DOS is written in."""
    return ((date >> 9) + 1980, (date >> 5) & 0xF, date & 0x1F,
            time >> 11, (time >> 5) & 0x3F, (time & 0x1F) * 2)


def read_structure(raw: bytes) -> list[dict]:
    """Account for **every byte** of the archive, from 0 to EOF.

    Read by hand because `zipfile` shows only the central directory's copy of
    each entry's extra field, and the packer identity that prompted this rewrite
    lived in the local headers alone.

    Byte accounting rather than boundary checks, because checking boundaries is
    the same losing game as naming bad fields. An earlier version verified three
    of them — nothing before the first local header, nothing after the end
    record, central directory reaching the end record — and still passed an
    archive with the builder's paths sitting in the unchecked span between the
    last file's data and the central directory, while printing "no bytes outside
    the records". Every span has to be claimed by a record, or the claim is not
    worth making: the cursor below starts at 0, is handed from one record to the
    next, and must land exactly on EOF.
    """
    eocd = len(raw) - EOCD_LEN
    if eocd < 0 or raw[eocd:eocd + 4] != EOCD_SIG:
        raise SystemExit("archive does not end with its end-of-central-directory record — "
                         "there are trailing bytes, or an archive comment, and both carry content")
    if _u16(raw, eocd + 20) != 0:
        raise SystemExit("archive claims a comment; refusing to ship a field nothing declared")
    if _u16(raw, eocd + 4) or _u16(raw, eocd + 6):
        raise SystemExit("archive claims to be one volume of a multi-part set — "
                         "the other parts are not here and nothing accounts for them")
    if _u16(raw, eocd + 8) != _u16(raw, eocd + 10):
        raise SystemExit("end record disagrees with itself about how many entries there are")

    count = _u16(raw, eocd + 10)
    cd_size, cd_at = _u32(raw, eocd + 12), _u32(raw, eocd + 16)
    if cd_at + cd_size != eocd:
        raise SystemExit("central directory does not run up to the end record — "
                         "there is unaccounted space inside the archive")

    # Pass 1: the central directory, consumed header by header up to the end record.
    entries, at = [], cd_at
    for _ in range(count):
        if raw[at:at + 4] != CENTRAL_SIG:
            raise SystemExit("central directory is shorter than its own entry count")
        n_len, e_len, c_len = _u16(raw, at + 28), _u16(raw, at + 30), _u16(raw, at + 32)
        name = raw[at + 46:at + 46 + n_len].decode("utf-8", "replace")
        if e_len or c_len:
            raise SystemExit(f"{name}: central directory entry carries an extra field or comment. "
                             "Those are exactly where a packer writes its uid — refusing.")
        if _u16(raw, at + 34):
            raise SystemExit(f"{name}: entry claims to start on another volume")
        flags = _u16(raw, at + 8)
        if flags & ~FLAG_UTF8_NAME:
            raise SystemExit(f"{name}: unexpected general-purpose flags {flags:#06x} "
                             "(encryption, data descriptor or a compression option this packer never emits)")
        entries.append({
            "name": name,
            "mode": (_u32(raw, at + 38) >> 16) & 0xFFFF,
            "when": dos_datetime(_u16(raw, at + 14), _u16(raw, at + 12)),
            "local_at": _u32(raw, at + 42),
            "central_at": at,
            "csize": _u32(raw, at + 20),
        })
        at += CENTRAL_HEADER_LEN + n_len + e_len + c_len
    if at != eocd:
        raise SystemExit("central directory ends before the end record — the gap between them ships too")

    # Pass 2: the local headers and their payloads, in file order, with no gaps.
    cursor = 0
    for e in sorted(entries, key=lambda e: e["local_at"]):
        name, local_at = e["name"], e["local_at"]
        if local_at != cursor:
            span = local_at - cursor
            raise SystemExit(
                f"{name}: {span} byte(s) before this entry belong to no record. "
                "Unclaimed bytes ship with the archive and no reader accounts for them." if span > 0 else
                f"{name}: entry overlaps the one before it")
        if raw[local_at:local_at + 4] != LOCAL_SIG:
            raise SystemExit(f"{name}: central directory points at something that is not a local header")
        ln_len, le_len = _u16(raw, local_at + 26), _u16(raw, local_at + 28)
        if le_len:
            raise SystemExit(
                f"{name}: local header carries an extra field ({le_len} bytes). This is where "
                "ditto writes the packer's uid and gid, and where the central directory copy "
                "cannot show it — refusing.")
        local_name = raw[local_at + 30:local_at + 30 + ln_len].decode("utf-8", "replace")
        if local_name != name:
            raise SystemExit(f"{name}: local header names it {local_name!r} instead. "
                             "A reader that trusts one of the two sees a different archive than the other.")
        # The two copies must agree; a reader that trusts one otherwise sees a
        # different archive than a reader that trusts the other.
        for field, off_c, off_l, width in (("flags", 8, 6, _u16), ("method", 10, 8, _u16),
                                           ("time", 12, 10, _u16), ("date", 14, 12, _u16),
                                           ("crc", 16, 14, _u32), ("csize", 20, 18, _u32),
                                           ("usize", 24, 22, _u32)):
            if width(raw, e["central_at"] + off_c) != width(raw, local_at + off_l):
                raise SystemExit(f"{name}: {field} differs between local header and central directory")
        cursor = local_at + LOCAL_HEADER_LEN + ln_len + le_len + e["csize"]
        if cursor > cd_at:
            raise SystemExit(f"{name}: its data runs past the start of the central directory")
    if cursor != cd_at:
        raise SystemExit(f"{cd_at - cursor} byte(s) between the last entry's data and the central "
                         "directory belong to no record. Unclaimed bytes ship with the archive.")

    return entries


def audit(zip_path: Path, want: dict[str, Entry]) -> None:
    """The archive must be exactly `want`: no extra entry, field, or byte.

    Kept separate from packing so it can be pointed at a finished archive
    without trusting whatever produced it.
    """
    entries = read_structure(zip_path.read_bytes())

    names = [e["name"] for e in entries]
    if len(names) != len(set(names)):
        dupes = sorted({n for n in names if names.count(n) > 1})
        raise SystemExit(f"archive lists the same entry twice: {', '.join(dupes)}. "
                         "Which one a reader gets depends on the reader.")
    for name in names:
        if name.startswith("/") or ".." in name.split("/") or "\\" in name:
            raise SystemExit(f"{name}: entry name escapes the extraction directory")

    missing = sorted(set(want) - set(names))
    surplus = sorted(set(names) - set(want))
    if missing or surplus:
        raise SystemExit(
            "archive does not match the bundle it claims to be:\n"
            + "".join(f"  missing: {n}\n" for n in missing)
            + "".join(f"  not declared anywhere: {n}\n" for n in surplus))

    for e in entries:
        declared = want[e["name"]]
        # Declared and then never checked is how the last hole got through: pack()
        # writes a fixed stamp so the archive says nothing about when — or in which
        # timezone — it was built, and nothing downstream confirmed it had.
        if e["when"] != EPOCH_DOS:
            raise SystemExit(f"{e['name']}: stamped {e['when']}, not the fixed {EPOCH_DOS}. "
                             "A real clock here leaks the packer's timezone.")
        if e["mode"] != declared.mode:
            raise SystemExit(f"{e['name']}: mode {e['mode']:o} in the archive, "
                             f"{declared.mode:o} in the bundle")

    with zipfile.ZipFile(zip_path) as z:
        for e in entries:
            declared = want[e["name"]]
            if declared.is_dir:
                continue
            buf = z.read(e["name"])
            got = hashlib.sha256(buf).hexdigest()
            if got != declared.digest:
                raise SystemExit(f"{e['name']}: content differs from the bundle "
                                 f"(declared {declared.digest[:12]}…, archive holds {got[:12]}…)")
            if buf[:6].startswith(ARCHIVE_MAGIC):
                raise SystemExit(
                    f"{e['name']}: a compressed archive inside the archive. Its bytes cannot "
                    "be scanned as text, so it is refused rather than trusted.")
            hay = buf.lower()
            for needle, enc in needles():
                at = hay.find(needle)
                if at != -1:
                    sample = buf[at:at + 120].decode(enc, "replace").split("\x00")[0]
                    raise SystemExit(
                        f"{e['name']}: carries a build-machine path ({enc}), refusing to ship it:\n"
                        f"  {sample}")

    exe = next((e for e in entries if e["name"].endswith("/" + EXEC_SUBPATH)), None)
    if exe is None:
        raise SystemExit(f"archive contains no {EXEC_SUBPATH} — refusing to call it clean "
                         "when it may hold nothing that runs")
    if not exe["mode"] & 0o111:
        raise SystemExit(f"{exe['name']}: no execute bit survived packing; the app would not launch")

    # Say only what was checked. The previous message asserted "no bytes outside
    # the records" while never having looked at one of the spans — a gate that
    # overstates its own coverage is worse than a missing gate, because the
    # overstatement is what people act on.
    print(f"Audited {zip_path.name}: {len(entries)} entries. Every byte from 0 to EOF belongs "
          "to a record; every entry matches the bundle's own name, mode, timestamp and sha256; "
          "no extra field, no comment, no entry the bundle does not have.\n"
          "  This proves the archive IS the bundle it was packed from. It does not prove the\n"
          "  bundle is clean — that is the installer's check at build time. The path scan below\n"
          "  is a second pair of eyes, not a proof: searched " + ", ".join(e for _, e in needles())
          + f" for {BUILD_PATH_ROOT!r}, found none.")


def prove_extractable(zip_path: Path, app_name: str) -> None:
    """Unpack it and check the app still runs and still verifies.

    Writing the archive by hand puts the permission bits and the byte-for-byte
    content under this file's control, and both are things the signature and the
    launch depend on. Neither is assumed.

    Unpacked with **ditto specifically**, because that is what expands the zip
    when someone double-clicks the download. `unzip` applies an entry's
    permissions where ditto refuses them, so verifying with `unzip` reports a
    launchable app for an archive that produces an unlaunchable one.
    """
    with tempfile.TemporaryDirectory() as tmp:
        run(["ditto", "-x", "-k", str(zip_path), tmp])
        app = Path(tmp) / app_name
        if not os.access(app / EXEC_SUBPATH, os.X_OK):
            raise SystemExit(f"{app_name} unpacks without an executable bit — it would not launch")
        run(["codesign", "--verify", "--deep", "--strict", str(app)])


def main() -> None:
    parser = argparse.ArgumentParser(description="Package a built Perch.app for release, and audit the result.")
    parser.add_argument("app", type=Path, help="Path to the built Perch.app")
    parser.add_argument("-o", "--out", type=Path, help="Output zip (default: ./<AppName>.zip beside this script)")
    opts = parser.parse_args()

    app = opts.app.resolve()
    if app.suffix != ".app" or not app.is_dir():
        raise SystemExit(f"{app} is not an .app bundle")
    out = (opts.out or Path.cwd() / f"{app.stem}.zip").resolve()

    want = manifest(app)
    pack(app, out, want)
    audit(out, want)
    prove_extractable(out, app.name)
    print(f"\n{out}  ({out.stat().st_size // 1024} KB)")
    print("Upload this file and nothing else: no .dSYM, no .swiftmodule, no build directory.")


if __name__ == "__main__":
    main()
