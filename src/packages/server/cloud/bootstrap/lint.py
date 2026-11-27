#!/usr/bin/env python3
"""Syntax-check bootstrap.py's source parts. Read-only: it writes no files.

- Python (parts/main/*.py, the main program as concatenated, and embedded
  *.py): compiled in memory with compile(), which writes no .pyc files.
- Bash (embedded *.sh): `bash -n`.
- Bash stored as Python source text (embedded *.sh.pystr): decoded with
  ast.literal_eval (literals only, never eval/exec), then `bash -n` on stdin.

bootstrap.py itself is also checked by `pnpm lint:py` (mypy).
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # leave no __pycache__ beside the parts
sys.path.insert(0, str(HERE))
import assemble  # noqa: E402  (this directory's assemble.py)

PARTS = assemble.PARTS


def decode_pystr(text: str) -> str:
    """The value of a non-raw triple-quoted literal whose body is `text`."""
    value = ast.literal_eval('"""' + text + '"""')
    if not isinstance(value, str):
        raise ValueError("not a string literal")
    return value


def check_python(name: str, source: bytes) -> str | None:
    try:
        compile(source, name, "exec", dont_inherit=True)
    except SyntaxError as err:
        return f"{name}: {err}"
    return None


def check_bash(name: str, script: bytes) -> str | None:
    result = subprocess.run(
        ["bash", "-n"], input=script, capture_output=True, check=False
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        return f"{name}: bash -n: {detail[0] if detail else result.returncode}"
    return None


def lint(parts: Path = PARTS) -> list[str]:
    problems: list[str] = []
    sections = assemble.manifest_sections(parts)
    main = b""
    for name in sections:
        data = (parts / name).read_bytes()
        main += data
        problems.append(check_python(name, data) or "")
    problems.append(check_python("main program (sections joined)", main) or "")
    problems.append(check_python("bootstrap.py (assembled)", assemble.assemble(parts)) or "")
    for path in sorted((parts / "embedded").iterdir()):
        rel = f"embedded/{path.name}"
        data = path.read_bytes()
        if path.name.endswith(".py"):
            problems.append(check_python(rel, data) or "")
        elif path.name.endswith(".sh"):
            problems.append(check_bash(rel, data) or "")
        elif path.name.endswith(".sh.pystr"):
            try:
                script = decode_pystr(data.decode("utf-8")).encode("utf-8")
            except (ValueError, SyntaxError) as err:
                problems.append(f"{rel}: does not decode: {err}")
                continue
            problems.append(check_bash(rel, script) or "")
        else:
            problems.append(f"{rel}: unknown part type")
    return [p for p in problems if p]


def main() -> int:
    problems = lint()
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("bootstrap parts: syntax OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
