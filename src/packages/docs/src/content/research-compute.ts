/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_STREAMING_BODY = `
Summarize a CSV one row at a time, then check the saved count, mean, and sample
variance against an independent calculation. This example keeps four statistical
state values per group for three known groups.

**Validation scope:** on September 13, 2026, the current files and all 19
command units across these two guides ran in a CoCalc Basic 1.7 project on
Linux x86_64 with Python 3.14.4. The CLI executed each project-shell command;
17 succeeded and both intended invalid/incomplete-data checks failed. The
companion suite passed all 14 tests, including output-file preservation,
bounded artifact verification, real interruption, and stalled-worker cleanup.
Independent comparisons verified all expected scientific results. The files
also passed local checks on macOS with Python 3.9.6 and 3.12.14. These checks
validate the small examples, not a performance or capacity guarantee.

## Prepare a project terminal

Use a project you can edit, Python 3.9 or later on Linux or macOS, and available CPU,
memory, and storage. See [choose compute](/docs/hosts/choose-compute),
[Python environments](/docs/python/use-python), and
[the terminal](/docs/terminal/use-terminal). This example uses only Python's
standard library. Its output directory must support hard links; unsupported
filesystems fail rather than replace existing files. A working project terminal does not require a Jupyter kernel.

Create a new folder named \`scientific-stream-demo\` in your project's home
directory. Download \`scientific-prototype-v2-workflows.py\` and
\`scientific-prototype-v2-tests.py\` from the
[scientific example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows/scientific)
and upload both files into that folder using **Files**. For CLI transfers, follow
[the remote research guide](/docs/research/remote-cli).

Run all commands below in a **project terminal**, from that new folder:

~~~sh
cd "$HOME/scientific-stream-demo"
pwd
python3 -c 'import sys; print(sys.executable); print(sys.version)'
ls scientific-prototype-v2-workflows.py scientific-prototype-v2-tests.py
~~~

Stop if the folder or interpreter is missing. Record the printed interpreter
path and version. These commands run in the project, rather than in your
laptop's terminal or a notebook cell.

## Create a small reference dataset

This fixture contains 12,000 measurements, divided equally among \`control\`,
\`low\`, and \`high\`. Its three-column format differs from the one-column
\`measurements.csv\` used in the introductory analysis guide.

~~~sh
python3 - <<'PY'
import csv
from pathlib import Path

groups = ("control", "low", "high")
with Path("grouped-measurements.csv").open("x", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["sample_id", "group", "value"])
    for index in range(12000):
        group_index = index % 3
        value = group_index * 5 + ((index * 17) % 97 - 48) / 8
        writer.writerow([index, groups[group_index], value])
print("Created 12000 synthetic measurements")
PY
~~~

The input must have the exact header \`sample_id,group,value\`, sequential sample
IDs starting at \`0\`, and only those three group names. Every group needs at
least two observations. Each physical CSV record must fit within 512 bytes;
multiline CSV records are unsupported. Values must be finite, with absolute
value at most \`1e100\`. These bounds define this example's accepted input, not a
promise of numerical accuracy for every dataset within them.

## Calculate and verify the saved run

Use a fresh output prefix and leave the input unchanged during the run:

~~~sh
python3 scientific-prototype-v2-workflows.py stream --input grouped-measurements.csv --out streaming-run
python3 scientific-prototype-v2-workflows.py verify --out streaming-run
~~~

Each command should exit successfully and print:

~~~text
verified complete: 3 results
~~~

The completed run consists of:

- \`streaming-run.started.json\`: expected groups, algorithm parameters, script
  hash, and Python version.
- \`streaming-run.results.jsonl\`: three result records with \`id\`, \`n\`,
  \`mean\`, and \`sample_variance\`.
- \`streaming-run.manifest.json\`: completion marker, input row count and hash,
  result count and hash.

Expected values, rounded for display:

- **control:** count 4000; mean -0.00109375; sample variance 12.257309224767.
- **low:** count 4000; mean 4.999; sample variance 12.251343085771.
- **high:** count 4000; mean 10.002125; sample variance 12.253730792073.

Now compare the saved results to Python's independent \`statistics\` functions.
This checker deliberately loads the **small reference fixture** into memory;
it is not the streaming approach to use for a large production input.

~~~sh
python3 - <<'PY'
import csv
import hashlib
import json
import statistics
import unittest
from pathlib import Path

check = unittest.TestCase()
groups = {name: [] for name in ("control", "low", "high")}
source = Path("grouped-measurements.csv")
with source.open(newline="") as stream:
    for row in csv.DictReader(stream):
        groups[row["group"]].append(float(row["value"]))
records = [json.loads(line) for line in Path("streaming-run.results.jsonl").read_text().splitlines()]
check.assertEqual(len(records), 3)
actual = {record["id"]: record for record in records}
check.assertEqual(set(actual), set(groups))
for group, values in groups.items():
    check.assertEqual(len(values), 4000)
    check.assertEqual(actual[group]["n"], len(values))
    check.assertAlmostEqual(actual[group]["mean"], statistics.mean(values), places=12)
    check.assertAlmostEqual(actual[group]["sample_variance"], statistics.variance(values), places=11)
evidence = json.loads(Path("streaming-run.manifest.json").read_text())["evidence"]
check.assertEqual(evidence["input_rows"], 12000)
check.assertEqual(evidence["input_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
print("PASS: counts, independent statistics, and input hash")
PY
~~~

An assertion failure means the saved run failed this reference comparison. Keep
the files and investigate before adapting the example to research data.

## Recognize rejected and incomplete runs

Create a separate invalid input and a separate output prefix:

~~~sh
python3 - <<'PY'
from pathlib import Path
with Path("bad-measurements.csv").open("x") as stream:
    stream.write("sample_id,group,value\\n0,control,nan\\n")
PY
python3 scientific-prototype-v2-workflows.py stream --input bad-measurements.csv --out rejected-run
python3 scientific-prototype-v2-workflows.py verify --out rejected-run
~~~

The last two commands should each exit with status \`1\`: the first rejects the
non-finite value; the second reports \`incomplete run: no completion manifest\`.
A \`.started.json\` or \`.partial.jsonl\` file alone is not a completed result.

| Symptom | Next step |
| --- | --- |
| \`output prefix already used\` | Keep the previous run and choose a new prefix; this example does not resume it. |
| Invalid header, ID, group, or value | Correct a copy of the input and run with a fresh prefix. |
| Missing manifest, checksum mismatch, or invalid result schema | Treat the run as incomplete or inconsistent; retain the files for diagnosis. |
| Missing Python, permission error, or filesystem sync error | Stop and inspect the selected runtime and writable directory before retrying. |

The streaming calculation holds four state values per group. The hosted test
measured peak traced Python allocations of 285,221 and 285,326 bytes for 6,000
and 60,000 rows with the same three groups;
that does not measure total process memory or establish a CoCalc memory quota.
The input hash identifies bytes consumed by the reader, not an atomic snapshot
of a concurrently edited file.

\`verify\` checks the saved schema, expected IDs, counts, and checksums. It does
not independently recalculate the science or authenticate the artifacts.
Retain independent numerical checks when changing the data or algorithm.

## Hand off and clean up

Keep the input, both example files, and all three completed-run files together.
Add a short README with the commands, interpreter path/version, compute image
when applicable, and the independent check result. Review environment details
before publishing. Follow [the research handoff guide](/docs/projects/research-handoff)
for collaborator instructions.

After saving any results you need, remove only the new \`scientific-stream-demo\`
folder through **Files**. Do not stop a shared project or remove another
person's work. Completion files are not a backup or proof of recovery after a
project or host failure.

Continue with [a bounded parallel CPU sweep](/docs/research/parallel-cpu) to
compare worker counts without changing the scientific result.
`;

