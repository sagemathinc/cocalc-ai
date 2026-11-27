#!/usr/bin/env python3
"""Tests for assemble.py and the parts it assembles bootstrap.py from.

Run: python3 assemble.test.py   (stdlib only; run in CI by `pnpm test:checks`)
"""

from __future__ import annotations

import ast
import hashlib
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # leave no __pycache__ beside the parts
sys.path.insert(0, str(HERE))
import assemble  # noqa: E402
import lint  # noqa: E402

# One-time gate for the change that split bootstrap.py into parts: the parts
# must assemble to exactly the bytes bootstrap.py had before the split. The
# first change that intentionally alters bootstrap.py removes this pin; from
# then on test_committed_matches_parts keeps bootstrap.py and parts/ in step.
BASELINE_SHA256 = "f19f7696551b27efe1402a6ab108230e570a72c32620f6fc47e6637ba6e303a5"
BASELINE_SIZE = 830981

DELIMITER = re.compile(rb"([rRuU]?)('''|\"\"\")$")


def committed() -> bytes:
    return (HERE / "bootstrap.py").read_bytes()


def string_constants(source: bytes) -> set[str]:
    tree = ast.parse(source.decode("utf-8"))
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }


class Identity(unittest.TestCase):
    def test_committed_matches_parts(self):
        self.assertEqual(assemble.assemble(), committed())

    def test_baseline_bytes(self):
        data = assemble.assemble()
        self.assertEqual(len(data), BASELINE_SIZE)
        self.assertEqual(hashlib.sha256(data).hexdigest(), BASELINE_SHA256)

    def test_check_mode_is_read_only(self):
        before = os.stat(HERE / "bootstrap.py")
        self.assertEqual(assemble.main(["--check"]), 0)
        after = os.stat(HERE / "bootstrap.py")
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)


class Markers(unittest.TestCase):
    def setUp(self):
        self.main = b"".join(
            (assemble.PARTS / name).read_bytes()
            for name in assemble.manifest_sections()
        )
        self.matches = list(assemble.MARKER.finditer(self.main))

    def test_marker_text_absent_from_output(self):
        self.assertEqual(committed().count(assemble.MARKER_TEXT), 0)

    def test_every_marker_is_a_whole_line(self):
        self.assertEqual(
            self.main.count(assemble.MARKER_TEXT), len(self.matches)
        )

    def test_each_embedded_file_used_once(self):
        names = [m.group(1).decode() for m in self.matches]
        files = sorted(p.name for p in (assemble.PARTS / "embedded").iterdir())
        self.assertEqual(sorted(names), files)

    def test_marker_sits_inside_a_triple_quoted_literal(self):
        for m in self.matches:
            name = m.group(1).decode()
            with self.subTest(name=name):
                before = self.main[: m.start()]
                opening = DELIMITER.search(before[-4:])
                self.assertIsNotNone(opening, "no literal opening before marker")
                quote = opening.group(2)
                self.assertTrue(self.main[m.end() :].startswith(quote))
                # a .pystr file holds a non-raw literal's source text
                if name.endswith(".pystr"):
                    self.assertNotIn(opening.group(1), (b"r", b"R"))

    def test_embedded_values_are_bootstrap_literals(self):
        # Each part is exactly one of bootstrap.py's string literals: the decoded
        # value for .pystr parts, the file text itself for the others.
        constants = string_constants(committed())
        for path in sorted((assemble.PARTS / "embedded").iterdir()):
            with self.subTest(name=path.name):
                text = path.read_text(encoding="utf-8")
                if path.name.endswith(".pystr"):
                    text = lint.decode_pystr(text)
                self.assertIn(text, constants)


class Lint(unittest.TestCase):
    def test_parts_syntax(self):
        self.assertEqual(lint.lint(), [])


