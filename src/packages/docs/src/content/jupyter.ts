/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CREATE_JUPYTER_BODY = String.raw`
## What CoCalc Jupyter notebooks are for

CoCalc notebooks are standard Jupyter notebooks in a backend project
environment. Kernels and outputs are not tied to the browser tab, so long-running
cells keep running and output is captured even if the browser disconnects.

## Create a notebook

1. Open the project.
2. Open **New**.
3. Choose **Notebook**.
4. Pick a filename and kernel.
5. Start running cells.

You can also create or open \`.ipynb\` files from the file browser, terminal, or
agent tools.

## Work with notebooks from agents

For live notebook work, agents should use the notebook APIs exposed by
\`cocalc project jupyter\` or the browser-session notebook API. The live
in-memory notebook state is the source of truth, not merely the \`.ipynb\` JSON
on disk.

## Why this matters in CoCalc

CoCalc keeps the familiar Jupyter document model while adding durable execution,
realtime collaboration, efficient rendering of large notebooks, TimeTravel,
nbgrader, whiteboard integration, and Codex-aware live notebook control.
`;

export const USE_JUPYTER_BODY = String.raw`
## What Jupyter in CoCalc is for

CoCalc runs standard Jupyter notebooks inside a durable project workspace. The
notebook file is collaborative, the kernel runs in the project backend, and
output is captured even if the browser tab disconnects.

Use notebooks for exploratory computation, teaching, data analysis, reports,
plots, and workflows where code, output, and explanation belong together.

## Start working

1. Open a project.
2. Create or open an \`.ipynb\` file.
3. Choose a kernel.
4. Run cells, edit markdown, and save work as usual.

For the creation flow, see [Create a Jupyter notebook](/docs/jupyter/create-notebook).

## What CoCalc adds

CoCalc notebooks are designed for shared and long-running work:

1. Multiple people can edit the same notebook in realtime.
2. Long-running cells keep running when the browser disconnects.
3. Output is captured server-side and shown when you reconnect.
4. TimeTravel records detailed notebook history.
5. Large notebooks and large outputs are handled with CoCalc-specific rendering.
6. Side chat, agents, terminals, and project files live next to the notebook.

## Kernels and environments

Use the kernel selector to switch between available project kernels. If you need
a project-specific Python environment, create a custom kernel backed by a
virtual environment; see [Custom Jupyter kernels with uv](/docs/jupyter/custom-kernels).

For a shared software stack across many projects, use a runtime image instead of
hand-configuring each notebook.

## Agents and notebooks

Agents should treat the live notebook state as the source of truth. Use
\`cocalc project jupyter\` or the browser-session notebook APIs for durable
notebook inspection and execution instead of editing \`.ipynb\` JSON directly.

## Troubleshooting

If a kernel stops, restarts, or the project runs out of memory, check the
resource indicators and restart only the affected kernel when possible. For
memory-specific failures, see [Troubleshoot project memory](/docs/troubleshooting/memory).
`;

export const JUPYTER_KERNEL_TERMINATED_BODY = String.raw`
## What this warning means

A Jupyter kernel is the process that runs the code cells in a notebook. A
"kernel terminated" warning means that process exited unexpectedly, was killed,
or failed to start. The notebook file usually remains intact, but variables,
imports, open files, and in-memory results from that kernel are gone.

The most common causes are:

1. The project ran out of memory.
2. The kernel crashed due to native code, compiled packages, or a bad extension.
3. The selected custom kernel points at a missing or broken Python environment.
4. The project restarted while the notebook was running.
5. Startup code or package imports failed before the kernel became ready.

## First recovery steps

1. Save the notebook.
2. Restart the kernel from the notebook **Kernel** menu.
3. Run a small cell such as \`1 + 1\` before rerunning expensive cells.
4. If the kernel immediately dies again, try a different kernel or open a
   terminal to inspect the environment.
5. Check project memory if the failure happened while loading data, training a
   model, plotting a large result, or importing a heavy package.

If the notebook had long-running work, inspect saved files and outputs before
rerunning everything. The kernel restart clears memory, but files written to the
project filesystem remain available.

## Diagnose memory pressure

Out-of-memory kills are the most common reason for sudden kernel termination.
The limit is shared by notebooks, terminals, language servers, web apps, and
agents in the project.

See [Low memory and out-of-memory crashes](/docs/troubleshooting/memory) for
ways to reduce memory use, stop other processes, checkpoint work, or move the
project to a host with more RAM.

## Diagnose custom kernels

If only one custom kernel fails, the kernelspec or virtual environment is
probably broken. Open a terminal and check:

~~~sh
jupyter kernelspec list
python -m ipykernel --version
~~~

For uv-managed environments, make sure the kernelspec points at the Python
inside the virtual environment and that \`ipykernel\` is installed there. See
[Custom Jupyter kernels with uv](/docs/jupyter/custom-kernels).

## Prevent repeat failures

Write long computations so they can restart from durable files. Save
intermediate data, avoid keeping duplicate large objects in memory, and test
custom kernels with a small notebook before using them for a class or research
workflow.
`;

