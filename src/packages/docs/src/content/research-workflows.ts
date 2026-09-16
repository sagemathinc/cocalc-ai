/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_REPRODUCE_BODY = `
Reproduce a small Python analysis in a **new project**, starting from its saved
inputs and code. You will check the input bytes and numeric result, and record
the software used. Reopening a notebook's old output is not this check.

## Before you start

Use two projects that you can edit, with Python 3 available. This example uses
only the Python standard library. It does not require a GPU or installation of
analysis packages. Use a new \`research-workflow\` folder so existing work is not
overwritten. The commands below run in a **CoCalc project terminal**, not on your
laptop. See [Create a project](/docs/projects/create-project) and
[Use the terminal](/docs/terminal/use-terminal).

The complete [example files](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows)
are in the public source repository. Download \`measurements.csv\` and \`analyze.py\`
using each file's **Download raw file** control, then upload them into the same
project folder. For scripted transfer, use
[Run an analysis from your laptop](/docs/research/remote-cli).

## Run the original analysis

In the project terminal, go to that folder. These examples assume the standard
project home; use \`pwd\` and adjust the path if yours differs.

~~~sh
cd /home/user/research-workflow
python3 --version
python3 analyze.py measurements.csv result.json
~~~

Expected output:

~~~text
count=4 mean=5.0
~~~

The CSV contains a \`value\` header followed by 2, 4, 6, and 8. The script writes
\`result.json\` with \`count\`, \`mean\`, and \`input_sha256\`. Check the saved result,
rather than treating an exit message as evidence that the right file was used:

~~~sh
python3 - <<'CHECK'
import hashlib
import json
from pathlib import Path
r = json.loads(Path("result.json").read_text())
assert r["count"] == 4
assert r["mean"] == 5.0
assert r["input_sha256"] == hashlib.sha256(Path("measurements.csv").read_bytes()).hexdigest()
print("PASS: saved result and input hash match")
CHECK
~~~

A hash checks identical input bytes; it does not establish whether research data
are correct. A changed line ending also changes the hash.

## Record the environment and evidence

Create a small manifest beside the result:

~~~sh
python3 - <<'MANIFEST'
import hashlib
import json
import platform
from pathlib import Path
manifest = {
    "python": platform.python_version(),
    "system": platform.system(),
    "machine": platform.machine(),
    "files": {
        name: hashlib.sha256(Path(name).read_bytes()).hexdigest()
        for name in ("analyze.py", "measurements.csv", "result.json")
    },
}
Path("manifest.json").write_text(json.dumps(manifest, indent=2) + "\\n")
print("Saved manifest.json")
MANIFEST
~~~

Add a \`README.md\` with the question, the run command, expected output, Python
version, selected runtime image or catalog identifier, and what you checked.
For a real analysis, also record package versions or a lockfile, data provenance,
seeds, and appropriate numerical tolerances. Do not copy credentials into the
manifest or publish private data to make an example reproducible.

## Rerun independently

1. Create a new project and a new \`research-workflow\` folder.
2. Transfer \`analyze.py\`, \`measurements.csv\`, \`manifest.json\`, and the README
   from the first project. **Do not copy \`result.json\` yet**; the second run must
   create it. You may use download/upload or the CLI transfer guide.
3. In the second project's terminal, change to the new folder and verify the
   transferred inputs against the first run's manifest:

~~~sh
python3 - <<'CHECK'
import hashlib
import json
from pathlib import Path
m = json.loads(Path("manifest.json").read_text())
for name in ("analyze.py", "measurements.csv"):
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == m["files"][name], name
print("PASS: input and code match the original")
CHECK
python3 analyze.py measurements.csv result.json
~~~

4. Repeat the saved-result check above. For this deterministic example, compare
   the new artifact with the original manifest as well:

~~~sh
python3 - <<'CHECK'
import hashlib
import json
from pathlib import Path
m = json.loads(Path("manifest.json").read_text())
assert hashlib.sha256(Path("result.json").read_bytes()).hexdigest() == m["files"]["result.json"]
print("PASS: independent result matches the original")
CHECK
~~~

5. Record the second project's Python version and image independently. Keep the
   original manifest; do not overwrite it with a new manifest before comparing.
   Matching this simple result does not prove all software environments are
   equivalent. For real floating-point or GPU workloads, compare the scientific
   acceptance criteria rather than assuming byte-for-byte output equality.

## Reproduce software as well as files

A [custom kernel](/docs/jupyter/custom-kernels) can isolate notebook dependencies.
Record its executable and recreate its packages in the new project. A
[published RootFS](/docs/projects/publish-rootfs) can share installed system
software, but publishing excludes \`/home/user\`, \`/root\`, and \`/tmp\`.
Research files and a virtual environment under HOME are **not automatically
included**. Transfer the files and recreate HOME-based environments separately.
Do not assume an image label alone captures a dataset or an external service.

For a notebook version of this analysis, follow
[Move a Jupyter or Colab notebook](/docs/research/notebook-migration).
Then use [Research handoff](/docs/projects/research-handoff) to let a collaborator
repeat the same checks, with the correct access to the files.

## Diagnose a mismatch

- **File not found:** run \`pwd\` and check that code and CSV are in the same folder.
  A remote Jupyter kernel reads a different machine's filesystem; see
  [Remote kernels](/docs/jupyter/remote-kernels).
- **CSV or assertion error:** inspect the header and values before changing the
  test. Compare input and code hashes first.
- **A real package is missing:** install it into the interpreter or kernel
  actually running the analysis, not an unrelated terminal Python.
- **Same inputs, different scientific output:** record both environments and
  investigate software versions, randomness, hardware, and tolerances. Do not
  replace the expected result merely to make the comparison pass.

After review, retain the source, manifest, and result together. Remove only the
example folders or disposable projects you no longer need through the normal
project controls.
`;

