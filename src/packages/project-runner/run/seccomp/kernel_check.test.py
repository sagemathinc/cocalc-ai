#!/usr/bin/python3
"""Tests for kernel_check.py's architecture selection (no syscalls):
python3 -I kernel_check.test.py. Skipped where libseccomp isn't installed."""

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
try:
    spec = importlib.util.spec_from_file_location("kernel_check", HERE / "kernel_check.py")
    kc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kc)
except OSError:  # libseccomp.so.2 missing
    kc = None

WITH_SUBARCHES = {"archMap": [{"architecture": "SCMP_ARCH_X86_64",
                               "subArchitectures": ["SCMP_ARCH_X86", "SCMP_ARCH_X32"]}]}
NATIVE_ONLY = {"archMap": [{"architecture": "SCMP_ARCH_X86_64", "subArchitectures": []}]}


@unittest.skipIf(kc is None, "libseccomp.so.2 not available")
class SubarchesTest(unittest.TestCase):
    def test_profile_arch_map_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SECCOMP_SUBARCHES", None)
            self.assertEqual(kc.subarches_of(WITH_SUBARCHES), ["x86", "x32"])
            self.assertEqual(kc.subarches_of(NATIVE_ONLY), [])

    def test_env_overrides_the_profile(self):
        with mock.patch.dict(os.environ, {"SECCOMP_SUBARCHES": "x86"}):
            self.assertEqual(kc.subarches_of(NATIVE_ONLY), ["x86"])
        with mock.patch.dict(os.environ, {"SECCOMP_SUBARCHES": ""}):
            self.assertEqual(kc.subarches_of(WITH_SUBARCHES), [])

    def test_native_wins_over_the_environment(self):
        """--diff builds natively whatever the environment says."""
        with mock.patch.dict(os.environ, {"SECCOMP_SUBARCHES": "x86,x32"}):
            self.assertEqual(kc.subarches_of(WITH_SUBARCHES, native=True), [])
            self.assertEqual(kc.subarches_of(NATIVE_ONLY, native=True), [])


if __name__ == "__main__":
    unittest.main()
