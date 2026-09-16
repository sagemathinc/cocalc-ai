"""Compile a synthetic C fit, verify it, and retain a new run's result."""

import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


def reference(x, y, sigma):
    weights = [1 / s**2 for s in sigma]
    sw = math.fsum(weights)
    mx = math.fsum(w * a for w, a in zip(weights, x)) / sw
    my = math.fsum(w * b for w, b in zip(weights, y)) / sw
    sxx = math.fsum(w * (a - mx)**2 for w, a in zip(weights, x))
    sxy = math.fsum(w * (a - mx) * (b - my)
                    for w, a, b in zip(weights, x, y))
    slope = sxy / sxx
    intercept = my - slope * mx
    chi2 = math.fsum(((b - slope * a - intercept) / s)**2
                     for a, b, s in zip(x, y, sigma))
    return [slope, intercept, chi2]


def fixture():
    x = list(range(20))
    y = [2.5 * a - 1 + ((a * 7) % 11 - 5) / 20 for a in x]
    sigma = [0.5 + a % 3 for a in x]
    return x, y, sigma


def publish_receipt(output, receipt):
    """Publish complete bytes without replacing an existing result."""
    final = output / "validation-receipt.json"
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output, prefix=".receipt-",
        suffix=".tmp", delete=False,
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(receipt, stream, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            # Remove only the temporary file this invocation created.
            temporary.unlink()
            raise
    try:
        os.link(temporary, final)
    finally:
        temporary.unlink()


def run(output):
    # Fail before compiling if any file or directory already occupies the name.
    output.mkdir()
    if sys.platform not in ("linux", "darwin"):
        raise RuntimeError("this example supports Linux and macOS")
    compiler = shutil.which("cc")
    if compiler is None:
        raise RuntimeError("C compiler cc is missing; no software was installed")
    version = subprocess.run(
        [compiler, "--version"], capture_output=True, text=True,
        check=True, timeout=10,
    ).stdout.splitlines()[0]

    with tempfile.TemporaryDirectory(prefix="build-", dir=output) as tmp:
        library = Path(tmp) / (
            "weighted_fit.dylib" if sys.platform == "darwin" else "weighted_fit.so"
        )
        command = [
            compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
            "-fPIC", "-dynamiclib" if sys.platform == "darwin" else "-shared",
            str(ROOT / "weighted_fit.c"), "-lm", "-o", str(library),
        ]
        built = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if built.returncode:
            raise RuntimeError("compilation failed: " + built.stderr.strip())

        native = ctypes.CDLL(str(library)).weighted_fit
        pointer = ctypes.POINTER(ctypes.c_double)
        native.argtypes = [ctypes.c_size_t, pointer, pointer, pointer, pointer]
        native.restype = ctypes.c_int

        def fit(x, y, sigma):
            if not len(x) == len(y) == len(sigma):
                raise ValueError("array length mismatch")
            array = ctypes.c_double * len(x)
            out = (ctypes.c_double * 3)(-1, -1, -1)
            status = native(len(x), array(*x), array(*y), array(*sigma), out)
            return status, list(out)

        class NativeFitTests(unittest.TestCase):
            def test_known_line(self):
                status, actual = fit([0, 1, 2, 3], [1, 3, 5, 7], [1, 2, 1, 2])
                self.assertEqual(status, 0)
                for a, b in zip(actual, [2, 1, 0]):
                    self.assertAlmostEqual(a, b, places=12)

            def test_weighted_reference_and_reordered_data(self):
                x, y, sigma = fixture()
                expected = reference(x, y, sigma)
                for values in ((x, y, sigma), (x[::-1], y[::-1], sigma[::-1])):
                    status, actual = fit(*values)
                    self.assertEqual(status, 0)
                    for a, b in zip(actual, expected):
                        self.assertAlmostEqual(a, b, places=10)

            def test_invalid_values_do_not_publish_output(self):
                cases = [([0, 1], [1, 2], [1, 1])]
                for slot, values in (
                    (0, [float("nan"), float("inf"), 2e6]),
                    (1, [float("nan"), float("inf"), 2e6]),
                    (2, [0, -1, float("nan"), float("inf"), 1e-4, 1e4]),
                ):
                    for value in values:
                        arrays = [[0, 1, 2], [1, 2, 3], [1, 1, 1]]
                        arrays[slot][1] = value
                        cases.append(arrays)
                cases.append(([0] * 100001, [1] * 100001, [1] * 100001))
                for arrays in cases:
                    status, actual = fit(*arrays)
                    self.assertEqual(status, 1)
                    self.assertEqual(actual, [-1, -1, -1])
                with self.assertRaises(ValueError):
                    fit([0, 1, 2], [1], [1, 1, 1])

            def test_degenerate_design_is_rejected(self):
                for x in ([2, 2, 2], [2, 2, 2 + 1e-8]):
                    status, actual = fit(x, [1, 2, 3], [1, 1, 1])
                    self.assertEqual(status, 2)
                    self.assertEqual(actual, [-1, -1, -1])

        suite = unittest.defaultTestLoader.loadTestsFromTestCase(NativeFitTests)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError("scientific checks failed; no result was published")
        x, y, sigma = fixture()
        status, actual = fit(x, y, sigma)
        expected = reference(x, y, sigma)
        check = unittest.TestCase()
        check.assertEqual(status, 0)
        for a, b in zip(actual, expected):
            check.assertAlmostEqual(a, b, places=10)
        receipt = {
            "state": "PASS", "tests_run": result.testsRun,
            "python": sys.version.split()[0], "interpreter": sys.executable,
            "system": platform.system(), "architecture": platform.machine(),
            "platform": platform.platform(),
            "compiler": {"executable": compiler, "version": version},
            "build_command": command, "build_stderr": built.stderr,
            "source_sha256": {
                name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                for name in ("weighted_fit.c", "check_native.py")
            },
            "library_sha256": hashlib.sha256(library.read_bytes()).hexdigest(),
            "example_result": {
                "n": len(x), "status": status,
                "input": {"x": x, "y": y, "sigma": sigma},
                "native_slope_intercept_chi2": actual,
                "independent_reference": expected,
            },
            "limitations": [
                "Only the specified synthetic fixtures were checked",
                "Callers must provide valid C arrays of the declared length",
                "Input bounds are not a general conditioning guarantee",
                "No speedup or cross-platform binary reproducibility claim",
            ],
        }
    receipt["temporary_library_removed"] = not library.exists()
    if not receipt["temporary_library_removed"]:
        raise RuntimeError("temporary build cleanup failed")
    publish_receipt(output, receipt)
    print("PASS: compiled C fit; 4 scientific/input tests; result published.")
    print(output / "validation-receipt.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True,
                        help="new output directory; must not already exist")
    args = parser.parse_args()
    try:
        run(args.output)
    except (OSError, ValueError, RuntimeError, AssertionError,
            subprocess.SubprocessError) as error:
        print("failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
