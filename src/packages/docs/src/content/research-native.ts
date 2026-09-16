/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_NATIVE_BODY = `
Call a small C numerical routine from project Python, compare its result with an independent calculation, and retain the inputs and build information. This demonstrates how to connect existing native code to a research project. It is not a speedup benchmark or a recommendation of a statistical model for your experiment.

**Validation scope:** on September 13, 2026, all three shell blocks below ran through the project CLI in a fresh CoCalc CPU project using the existing Basic 1.7 image: Linux x86_64, Python 3.14.4, and GCC 15.2.0. The four scientific/input tests and four result-publication regression tests passed; repeating the command with the existing output name failed and preserved the earlier result. Downloaded sources and the receipt matched their project hashes, and the test project was stopped and cleaned up. The same example also passed locally on macOS ARM64 with Python 3.9.6 and Apple Clang 21. This validates the named environments, without establishing a performance or capacity guarantee.

## Prepare a project terminal

Use a project you can edit, Python 3.9 or later, and an existing C compiler named \`cc\`. The example supports Linux and macOS. It uses Python's standard library and compiles a shared library locally. The output filesystem must support hard links; the script stops if exclusive publication is unsupported. A Jupyter kernel is unnecessary.

In a **project terminal**, inspect the runtime:

~~~sh
python3 -c 'import sys, platform; print(sys.executable); print(sys.version); print(platform.system(), platform.machine())'
command -v cc
cc --version
~~~

Stop if Python or the compiler is missing. See [Python environments](/docs/python/use-python), [project runtime images](/docs/projects/runtime-image), and [the terminal](/docs/terminal/use-terminal). An image description alone does not prove that a compiler is installed in the running project. This example installs nothing and does not change the runtime image.

Create a new folder named \`native-fit-demo\` in your project home directory. Put \`weighted_fit.c\` and \`check_native.py\` together in it using **Files**. Follow [remote research with the CLI](/docs/research/remote-cli) for file transfers.

Download [weighted_fit.c](https://raw.githubusercontent.com/sagemathinc/cocalc-ai/main/src/packages/docs/examples/research-workflows/native/weighted_fit.c) and [check_native.py](https://raw.githubusercontent.com/sagemathinc/cocalc-ai/main/src/packages/docs/examples/research-workflows/native/check_native.py) from the repository. Keep their filenames unchanged. The [example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows/native) also contains the companion regression tests.

~~~sh
cd "$HOME/native-fit-demo"
ls weighted_fit.c check_native.py
python3 -B check_native.py --output native-fit-run
~~~

The script creates \`native-fit-run\`; do not create that output directory yourself. If its name already exists, the command fails before compilation and preserves its contents. Choose a different new output name for another run. Leave both source files unchanged while the command runs.

## Understand the native interface

The C function has this interface:

~~~c
int weighted_fit(size_t n, const double *x, const double *y,
                 const double *sigma, double *out);
~~~

Here \`x\`, \`y\`, and \`sigma\` each contain \`n\` observations. Positive \`sigma\` values determine weights \`1 / sigma²\`. The output array has three values in order: **slope, intercept, residual chi-square** for a weighted straight-line fit.

- Status **0** means the demonstration's input and numerical checks accepted the result.
- Status **1** means invalid inputs, such as a wrong sample count or out-of-range value. The output array is unchanged.
- Status **2** means insufficient predictor variation or a nonfinite calculation. The output array is unchanged.

The Python adapter declares the C argument types and integer return type through \`ctypes\`. It creates the arrays, checks equal lengths, and keeps them alive during the call. When adapting another routine, update the C signature and Python declarations together, including the output-array length. A wrong declaration or invalid native pointer can crash Python; array lengths are a caller contract, not something C pointers prove. Compile and load only source and libraries you trust.

The checker and its native adapter are a worked example, not an installed Python library. Edit a copy when changing the numerical routine or fixture, and retain independent checks appropriate to that change.

## Check the result

Compilation uses C11, optimization, position-independent code, and warnings treated as errors. Linux uses \`-shared\`; macOS uses \`-dynamiclib\`. The temporary library is removed before the successful receipt is published.

The expected outcome is four passing scientific test methods, \`OK\`, and:

~~~text
PASS: compiled C fit; 4 scientific/input tests; result published.
native-fit-run/validation-receipt.json
~~~

The tests check a known line with slope 2, intercept 1, and zero residual chi-square; a 20-point weighted fixture and its reversed input order against an independent Python \`math.fsum\` reference; invalid sample counts, array lengths, nonfinite/out-of-range inputs and uncertainties; and identical or nearly identical predictor values.

Inspect the retained result:

~~~sh
python3 - <<'PY'
import json
from pathlib import Path

receipt = json.loads(Path("native-fit-run/validation-receipt.json").read_text())
print("State:", receipt["state"], "tests:", receipt["tests_run"])
print("Native [slope, intercept, chi-square]:",
      receipt["example_result"]["native_slope_intercept_chi2"])
print("Independent reference:", receipt["example_result"]["independent_reference"])
print("Platform:", receipt["system"], receipt["architecture"])
print("Compiler:", receipt["compiler"]["version"])
print("Temporary library removed:", receipt["temporary_library_removed"])
PY
~~~

Read both the terminal's successful exit and the numerical result. The receipt contains all 20 synthetic inputs, the native result, its independently calculated reference, both source-file hashes, a library hash, the actual build command, compiler and interpreter identities, and platform information. It does not infer whether it ran in CoCalc from the operating-system name.

For the included 20-point fixture, values rounded for display are slope **2.5012121493**, intercept **-0.9547812141**, and residual chi-square **0.7736769006**. The test compares the unrounded values to the independent reference to ten decimal places; displayed rounding is not an additional accuracy guarantee.

The example accepts 3–100000 observations, finite predictor/response magnitudes at most \`1e6\`, and uncertainties from \`1e-3\` through \`1e3\`. It rejects weighted predictor variance at or below \`1e-12\` in squared predictor units. These demonstration bounds and fixture tolerances are not a general numerical-conditioning guarantee. Residual chi-square here is not an uncertainty estimate or a scientific goodness-of-fit conclusion.

## Recognize failed runs

| Symptom | Meaning and next step |
| --- | --- |
| \`File exists\` for the output directory | Keep that run and use a new output name. Nothing is overwritten. |
| Missing \`cc\` or compilation error | Inspect the existing runtime and compiler output. No completion receipt is published; the failed output directory remains for inspection. |
| Shared library cannot load | Check the compiler target, operating system, architecture, and error message; rebuild from source in the actual execution environment. |
| A scientific test fails | Retain the source and diagnostic output. Do not accept the calculation or discard the independent check to force it to pass. |
| Publication fails or the process is interrupted | A nonzero exit is not a successful run, even if another process created a result file. Inspect the folder and retry with a new name. |

Only a successful invocation publishes its completed \`validation-receipt.json\`. It does not replace an existing receipt, including one another process creates just before publication. A leftover output directory or temporary file is not completion evidence. The example does not resume interrupted work or promise recovery after host or storage failure.

## Retain and clean up

Keep both source files, the successful receipt, and a short README containing the invocation and any intentional changes. Review recorded paths and environment details before sharing the receipt. A checksum identifies bytes; it does not establish scientific validity or reproduce the compiled binary by itself.

The temporary library is removed intentionally. Rebuild from source after changing operating system, architecture, or toolchain; do not assume a binary built elsewhere will load. See [research handoff](/docs/projects/research-handoff) for collaborator instructions.

After saving needed results, remove only your new \`native-fit-demo\` folder through **Files**. Do not remove another person's work or stop a shared project.
`;
