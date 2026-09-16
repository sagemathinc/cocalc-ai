/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_RECOVERY_BODY = `
Recover one research file without rewinding the rest of a project, then learn
when an environment or project restore is the appropriate operation. The
exercise uses disposable data; do it before you need to recover important work.

## Choose the smallest recovery operation

| What happened? | Start here | Scope to check |
| --- | --- | --- |
| A notebook or text file contains an unwanted edit. | Open the file's **TimeTravel**, inspect an earlier version, then **Restore This Version**. | Changes this document and records the restoration as a new version. Other project files are not restored. |
| A file was deleted, or the version you need is in a filesystem checkpoint. | **Files -> Recovery -> Open Snapshots** or **Open Backups**. Browse to the file and restore a temporary copy first. | Recover the selected file, then compare it with current work. |
| Many files in HOME need to return to a known checkpoint. | **Settings -> Recovery -> Restore Snapshot**, then **Restore HOME only**. | Rewinds HOME while retaining the current root filesystem. This also rewinds HOME-based environments and documents in the restored paths. |
| A systemwide software change broke the project, but current research files must stay. | **Restore Snapshot**, then **Restore rootfs only**. | Restores the root filesystem image and preserves HOME. It does not repair a virtual environment installed inside HOME. |
| Research files and the system environment must return together. | **Restore Snapshot**, then **Restore both HOME and rootfs**. | Rewinds both areas, including affected notebooks and chat documents. |
| You want a separate workspace before experimenting. | **Settings -> Recovery -> Clone**, then **Create Clone**. | Copies the current HOME, root filesystem customizations, TimeTravel history, and project secrets. Snapshots and collaborators are not copied. |

A clone is a copy of the current state, not a selection of an older checkpoint.
Snapshots are host-local checkpoints. Backups are host-independent archives
that can include project files, rootfs state, and TimeTravel history; their
file-search interface searches HOME. Availability, retention, and the newest
recoverable time depend on the project's runtime and configured schedules.

## Prepare a disposable example

Use an editable project with Python 3 and enabled snapshots. Open its full
CoCalc interface; from Essential, use **File actions -> Full CoCalc** on a file
or **More -> Settings -> Full project settings**. If you do not have a suitable
project, follow [Create a project](/docs/projects/create-project). Do not run a
whole-project restore exercise in a project containing other people's work.

Open a project terminal and run this once. It deliberately refuses to reuse
an existing example directory.

~~~sh
cd "$HOME"
python3 - <<'PY'
from pathlib import Path

folder = Path("recovery-demo")
folder.mkdir()
(folder / "measurements.csv").write_text("value\\n2\\n4\\n6\\n8\\n")
print("Created recovery-demo/measurements.csv")
PY
~~~

If the directory already exists, choose a different name and substitute it
throughout the exercise. In **Files**, open \`recovery-demo/measurements.csv\`
and check that it contains the heading \`value\` followed by 2, 4, 6, and 8.

1. Open **Settings -> Recovery -> Create Snapshot**.
2. Enter a unique name such as \`recovery-demo-before-edit\` and choose
   **Create Snapshot**.
3. In **Files -> Recovery -> Open Snapshots**, open that snapshot and verify
   that its \`recovery-demo/measurements.csv\` has those original values.
   Do not change or delete the live file until this check succeeds.
4. Return to the live \`recovery-demo/measurements.csv\` in **Files**. Change
   its final value from 8 to 80, save it, and confirm the change after reopening
   the live file.

Named snapshots retain data and count against the project's quota. A
**Manual snapshot limit reached** message means that you must resolve the
limit before claiming a checkpoint exists.

## Recover a file without overwriting current work

1. Use **Files -> Recovery -> Open Snapshots** again. Open the named checkpoint
   and select \`recovery-demo/measurements.csv\`.
2. In **Snapshot selection**, check **Selected path** and **Preview**. The
   preview should contain 8, not 80.
3. Choose **Restore to /tmp/<path>**. For this example the destination is
   \`/tmp/recovery-demo/measurements.csv\`. If you have used that temporary
   path before, preserve or remove your earlier comparison copy first.
4. After **Restore completed**, run the comparison below in a terminal.

~~~sh
cd "$HOME"
python3 - <<'PY'
import csv
from pathlib import Path

def mean(path):
    with path.open(newline="") as stream:
        values = [float(row["value"]) for row in csv.DictReader(stream)]
    return sum(values) / len(values)

live = Path("recovery-demo/measurements.csv")
recovered = Path("/tmp/recovery-demo/measurements.csv")
print(f"live mean={mean(live):.1f}")
print(f"recovered mean={mean(recovered):.1f}")
assert mean(live) == 23.0
assert mean(recovered) == 5.0
PY
~~~

Expected output:

~~~text
live mean=23.0
recovered mean=5.0
~~~

Copy the checked version into HOME under a new name so it is retained with
the research files. This command refuses to overwrite an existing result:

~~~sh
cd "$HOME"
python3 - <<'PY'
from pathlib import Path

source = Path("/tmp/recovery-demo/measurements.csv")
target = Path("recovery-demo/measurements-recovered.csv")
with target.open("xb") as stream:
    stream.write(source.read_bytes())
print("Saved recovery-demo/measurements-recovered.csv")
PY
~~~

Open the saved file in **Files**, then reload it and verify the four original
values. Keeping the changed file and the recovered copy makes the decision
reviewable. If the original file is missing, this same workflow recovers a
separate copy without first recreating the original path.

For older data in a backup, use **Recovery -> Open Backups**, choose the backup
and file, and inspect **Backup selection**. The temporary-copy option is the
same, but **Restore started** means the operation is still asynchronous. Wait
for its completion and inspect the restored file before using it.

## Restore an earlier editor revision

For an edit retained in [TimeTravel](/docs/files/timetravel), open the live file,
choose **TimeTravel**, and inspect the desired version. Use **Restore This
Version** only after checking the displayed contents. Reopen the live editor,
save if necessary, and verify its contents after a reload. Keep a separate
copy of useful current work before restoring over it. An empty history is not
evidence that a snapshot or backup also lacks the file; inspect those sources
separately.

## Restore an environment or an entire HOME

Use this procedure when a file copy is insufficient. First record the failing
command, its error, the desired checkpoint, and the software location. For a
Python environment, \`python3 -c 'import sys; print(sys.executable)'\` helps
distinguish a HOME virtual environment from system software.

1. Save current work and coordinate with project collaborators. Whole-project
   snapshot restoration stops and restarts the project; running processes do
   not continue from their previous memory state.
2. Open **Settings -> Recovery -> Restore Snapshot**.
3. Under **Snapshot to restore**, choose the checkpoint you inspected.
4. Under **Restore mode**, explicitly choose the HOME, rootfs, or combined
   option from the table above. The dialog initially selects both.
5. Record **Safety snapshot name** outside the project before proceeding.
   Keep its unique suggested value or provide another unique name. The
   workflow creates this snapshot of the current state before restoring.
6. Choose **Restore Snapshot** and complete any sign-in verification the
   interface requests. Wait for the restore operation to finish and the
   project to be available again.
7. Reopen the research files, restart the notebook kernel, rerun the original
   failing command, and record the new result. A completed restore alone does
   not prove the scientific result or environment is correct.

Project secrets are managed separately from filesystem snapshots and backups;
do not expect this operation to rewind secret values. See
[Project secrets](/docs/projects/project-secrets). A rootfs restore preserves HOME,
including a broken HOME-based virtual environment. For that case, rebuild the
environment from its recorded dependencies or choose a suitable HOME restore
after preserving newer research work.

## Troubleshooting and cleanup

- Missing recovery controls can indicate that the runtime does not support
  snapshots or backups. Check **Settings -> Recovery** and the project's
  placement before assuming a recovery point exists.
- No matching history may mean the file was created after the selected
  checkpoint, retained history expired, or the project moved hosts. Check
  backup dates and the exact path; host-local snapshots do not follow a move.
- Storage usage includes retained history as well as live files. Deleting a
  live file may not immediately reduce usage retained by snapshots. Inspect
  storage and recovery points before cleanup; deleting a snapshot removes that
  recovery option. If quota prevents cleanup, preserve the error and ask support
  for the appropriate recovery path rather than running internal quota commands.
- A full restore can rewind chatrooms and Codex conversations stored in the
  restored filesystem. Keep the incident note and checkpoint identifiers
  outside that filesystem while restoring it.
- Copy useful recovered data out of \`/tmp\`; it is a temporary inspection
  location. Retain the named checkpoint until you have verified recovery, then
  remove only the disposable files and checkpoints you deliberately created.

For a real incident, leave the recovered file, checkpoint date, comparison,
and next action in a handoff note. Follow
[Start and hand off a research task](/docs/projects/research-handoff) to give
a colleague the correct access and links.
`;