class Rejects(unittest.TestCase):
    """assemble() refuses malformed parts instead of producing output."""

    def make(self, manifest=b"main/00-a.py\n", main=None, embedded=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        parts = Path(tmp.name) / "parts"
        (parts / "main").mkdir(parents=True)
        (parts / "embedded").mkdir()
        (parts / "manifest.txt").write_bytes(manifest)
        files = {
            "00-a.py": b"X = r'''\n@@bootstrap-include embedded/e.sh@@\n'''\n"
        }
        files.update(main or {})
        for name, data in files.items():
            (parts / "main" / name).write_bytes(data)
        for name, data in (embedded if embedded is not None else {"e.sh": b"echo hi\n"}).items():
            (parts / "embedded" / name).write_bytes(data)
        return parts

    def test_valid_tree(self):
        self.assertEqual(
            assemble.assemble(self.make()), b"X = r'''echo hi\n'''\n"
        )

    def assertRejects(self, parts):
        with self.assertRaises(assemble.PartsError):
            assemble.assemble(parts)

    def test_parent_path_in_manifest(self):
        self.assertRejects(self.make(manifest=b"main/../00-a.py\n"))

    def test_absolute_path_in_manifest(self):
        self.assertRejects(self.make(manifest=b"/etc/passwd\n"))

    def test_subdirectory_in_manifest(self):
        self.assertRejects(self.make(manifest=b"main/sub/00-a.py\n"))

    def test_duplicate_manifest_entry(self):
        self.assertRejects(self.make(manifest=b"main/00-a.py\nmain/00-a.py\n"))

    def test_crlf_manifest(self):
        self.assertRejects(self.make(manifest=b"main/00-a.py\r\n"))

    def test_section_missing_from_manifest(self):
        self.assertRejects(self.make(main={"01-b.py": b"Y = 1\n"}))

    def test_missing_section_file(self):
        self.assertRejects(self.make(manifest=b"main/00-a.py\nmain/02-c.py\n"))

    def test_embedded_file_never_included(self):
        self.assertRejects(
            self.make(embedded={"e.sh": b"echo hi\n", "extra.sh": b"echo\n"})
        )

    def test_missing_embedded_file(self):
        self.assertRejects(self.make(embedded={}))

    def test_embedded_included_twice(self):
        twice = b"X = r'''\n@@bootstrap-include embedded/e.sh@@\n'''\nY = r'''\n@@bootstrap-include embedded/e.sh@@\n'''\n"
        self.assertRejects(self.make(main={"00-a.py": twice}))

    def test_marker_not_on_its_own_line(self):
        inline = b"X = r'''@@bootstrap-include embedded/e.sh@@'''\n"
        self.assertRejects(self.make(main={"00-a.py": inline}))

    def test_path_in_marker(self):
        sneaky = b"X = r'''\n@@bootstrap-include embedded/../manifest.txt@@\n'''\n"
        self.assertRejects(self.make(main={"00-a.py": sneaky}))

    def test_embedded_file_with_marker(self):
        self.assertRejects(
            self.make(embedded={"e.sh": b"@@bootstrap-include embedded/e.sh@@\n"})
        )

    def test_symlinked_embedded_file(self):
        parts = self.make(embedded={})
        target = parts.parent / "outside.sh"
        target.write_bytes(b"echo outside\n")
        os.symlink(target, parts / "embedded" / "e.sh")
        self.assertRejects(parts)

    def test_symlinked_section(self):
        parts = self.make()
        target = parts.parent / "outside.py"
        target.write_bytes((parts / "main" / "00-a.py").read_bytes())
        (parts / "main" / "00-a.py").unlink()
        os.symlink(target, parts / "main" / "00-a.py")
        self.assertRejects(parts)

    def test_symlinked_embedded_directory(self):
        parts = self.make()
        outside = parts.parent / "elsewhere"
        (parts / "embedded").rename(outside)
        os.symlink(outside, parts / "embedded")
        self.assertRejects(parts)

    def test_symlinked_main_directory(self):
        parts = self.make()
        outside = parts.parent / "elsewhere"
        (parts / "main").rename(outside)
        os.symlink(outside, parts / "main")
        self.assertRejects(parts)

    def test_symlinked_parts_directory(self):
        parts = self.make()
        outside = parts.parent / "elsewhere"
        parts.rename(outside)
        os.symlink(outside, parts)
        self.assertRejects(parts)


if __name__ == "__main__":
    unittest.main()
