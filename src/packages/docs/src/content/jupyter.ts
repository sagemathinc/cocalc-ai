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

## Improve a Markdown cell with Agent

An editable Markdown cell has its own **Agent** dropdown when project policy
allows AI tools.
Use it for the explanatory text and mathematics that accompany a computation.

Choose one action: **Ask** for a question, **Document** for an explanation,
**Proofread** to improve the writing, **Add Formulas** for mathematical content,
or **Translate** for another language.

1. Enter a question for **Ask**, or optionally describe what **Document**
   should emphasize. For **Translate**, check the target-language field.
2. Check **Recent agent sessions** when shown, then choose **Send**. If
   **Automatically submit to Agent** is unchecked, send the prepared draft
   from the agent chat. Follow the request there and review the result.

The agent is directed to the selected cell in the live notebook. After it
responds, inspect the rendered Markdown and any changed mathematics. For a
specific requirement, use **Ask** or the optional **Document** instructions;
for example, request an explanation suitable for readers encountering the
method for the first time.

## Choose a notebook view

A notebook frame can use the classic cell-oriented layout or the content-first
Studio view, which puts outputs and prose in the main column and adds a mini
table of contents, a minimap, and a reading mode that hides code. Switch between
them at any time on the same live notebook; see
[The Studio notebook view](/docs/jupyter/studio-view).

## Kernels and environments

Use the kernel selector to switch between available project kernels. If you need
a project-specific Python environment, create a custom kernel backed by a
virtual environment; see [Custom Jupyter kernels with uv](/docs/jupyter/custom-kernels).

For a shared software stack across many projects, use a runtime image instead of
hand-configuring each notebook.

## Use Agent on a code cell

When AI tools are allowed in the project and the notebook is editable, open
the **Agent** dropdown on a code cell. In Studio, hover over the code column to reveal the cell controls.

Choose one action: **Ask** for a question, **Explain** for a walkthrough,
**Fix Bugs**, **Modify**, or **Improve** for changes, **Document** for code
documentation, or **Translate** for another programming language.

1. Enter a question for **Ask** or instructions for **Modify**. For **Fix Bugs**,
   **Improve**, and **Document**, an optional note can focus the request.
2. For **Translate**, check the target programming language. Choosing this
   action does not itself switch the notebook kernel.
3. Check **Recent agent sessions** when shown, then choose **Send**. If
   **Automatically submit to Agent** is unchecked, send the prepared draft
   from the agent chat. Follow the request there and review the result.

The request identifies the notebook, cell ID, and kernel. It instructs the
agent to read that cell and its outputs from the live notebook. The agent can
inspect surrounding cells when needed. State constraints such as preserving
the function signature or avoiding package changes in your request.

## Agents and notebooks

Agents should treat the live notebook state as the source of truth. Use
\`cocalc project jupyter\` or the browser-session notebook APIs for durable
notebook inspection and execution instead of editing \`.ipynb\` JSON directly.

## Troubleshooting

If a kernel stops, restarts, or the project runs out of memory, check the
resource indicators and restart only the affected kernel when possible. For
memory-specific failures, see [Troubleshoot project memory](/docs/troubleshooting/memory).

## Send a notebook error to Agent

When **Fix with Agent** appears with a notebook error, use it to start a repair
request from that failure.

1. Click **Fix with Agent** beside the error output.
2. In the dialog, check **Recent agent sessions** when shown and select the
   conversation that should receive the request.
3. Click **Fix with Agent** in the dialog to submit it.
4. Follow the investigation in the agent chat. Review any reported verification and
   rerun the affected cell if needed.

The request includes the notebook path, the cell ID when available, the
traceback, the cell input, and the kernel language when available. Long traceback and input text can be shortened.
The agent is instructed to inspect the live notebook, investigate the cause,
and apply a fix when possible; it can read current cell content and outputs
instead of relying solely on the attached error text.

This shortcut submits a repair request. Include additional constraints or
corrections in the agent conversation if the failure needs more context.
`;