export const RESEARCH_GPU_BODY = `
Verify that a Python notebook can actually use a CUDA GPU, perform a tiny
calculation on it, and save enough information for a collaborator to check
the result. The example distinguishes an installed GPU-capable framework from
an accessible GPU device.

## Check compute and software separately

You need an editable CoCalc project running on a host with an NVIDIA GPU
exposed to that project, a compatible host driver, and a Python Jupyter kernel
with CUDA-enabled PyTorch. An image name or a successful package import does
not establish GPU access. Availability depends on the deployment, host,
region, capacity, and your access to that host.

1. Check the intended host and project placement using
   [Use project hosts](/docs/hosts/project-hosts). Use
   [Move projects between hosts](/docs/hosts/move-projects) when appropriate;
   do not assume changing a software image allocates different hardware.
2. In the full project interface, open **Settings -> Environment**. Under
   **Image**, choose **Details** and inspect the selected runtime image.
   Follow [Project images](/docs/projects/runtime-image) if it must change.
   Save ongoing work before applying a change that restarts the project.
3. Choose an available image containing CUDA-enabled PyTorch, or have the
   environment prepared using a compatible recipe. The source repository's
   \`ml-pytorch-gpu\` example installs a Python Jupyter environment and
   \`cocalc/pytorch-gpu\`. A recipe existing in source does not mean its
   resulting image is published or accessible on your deployment.
4. In a new \`gpu-demo\` folder, create \`gpu-check.ipynb\`. In its full
   notebook editor use **Kernel -> Change Kernel...** to select the Python
   kernel belonging to that environment, then save the notebook.

For a first notebook, use
[Start and hand off a research task](/docs/projects/research-handoff). The
commands below run in notebook code cells, not in the terminal.

If your GPU is on a separately managed machine, consider
[Remote Jupyter kernels](/docs/jupyter/remote-kernels) instead. With a remote
kernel, these cells execute on that machine and \`gpu-result.json\` is written
to its filesystem. Transfer the checked result back into the CoCalc project
before following the file-browser and handoff steps below.

## Run the preflight in the notebook kernel

~~~python
import sys
import torch

print("python:", sys.executable)
print("torch:", torch.__version__)
print("cuda build:", torch.version.cuda)
print("gpu available:", torch.cuda.is_available())
print("visible device count:", torch.cuda.device_count())

if not torch.version.cuda:
    raise RuntimeError("This notebook kernel has a PyTorch build without CUDA")
if not torch.cuda.is_available():
    raise RuntimeError("No CUDA GPU is accessible from this notebook kernel")

print("device:", torch.cuda.get_device_name(0))
~~~

Expected: a Python executable path, installed PyTorch and CUDA build versions,
\`gpu available: True\`, a positive device count, and a GPU device name.
Exact paths, versions, and names vary. Stop here if either preflight check
fails; a CPU fallback would not verify the GPU workflow.

The source recipe's verifier makes the same distinction: it checks that the
wheel is CUDA-enabled, and only requires a visible GPU when its
\`require_gpu\` setting is true. The sample image recipe uses false so that
an image can be built without a GPU attached. Consequently, an image build
passing verification is not a successful notebook GPU test.

## Compute on the GPU and save the evidence

Run this as the next cell in the same notebook. It writes a JSON result to
the notebook kernel's working directory and refuses to replace an existing
result. If rerunning, choose a new result filename deliberately.

~~~python
import json
import platform
from pathlib import Path

output = Path("gpu-result.json")
if output.exists():
    raise FileExistsError(f"Choose a new result filename: {output.resolve()}")

values = torch.tensor([2.0, 4.0, 6.0, 8.0], device="cuda:0")
mean = values.mean()
torch.cuda.synchronize()
assert values.is_cuda
assert mean.is_cuda
assert mean.item() == 5.0

record = {
    "python_version": platform.python_version(),
    "python_executable": sys.executable,
    "torch_version": str(torch.__version__),
    "cuda_build_version": torch.version.cuda,
    "device": str(values.device),
    "device_name": torch.cuda.get_device_name(values.device),
    "input_values": [2.0, 4.0, 6.0, 8.0],
    "count": values.numel(),
    "mean": mean.item(),
}
with output.open("x") as stream:
    json.dump(record, stream, indent=2)
    stream.write("\\n")

print(f"count={record['count']}")
print(f"mean={record['mean']:.1f}")
print(f"device={record['device']}")
print("saved:", output.resolve())
~~~

Expected calculation output:

~~~text
count=4
mean=5.0
device=cuda:0
~~~

The final line gives the absolute location of \`gpu-result.json\`. Open that
file in **Files** and inspect its device, framework versions, inputs, and
result. Save the notebook, reload it, and confirm that both the code and output
remain. This tiny example demonstrates device execution; it is not a GPU
performance benchmark or a guarantee that a larger model fits in memory.

## Diagnose the failing layer

| Observation | Next check |
| --- | --- |
| \`ModuleNotFoundError: No module named 'torch'\` | Check \`sys.executable\` in this notebook and select the kernel for the prepared environment. A terminal's Python can be different. |
| \`torch.version.cuda\` is \`None\` | The selected kernel has a non-CUDA build. Correct the environment before investigating GPU allocation. |
| CUDA build version exists, but availability is false. | Check project placement, GPU exposure, and driver compatibility with the host operator. In a project terminal, \`nvidia-smi\` can provide driver/device diagnostics when installed; its absence alone does not identify the cause. |
| Allocation or out-of-memory error | Inspect device usage, reduce the workload, and release unused tensors or restart this kernel. The tiny check should precede a full training run. |
| The result is correct but the saved file is missing from the expected folder. | Use the absolute path printed by the cell. Check the notebook's working directory rather than assuming it matches the file browser. |

When asking for help, include the preflight output, intended image, and exact
error. Review output before sharing it externally; avoid sharing unrelated
project files or credentials.

## Hand off and release compute

Keep \`gpu-check.ipynb\`, \`gpu-result.json\`, the selected image identifier,
and a brief README together. State that the result was calculated on CUDA,
which GPU and framework were used, and that the next person needs equivalent
GPU access to repeat that device check. Use
[Research handoff](/docs/projects/research-handoff) for collaborator access.

Save the notebook and result before shutting down its kernel. For an otherwise
unused project, use the normal **Stop…** control under **Settings ->
Runtime** after coordinating with collaborators. Stopping a project kills its
processes; it is not the same as stopping an account-owned host. Manage any
dedicated host separately using [Project host lifecycle
actions](/docs/hosts/lifecycle). Do not stop a shared host to clean up this
example.
`;