export const CUSTOM_JUPYTER_KERNELS_BODY = String.raw`
## What custom kernels are for

A custom Jupyter kernel lets a notebook run with a specific Python environment
instead of the default project Python. Use one when a project needs a controlled
set of Python packages, a different Python version, or separate environments for
different notebooks.

For shared courses or many projects, prefer a runtime image when everyone should
start with the same system-wide environment. Use a custom kernel when one
project or one notebook needs an isolated Python environment.

## Create a Python kernel with uv

Open a terminal in the project and install \`uv\` if it is not already
available:

~~~sh
curl -LsSf https://astral.sh/uv/install.sh | sh
~~~

Then create a virtual environment, install \`ipykernel\`, and register the
environment as a Jupyter kernel:

~~~sh
mkdir -p ~/.venvs
uv venv ~/.venvs/my-analysis --python 3.12
uv pip install --python ~/.venvs/my-analysis/bin/python \
  ipykernel pandas numpy matplotlib
~/.venvs/my-analysis/bin/python -m ipykernel install --user \
  --name my-analysis \
  --display-name "Python (my-analysis)"
~~~

Use a short lowercase \`--name\` with letters, numbers, dashes, or underscores.
The display name is what people see in the notebook kernel selector. Replace
\`3.12\` with \`python3\` or another installed Python version when needed.

## Use the kernel in CoCalc

1. Open or create a notebook.
2. Open the kernel selector or **Kernel** menu.
3. Choose **Python (my-analysis)**.
4. Run a cell that imports a package installed in the environment.

If the kernel does not appear immediately, refresh the browser tab, reopen the
notebook, or restart the project so Jupyter reloads the kernelspec list.

## Install more packages later

Install packages into the same virtual environment by pointing \`uv pip\` at the
environment's Python:

~~~sh
uv pip install --python ~/.venvs/my-analysis/bin/python scikit-learn seaborn
~~~

Then restart the notebook kernel before importing newly installed packages.

## Remove a custom kernel

Remove the Jupyter kernelspec and, if you no longer need it, remove the virtual
environment:

~~~sh
jupyter kernelspec uninstall my-analysis
rm -rf ~/.venvs/my-analysis
~~~

## Why this matters in CoCalc

CoCalc projects are real Linux environments, so Jupyter kernels are ordinary
kernelspecs backed by ordinary Python executables. That means humans and agents
can inspect, rebuild, and document the environment with normal terminal tools
instead of relying on hidden browser state.
`;

export const ROOTFS_BODY = String.raw`
## What the runtime image controls

The project runtime image, also called the RootFS image, defines the Linux
software stack available in a project. It is how you make a reproducible
environment for a class, research workflow, workshop, or agent sandbox.

## Change the runtime image

1. Open the project.
2. Open **Settings**.
3. Go to **Environment**.
4. Open the runtime image or RootFS controls.
5. Pick a catalog image or enter a custom image.
6. Restart the project when prompted.

Changing the image affects system software. Project files remain in the project,
but processes should be restarted so the new environment is active.

## Reuse environments

After installing packages or configuring a project, publish or clone the runtime
image workflow when appropriate. This is useful for courses, workshops, and
teams that need every participant to start with the same tools.

## Why this matters in CoCalc

CoCalc combines normal Linux administration inside a project with managed,
shareable runtime images. You can use \`sudo\`, install packages, build custom
software stacks, and then make those stacks available to other projects without
turning setup instructions into a fragile checklist.
`;