export const JUPYTER_STUDIO_BODY = String.raw`
## What the Studio view is for

Every Jupyter notebook in CoCalc can be shown in two ways. The classic view is
the familiar cell-oriented notebook. The **Studio** view is a content-first
layout for the same live notebook: results and prose get the main column, source
code moves into a narrow column beside them, and navigation aids make long
notebooks easier to move through.

Studio is a full editor, not a preview. Everything you can do in the classic
view works here, including editing, running cells, collaborating, and chatting.

Use Studio when you are reading through results, presenting a notebook, working
on a long document-style notebook, or when the code matters less than what it
produced.

## Switch between the views

Switch a notebook frame with the **Studio** and **Classic** buttons in the
notebook header, or from **View → Switch to Studio Notebook View**.

Both views act on the same notebook, so you can switch at any time without
losing state. Because this is a frame in the frame editor, you can also split
the view and keep a classic frame and a Studio frame open side by side on the
same notebook, or combine either with a terminal or another editor.

## Side-by-side layout

Output is on the left, code on the right. This keeps the focus on results while
the code stays accessible. Hover over the code column to reveal run and action
buttons for that cell.

## Reading mode

Turn on **Reading mode** to hide code cells entirely and show only outputs and
markdown. This is useful for presenting a notebook or reading through results.

Reading mode does not make the notebook read-only. Double-click an output, or
use the pencil button, to edit the cell behind it.

## Layout widths

Use the width control in the notebook header to switch between:

1. **Wide** — full frame width.
2. **Comfortable** — centered, with room for the mini table of contents.
3. **Narrow** — compact and centered.

Narrower widths trade horizontal space for line length that is easier to read.
Which widths are offered depends on how much room the frame has.

## Sections

A markdown cell that begins with a heading — \`#\` through \`####\` — starts a
**section**. The section holds that heading cell and every cell after it up to
the next heading. Cells before the first heading form an opening section of
their own.

That is the whole mechanism. There is no section metadata, no special cell type,
and nothing to configure: write headings as you go and the notebook gains
structure. Sections are what make the rest of this page work, so a notebook with
headings is markedly easier to navigate, run, and fold than one long
undifferentiated run of cells.

Once a notebook has headings you can:

1. Jump to any section from the mini table of contents.
2. Run a whole section at once.
3. Run the cells above or below a cell without leaving its section.
4. Fold a section down to its heading.
5. See at a glance whether anything inside a folded section is running or
   failed.

## Navigate long notebooks

At comfortable and narrow widths, a floating mini table of contents appears in
the left margin, built from those headings. Click an entry to jump to that
section. Double-click it to run every code cell in the section.

A minimap on the right shows the shape of the whole notebook and the run state
of each cell, so you can see which parts have run, failed, or are still running
without scrolling.

## Fold sections

Fold a section down to its heading with the control on the heading itself, or by
clicking the section line in the left gutter. Folding is a display choice and
does not change the notebook: the cells are still there and still run.

A folded section keeps reporting itself. Its heading and its minimap entry show
when a cell inside is running or has raised an error, so long computations stay
visible while folded away.

## Run controls

The run button on each cell has a dropdown. In a notebook with sections it
offers both scopes:

1. **Run above in section** and **Run cell and below in section** stop at the
   section boundary.
2. **Run all above** and **Run all below** cover the whole notebook.

Section-scoped runs are the reason headings pay off while you work, not only
when you read: they let you re-run the part of the notebook you are editing
without waiting for everything before or after it.

All standard Jupyter keyboard shortcuts work unchanged: Shift+Enter to run,
Escape and Enter to switch between command and edit mode, arrow keys to
navigate.

## Agents in the Studio view

The **Agent** button in the title bar opens an AI agent that works on the open
notebook: ask questions about it, generate or fix cells, and debug errors.
Hovering over a code cell also offers a per-cell agent action scoped to just
that cell.

For more on agents and notebooks, see [Use Jupyter notebooks](/docs/jupyter/use-jupyter).

## Why this matters in CoCalc

A notebook is used for two different things: writing computations and reading
the results of them. The classic view is built for the first, and the Studio
view is built for the second, without forking the document or exporting it. The
notebook stays live, collaborative, and editable in both.
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

export const OCTAVE_JUPYTER_KERNEL_BODY = String.raw`
## What this page is for