export const RESEARCH_PARALLEL_BODY = `
Calculate a small family of numerical integrals with one and two worker
processes. A single coordinator writes the results; independent serial and
analytic checks test the calculation. This is a bounded process-pool example,
not a speedup benchmark.

**Validation scope:** on September 13, 2026, the current files and all 19
command units across these two guides ran in a CoCalc Basic 1.7 project on
Linux x86_64 with Python 3.14.4. The CLI executed each project-shell command;
17 succeeded and both intended invalid/incomplete-data checks failed. The
companion suite passed all 14 tests, including output-file preservation,
bounded artifact verification, real interruption, and stalled-worker cleanup.
Independent comparisons verified all expected scientific results. The files
also passed local checks on macOS with Python 3.9.6 and 3.12.14. These checks
validate the small examples, not a performance or capacity guarantee.

## Prepare a project terminal

Use a project you can edit and an existing Python 3.9 or later interpreter on
Linux or macOS. This example uses only the standard library. Its output
directory must support hard links; unsupported filesystems fail rather than
replace existing files. A working project terminal does not require a Jupyter
kernel.
Check [your compute allocation](/docs/hosts/choose-compute) before running up to
two workers plus their coordinator and possible Python resource-tracker
process. A worker setting does not reserve CPU cores or establish a memory
limit. Avoid competing work in the same project during the comparison.

Create a new folder named \`scientific-cpu-demo\` in your project's home
directory. Download \`scientific-prototype-v2-workflows.py\` and
\`scientific-prototype-v2-tests.py\` from the
[scientific example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows/scientific)
and upload both into that folder using **Files**. For CLI transfers, follow
[the remote research guide](/docs/research/remote-cli).

Run these commands in a **project terminal**:

~~~sh
cd "$HOME/scientific-cpu-demo"
pwd
python3 -c 'import sys; print(sys.executable); print(sys.version)'
ls scientific-prototype-v2-workflows.py scientific-prototype-v2-tests.py
~~~

Stop if the folder or interpreter is missing. Record the interpreter path and
version. The script uses a guarded command-line entry point and Python's
\`spawn\` process start method; these instructions do not create a process pool
inside a notebook cell.

## Define eight cases

For each rate, calculate the integral of \`exp(-rate*x)\` from \`0\` to \`1\` with
20,000 midpoint intervals. Create the exact small fixture:

~~~sh
python3 - <<'PY'
import json
from pathlib import Path
with Path("rates.json").open("x") as stream:
    json.dump([0, 0.125, 0.5, 1, 2, 4, 8, 16], stream)
print("Created eight distinct rates")
PY
~~~

The example accepts a JSON file of at most 4,096 bytes containing 1–32 unique,
finite numeric rates from \`0\` to \`100\`. Its argument limits are 1–4 workers
and 10–500,000 intervals. The reference checks use only one and two workers;
keep those small settings for this exercise.

## Compare one worker with two

Use separate fresh output prefixes:

~~~sh
python3 scientific-prototype-v2-workflows.py parallel --rates rates.json --out cpu-one-worker --workers 1 --intervals 20000
python3 scientific-prototype-v2-workflows.py parallel --rates rates.json --out cpu-two-workers --workers 2 --intervals 20000
python3 scientific-prototype-v2-workflows.py verify --out cpu-one-worker
python3 scientific-prototype-v2-workflows.py verify --out cpu-two-workers
~~~

Each computation prints \`started bounded CPU sweep\`, eight \`completed rate-...\`
lines, and finally \`verified complete: 8 results\`. Completion order can vary.
Each separate verification command should also print \`verified complete: 8 results\`
and exit successfully.

Each prefix has three completed-run files:

| Suffix | Contents |
| --- | --- |
| \`.started.json\` | Rates, interval and worker counts, method, input hash, script hash, Python version |
| \`.results.jsonl\` | Eight records with \`id\`, \`rate\`, \`intervals\`, and \`integral\` |
| \`.manifest.json\` | Completion marker, submitted-case count, result count and checksum |

The coordinator keeps at most one pending task per worker. Workers return
records; only the coordinator writes these artifacts. A \`.partial.jsonl\` file
without a completion manifest is incomplete even if it contains plausible
numbers.

## Check against independent calculations

This checker uses a reverse-order serial sum and the closed-form integral.
It also compares all saved records between the two worker counts:

~~~sh
python3 - <<'PY'
import hashlib
import json
import math
import unittest
from pathlib import Path

check = unittest.TestCase()
rates = json.loads(Path("rates.json").read_text())
check.assertEqual(rates, [0, 0.125, 0.5, 1, 2, 4, 8, 16])
intervals = 20000
outputs = []
for prefix in ("cpu-one-worker", "cpu-two-workers"):
    records = [json.loads(line) for line in Path(prefix + ".results.jsonl").read_text().splitlines()]
    check.assertEqual(len(records), 8)
    actual = {record["id"]: record for record in records}
    check.assertEqual(set(actual), {f"rate-{index:03d}" for index in range(8)})
    for index, rate in enumerate(rates):
        record = actual[f"rate-{index:03d}"]
        check.assertEqual(record["rate"], rate)
        check.assertEqual(record["intervals"], intervals)
        total = 0.0
        for cell in reversed(range(intervals)):
            total += math.exp(-rate * (cell + 0.5) / intervals)
        check.assertAlmostEqual(record["integral"], total / intervals, places=12)
        exact = 1.0 if rate == 0 else -math.expm1(-rate) / rate
        bound = rate * rate / (24 * intervals * intervals) + 1e-14
        check.assertLessEqual(abs(record["integral"] - exact), bound)
    manifest = json.loads(Path(prefix + ".manifest.json").read_text())
    check.assertEqual(manifest["specification"]["parameters"]["input_sha256"], hashlib.sha256(Path("rates.json").read_bytes()).hexdigest())
    outputs.append(actual)
check.assertEqual(outputs[0], outputs[1])
print("PASS: eight cases, independent serial and analytic checks, equal worker results")
PY
~~~

The rate-zero result is \`1.0\`; the rate-one result is approximately
\`0.632120558763\`. The error bound applies to this integrand and interval, not
to arbitrary numerical workloads. A failed assertion requires investigation
before using the example as a research result.

## Handle failures and interruption

| Symptom | Next step |
| --- | --- |
| Invalid rates or resource arguments | Fix a copy of the inputs or lower the settings; choose a fresh prefix. |
| \`output prefix already used\` | Preserve that run and use another prefix. This pool example does not resume it. |
| Worker exception or interruption | Wait for the process to exit, then run \`verify\` on that prefix and inspect its exit status. |
| No completion manifest or checksum/schema failure | Treat the saved output as incomplete or inconsistent. |
| Slow or unresponsive project | Inspect the project's current resource use before starting another run; adding workers may make contention worse. |

For a deliberately resumable example, use
[the checkpointed computation guide](/docs/research/resume-computation).
The pool's context manager may wait for running tasks during shutdown; do not
assume an interrupted command has already stopped every process.

For a broader regression check, run the companion suite from this new
folder, with both files beside one another:

~~~sh
python3 -B scientific-prototype-v2-tests.py
~~~

The recorded hosted result was \`Ran 14 tests in 12.472s\` followed by \`OK\`. The suite writes
PID-prefixed synthetic fixtures beside itself, checks malformed inputs and
42 checksum-consistent corruptions, simulates a worker failure, and interrupts
a real child run. It includes a two-worker interruption case with 16 rates and
500,000 intervals. Per-process CPU limits and subprocess timeouts bound that
test; they do not impose a total RAM limit. Its \`resource\` module requires a
compatible Unix-like runtime. Your runtime and elapsed time can differ.

\`verify\` checks schema, expected cases, counts, and checksums; it does not
independently recompute the science or authenticate the artifacts. The
interruption test does not establish recovery from a project stop, host failure,
out-of-memory kill, or network reconnection.

## Hand off and clean up

Keep \`rates.json\`, both scripts, and all three files for each completed prefix.
Add a README with the exact commands, interpreter path/version, compute image
when applicable, and the independent comparison result. Review environment
details before publishing; see [the research handoff guide](/docs/projects/research-handoff).

After the commands have exited and you have retained the results, remove only
the new \`scientific-cpu-demo\` folder through **Files**. Do not stop another
person's processes or a shared project. These completion files do not replace
backups.

For large row-oriented inputs, see
[streaming group statistics](/docs/research/streaming-analysis).
`;