export const RESEARCH_MIGRATION_BODY = `
Move an ordinary \`.ipynb\` notebook from local Jupyter or Colab into a CoCalc
project, restore its inputs and Python environment, and check a fresh execution.
This is a file-and-environment migration; source-platform services are not
converted automatically.

## Prepare the source files

1. Save the notebook in the source application and download its \`.ipynb\` file.
   Also download the datasets and local modules it reads. Keep their relative
   directory structure. Do not rely on outputs already embedded in the notebook.
2. Record the Python version and required packages. If the source environment
   has a reproducible dependency file, include it. Review notebook cells for
   absolute paths, credentials, cloud mounts, and platform-specific APIs.
3. For a small practice migration, download \`analysis.ipynb\`, \`analyze.py\`, and
   \`measurements.csv\` from the
   [research example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows).
   Use each file's raw download, not an HTML copy of its GitHub page. This example
   uses only the Python standard library for analysis.

## Upload into one project folder

Open a project you can edit. In the full CoCalc file browser, create and open a
new \`research-workflow\` folder, then upload the three practice files there. For
nested real datasets, preserve subdirectories; uploading only the notebook does
not transfer their contents. See [Project files](/docs/files/project-files) and
[SSH, SCP, and rsync](/docs/terminal/ssh-access) for transfer choices.

Open \`analysis.ipynb\` in the full notebook editor and use **Kernel -> Change
Kernel...** to select a local Python 3 kernel. The saved kernelspec from another
computer may name an environment that is not installed in this project. Selecting
a matching language does not install the original packages.

For this first migration, choose a kernel running **inside the project**.
[Remote SSH kernels](/docs/jupyter/remote-kernels) are a separate option: project
uploads do not synchronize to their remote filesystem.

## Check the interpreter and files

The practice notebook's first cell checks its working directory and required
files. In your own notebook, run an equivalent preflight:

~~~python
import sys
from pathlib import Path
print(sys.version)
print(sys.executable)
print(Path.cwd())
assert Path("measurements.csv").is_file(), "Place the CSV beside this notebook"
~~~

Check that the path is the intended project folder. Prefer paths relative to the
notebook's working folder over laptop-specific paths. For a more complex layout,
record where execution starts and use explicit paths to the data.

## Recreate missing packages

The practice analysis needs no additional packages. For other notebooks, follow
[Create a custom kernel](/docs/jupyter/custom-kernels) to create an isolated
Python environment, install \`ipykernel\` and the needed packages, and register it.
Select that kernel, restart it after package changes, and rerun the preflight.

Do not conclude that installation worked for the notebook merely because an
import succeeds in a separate terminal. Compare \`sys.executable\` in the notebook
with the Python used to install packages. Pin versions when the source notebook
requires them and record any compatibility changes you make.

## Distinguish a missing kernel from a missing package

If R, SageMath, or another language is absent from the selector, inspect the
[project runtime image](/docs/projects/runtime-image) first. Images provide
different software; the notebook file does not bring its original kernel along.
In a project terminal, inspect the registered kernels:

~~~sh
jupyter kernelspec list
~~~

Use the displayed kernelspec locations to identify a user registration that may
shadow a system kernel. Inspect before changing it; do not delete all user
Jupyter configuration to fix one notebook. If the command itself is unavailable,
record that error and check the selected environment. For R, \`R --version\` in the
project terminal independently checks the terminal executable, not the notebook
registration. After changing an image or registration, reopen the kernel selector,
choose the intended kernel, and rerun the notebook preflight.

A missing shell command is another layer: \`command -v python3\` and
\`python3 -m pip --version\` identify the terminal's interpreter and pip location.
Compare them with the notebook's \`sys.executable\`. An importable package does not
necessarily install a shell command with the same name, or add it to PATH.

## Replace source-platform assumptions

| Source notebook dependency | What to do in CoCalc |
| --- | --- |
| A Colab Drive mount or \`/content/...\` path | Transfer the required data into the project or explicitly configure its original storage service; update the paths. |
| \`google.colab\` helpers | Replace the particular upload, display, or integration step with an equivalent project workflow. There is no general automatic conversion. |
| A source-platform secret store | Configure the needed credential separately using [Project secrets](/docs/projects/project-secrets); keep it out of notebook cells and outputs. |
| An assumed accelerator | Verify actual device availability using [GPU notebook checks](/docs/research/gpu-notebook). A notebook file does not allocate a GPU. |
| Notebook widgets or rich HTML | Use the full notebook editor and verify the specific output; a saved preview may not reproduce the interaction. |

## Run from a fresh kernel and inspect the artifact

Restart the kernel to clear old variables, then run every cell from top to
bottom. For the practice notebook, confirm:

~~~text
count=4 mean=5.0
Saved result matches the computation
~~~

The notebook asserts the count and mean, saves \`notebook-result.json\`, and reads
it back. Open that file from the project file browser. It should contain \`count\`
4, \`mean\` 5.0, and an input SHA-256 hash. Save the notebook, close and reopen it,
and confirm that its code and saved outputs are present.

For your real notebook, define equivalent checks before accepting the migration:
expected table dimensions, representative values, plots, and exported files.
A notebook can finish executing while one or more cells contain errors. Inspect
the outputs, not just whether a run command returned.

Download the resulting notebook and JSON if you need a local copy. Test a fresh
project rerun with [Reproduce an analysis](/docs/research/reproduce-analysis), and
leave a [handoff note](/docs/projects/research-handoff) containing the source,
environment, run order, checked output, and unresolved differences.

## Troubleshoot the first rerun

- **Unknown kernel:** choose or register an installed kernel; copying a kernelspec
  name does not copy its interpreter.
- **ModuleNotFoundError:** check the active interpreter before reinstalling.
- **FileNotFoundError:** check paths, uploaded subfolders, and local versus remote
  kernel location.
- **Kernel terminated:** use [Kernel troubleshooting](/docs/troubleshooting/jupyter-kernel-terminated)
  and start with a smaller dataset; repeated full reruns can repeat the same
  memory failure.
- **Different result:** compare the input bytes, package versions, cell execution
  order, and random seeds. Preserve the original notebook while investigating.
`;

