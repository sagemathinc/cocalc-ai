# Research workflow examples

These synthetic examples accompany the [research workflow documentation](https://cocalc.ai/docs/research/reproduce-analysis).
Python 3 and its standard library are sufficient for the scripts. The notebook
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

From the repository root:

```sh
python3 src/packages/docs/test/research_examples.py
```

This tests the analysis, failure/resume behavior, and rejection of corrupt or
incomplete results in temporary directories. It does not exercise CoCalc
authentication, remote execution, or browser behavior.