export const RESEARCH_QUARTO_BODY = `
Create an R analysis whose input data, executable source, rendered report, and
environment record live together in one CoCalc project. This example calculates
the mean of four synthetic measurements and produces an HTML report.

## Prepare the project and check its tools

Use an editable project with R, Quarto, and the R packages \`knitr\` and
\`rmarkdown\` installed. The repository's Quarto image recipe combines
\`cocalc/r\`, \`cocalc/quarto\`, and \`cocalc/rstudio\`; available published
images vary by deployment. Follow [Project images](/docs/projects/runtime-image)
to inspect or change your environment. This example uses the terminal and
CoCalc's Quarto editor; opening a separate RStudio session is optional.

In a project terminal, run:

~~~sh
Rscript --version
quarto --version
Rscript --vanilla -e 'stopifnot(requireNamespace("knitr", quietly=TRUE), requireNamespace("rmarkdown", quietly=TRUE)); cat("R report dependencies ready\\n")'
~~~

The first two commands must print installed versions. The last must end with
\`R report dependencies ready\`. Resolve missing executables or packages in
the selected project environment before creating the report. Do not substitute
a notebook kernel for the terminal's R without checking which environment is
actually rendering the document.

If R is available but the two packages are missing, install them into R's
configured user library, then rerun the dependency check in a new R process:

~~~sh
Rscript --vanilla - <<'RS'
user_lib <- Sys.getenv("R_LIBS_USER")
stopifnot(nzchar(user_lib))
dir.create(user_lib, recursive = TRUE, showWarnings = FALSE)
install.packages(c("knitr", "rmarkdown"), lib = user_lib,
                 repos = "https://cloud.r-project.org")
RS
~~~

This requires outbound network access and a writable user library. If R or
Quarto itself is missing, select an available prepared image or have its owner
build one using the [RootFS recipe workflow](/docs/projects/publish-rootfs)
and the repository's
[Quarto recipe](https://github.com/sagemathinc/cocalc-ai/blob/main/src/packages/rootfs-recipes/examples/quarto.yaml).
Changing the image can restart the project, so preserve ongoing work first.
Quarto's [installation guide](https://quarto.org/docs/get-started/) describes
installation outside a prepared image.

## Create the data and report source

Use a new folder to keep source and outputs together. These terminal commands
refuse to reuse an existing \`quarto-demo\` directory:

~~~sh
cd "$HOME"
mkdir quarto-demo && cd quarto-demo
~~~

Continue only if both commands succeeded and your terminal is in
\`quarto-demo\`. Create the input:

~~~sh
cat > measurements.csv <<'CSV'
value
2
4
6
8
CSV
~~~

In **Files**, open \`quarto-demo\`, create \`report.qmd\`, and replace any
starter content with the following. Use the full editor; from Essential choose
**File actions -> Full CoCalc**. Keep \`measurements.csv\` in the same folder
as \`report.qmd\`.

~~~markdown
---
title: "A reproducible measurement report"
format:
  html:
    embed-resources: true
execute:
  echo: true
---

## Question and inputs

What is the mean of the four synthetic measurements in measurements.csv?
These values illustrate the workflow; they are not research observations.

\`\`\`{r}
measurements <- read.csv("measurements.csv")
stopifnot(identical(names(measurements), "value"))
stopifnot(is.numeric(measurements$value))
stopifnot(nrow(measurements) == 4L, !anyNA(measurements$value))
stopifnot(all(is.finite(measurements$value)))
result <- mean(measurements$value)
stopifnot(result == 5)
cat(sprintf("count=%d\\nmean=%.1f\\n", nrow(measurements), result))
\`\`\`

## Inspect the measurements

\`\`\`{r}
plot(seq_len(nrow(measurements)), measurements$value,
     type = "b", xlab = "Measurement number", ylab = "Value")
abline(h = result, col = "blue", lty = 2)
\`\`\`

## Result and interpretation

The four supplied values have mean 5.0. This example checks a calculation;
it does not estimate uncertainty or establish a scientific conclusion.

## Environment used to render this report

\`\`\`{r}
sessionInfo()
\`\`\`
~~~

The complete \`report.qmd\` and CSV are also available in the
[example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows).

## Render and verify the HTML

Save \`report.qmd\`. In the terminal, run from the report's directory:

~~~sh
cd "$HOME/quarto-demo"
quarto render report.qmd --log-level info
~~~

This is also the command shape used by CoCalc's Quarto build integration.
In the full Quarto editor you can instead choose **Build**, inspect **Build
Log**, and view **HTML (Converted)**. Use one build at a time. Merely opening
the source document is not a request to render it.

Check that the render finishes successfully and produces \`report.html\`.
Open the HTML in the project's file browser or the editor's converted HTML
view. Verify all of the following:

1. The title reads **A reproducible measurement report**.
2. The first executed code block reports \`count=4\` and \`mean=5.0\`.
3. The plot has four points at values 2, 4, 6, and 8, and a horizontal line
   at 5.
4. The environment section contains the actual R version and session details.

The report includes the analysis code because \`echo: true\` is enabled.
\`embed-resources: true\` keeps this report's plot and supporting resources
inside the HTML. Inspect the result after downloading it as well if you intend
to distribute that file. HTML is the intended output here; PDF requires a
separately configured PDF toolchain.

## Preserve a rerun and collaborator handoff

Record tool versions and the input checksum next to the report:

~~~sh
cd "$HOME/quarto-demo"
quarto --version > quarto-version.txt
Rscript --vanilla -e 'print(tools::md5sum("measurements.csv")); sessionInfo()' > environment.txt
~~~

Use the checksum to detect changed inputs, not as a security signature. Keep
\`measurements.csv\`, \`report.qmd\`, \`report.html\`,
\`quarto-version.txt\`, and \`environment.txt\` together. Add \`README.md\`
containing the input description, selected project image, render command,
checked result, and next research question.

Follow [Research handoff](/docs/projects/research-handoff) to grant a coauthor
collaborator access and share links to the source, data, and HTML. A link alone
does not grant access. Someone who only needs to read the result can receive
the downloaded HTML or appropriately configured viewer access.

To check independence from the original working directory, create a new
\`quarto-rerun\` folder, copy only \`measurements.csv\` and \`report.qmd\`
into it, and render there. Compare the reported count and mean rather than the
entire HTML file, which can contain generated metadata. For an environment
reproduction claim, repeat that step in a separately prepared project, following
[Reproduce an analysis](/docs/research/reproduce-analysis). An environment
record describes installed versions; it is not a dependency lockfile.

## Troubleshooting and cleanup

- **Command not found:** check the selected image and terminal environment.
  Having an R notebook kernel does not by itself prove that the Quarto CLI and
  its R dependencies are available to document builds.
- **Cannot open measurements.csv:** check spelling and case, keep the input
  beside the source, and run the terminal render from that directory.
- **A stopifnot check fails:** inspect the data. The expected result is
  deliberately fixed for this example; update both the analysis and its
  checks when you replace the synthetic inputs.
- **Old output remains after a failed build:** inspect the latest build log
  and rerun successfully before treating an existing \`report.html\` as
  current. Open or reload the converted view after the successful build.
- **No PDF file has been generated:** this example requests HTML. Inspect
  **HTML (Converted)**, or explicitly configure and verify a PDF format and
  toolchain before expecting a PDF.

Keep the source, data, and checked HTML for the handoff. Remove the disposable
rerun folder only after comparing results. No long-running preview server is
started by this render workflow. For R Markdown rather than Quarto source, see
[R Markdown](/docs/editors/r-markdown).
`;
