# Research workflow examples

These synthetic examples accompany the [research workflow documentation](https://cocalc.ai/docs/research/reproduce-analysis).
Python 3 and its standard library are sufficient for the introductory scripts.
The native example below additionally needs an existing C compiler. The notebook
also requires a working Python Jupyter kernel. Use a new directory for your work.

| File               | Purpose                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `measurements.csv` | Four synthetic values: 2, 4, 6, 8.                                                            |
| `analyze.py`       | Calculate count, mean, and the SHA-256 hash of the input bytes.                               |
| `analysis.ipynb`   | Run the same analysis from a fresh notebook kernel. Keep the CSV and Python module beside it. |
| `sweep.py`         | Save one checkpoint per completed case, with an optional deliberate failure.                  |
| `summarize_run.py` | Reject incomplete or incorrect checkpoint sets and summarize a completed run.                 |

`report.qmd` is the complete R/Quarto report from the [Quarto guide](https://cocalc.ai/docs/research/quarto-report). It requires R, Quarto, knitr, and rmarkdown.
`dashboard.py` is the [private dashboard](https://cocalc.ai/docs/research/private-dashboard) server; keep `measurements.csv` beside it and follow the guide to register, verify, and stop the managed app.

## Reproduce the analysis

```sh
python3 analyze.py measurements.csv result.json
```

Expected: `count=4 mean=5.0`, plus `result.json`. Open `analysis.ipynb` in a
Python kernel and run all cells for the notebook version. It writes a separate
`notebook-result.json` and checks that the saved result matches the calculation.
Generated results can contain environment-specific information; review them
before publishing.

## Fail and resume a computation

Use a fresh output directory. The first command intentionally exits nonzero:

```sh
python3 sweep.py --out runs/demo --stop 6 --fail-at 3
```

Cases 0, 1, and 2 should be saved. Then run:

```sh
python3 sweep.py --out runs/demo --stop 6
python3 summarize_run.py runs/demo --stop 6
```

Expected: the first three cases are skipped, the remaining cases complete, and
the summary prints `completed=6 sum_of_squares=55`.

Only run one worker per output directory. Start a new directory if the code,
inputs, or parameters change. Checkpoint files support restarting a computation;
they do not preserve process memory or replace backups.

## Check the examples locally

The documentation package test command runs these checks alongside its registry
and link tests. Python 3 is required; the examples use only its standard library:

```sh
pnpm -C src/packages/docs test
```

To run just the example checks from the repository root:

```sh
python3 src/packages/docs/test/research_examples.py
```

This tests the analysis, failure/resume behavior, and rejection of corrupt or
incomplete results in temporary directories. It does not exercise CoCalc
authentication, remote execution, or browser behavior.

## Stream data and bound CPU workers

The `scientific/` directory contains the version 2 terminal example and its
companion regression suite. Keep these two files beside one another in a new,
writable working folder with Python 3.9 or later on Linux or macOS:

- `scientific-prototype-v2-workflows.py`: streaming group statistics, a bounded
  process pool for numerical integrals, and saved-artifact verification.
- `scientific-prototype-v2-tests.py`: independent numerical references, malformed
  inputs, incomplete artifacts, simulated worker failure, and real child-run
  interruption checks.

Follow the [streaming analysis guide](https://cocalc.ai/docs/research/streaming-analysis)
or [parallel CPU guide](https://cocalc.ai/docs/research/parallel-cpu) for exact
synthetic inputs, commands, expected results, and cleanup. These are terminal
examples; no companion notebook is required. The serial `sweep.py` example
above remains the separate resumable workflow.

From a disposable copy of the `scientific/` folder, run the companion suite:

```sh
python3 -B scientific-prototype-v2-tests.py
```

The suite writes PID-prefixed fixtures beside itself. It uses the Unix-like
`resource` module and runs up to two workers, including an interruption case
with 16 rates and 500,000 intervals. It sets per-process CPU limits and
subprocess timeouts, not a total memory cap. Wait for it to exit before deleting
only that disposable folder. The package's `test:examples` command also runs
this suite from a temporary copy, so its fixtures stay out of the source tree.

On September 13, 2026, the current files and both guides passed 19 project-shell
command checks (17 successful commands and two intended failures) in a CoCalc
Basic 1.7 project on Linux x86_64 with Python 3.14.4. One companion-suite run
passed all 14 tests, including exclusive output publication, bounded artifact
verification, deterministic interruption, and stalled-worker cleanup. All 15
scientific input/result/receipt downloads matched remote hashes, and the guide
commands independently checked complete 3/8/8-result artifacts. The test folders
were removed and the disposable project stopped. The current files also passed
locally on Python 3.9.6 and 3.12.14. Output directories must support hard links;
unsupported filesystems fail without falling back to replacing existing files.
Pre-publication testing uploaded the candidate files through the CLI; public
main-download navigation requires the files to be merged. Saved checksums and
schemas establish run consistency; they do not authenticate the
artifacts, independently verify the science, or replace backups.

## Call compiled C from Python

The `native/` directory accompanies the
[native numerical component guide](https://cocalc.ai/docs/research/native-python).
Keep `weighted_fit.c` and `check_native.py` together in a new folder with Python
3.9 or later, an existing `cc` compiler, and Linux or macOS. No packages or
compiler are installed by the example. From that folder, run:

```sh
python3 -B check_native.py --output native-fit-run
```

Expected: four scientific/input tests pass and a new
`native-fit-run/validation-receipt.json` records the synthetic inputs, numerical
reference, result, source hashes, compiler and interpreter. The output name must
not exist. The temporary shared library is removed before receipt publication;
retain source and rebuild it in each target environment. Review recorded paths
and environment details before sharing receipts.

The package's `test:examples` runs `test_native_publication.py` from a temporary
copy. Its four regression tests cover an existing result, failed compilation,
a competing publication and a successful existing-compiler run. The last test
explicitly skips when `cc` is unavailable; a skip is not native execution
acceptance. To run these checks independently, use a disposable copy of all
three files and run `python3 -B test_native_publication.py` there. Existing-output
and compilation checks preserve prior files; no result authenticates the science
or promises speedup. On September 13, 2026, the exact guide shell blocks and all
eight scientific/publication tests passed in a fresh CoCalc CPU project with the
existing Basic 1.7 image, Linux x86_64, Python 3.14.4 and GCC 15.2.0. Reusing the
output name failed without changing the earlier receipt. Downloaded source and
result hashes matched before the disposable project was stopped and cleaned up.