Use this guide when an existing CoCalc AI project needs GNU Octave in Jupyter.
It adds Octave as another selectable notebook kernel in that one project.
Python remains the normal default Jupyter kernel.

This is project-local setup. It does not mean Octave is preinstalled in the
CoCalc Legacy image, and it is not a RootFS publishing workflow. For many
projects or a class, an admin-built RootFS image is the longer-term solution,
but that image should be built through the proper RootFS build path and
cold-restore validated before publication.

This workflow was tested on 2026-07-04 in fresh CoCalc AI projects using the
public CoCalc Legacy 2026.06 image. The fresh baseline had no \`octave\` binary
and no Octave kernelspec. In that test, apt installed GNU Octave 11.1.0 and
PyPI provided \`octave-kernel\` 1.1.0; exact package versions may change over
time.

## Install Octave and the Jupyter kernel

Open a project terminal and run:

~~~sh
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends octave gnuplot-nox

python3 -m venv ~/.venvs/octave-kernel
~/.venvs/octave-kernel/bin/python -m pip install --upgrade pip
~/.venvs/octave-kernel/bin/python -m pip install --upgrade octave-kernel
~/.venvs/octave-kernel/bin/python -m octave_kernel install --user --replace
~~~

The \`octave\` and \`gnuplot-nox\` packages are system packages, so they use
\`sudo apt-get\`. The \`--no-install-recommends\` option keeps the project
install smaller.

The \`octave-kernel\` Python package belongs in a project-local virtual
environment. Avoid installing it into the shared Sage/Python environment with
\`sudo python3 -m pip install ...\`; that direct command can modify shared
dependencies used by other tools. The venv-backed kernelspec keeps the kernel
wrapper isolated while still letting Jupyter launch Octave.

The \`--user --replace\` flags register the kernelspec for the project user and
make the install command safe to rerun after updating the virtual environment.

## Verify the installation

Run these checks from a project terminal:

~~~sh
octave --version
~/.venvs/octave-kernel/bin/python -m pip show octave-kernel
jupyter kernelspec list
cat ~/.local/share/jupyter/kernels/octave/kernel.json
~~~

Expected results:

1. \`jupyter kernelspec list\` includes \`octave\`.
2. \`kernel.json\` has an \`argv\` beginning with
   \`/home/user/.venvs/octave-kernel/bin/python\`.
3. The existing \`python3\` kernel is still present.
4. Octave is selectable in notebooks, but it is not the default kernel.

## Use Octave in a notebook

Open or create a notebook, use the kernel selector to choose **Octave**, and
run:

~~~octave
disp("octave-kernel-ok")
disp(2 + 2)

graphics_toolkit("gnuplot")
x = 0:0.1:2*pi;
plot(x, sin(x));
~~~

Expected notebook result:

1. The text output includes \`octave-kernel-ok\`.
2. The numeric output includes \`4\`.
3. A plot renders.
4. A warning that the \`gnuplot\` graphics toolkit is discouraged is acceptable
   in this headless notebook setup.

## Troubleshooting

If the Octave kernel does not appear immediately, refresh the browser tab,
reopen the notebook, or restart the project so Jupyter reloads kernelspecs.

If plotting works but prints a \`gnuplot\` warning, that warning is acceptable
for this headless notebook setup.

If the kernel fails, verify that \`octave\` is on \`PATH\` and that the
kernelspec points at \`~/.venvs/octave-kernel/bin/python\`:

~~~sh
which octave
cat ~/.local/share/jupyter/kernels/octave/kernel.json
~~~

If you previously installed \`octave-kernel\` into the shared Python
environment, you do not need to repeat that approach. Prefer the venv-backed
kernelspec above for new projects and repairs.

## Clean up

Remove the kernelspec and virtual environment when the project no longer needs
Octave notebooks:

~~~sh
jupyter kernelspec uninstall octave
rm -rf ~/.venvs/octave-kernel
~~~
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
