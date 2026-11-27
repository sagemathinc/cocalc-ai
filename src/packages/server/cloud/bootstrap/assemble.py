#!/usr/bin/env python3
"""Assemble bootstrap.py from its source parts.

bootstrap.py is generated and committed: edit the files under parts/, then run

    python3 assemble.py --write

`--check` (run in CI and by assemble.test.py) only reads; it exits 1 when the
committed bootstrap.py differs from what the parts assemble to.

Layout, relative to this directory:

  parts/manifest.txt    the main program's section files, one per line, in order
  parts/main/*.py       the top-level program, cut between top-level statements
  parts/embedded/*      programs that bootstrap.py embeds as string literals

In a main section, an embedded program's literal keeps its prefix and quotes,
and its body is replaced by one marker line:

    NAME = r'''
    @@bootstrap-include embedded/<file>@@
    '''

The assembler concatenates the sections in manifest order and replaces each
marker line, together with the newline before it and its own newline, by the
bytes of the named file. Everything is bytes: no newline, encoding or locale
handling touches the content, so the output is exactly the committed file.

Files ending in .pystr hold a literal body as written in Python source, escape
sequences included, rather than the decoded program: those literals are not raw
strings, and their escapes cannot be recovered from the decoded text. lint.py
decodes them (with ast.literal_eval) before checking the program.

Manifest rules: UTF-8, lines end with "\\n" only, blank lines and lines starting
with "#" are ignored, every other line is "main/<name>.py" and appears once.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARTS = HERE / "parts"
OUTPUT = HERE / "bootstrap.py"

NAME = rb"[A-Za-z0-9][A-Za-z0-9_.-]*"
# A whole marker line, with the newline before it and its own newline.
MARKER = re.compile(rb"\n@@bootstrap-include embedded/(" + NAME + rb")@@\n")
MARKER_TEXT = b"@@bootstrap-include"
SECTION = re.compile(r"main/[A-Za-z0-9][A-Za-z0-9_.-]*\.py")


class PartsError(ValueError):
    pass


def real_dir(path: Path) -> Path:
    """`path` itself, which must be a real directory (not a symlink)."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        raise PartsError(f"missing directory: {path}") from None
    if not stat.S_ISDIR(info.st_mode):
        raise PartsError(f"not a real directory: {path}")
    return path


def regular_file(path: Path, under: Path) -> bytes:
    """The bytes of `path`, a regular file (not a symlink) directly in `under`.

    `under` must be a real directory. The file is opened with O_NOFOLLOW and
    checked on the open descriptor, so what is read is what was checked. The
    parts are repository sources: this guards against a part reaching outside
    parts/ by a link, not against a local user changing parts/ while it runs.
    """
    if path.parent != under:
        raise PartsError(f"{path} is not directly in {under}")
    real_dir(under)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        raise PartsError(f"missing part: {path}") from None
    except OSError as err:  # ELOOP: the part is a symlink
        raise PartsError(f"not a regular file: {path} ({err.strerror})") from None
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise PartsError(f"not a regular file: {path}")
        return f.read()


def manifest_sections(parts: Path = PARTS) -> list[str]:
    real_dir(parts)
    raw = regular_file(parts / "manifest.txt", parts)
    if b"\r" in raw:
        raise PartsError("manifest.txt must use \\n line endings")
    names: list[str] = []
    for line in raw.decode("utf-8").split("\n"):
        if not line or line.startswith("#"):
            continue
        if not SECTION.fullmatch(line) or ".." in line:
            raise PartsError(f"bad manifest entry: {line!r}")
        if line in names:
            raise PartsError(f"duplicate manifest entry: {line}")
        names.append(line)
    if not names:
        raise PartsError("manifest.txt lists no sections")
    listed = {name.split("/", 1)[1] for name in names}
    present = {p.name for p in real_dir(parts / "main").iterdir()}
    if present - listed:
        raise PartsError(f"main sections not in the manifest: {sorted(present - listed)}")
    return names


def assemble(parts: Path = PARTS) -> bytes:
    """The bytes of bootstrap.py, assembled from `parts`."""
    main_dir = parts / "main"
    embedded_dir = parts / "embedded"
    main = b"".join(
        regular_file(parts / name, main_dir) for name in manifest_sections(parts)
    )
    used: list[str] = []

    def include(match: re.Match[bytes]) -> bytes:
        name = match.group(1).decode("ascii")
        data = regular_file(embedded_dir / name, embedded_dir)
        if MARKER_TEXT in data:
            raise PartsError(f"embedded/{name} contains an include marker")
        used.append(name)
        return data

    out = MARKER.sub(include, main)
    if MARKER_TEXT in out:
        raise PartsError("an include marker is not on a line of its own")
    duplicates = sorted({name for name in used if used.count(name) > 1})
    if duplicates:
        raise PartsError(f"embedded files included more than once: {duplicates}")
    present = {p.name for p in real_dir(embedded_dir).iterdir()}
    unused = sorted(present - set(used))
    if unused:
        raise PartsError(f"embedded files never included: {unused}")
    return out


def first_difference(a: bytes, b: bytes) -> int:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return min(len(a), len(b))


def write_atomically(path: Path, data: bytes) -> None:
    mode = stat.S_IMODE(os.stat(path).st_mode) if path.exists() else 0o644
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Assemble bootstrap.py from parts/.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="regenerate bootstrap.py")
    mode.add_argument(
        "--check",
        action="store_true",
        help="read-only: exit 1 if bootstrap.py differs from its parts",
    )
    args = parser.parse_args(argv)
    try:
        data = assemble()
    except PartsError as err:
        print(f"assemble.py: {err}", file=sys.stderr)
        return 2
    if args.write:
        write_atomically(OUTPUT, data)
        print(f"wrote {OUTPUT.name} ({len(data)} bytes)")
        return 0
    current = OUTPUT.read_bytes()
    if current == data:
        print(f"{OUTPUT.name} matches its parts ({len(data)} bytes)")
        return 0
    offset = first_difference(current, data)
    print(
        f"{OUTPUT.name} differs from its parts: first difference at byte {offset}; "
        f"committed {len(current)} bytes, assembled {len(data)} bytes. "
        "Run: python3 assemble.py --write",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