export const RESEARCH_RESUME_BODY = `
Run a small computation that saves each completed case, deliberately fail it,
and resume without recomputing finished cases. You will verify the saved results
rather than infer success from a still-open terminal.

This is the executable companion to
[Research Runs That Survive](https://sagemathinc.github.io/cocalc-guides/research-computation/).
A persistent project keeps files available; it cannot preserve process memory
through a project restart, host failure, or every connection outage.

## Prepare a disposable run

In a project with Python 3, create a new \`research-workflow\` folder and upload
\`sweep.py\` and \`summarize_run.py\` from the
[complete example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows).
Open a CoCalc terminal file in that folder. Record its filename so you can return
to the same terminal; opening a new terminal starts a different session.

~~~sh
cd /home/user/research-workflow
mkdir -p runs
~~~

The scripts use only the Python standard library. Use a fresh run directory for
each changed experiment and only one worker per directory. The sample validates
existing checkpoint contents before skipping them; it is not a general job
scheduler or a solution for multiple simultaneous workers.

## Deliberately fail after three completed cases

The example computes squares for cases 0 through 5. The first command below is
**expected to fail**, after saving cases 0, 1, and 2:

~~~sh
python3 -u sweep.py --out runs/failure-demo --stop 6 --fail-at 3 > runs/failure-demo.log 2>&1
run_status=$?
printf 'exit=%s\\n' "$run_status"
cat runs/failure-demo.log
~~~

Expected status: \`exit=1\`. The log begins with:

~~~text
completed case=0
completed case=1
completed case=2
~~~

It ends with an intentional failure at case 3. If run from a script using
\`set -e\`, handle this expected failure explicitly so the wrapper does not stop
before recording the status. Logs are redirected directly here; piping through
\`tee\` requires care to preserve the Python command's exit status.

Inspect the completed checkpoints:

~~~sh
ls runs/failure-demo/case-*.json
python3 summarize_run.py runs/failure-demo --stop 6
~~~

The summary should fail with an incomplete-cases error. That failure is useful:
three result files are not a completed six-case experiment.

## Resume and verify

Run the same experiment without the deliberate failure flag:

~~~sh
python3 -u sweep.py --out runs/failure-demo --stop 6 >> runs/failure-demo.log 2>&1
run_status=$?
printf 'exit=%s\\n' "$run_status"
tail -n 6 runs/failure-demo.log
python3 summarize_run.py runs/failure-demo --stop 6
~~~

Expected final log lines:

~~~text
skip case=0
skip case=1
skip case=2
completed case=3
completed case=4
completed case=5
~~~

Expected status is \`exit=0\`, and the summary prints:

~~~text
completed=6 sum_of_squares=55
~~~

The sample writes each result to a temporary file and renames it after writing.
After interruption, an unfinished \`.tmp\` file is not a completed case and can be
recomputed. This reduces partial-result confusion; it is not a guarantee of
survival through storage failure. Keep configured backups for important work.

## Try reconnecting to a running terminal

Use a different run directory and a longer per-case delay:

~~~sh
python3 -u sweep.py --out runs/reconnect-demo --stop 6 --delay 5 > runs/reconnect-demo.log 2>&1
~~~

Close only the browser tab while the command is running, then reopen the project
and the **same terminal file**. Do not stop or restart the project. Inspect the
log from another terminal if needed:

~~~sh
tail -n 10 /home/user/research-workflow/runs/reconnect-demo.log
~~~

When execution is finished, run the summary on \`runs/reconnect-demo\`. If the
session or process ended, first check whether a worker is still running before
starting another. Resume using the same output directory only after the prior
worker has stopped. Do not assume a missing browser response means the command
never ran.

## Choose the right recovery action

| What happened | What to inspect and do |
| --- | --- |
| Only the browser disconnected | Reopen the same terminal and inspect its output and log before submitting another run. |
| The Python process failed | Inspect the exit status and traceback, fix the cause, then resume from validated checkpoints. |
| The kernel or project restarted | In-memory state is gone. Restart the computation from saved inputs and checkpoints. |
| A checkpoint is malformed or has unexpected content | Stop and investigate; retain the evidence and use a separate run directory rather than silently accepting it. |
| Files were deleted or the environment broke | Follow [Recover research work](/docs/research/recover-work); a log is not a backup. |

For notebooks, the [CLI notebook workflow](/docs/cli/notebook-workflows) explains
how to retain a detached run ID and inspect execution. Detaching the request does
not make an experiment checkpoint itself. For a
[remote SSH kernel](/docs/jupyter/remote-kernels), files written by code live on
the remote machine and need their own recovery plan.

## Hand off the run

Keep the scripts, run directory, log, input or parameter description, and final
summary together. Record the exit status and last verified completed case in the
[handoff note](/docs/projects/research-handoff). A collaborator should be able to
run the summary without rerunning the experiment first. For a real workload,
include the code revision, environment, input hashes, and a restart command.

Once the example is reviewed, remove only its two run directories if you no
longer need them. Keep the scripts for reuse, and choose a new directory when
changing their computation.
`;
