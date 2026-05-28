/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DocsAudience =
  | "agents"
  | "instructors"
  | "researchers"
  | "students"
  | "teams";

export type DocsEntryStatus = "draft" | "ready";
export type DocsVisibility = "public" | "signed-in" | "admin";
export type DocsAccess = {
  includeAdmin?: boolean;
  includeSignedIn?: boolean;
};
export type DocsActionParameterType = "project" | "project-host";

export interface DocsActionParameter {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type: DocsActionParameterType;
}

export type DocsActionId =
  | "admin.news.open"
  | "admin.news.create-system"
  | "admin.bay-ops.open"
  | "admin.membership-tiers.open"
  | "admin.managed-egress.open"
  | "admin.project-backup-shards.open"
  | "admin.registration-tokens.open"
  | "admin.rootfs.open"
  | "admin.site-settings.open"
  | "admin.software-licenses.open"
  | "admin.sso.open"
  | "admin.users.open"
  | "hosts.open"
  | "hosts.access.open"
  | "hosts.change-rules.open"
  | "hosts.lifecycle.open"
  | "hosts.move.open"
  | "hosts.reliability.open"
  | "hosts.runtime.open"
  | "hosts.scratch.open"
  | "hosts.storage.open"
  | "hosts.logs.open"
  | "hosts.spot-recovery.open"
  | "settings.environment.secrets"
  | "project.terminal.open"
  | "project.jupyter.create"
  | "settings.runtime.rootfs"
  | "settings.people.collaborators"
  | "file.timetravel.open"
  | "course.assignment.create"
  | "project.codex.open";

export interface DocsAction {
  description: string;
  executable?: boolean;
  id: DocsActionId;
  label: string;
  parameters?: DocsActionParameter[];
}

export interface DocsActionSummary extends DocsAction {
  entryId: string;
  entrySlug: string;
  entryTitle: string;
}

function projectActionParameters(): DocsActionParameter[] {
  return [
    {
      label: "Project",
      name: "projectId",
      placeholder: "Select a project",
      required: true,
      type: "project",
    },
  ];
}

function projectHostActionParameters(): DocsActionParameter[] {
  return [
    {
      label: "Project host",
      name: "hostId",
      placeholder: "Select a host",
      required: true,
      type: "project-host",
    },
  ];
}

export interface DocsEntryImage {
  alt: string;
  presentation?: "hero" | "icon";
  src: string;
  thumbnailSrc?: string;
}

export interface DocsEntry {
  actions?: DocsAction[];
  audiences: DocsAudience[];
  body: string;
  category: string;
  id: string;
  image?: DocsEntryImage;
  lastReviewed: string;
  slug: string;
  status: DocsEntryStatus;
  summary: string;
  title: string;
  visibility?: DocsVisibility;
}

export interface DocsSearchResult extends DocsEntry {
  score: number;
}

function docsIcon(src: string, alt: string): DocsEntryImage {
  return {
    alt,
    presentation: "icon",
    src,
    thumbnailSrc: src,
  };
}

const PROJECT_SECRETS_BODY = String.raw`
## What project secrets are for

Project secrets are named values that are available to code running in a
project without committing private tokens into notebooks, scripts, terminals,
or TimeTravel history.

Use them for API keys, access tokens, deployment credentials, and other values
that code needs at runtime but should not be stored in project files.

Secrets are encrypted at rest in the database and mounted into running projects
as read-only files under \`/run/secrets/cocalc/<name>\`. They are not stored in
project files, snapshots, backups, rootfs images, downloads, or public shares.

## Add a secret from the UI

1. Open the project.
2. Open **Settings**.
3. Go to **Environment**.
4. Choose **Secrets**.
5. Add a name and value, then save it.

The exact UI action is identified as \`settings.environment.secrets\`. The docs
system will use these action ids so Codex and other agents can open the right
panel in the current browser session instead of merely describing where to
click.

## Use the secret

Secrets are files, not environment variables. In a terminal, notebook, or
script, read the value from the mounted secret file. Use the
\`COCALC_SECRETS\` environment variable instead of hardcoding the directory.

~~~python
import os
from pathlib import Path

secrets_dir = Path(os.environ["COCALC_SECRETS"])
token = (secrets_dir / "MY_API_TOKEN").read_text().strip()
~~~

Use clear uppercase names such as \`OPENAI_API_KEY\`, \`HF_TOKEN\`, or
\`DATABASE_URL\`. Any code or collaborator with access to the running project
can read these files, so avoid putting secret values in source files, notebook
outputs, chat messages, logs, or command history.

SSH private keys usually need a final newline. If you paste one manually, use
the warning in the Secrets dialog to add the newline before saving.

## Why this matters in CoCalc

CoCalc projects are collaborative, durable, and agent-friendly. That is exactly
why secrets should have a first-class home: humans and agents can run code,
restart terminals, execute notebooks, and automate tasks without turning private
credentials into shared document content.
`;

const OPEN_TERMINAL_BODY = String.raw`
## What CoCalc terminals are for

CoCalc terminals are real terminals running in your project Linux environment.
They use xterm.js in the browser, but the process state lives on the backend:
you can start a command, close the browser tab, and come back to the same
running terminal.

## Open a terminal

1. Open the project.
2. Open the file browser or the activity bar.
3. Choose **Terminal** or create a file ending in \`.term\`.
4. Run normal shell commands.

Terminal files are intentionally path-based. Opening \`work/analysis.term\`
starts in \`work/\`, and the terminal session has a stable file anchor that
humans and agents can refer to.

## Agent and CLI access

Codex can inspect and drive live terminal sessions through the browser-session
API. For persistent terminal work from an agent, prefer the typed terminal APIs
over screenshot automation when possible.

## Why this matters in CoCalc

A CoCalc terminal is collaborative, durable, and attached to project files. It is
not just a temporary browser shell: it is part of a shared computational
workspace with side chat, project storage, TimeTravel-friendly files, and direct
SSH access when you want native tools.
`;

const USE_TERMINAL_BODY = String.raw`
## What CoCalc terminals are for

CoCalc terminals are persistent Linux shell sessions inside a project. The
terminal UI runs in the browser, but the shell process runs in the project
backend, so commands can keep running while the browser disconnects.

Use terminals to install packages, run scripts, inspect files, start services,
use Git, manage virtual environments, and work with command-line tools that are
part of the project environment.

## Open and organize terminals

Open a terminal from the project activity bar, the file browser, or by opening a
file ending in \`.term\`. For the short action flow, see
[Open a terminal](/docs/projects/open-terminal).

Terminal files are path-based. A terminal at \`analysis/run.term\` starts in the
\`analysis/\` directory and gives the session a stable project-file anchor.
Create separate terminal files for separate tasks when that makes the workspace
easier to understand.

## Open project files from the terminal

Use the \`open\` command to open files and directories in CoCalc from the shell,
similar to \`xdg-open\` on Linux or \`open\` on macOS:

~~~sh
open path/to/file.ipynb path/to/script.py path/to/folder
~~~

This is often faster than switching to the file browser when you are already
working in a terminal. Paths are interpreted relative to the terminal's current
directory.

## Persistent work

Browser tabs are not the process boundary. Long commands can continue after the
browser disconnects, and collaborators can reconnect to the same terminal later.
For very long or fragile jobs, use standard shell tools such as \`tmux\`, log
files, or scripts so progress is visible and restartable.

## Collaboration and safety

Terminals are collaborative. People with access to the running project can see
terminal content and may be able to interact with the shell. Avoid pasting
secrets into commands, prompts, logs, or shell history. Use
[project secrets](/docs/projects/project-secrets) for credentials consumed by
project code.

## Agents and automation

Agents should prefer typed CoCalc terminal or browser-session APIs when they
need to inspect or drive a live terminal. Use the terminal for real shell work,
but avoid relying on screenshot-only automation when a CLI or project API can
perform the same operation directly.

## Troubleshooting

If a terminal seems unresponsive, check whether the project is running and
whether a command is still active. Use Ctrl-C for a foreground command, open a
new terminal for independent diagnosis, and inspect project memory if commands
are being killed.
`;

const CREATE_JUPYTER_BODY = String.raw`
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

const USE_JUPYTER_BODY = String.raw`
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

const JUPYTER_KERNEL_TERMINATED_BODY = String.raw`
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

const CUSTOM_JUPYTER_KERNELS_BODY = String.raw`
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

const ROOTFS_BODY = String.raw`
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

const MEMORY_TROUBLESHOOTING_BODY = String.raw`
## What low memory means

Low memory means the project is close to its RAM limit. Out-of-memory means the
Linux kernel killed a process because the project used more memory than the host
allowed. In notebooks, this often looks like a kernel restart, missing output,
or a cell that stops without finishing.

The limit is shared by everything running in the project: notebooks, terminals,
language servers, background jobs, web apps, databases, and agents.

## First things to try

1. Open the project process or activity view and stop work you do not need.
2. Restart the notebook kernel or terminal process that is using too much RAM.
3. Close idle notebooks, terminals, and servers.
4. Load less data at once, stream data in chunks, or write intermediate results
   to files.
5. Avoid keeping duplicate large arrays, dataframes, models, or images in
   memory.

For Python notebooks, clear variables you no longer need, restart the kernel
after large experiments, and prefer chunked data tools when datasets approach
the available RAM.

## When the workload really needs more memory

If the computation genuinely needs more RAM, move the project to a host or plan
with more memory. For repeated workloads, choose a project host with enough RAM
and disk for the largest expected dataset and runtime image.

If the project is on a shared host, remember that other work on the same host
can compete for memory. A dedicated host or larger host is more predictable for
large research jobs, courses, or agent sandboxes.

## Prevent repeat failures

Keep setup and data-processing steps reproducible so a killed process is not a
lost result. Save intermediate files, checkpoint long calculations, and use
scripts or notebooks that can restart from a durable point.

For agents, ask them to inspect memory usage before starting a large job and to
prefer incremental processing when the input data is large.

## Why this matters in CoCalc

CoCalc keeps notebooks and terminals durable, but it cannot make a process use
less RAM than the host provides. Treat memory as part of the project
environment: monitor it, size the host appropriately, and design workflows that
can recover after a process is killed.
`;

const CONNECTIVITY_TROUBLESHOOTING_BODY = String.raw`
## What connectivity trouble looks like

CoCalc keeps a live connection between your browser and the service so files,
terminals, notebooks, chat, and project state stay synchronized. Connectivity
trouble usually appears as a sign-in prompt that never completes, reconnect
messages, stale project state, failed websocket connections, or editors that do
not update.

## First things to try

1. Refresh the browser tab.
2. Sign out and sign back in if the page says you are not authenticated.
3. Open CoCalc in a private browser window to rule out stale site data or a
   browser extension.
4. Disable privacy, ad-blocking, or script-blocking extensions for the CoCalc
   site.
5. Try another network if you are behind a strict firewall, campus proxy, VPN,
   or corporate security filter.

If the same browser has been used across several local development servers or
site hostnames, clearing site data for that hostname can fix stale localStorage
or cookie state.

## Network requirements

CoCalc needs normal HTTPS traffic and websocket connections to the site you are
using. Some proxies allow web pages but block websocket upgrades; that can make
the page load while realtime project features fail.

For a local development instance, make sure the browser is using the same
localhost port, session, and site hostname as the running server. If you switch
between Lite, hub, and project-host development environments, refresh the
matching development environment before using browser automation or CLI tools.

## What to include in a support report

When reporting a connectivity problem, include:

1. The exact site URL.
2. The browser and operating system.
3. Whether the problem happens in a private browser window.
4. Whether another network works.
5. Any visible reconnect message or browser console websocket error.
6. The approximate time the issue happened.

Do not include passwords, API keys, project secrets, or private tokens in a
support report.

## Why this matters in CoCalc

CoCalc projects are live collaborative workspaces. A partial connection can be
more confusing than a fully offline page because some UI may render while the
realtime project connection is blocked. The fastest diagnosis is to separate
browser state, authentication state, and network websocket access.
`;

const COLLABORATORS_BODY = String.raw`
## What collaborators are for

Collaborators are people who can work in the same CoCalc project. They can edit
files together, share terminals and notebooks, use chat, and see the same
project state.

## Add a collaborator

1. Open the project.
2. Open **Settings**.
3. Go to **People**.
4. Invite a user by email or account.
5. Review pending invitations and access rules.

For courses, add students through the course interface instead of manually
sharing every project.

## Work together

Collaboration is realtime across documents, notebooks, terminals, chat, course
management files, and many project workflows. Use side chat when the discussion
is tied to a specific file or activity.

## Why this matters in CoCalc

CoCalc treats collaboration as part of the computational workspace rather than a
separate sharing layer. Students, instructors, researchers, and agents can work
inside the same project while the backend keeps execution and file state
durable.
`;

const CHAT_BODY = String.raw`
## What chat is for

CoCalc chat keeps project discussion next to the files, notebooks, terminals,
courses, and agent work it is about. Use chat for questions, review notes,
handoffs, lightweight records of decisions, and conversations with humans or
AI assistants.

## Create and use chat

Create a chat file from the project **New** page or open an existing \`.chat\`
file. Chat files are project files, so they can live beside the notebooks,
assignments, scripts, or folders they discuss.

Use chat when discussion should remain part of the project context. Use a
Markdown file when the result should become durable documentation, instructions,
or a polished explanation.

## Mentions

Use @mentions to notify collaborators and create a link back to the relevant
conversation or document context. See [Mentions](/docs/collaboration/mentions)
for the notification workflow.

## Safety

Do not paste passwords, API keys, private tokens, or project secrets into chat.
Use [project secrets](/docs/projects/project-secrets) for credentials that code
needs at runtime.
`;

const MENTIONS_BODY = String.raw`
## What mentions are for

Mentions notify a collaborator and make the relevant context easy to find
later. Use them when a specific person should look at a chat message, notebook
cell, Markdown note, whiteboard, teaching discussion, or other collaborative
project content.

## Mention a collaborator

Type \`@\` and choose a collaborator when the editor or chat surface supports
mentions. CoCalc sends a notification and lists the mention on the notifications
page so the collaborator can return to the context.

You can mention yourself for testing or to bookmark something you want to find
later.

## Teaching and project workflows

Mentions are useful in courses because instructors and students often need to
refer to a precise file, assignment, or discussion. Keep substantive feedback
in the relevant project context instead of scattering it across external
messages.

## Keep private data out of mentions

Mention text can be visible to collaborators who can access the project or
conversation. Do not include passwords, private tokens, API keys, or other
secrets in mention text.
`;

const TIMETRAVEL_BODY = String.raw`
## What TimeTravel is for

TimeTravel lets you inspect how a file changed over time. It is useful for
recovering work, understanding how a result was produced, reviewing student
engagement, and comparing edits without manually creating commits.

## Open TimeTravel

1. Open a file in the project.
2. Open the **View** menu.
3. Choose **TimeTravel**.
4. Browse versions, diffs, and recovery options.

TimeTravel is especially useful for notebooks, LaTeX files, Markdown, code, and
course assignments.

## How to think about it

TimeTravel can show multiple history sources for the same file. In addition to
CoCalc's high-resolution edit history, it can browse Git revisions when the file
is in a Git repository, and it can also expose snapshots and backups when those
are available. Use the Git viewer when you want to inspect full commits across a
repository; use TimeTravel when you want a fast, file-focused slider through the
versions of the file you are editing.

## Why this matters in CoCalc

CoCalc projects are collaborative and durable. TimeTravel makes that durability
visible: you can understand how work evolved, recover from mistakes, and support
teaching workflows where the process matters as much as the final file.
`;

const COURSE_ASSIGNMENT_BODY = String.raw`
## What CoCalc assignments are for

CoCalc courses distribute computational work into student projects. Students do
not need a separate submission step: instructors assign files, students work in
their projects, and instructors collect the results.

## Create an assignment

1. Open a course file.
2. Add or select students.
3. Create an assignment from files in the instructor project.
4. Assign it to student projects.
5. Collect, grade, return, or peer grade as needed.

For notebooks, use nbgrader when you need automated grading cells and structured
feedback.

## What makes this different from an LMS

Canvas and Moodle organize course communication, calendars, and grades. CoCalc
organizes live computational work: notebooks, terminals, LaTeX, code, datasets,
software environments, realtime help, and TimeTravel.

## Why this matters in CoCalc

Instructors can see what students are doing, help in realtime, recover mistakes,
configure a shared runtime image, and run a course where the computational
environment is part of the assignment instead of a prerequisite.
`;

const COURSE_WORKFLOW_BODY = String.raw`
## What courses are for

CoCalc courses manage computational classes where files, notebooks, terminals,
software environments, realtime help, and grading all live in student projects.
The course file is the instructor control center; student work happens in
ordinary CoCalc projects.

Use courses when students need to run code, write notebooks, edit LaTeX, submit
files, receive feedback, or get help in the same environment where the work
runs.

## Core workflow

1. Create a course file in an instructor project.
2. Add students or invite them by email.
3. Prepare assignment files in the instructor project.
4. Assign files into student projects.
5. Monitor progress, answer questions, and open student work when needed.
6. Collect, grade, return, or peer grade the assignment.

For the assignment-specific flow, see
[Create a course assignment](/docs/teaching/create-assignment).

## Student projects

Each student gets a project for course work. That project can contain notebooks,
scripts, terminals, data, output, and chat. Instructors can open student
projects to help, inspect files, use TimeTravel, or run grading workflows.

When the class needs a shared software stack, use a runtime image or project
host setup that every student project can run. This avoids per-student package
installation drift.

## Grading

Use ordinary collect/grade/return workflows for file-based assignments. Use
[nbgrader](/docs/teaching/nbgrader) when notebooks need autograded cells,
hidden tests, structured feedback, or a more formal grading pipeline.

## Operational advice

Test assignments in a student-style project before releasing them. Keep starter
files small, put large datasets in a durable shared location, and make setup
steps reproducible. For large classes, choose project hosts and runtime images
that match the expected memory, disk, and package needs.
`;

const NBGRADER_BODY = String.raw`
## What nbgrader is for

nbgrader is a Jupyter-based grading workflow for notebook assignments. It lets
instructors create notebooks with graded cells, tests, hidden tests, feedback,
and scores, then autograde submitted notebooks.

Use nbgrader when the assignment is naturally a notebook and needs structured
grading. Use normal CoCalc collect/grade/return when the work is file-based,
manual, or not organized around notebook cells.

## Use nbgrader in a course

1. Enable nbgrader in the course configuration.
2. Create an instructor version of the notebook with graded cells and tests.
3. Assign the notebook to students.
4. Let students complete the notebook in their projects.
5. Collect submissions.
6. Autograde, inspect results, adjust feedback, and return grades.

Run a small test assignment first. nbgrader depends on notebook metadata, so
editing cells carelessly or copying content through tools that drop metadata can
break grading.

## Resource planning

Autograding runs code. It can use significant CPU, RAM, disk, and time,
especially for large classes or heavy notebooks. Tune the parallel grading
limit based on the host where grading runs and the expected memory per
submission.

If grading frequently hits memory limits, reduce parallelism, simplify tests,
or move grading to a host with more RAM. For the memory side of these failures,
see [Low memory and out-of-memory crashes](/docs/troubleshooting/memory).

## Common problems

If cells are not graded, check that the instructor notebook has the expected
nbgrader metadata. If autograding hangs, inspect the exact student notebook and
run the failing cells manually in a fresh kernel. If every submission fails, the
course environment or runtime image probably differs from the environment used
to author the assignment.
`;

const CODEX_CHAT_BODY = String.raw`
## What Codex chat is for

Codex chat is the integrated agent interface in CoCalc-ai. A project chat thread
can include humans and Codex, and Codex can use project-aware tools to inspect
files, run commands, work with notebooks, and make changes.

## Open Codex

1. Open the project.
2. Open the Agents or chat area.
3. Start a Codex thread.
4. Ask a concrete task, including relevant files and constraints.

For terminal-native agents such as Claude Code or opencode, install and run them
inside a normal project terminal. CoCalc provides the durable Linux environment;
those tools provide their own agent interface.

## Give better tasks

Name files, describe the desired outcome, and ask Codex to validate changes.
For live notebooks, ask Codex to use the live notebook APIs. For UI actions,
docs action ids such as \`settings.environment.secrets\` let agents open the
right panel directly.

## Why this matters in CoCalc

CoCalc is both a collaborative workspace and an agent sandbox. Humans can review
what Codex changes, keep terminals and notebooks running, use TimeTravel, and
share the same project state with collaborators.
`;

const CREATE_PROJECT_BODY = String.raw`
## What projects are for

A CoCalc project is a persistent Linux workspace with files, terminals,
notebooks, chat, settings, collaborators, secrets, and an optional project host.
Use one project for a class assignment, research computation, agent sandbox,
paper, workshop, or team workspace.

## Create a project

1. Open **Projects**.
2. Choose **New Project**.
3. Give the project a clear name.
4. Pick an initial setup if one is offered.
5. Open the project and add files, collaborators, or runtime settings.

Project names are for humans. The project id is the durable identifier used by
APIs, agents, browser-session actions, project hosts, and logs.

## Choose the right boundary

Create separate projects when work needs different collaborators, secrets,
software environments, compute resources, or retention policies. Keep related
files in the same project when they share one runtime environment and should be
reviewed together.

## Why this matters in CoCalc

Most CoCalc features are project-scoped. Once a project exists, humans and
agents have a shared place to run commands, edit notebooks, manage secrets,
configure the runtime image, and keep long-running work attached to durable
backend state.
`;

const AI_CREDENTIALS_BODY = String.raw`
## What AI credentials are for

CoCalc-ai uses OpenAI access for integrated Codex chat. A user can connect a
ChatGPT subscription or configure an OpenAI API key, depending on what access
the deployment and account support.

## Connect access for Codex

1. Open Codex or the AI settings area.
2. Choose **Sign in with ChatGPT** or configure an OpenAI API key.
3. Complete the device authorization or key setup flow.
4. Return to the Codex thread and start a concrete task.

If device authorization is running, keep the authorization panel visible until
the browser confirms that the account is connected.

## Use project secrets for keys

For code that calls OpenAI directly from a notebook, script, or terminal, store
the API key as a project secret such as \`OPENAI_API_KEY\`. Do not paste keys
into notebooks, chat messages, shell history, or committed files.

## Why this matters in CoCalc

AI access is both account-level and project-contextual. The account connection
lets Codex work in the UI; project secrets let ordinary code and terminal-native
agents use credentials without turning private tokens into shared content.
`;

const COCALC_CLI_BODY = String.raw`
## What the CoCalc CLI is for

The CoCalc CLI is the preferred automation interface for many CoCalc-ai tasks.
It can work with the running site, project context, browser sessions, notebooks,
docs, hosts, and other typed workflows without exposing a broad API key.

Use the CLI when you want to automate CoCalc itself. Use project terminals and
ordinary command-line tools when you want to automate software inside a project.

## Why not start with API keys

CoCalc-ai intentionally reduced the power of general API keys. Broad API keys
were rarely used and increased the security and attack surface risk. Prefer
task-specific CLI commands and authenticated browser-session or project
commands when they exist.

API access still has a place for narrow integration points, but it should not be
the default answer for normal project, notebook, docs, or browser automation.

## Common CLI workflows

Search and show the versioned docs bundled with this CoCalc-ai version:

~~~sh
cocalc docs search "project secrets"
cocalc docs show projects/project-secrets
~~~

Open a documented UI destination in the current browser session:

~~~sh
cocalc browser action docs-list
cocalc browser action docs settings.environment.secrets
~~~

Work with live notebooks using the project Jupyter commands instead of editing
\`.ipynb\` JSON directly:

~~~sh
cocalc project jupyter -h
~~~

For local development against a running hub, load the matching environment
before control-plane or browser commands:

~~~sh
cd src
eval "$(pnpm -s dev:hub:env)"
~~~

## Why this matters in CoCalc

The CLI gives humans and agents a stable, inspectable way to drive CoCalc-ai
without scraping the UI or handing out overly powerful credentials. It is also a
bridge between docs, browser-session actions, notebooks, and project-host
administration.
`;

const HTTP_API_BODY = String.raw`
## What the HTTP API is for

The CoCalc HTTP API is for narrow integrations that need to call CoCalc from an
external service. It is not the primary automation surface for most CoCalc-ai
workflows.

Use the [CoCalc CLI](/docs/cli/use-cocalc-cli) first when you are automating
CoCalc from a terminal, agent, local script, or development environment. The CLI
has richer typed workflows for docs, browser sessions, notebooks, project hosts,
and authenticated local development.

## API keys in CoCalc-ai

CoCalc-ai intentionally reduced the capabilities of broad API keys. Very few
users relied on the old broad API-key surface, and keeping it large creates
security risk. New API keys should be scoped to the minimum capability needed
for the integration.

Treat API keys like credentials:

1. Create keys only for specific integrations.
2. Give each key a clear name and the smallest useful capability set.
3. Rotate or delete keys that are no longer needed.
4. Store keys outside source files, notebooks, chat messages, and terminal
   history.
5. For code running inside a project, store external service tokens as
   [project secrets](/docs/projects/project-secrets), not as files.

## Authentication shape

The HTTP API uses basic authentication. Put the API key in the username field
and leave the password blank.

~~~sh
curl -u "$COCALC_API_KEY:" https://cocalc.com/api/v2
~~~

For local development, use the local site origin instead of
\`https://cocalc.com\`.

## When to use something else

Use \`cocalc-cli\` for project, browser, docs, notebook, and host workflows when
a typed command exists. Use project secrets for credentials consumed by code
inside a project. Use Codex or browser-session docs actions when the job is to
open or verify a UI destination in the current session.

## Why this matters in CoCalc

CoCalc-ai is designed around authenticated, typed control paths instead of one
large ambient API key. That keeps the attack surface smaller while still giving
humans and agents practical ways to automate the product.
`;

const PROJECT_HOSTS_BODY = String.raw`
## What project hosts are for

A project host is compute capacity that can run CoCalc projects. On hosted
CoCalc, project hosts are CoCalc-managed or cloud-backed capacity; users cannot
attach an arbitrary local computer or VM as a host. Hosts have access to
project-level credentials such as backup passwords, so direct user-controlled
hosts are only appropriate in self-hosted Launchpad or Rocket deployments.

Use project hosts for heavier workloads such as long-running research
computations, courses, or agent sandboxes.

The host is not just a label. It controls where the project filesystem lives,
where project processes run, where host-local snapshots are stored, what runtime
software is installed, which backup region is used, and which users are allowed
to place projects there.

## Create or choose a host

1. Open the project host administration area.
2. Configure a cloud provider. In self-hosted Launchpad or Rocket, configure a
   cloud provider or self-hosted connector.
3. Refresh the provider catalog if needed.
4. Choose a machine type, region, disk size, and lifecycle policy.
5. Start the host and wait for bootstrap to finish.
6. Move or create projects on the host when it is ready.

Use enough disk space for runtime images and project data. Very small disks can
fail during image bootstrap or package installation.

## Access and placement

Private hosts are available to the owner and delegated users. A delegated
**User** can create or move projects onto the host. A delegated **Manager** can
also start and stop the host, manage access, configure the per-project RAM cap,
and place projects there.

Admins can publish a host into the **Public shared pool** by assigning a host
tier. Users whose membership grants that project-host tier, or a higher tier,
may place projects there without delegated host access.

## Project RAM cap

The host **Project resource policy** has an optional per-project RAM cap. This
cap lets projects use more RAM on a large host without changing normal project
policy for CPU and storage. Leave it blank when normal project limits should
apply. Set it deliberately when the host is dedicated to workloads that need
larger in-memory notebooks, language models, databases, or agents.

## Moving projects

Moving a project between hosts is a data operation, not a cosmetic setting.
CoCalc moves through backups and restore. Files in \`/tmp\` are discarded,
previous host-local snapshots are discarded after the move, and SSH access must
be reconfigured after the move. If the destination region differs, the backup
region can change after a successful new backup.

## Long-running work

For research jobs, scheduled automation, or agent sandboxes, use a host with
enough CPU, RAM, disk, and restart behavior for the workload. Keep important
state in project files, a database, or another durable location rather than only
inside a process.

## Agent notes

When helping with project hosts:

1. Determine whether the user is on hosted CoCalc, Launchpad, Rocket, or Lite.
   Lite does not use project hosts. Hosted CoCalc does not allow arbitrary
   local user machines as hosts.
2. Open the hosts page with the \`hosts.open\` docs action when browser context
   is available.
3. For CLI inspection, start with:

~~~sh
cocalc host list --json
cocalc host get <host>
cocalc host projects <host> --all
cocalc host metrics <host>
cocalc host bootstrap-status <host>
~~~

4. Before recommending a move, check source host status, backup freshness,
   destination access, destination RAM/disk, region changes, and whether \`/tmp\`
   or host-local snapshots matter.
5. Do not assume the current bay is authoritative. Route host operations by the
   host's owning bay and project operations by the project's owning bay.

## Why this matters in CoCalc

Project hosts make CoCalc more than a shared web editor. They let the workspace
own real compute, run persistent services, use cloud machines economically, and
give agents a stable Linux environment to work in.
`;

const PROJECT_HOST_ACCESS_BODY = String.raw`
## What host access controls

Host access controls who may place projects on a private dedicated host and who
may administer that host. It is separate from project collaborators: a user can
collaborate on a project without being able to create their own projects on the
host, and a host user can place their own projects without being a collaborator
on every existing project.

## Roles

- **Owner** pays for the host and has full control.
- **Manager** can start and stop the host, manage access, configure the
  per-project RAM cap, and place projects on the host.
- **User** can create or move their own projects onto the host.

Use **Access** on the host drawer to add users or managers by account. Use
**Remove** to revoke delegated access.

## Public shared pool

Admins can put a host in the public shared pool by enabling the shared-pool
policy and setting a tier. Any user with project-host tier greater than or
equal to that value may place projects there without a delegated access row.

Use this for shared fleet capacity. Use delegated access for a private host
that should only be usable by a known set of people.

## Per-project RAM cap

The host access page also includes **Project resource policy**. The optional
RAM cap applies to projects running on that host. It is useful when a large
dedicated host should permit larger notebooks, agents, or databases than the
normal project policy allows.

Do not set the cap higher than the host can realistically support for the
number of simultaneous projects. If several projects can run at once, leave
headroom for the project host itself, filesystem cache, backups, and runtime
services.

## Agent notes

When answering access questions:

1. Distinguish host access from project collaborators.
2. Check whether the host is private, delegated, or public shared-pool.
3. For "why can't I move/create here?", check delegated access, membership host
   tier, host status, placement availability, and region filters.
4. For RAM questions, compare the per-project RAM cap with host RAM and the
   number of projects expected to run concurrently.
5. Host access mutations require fresh auth and must route to the host-owning
   bay.
`;

const PROJECT_HOST_MOVE_BODY = String.raw`
## What a project host move does

Moving a project to another host changes where the project runs and where the
project's host-local data lives. CoCalc uses backups to transfer the project to
the destination host, restores it there, and updates the project-host
assignment.

Use a move when a project needs more RAM, GPUs, a different region, a quieter
host, or a host that a specific group can access.

## Before moving

Check these items before starting the move:

1. The destination host is running or can be started.
2. The user is allowed to place projects on the destination host.
3. The destination has enough disk and RAM for the project.
4. The source host has a recent backup, especially if the source host is
   stopped or deprovisioned.
5. The user understands that \`/tmp\` files and previous host-local snapshots
   will not follow the project.
6. SSH access may need to be configured again after the move.

If the move changes backup region, CoCalc restores from the current backup
region, creates a new backup in the destination region, then switches the
project's backup region after that backup succeeds.

## During and after the move

Watch the move progress. If the source host is unavailable, the move may use
the most recent backup. After the move finishes, open the project, verify files,
start the needed notebooks or services, and check that collaborators can still
work.

## Agent notes

For browser work, open the project settings or project file flyout and use the
host picker. For CLI work, inspect the host and project first:

~~~sh
cocalc host list --json
cocalc host get <destination-host>
cocalc host projects <source-host> --all
~~~

If automating a move, prefer explicit destination host ids. Do not rely on
implicit placement unless the task is genuinely "pick an available host".
Always mention the \`/tmp\`, snapshot, backup freshness, SSH, and region
consequences before advising a user to move important work.
`;

const PROJECT_HOST_LIFECYCLE_BODY = String.raw`
## Lifecycle states

A project host has two related lifecycles:

1. the CoCalc host record, access policy, billing policy, and project
   placement metadata
2. the provider resources that actually run projects, such as the VM, disk,
   network identity, daemon processes, and runtime software

**Start** provisions or starts the provider machine and then waits for
bootstrap, software lifecycle, and daemon health to settle. **Stop** shuts down
the machine while keeping the host record and recoverable provider state.
**Restart** reboots the running machine. **Deprovision** removes provider
resources. **Delete** removes the host record after deprovisioning, or before a
provider machine was ever created.

## Start, stop, and restart

Use **Start** when the host is stopped or deprovisioned but should run
projects again. Start can be blocked by billing enforcement, missing connector
availability for self-hosted machines, active lifecycle work, or provider
errors.

Use **Stop** when you want to stop paying for active compute while keeping the
host configuration. CoCalc may ask whether to back up projects first. During an
active start or restart, **Emergency stop** can appear when the provider
supports stopping the machine and the host is in a stoppable state.

Use **Restart** for runtime drift, daemon problems, or settings that require a
machine restart. Reboot is graceful when the provider supports it. Some
providers also expose a hard reboot, which is more disruptive and should be a
maintenance-window action.

## Deprovision and delete

Deprovisioning is destructive for provider resources. It removes the cloud
machine and attached provider resources. It does not mean "hide from the UI" or
"pause billing for a minute"; it is a lifecycle boundary. Use it when changing
settings that require a fresh machine, retiring the host, or recovering from
provider drift that cannot be reconciled safely.

Deletion is the final cleanup. It is available after deprovisioning, or before
provisioning created provider resources. Deleted hosts do not expose further
destructive actions.

## Maintenance operations

The host action menu also includes **Backup projects**, **Drain**, and
sometimes **Cancel backups**. Backup projects creates project backups for
provisioned or running projects on the host. Drain is for removing active work
from a host before maintenance. Cancel backups is only offered during the
backup stage of a host operation.

## Agent notes

Before running lifecycle commands, check active host operations, project
backups, assigned projects, billing enforcement, and provider capabilities.
Prefer deprovision over delete when provider resources still exist. Do not
advise deprovisioning a host with important unbacked work.
`;

const PROJECT_HOST_SPOT_RECOVERY_BODY = String.raw`
## Why spot recovery exists

Spot hosts can be much cheaper than standard on-demand hosts, but the cloud
provider can reclaim them at any time. CoCalc's spot recovery strategy controls
what happens after that interruption: retry spot, optionally fall back to a
standard VM, and later probe whether spot capacity is available again.

Spot recovery is active only when the host uses **spot** pricing and
**Interruption restore** is set to **Restore immediately**. The **Spot Recovery
Strategy** modal shows the recovery states as a diagram, but the diagram is
read-only; the settings below it control behavior.

## Retry spot first

After a spot interruption, CoCalc first tries to restore the same kind of spot
capacity. The key settings are:

- **Spot retry window (minutes)**: how long CoCalc keeps retrying spot before
  moving on.
- **Retry backoff (seconds)**: the base delay between spot restore attempts.
  The worker adds exponential backoff up to a cap.
- **Max restore attempts before fallback**: a count-based limit. Set it to
  \`0\` to rely only on the retry window.

Use a short window when user-facing uptime matters. Use a longer window when
cost matters more than immediate recovery.

## Standard fallback

When **Allow standard fallback** is enabled, CoCalc can temporarily switch the
host to a standard on-demand VM if spot recovery fails. The host remains
configured as a spot host, but it is running as a standard fallback. The UI
shows this as **standard fallback** and explains the current standard rate and
the spot rate when restored.

The fallback settings are:

- **Minimum standard runtime (minutes)**: how long the standard fallback should
  run before CoCalc starts trying to return to spot.
- **Spot probe interval (minutes)**: how often to check the same zone and
  machine type for spot availability.
- **Require successful probe before returning to spot**: when enabled, CoCalc
  only switches back after a matching probe VM starts successfully.

## Returning to spot

While a host is on standard fallback, CoCalc probes for spot availability.
After a successful probe and the minimum runtime window, it can move back to
spot. Returning to spot is itself disruptive because the underlying VM changes,
so schedule sensitive workloads accordingly.

## Agent notes

When explaining spot recovery, distinguish three states: desired pricing
(spot), effective pricing (possibly standard fallback), and recovery phase.
Use spot for cost-sensitive workloads that tolerate interruption. Use standard
hosts for workloads that must not be interrupted by cloud spot reclamation.
`;

const PROJECT_HOST_CHANGE_RULES_BODY = String.raw`
## The rule of thumb

Some host settings are policy and can change immediately. Other settings change
the underlying provider machine and need a restart or full deprovision. Treat
host edits as infrastructure changes, not normal project settings.

## Changes that can happen while running

**Disk enlarge** can be done any time without reboot for GCP and Nebius hosts.
This is an online capacity increase. It should still be treated carefully:
watch the storage tab and keep backups current, but users do not need to stop
the host just to grow disk.

Access policy, per-project RAM cap, shared-pool tier, and many metadata or
billing policy settings are also host record changes. They do not by
themselves recreate the provider machine.

## Changes that require restart

Switching **spot** and **standard** pricing can be requested any time, but the
effective machine changes only after restart. Instance type changes are the
same: they can be edited while the host exists, but they require restart before
the running machine matches the new shape.

Use the UI's restart/reprovision warnings as the source of truth for whether a
host is currently running old infrastructure.

## Changes that require deprovision

Moving a host between region or zone requires deprovision. Region and zone are
provider placement decisions; CoCalc cannot mutate a running VM into another
region. Back up projects, drain or move workloads, deprovision, then provision
again in the new location.

## Practical checklist

1. Check whether projects are running on the host.
2. Check whether the change is disk, pricing, instance shape, region, or zone.
3. Back up projects before restart or deprovision work.
4. Warn users about interruption when the change requires restart.
5. Warn users about provider-resource deletion when the change requires
   deprovision.

## Agent notes

For GCP and Nebius, disk enlarge is online. For spot/standard and instance type
changes, expect restart. For region/zone moves, expect deprovision. Do not
promise a no-downtime machine shape or location change unless provider-specific
code explicitly supports it.
`;

const PROJECT_HOST_RELIABILITY_BODY = String.raw`
## What the reliability view measures

The host **Reliability** tab summarizes recent host availability. It is not a
generic cloud SLA and it is not a project success metric. It answers: when this
host was intended to be online, how often was it actually reporting online?

The modal and tab show:

- current state, such as online, planned downtime, or recovering
- current uptime
- window availability over the selected lookback period
- reliability over intended-online periods
- unplanned outage count
- unplanned exposure time
- planned downtime, when present

## Reliability versus availability

**Reliability** measures uptime only during periods when the host was intended
to be online. Planned downtime is excluded from the reliability denominator.

**Availability** is wall-clock uptime over the whole window. A host that was
intentionally stopped for most of the month can have low availability but good
reliability.

## Reading the day grid

The small day squares summarize the recent window. Green days were reporting
online. Yellow or red indicates unplanned exposure. Gray indicates planned
downtime. Hovering a day shows the day's details.

If the host is currently unavailable, the top alert distinguishes planned
unavailability from unplanned or recovering state.

## Admin annotations

Admins can annotate recent non-online events. Use this to distinguish planned
maintenance, provider incidents, testing, billing holds, or known user-driven
stops. Public notes should be written carefully because they can be shown to
users.

## Agent notes

Use reliability when deciding whether a host is suitable for long-running
workloads. If a user reports intermittent failures, compare reliability,
current state, host logs, active operations, spot recovery state, and project
events before blaming a notebook or terminal.
`;

const PROJECT_HOST_SOFTWARE_LIFECYCLE_BODY = String.raw`
## What the runtime tab is for

The host **Runtime** tab explains what software the host wants to run, what is
actually installed, and what managed daemons are currently doing. It combines
cluster defaults, host-specific overrides, host telemetry, reconcile state, and
daemon rollout state.

There are two related surfaces:

- **Runtime software**: versions for project-host, project bundle, and tools.
- **Managed daemon components**: local daemons such as project-host services
  that can be restarted, reconciled, rolled forward, or rolled back.

## Bootstrap and software lifecycle

Bootstrap prepares the host. Software lifecycle then keeps the host aligned
with desired state. The lifecycle reports summary status, drift count, last
reconcile result, active reconcile work, and errors.

Drift means the host's observed state does not match desired state. It may be
normal during an upgrade or after changing versions, but persistent drift means
the host needs reconcile or investigation.

## Reconcile and upgrade

**Reconcile** asks the host to repair or align installed software and daemon
state with the desired configuration. It is the first action to try when the
host reports drift but the desired versions are already correct.

**Upgrade** changes desired versions and then queues lifecycle work. Newly
started projects use the upgraded project bundle and tools. Project-host daemon
upgrades may briefly reconnect browser and proxy traffic, so they should be
scheduled with care.

## Daemon lifecycle

Managed daemons have desired versions, installed versions, running versions,
health, rollout phase, and sometimes rollback hints. A daemon can be pinned by
a host-specific override or inherit the cluster default.

If a daemon is disruptive, prefer maintenance windows. If a desired version is
not installed yet, setting it queues reconcile work. Refresh the runtime tab to
watch rollout, health, rollback, and repair state.

## Agent notes

For deep inspection, use host runtime and deployment commands in addition to
the browser tab. Look for version drift, failed reconcile, daemon health,
rollout phase, and host-specific overrides. Do not treat project bundle,
project-host daemon, and tools as the same artifact; they affect different
parts of the runtime stack.
`;

const PROJECT_HOST_STORAGE_BODY = String.raw`
## What the storage tab is for

The host **Storage** tab is where you inspect provider disk capacity, storage
mode, usage, reservations, and host-level storage actions. It is the right
place to check before growing a disk, moving projects onto a host, draining a
host, or changing infrastructure that could affect local project data.

Project host storage is not the same thing as a project backup. The host disk
is where running project files live. Project backups are the portable recovery
copy that CoCalc can use when moving or restoring projects.

## Persistent and ephemeral storage

Persistent storage is designed to survive ordinary host restarts and provider
machine replacement according to the provider's disk model. Ephemeral or local
storage is faster or cheaper for some workloads, but it should be treated as
recoverable only through project backups and explicit project data copies.

Before placing important projects on a host, check whether the host uses
persistent storage, ephemeral storage, or provider-specific attached disks. Do
not assume that files outside the project backup path, such as temporary files,
will survive deprovision, move, or provider replacement.

Shared scratch disks are a separate host-scoped storage feature. They are
mounted at \`/scratch\` in projects on the host, shared by those projects, and
not included in project backups or project moves. Use the **Shared scratch
disks** docs before enabling scratch for a host with multiple users or projects.

## Growing disk

For GCP and Nebius hosts, disk enlarge can be done while the host is running
and does not require a reboot. Growing disk is one-way: plan for future use,
but do not treat it as a reversible experiment.

After growing disk, verify the Storage tab and the host status. If usage remains
high, check whether projects are producing temporary files, caches, datasets,
or build artifacts that should be moved or deleted instead of simply growing
the disk again.

## Backups and snapshots

Use project backups for portable project recovery, cross-host moves, and
protection before lifecycle actions. Use provider snapshots or host-local
snapshots only when the UI or provider explicitly exposes that workflow for the
host; they are infrastructure recovery tools, not a substitute for project
backups.

Before deprovisioning, deleting, moving, or changing storage mode, make sure
important projects have current backups. If a project has changed region, verify
that a backup exists in the destination backup region after the move completes.

## Agent notes

When diagnosing storage or advising a lifecycle action:

1. Open the host **Storage** tab for the selected host.
2. Check storage mode, provider, disk size, current usage, and whether online
   grow is supported.
3. Distinguish host disk state from project backup state.
4. Before deprovision, delete, region move, or storage-mode change, verify
   project backup freshness and assigned projects.
5. Warn explicitly that \`/tmp\`, caches, host-local snapshots, and files
   outside the project backup model may not follow a project move.
`;

const PROJECT_HOST_SHARED_SCRATCH_BODY = String.raw`
## What shared scratch is

A shared scratch disk is host-scoped working storage mounted at \`/scratch\`
inside projects on a project host. It is useful for large shared datasets,
model checkpoints, build caches, generated artifacts, and temporary working
files that should not live in normal project quota.

The word **shared** is the important part: every project on that host sees the
same \`/scratch\` filesystem. Do not put secrets, private student work, or
user-specific data there unless every project and user on the host should be
able to read and write it.

## What it is not

Shared scratch is not project storage. It does not count toward project quota,
does not move with a project, and is not copied by project backup, project copy,
or project move. If a project moves to another host, the files in \`/scratch\`
stay with the original host.

Shared scratch is also not a CoCalc backup. It uses provider network block
storage rather than local SSD, and the provider disk type may have its own
durability properties, but CoCalc does not back up scratch contents.

## Lifecycle rules

Scratch persists across normal host stop/start, reboot, ordinary host edit or
recreate, spot-to-standard fallback, standard-to-spot changes, and instance type
changes. It is deleted when the host is explicitly deleted or when the scratch
disk itself is deleted.

Adding scratch or deleting scratch can be requested while the host is running.
Projects may need to be restarted before they see a newly added \`/scratch\`
mount. Deletion can fail if running projects are still using the filesystem,
because the host must unmount it before destroying the disk.

## Growing and changing scratch

For GCP hosts, scratch disk growth is online. It does not require a host reboot,
and projects can keep running while the disk and filesystem are enlarged.

GCP scratch disks can also be configured for automatic grow. When automatic
grow is enabled, CoCalc watches host-level \`/scratch\` usage, grows by the
configured increment when free space crosses the threshold, caps growth at the
configured maximum, and still runs billing/admission checks before increasing
pay-as-you-go storage.

For Nebius hosts, creating the initial scratch disk can be done without a host
reboot. Growing an existing Nebius scratch disk later requires a host reboot
before the larger filesystem is available.

Scratch growth is one-way: you can grow the disk, but you cannot shrink it in
place. To shrink or change disk type, delete the scratch disk and recreate it at
the desired size and type, which destroys all scratch data.

Nebius scratch disks are sized in 93 GB increments. If you request a smaller or
non-aligned size, the UI rounds up to the provider-supported size.

## Billing and planning

Scratch is host pay-as-you-go storage. It can continue to cost money while the
host is stopped, because the provider disk still exists. Use it deliberately
for data that benefits from being shared on one host, and clean it up when the
workload is finished.

For course or workshop hosts, explain the sharing model to users before
enabling scratch. A public or shared-pool host with scratch can make the same
filesystem visible to unrelated projects if placement is broad enough.

## Agent notes

When helping with shared scratch:

1. Ask for or select the project host id; scratch is attached to a host, not to
   a project.
2. Open the selected host's Storage tab with the \`hosts.scratch.open\` docs
   action.
3. Confirm the host-owning bay before making control-plane changes.
4. Warn that \`/scratch\` does not follow project backup, copy, restore, or
   host-to-host move workflows.
5. Treat scratch deletion as destructive for every project using that host.
6. If the user is moving a project to another host, ask whether any needed data
   is only in \`/scratch\` and should be copied into project files or another
   durable location first.
`;

const PROJECT_HOST_LOGS_BODY = String.raw`
## What host logs are for

The host **Logs** tab shows operational history for the project host itself:
provisioning, bootstrap, lifecycle actions, software reconcile, daemon state,
provider errors, and recent host-controller activity. Use it when the host is
not starting, projects cannot be placed, software is drifting, or a lifecycle
action looks stuck.

Host logs are different from project logs. A notebook kernel crash, terminal
process failure, or web app error may be a project problem. A failed provision,
daemon rollout, provider API error, or unavailable host service is a host
problem.

## First things to check

Start with the drawer overview and the relevant tab:

1. **Details** for current state and active operations.
2. **Reliability** for recent online/offline history.
3. **Runtime** for software lifecycle, drift, and daemon health.
4. **Logs** for the event stream behind those summaries.

For CLI inspection, use a small recent tail first:

~~~sh
cocalc host logs <host-id> --tail 200
~~~

If the recent tail is not enough, narrow by the time of the failed action
instead of dumping unrelated history.

## Reading log patterns

Provider errors usually point to credentials, quotas, unavailable machine
types, pricing mode, spot interruptions, region or zone capacity, or network
setup. Bootstrap errors usually point to package installation, image setup,
SSH/connector availability, or first-start configuration. Runtime errors point
to daemon health, version drift, reconcile failures, or project-host service
rollout.

When a host is recovering from spot interruption or fallback, logs are most
useful when read together with the spot recovery state and current effective
pricing.

## Sharing logs safely

Logs may include host ids, project ids, paths, provider names, and operational
context. Avoid pasting large raw logs into public channels. Prefer a short
tail around the failure time, plus the host id, action attempted, current
state, and any active operation id.

## Agent notes

When helping with host debugging:

1. Ask for or select the host id.
2. Open **Logs**, **Runtime**, and **Reliability** rather than using logs alone.
3. Capture the action attempted, approximate time, current host state, active
   operation, and whether the host is spot or standard.
4. Use \`cocalc host logs <host-id> --tail 200\` for a focused first pass.
5. Route host inspection to the host-owning bay; do not assume the browser's
   current project bay owns the host.
`;

const PROJECT_FILES_BODY = String.raw`
## What project files are for

Project files are the shared filesystem for notebooks, scripts, terminals,
LaTeX documents, datasets, whiteboards, and generated output. They are visible
to collaborators, agents, terminals, and most project tools.

## Add files

1. Open the project.
2. Use **New** to create notebooks, terminals, scripts, folders, and documents.
3. Upload files or drag them into the file browser when appropriate.
4. Organize related work into folders.
5. Use descriptive names that humans and agents can refer to.

Avoid putting credentials, large temporary build artifacts, or private tokens in
ordinary files. Use project secrets for credentials.

## Work with files from agents

When asking Codex to edit files, name the relevant paths and expected outcome.
For unsaved browser editor state, agents should use the live text editor or
notebook APIs instead of assuming the filesystem copy is current.

## Why this matters in CoCalc

Files are the common substrate between humans, terminals, notebooks, Codex,
TimeTravel, Git, and project hosts. Clear file organization makes the workspace
easier to inspect, automate, recover, and teach.
`;

const MARKDOWN_BODY = String.raw`
## What Markdown is for

Markdown files are lightweight text documents that can include headings, lists,
links, images, code blocks, math, and mentions. Use them for README files,
notes, lab instructions, project documentation, and content that should remain
easy to edit as plain text.

## Edit Markdown

Open a \`.md\` file in a project. CoCalc can show a source editor, a rendered
preview, and rich text editing surfaces depending on the file and view. Use the
source view when exact Markdown syntax matters, and use the rendered view when
you want to inspect the final document.

## Use code and math

Fence code blocks with triple backticks and include a language name when useful.
Use Markdown math syntax for formulas. Keep long generated output in separate
files or notebooks instead of pasting it into prose.

## Mentions and collaboration

Markdown is collaborative in CoCalc. Use mentions when you want to draw a
collaborator into a specific discussion or document context, and keep durable
instructions in files instead of only in chat.
`;

const LATEX_BODY = String.raw`
## What LaTeX is for

LaTeX projects are for papers, assignments, reports, and technical documents
that need high-quality typesetting, bibliographies, cross references, figures,
and reproducible builds.

## Build a paper

1. Create or open a \`.tex\` file.
2. Edit the source in the LaTeX editor.
3. Build the PDF.
4. Inspect errors and warnings in the build output.
5. Use SyncTeX, preview panes, and project files to move between source and
   output.

Keep figures, bibliography files, generated data, and scripts in the same
project so collaborators and agents can inspect the complete paper workflow.

## Troubleshooting

If the PDF does not build, start with the first meaningful LaTeX error rather
than later follow-up errors. Clean auxiliary files when stale build state is
suspect. For large documents, isolate failing sections in a small test file
before changing the full paper.
`;

const R_MARKDOWN_BODY = String.raw`
## What R Markdown is for

R Markdown combines prose, R code, output, and document rendering in one file.
Use it for reports, statistical notebooks, teaching materials, and reproducible
analysis that should render to HTML, PDF, or other formats.

## Create and render

1. Create a \`.Rmd\` file.
2. Put document settings in the YAML header.
3. Write Markdown prose.
4. Add R chunks for computations, plots, tables, and checks.
5. Render the document and inspect the output.

Run chunks incrementally while developing. If a full render fails, rerun the
failing chunk in a fresh session and check package availability in the project
environment.

## Reproducibility

Keep package setup, data paths, and rendering commands explicit. For classes or
shared research projects, prefer a runtime image or setup script so the R
environment is reproducible across projects.
`;

const TASKS_BODY = String.raw`
## What task files are for

Task files organize project work into checkable items. Use them for lab
checklists, project plans, bug triage, grading queues, or shared TODO lists that
belong next to the files and notebooks they describe.

## Work with tasks

Create a task file, add items, assign structure with headings or hashtags, and
mark work complete as the project evolves. Because task files live in the
project, collaborators and agents can refer to the same durable checklist.

## Practical use

Keep tasks actionable and close to the related project files. Put detailed
discussion in chat or Markdown when it grows beyond a task item, then link or
name the relevant file from the task list.
`;

const SLIDES_BODY = String.raw`
## What slides are for

Slides are presentation documents stored in the project. Use them for teaching,
research talks, demos, and lightweight visual explanations that should live near
the notebooks, figures, and files they reference.

## Build slides

Create a slides file, add pages, arrange content, and present from the browser.
Keep source data, generated figures, and supporting notebooks in the same
project so the presentation can be updated and reviewed with the rest of the
work.

## Collaboration

Slides are project files, so collaborators can edit, review, and recover them
with the same project tooling as other documents. Use TimeTravel when you need
to inspect or restore earlier versions.
`;

const WHITEBOARD_BODY = String.raw`
## What whiteboards are for

Whiteboards are collaborative drawing surfaces inside a project. Use them for
diagrams, sketches, lecture notes, planning, and visual explanations that do not
need to be a polished paper or slide deck.

## Use a whiteboard

Create or open a whiteboard file, draw or add content, and collaborate in
realtime. Keep related notebooks, scripts, data, and written notes nearby in the
same project so the visual context is not separated from the work.

## Recovery

Whiteboards are project files. Use TimeTravel when you need to inspect earlier
states or recover from accidental edits.
`;

const FILE_EXPLORER_BODY = String.raw`
## What the file explorer is for

The file explorer is the project file browser. Use it to create, open, upload,
rename, move, delete, and organize the files that make up a CoCalc project.

## Work efficiently

Use folders for related work, descriptive filenames for humans and agents, and
the search and new-file controls when a project grows. The explorer is also a
good starting point for creating terminals, notebooks, scripts, LaTeX files,
slides, whiteboards, and task files.

## Files are shared project state

Files opened from the explorer are visible to collaborators and tools in the
same project. For credentials, use project secrets instead of ordinary project
files.
`;

const PROJECT_LIST_BODY = String.raw`
## What the projects page is for

The projects page lists the CoCalc projects you can access. Use it to open
recent work, create projects, search by title or file, inspect activity, and
manage the projects that back your courses, research, classes, and agent
workspaces.

## Organize projects

Use clear project names and descriptions. Archive, stop, or delete work that is
no longer active, and keep important projects easy to find with naming
conventions that match your team or course.

## Create new projects

Create a project when you need a separate filesystem, collaborator set, runtime
environment, or host placement. For the short creation flow, see
[Create a project](/docs/projects/create-project).
`;

const GIT_BODY = String.raw`
## What Git is for

Git tracks deliberate versions of a repository: commits, branches, remotes, and
reviews. Use it when you need portable history, collaboration with external
tools, or a clean release record.

## Use Git in a project

1. Open a terminal in the project.
2. Clone a repository or run \`git init\`.
3. Configure remotes and credentials as needed.
4. Commit meaningful changes.
5. Push or pull through the terminal, file tools, or Git viewer.

Store deploy keys and access tokens using project secrets or SSH keys, not
inside the repository.

## Git and TimeTravel

Git and TimeTravel solve different problems. Git is for intentional repository
history. TimeTravel is for file-focused recovery and inspection. When a file is
in Git, TimeTravel can also make Git revisions easy to browse with a slider, and
the Git viewer is available when you need full commit context.

## Why this matters in CoCalc

CoCalc projects are full Linux environments, so Git works like it does on a
normal machine. The difference is that Git is integrated into a collaborative,
browser-accessible workspace with terminals, notebooks, TimeTravel, and agents.
`;

const PYTHON_BODY = String.raw`
## What Python in CoCalc is for

Python in CoCalc is real Python running in a Linux project, not a browser-only
runtime. You can use notebooks, scripts, terminals, virtual environments,
package managers, LaTeX workflows, and agents in the same project.

## Common ways to use Python

1. Create a Jupyter notebook for exploratory work.
2. Edit \`.py\` files for scripts, modules, and packages.
3. Run \`python3\`, \`uv\`, \`pip\`, or \`conda\` in a terminal.
4. Use Python from LaTeX workflows such as PyTeX when the document needs code.
5. Install alternate Python versions or virtual environments when needed.

Keep environment setup commands in a script, README, or runtime image workflow
when other people or agents need to reproduce the project.

## Why this matters in CoCalc

CoCalc lets Python move naturally from notebook to script to paper in one
durable workspace. The same project can contain experiments, production scripts,
package installs, plots, papers, terminals, and Codex-driven automation.
`;

const DOCS_BROWSER_BODY = String.raw`
## What the docs browser is for

The CoCalc-ai docs browser gives each running CoCalc instance its own built-in
documentation. This matters because the docs should match the version of CoCalc
you are actually using instead of sending you to stale external documentation.

## Open docs

1. Open the public **Docs** page, or open **Docs** inside a project.
2. Search for a task, feature, or action id.
3. Open the matching entry.
4. Use any available action button when the docs can open the relevant UI for
   you.

Inside a project, the docs can appear as a flyout or a full project tab. Public
docs use the same content but do not have project-scoped browser actions.

## Adjust readability

Use the docs font size control when you need larger or smaller text. The setting
is saved locally in the browser so docs stay readable without zooming the whole
CoCalc interface.

## Why this matters in CoCalc

Docs are part of the product runtime. They can be searched by humans, consumed
by agents, and verified against the current UI, which makes them less likely to
drift away from reality.
`;

const DOCS_ACTIONS_BODY = String.raw`
## What executable docs actions are for

Executable docs actions are stable identifiers for UI destinations. Instead of
only saying "open Settings, then Environment, then Secrets", a docs entry can
also name \`settings.environment.secrets\`, and CoCalc can open that panel in
the current browser session.

## Use an action id

1. Open a docs entry that lists an action.
2. Click the action button, or ask Codex to use the action id.
3. CoCalc opens the matching project UI when the action is implemented and
   available.
4. If the action is not implemented yet, use the written steps.

Agents can list actions with \`cocalc browser action docs-list\` and execute one
with \`cocalc browser action docs <action-id>\`.

## Verify actions

Docs actions should be tested with browser-session verification. The verifier
does not only check that the action returned success; it also asserts that the
expected visible UI appeared.

## Why this matters in CoCalc

Executable docs turn documentation into a bridge between explanation and action.
That is especially valuable for Codex: it can answer a question, open the right
panel, and then continue working in the same project context.
`;

const BROWSER_AUTOMATION_BODY = String.raw`
## What browser-session automation is for

Browser-session automation lets Codex and other agents safely operate a
restricted set of actions in the exact browser session that asked for help. It
is useful for opening panels, checking visible UI, reading state, and validating
that docs match the product.

## Use the browser session

1. Load the matching dev environment before using \`cocalc browser\`.
2. List browser files or docs actions when you need context.
3. Use high-level actions such as docs actions before falling back to generic
   browser exec scripts.
4. Use assertions such as waiting for text or a URL when verifying behavior.

For local hub development, refresh the environment with
\`cd src && eval "$(pnpm -s dev:hub:env)"\` before live browser commands.

## Keep automation scoped

Prefer typed actions and restricted QuickJS browser exec APIs over raw DOM
scripts. The goal is enough UI access for useful help and verification, not an
unbounded remote-control surface.

## Why this matters in CoCalc

The same infrastructure that lets Codex open a Secrets modal can also verify
that docs are still true after frontend changes. This makes documentation,
support, and agent behavior part of one testable system.
`;

const ADMIN_OVERVIEW_BODY = String.raw`
## What admin docs are for

Admin docs describe operational workflows for running a CoCalc-ai site. They
are not public product docs: they assume a signed-in site administrator, current
source-derived behavior, and the security model of the running deployment.

Use admin docs when you need to operate the site, inspect users, configure
settings, publish site messages, or guide Codex to the correct admin panel
without searching source code from scratch every time.

## Admin safety model

Admin workflows can reveal account data, change site behavior, impersonate
users, reset credentials, disable 2FA, affect billing, or move ownership across
bays. Treat them as high-trust operations.

Prefer UI actions and documented CLI commands that require fresh auth for
dangerous operations. Avoid ad hoc database edits unless the docs or source
explicitly call for them.

## Navigation

Open the Admin tab from the main app. The admin landing page contains collapsible
sections for users, news, site settings, RootFS images, bay operations, backup
shards, software licenses, registration tokens, SSO, and membership tiers.

Docs actions for admin pages are stable destinations that Codex can use through
the browser action API when the current user is an admin.
`;

const ADMIN_NEWS_BODY = String.raw`
## What admin news is for

Admin news manages public news posts, event posts, and in-app system notices.
System notices are useful for urgent operational messages such as outages,
maintenance, or service-impacting configuration changes.

## Create a system notice

1. Open the Admin tab.
2. Open **News**.
3. Choose **Create system notice**.
4. Write the notice in Markdown.
5. Set timing, visibility, and any image or link fields.
6. Save and verify how it appears in the app.

System notices are operational communication. Keep them short, concrete, and
dated when they describe an incident or maintenance window.

## News and events

Use regular news items for public product updates. Use event posts for events
that should appear on the public events surface. The same admin editor supports
Markdown, image paste/upload, and preview.
`;

const ADMIN_SITE_SETTINGS_BODY = String.raw`
## What site settings are for

Site settings configure behavior for the running CoCalc-ai deployment. They
include product configuration, authentication options, project-host/cloud
settings, email, backup, runtime policies, and other operational controls.

## Work with settings

1. Open the Admin tab.
2. Open **Site Settings**.
3. Search for the setting or section you need.
4. Read the current value and nearby help text before changing it.
5. Save, then verify the affected workflow in the app or CLI.

Some setting changes affect security, authentication, billing, project hosts,
or backups. For those, make a note of the old value and prefer a small
roll-forward/roll-back test.

## Configuration wizards

Some settings have dedicated helper wizards, such as Cloudflare, GCP service
accounts, Nebius CLI, launcher defaults, and runtime retention policies. Use
those wizards when available instead of editing related fields independently.
`;

const ADMIN_USERS_BODY = String.raw`
## What user management is for

The admin user search surface is the starting point for account support and
site operations. It lets admins find accounts and open account-specific tools.

## Common workflows

Search for a user by name or email, expand the result, then use the detail tags
for the workflow you need:

- **Impersonate** generates an impersonation link after recent admin
  verification and 2FA.
- **Profile** includes password reset and 2FA removal tools.
- **Ban** controls account ban state.
- **Projects** lists recent projects the account collaborates on.
- **Purchases**, **Egress**, and **Membership** expose billing, network, and
  membership tools.

## Safety

Impersonation, password reset, and removing 2FA are sensitive support actions.
Use them only for a concrete support or administrative reason, and expect fresh
admin authentication checks for dangerous operations.
`;

const ADMIN_CLI_BODY = String.raw`
## What admin CLI workflows are for

The CoCalc CLI is often the fastest way to inspect a running dev or production
site, especially for bay/account/project-host operations. Admin CLI workflows
should use fresh environment and fresh auth so commands target the intended
hub.

## Start with the correct environment

For local hub-backed development:

~~~sh
cd src && eval "$(pnpm -s dev:hub:env)"
~~~

Refresh this after restarting the hub or changing local dev instances.

## Useful commands

~~~sh
cocalc bay list --json
cocalc account where <account_id> --json
cocalc account rehome <account_id> --bay <bay_id> --reason "..." --yes --json
cocalc account rehome-status --op-id <op_id> --source-bay <bay_id> --json
~~~

Dangerous account operations require recent admin verification. In local dev,
use:

~~~sh
cocalc auth elevate --dev
~~~

## Account-owned state

Account-private DKV/conat-persist state, including docs private notes and git
review state, must follow the account home bay. After rehome, verify the account
location and smoke-test a feature that reads account-private state.
`;

const ADMIN_BAY_OPS_BODY = String.raw`
## What Bay Operations is for

Bay Operations is the admin overview for a multi-bay CoCalc-ai deployment. Use
it to see which bays are alive, how much work each bay owns, whether rehome
operations are running or failing, and whether backup or load projections need
attention.

## What to check first

1. Open the Admin tab.
2. Open **Bay Operations**.
3. Check heartbeat status for every bay.
4. Review account, project, and project-host ownership counts.
5. Look for failed or running rehome operations.
6. Open bay details when backup health or load projections look suspicious.

The detail view includes copyable commands for common bay inspection and
diagnostic workflows. Prefer those typed commands over ad hoc database queries.

## Ownership model

Account-private state belongs on the account home bay. Project data belongs on
the project owning bay. Project-host operations belong on the host bay. When
moving accounts, projects, or hosts, verify both the database owner fields and
the corresponding filesystem or conat-persist state.

## Safety

Bay operations are control-plane work. Do not change ownership fields manually
unless the documented move operation cannot run and you have already inspected
the source and destination bays.
`;

const ADMIN_ROOTFS_BODY = String.raw`
## What RootFS administration is for

RootFS administration manages the runtime image catalog and the images cached
on project hosts. Use it when a runtime image should be published, hidden,
blocked, deleted, garbage-collected, or scanned on a real host.

## Common workflow

1. Open the Admin tab.
2. Open **RootFS Images**.
3. Filter for the catalog entry you care about.
4. Inspect central lifecycle state and per-host availability.
5. Use **Scan** on an online project host when you need a host-level check.
6. Hide or block images before deleting when users may still depend on them.

Scans run on project hosts. If no online host is available, start or choose a
host before expecting scan results.

## When to use this page

Use RootFS administration after changing runtime-image build or retention
policy, when a project host fails to pull an image, or before removing old
images from the catalog.
`;

const ADMIN_BACKUP_SHARDS_BODY = String.raw`
## What backup shards are for

Backup shards describe where project backups are stored and how backup capacity
is split across the deployment. Admins use this page to inspect shard
configuration and avoid silent backup-capacity or routing mistakes.

## Review backup shards

1. Open the Admin tab.
2. Open **Backup Shards**.
3. Confirm the expected shards are present.
4. Check that shard metadata matches the intended deployment.
5. Use **Bay Operations** to inspect bay backup health if a shard looks stale or
   overloaded.

Backups are a safety boundary. Treat edits as operational changes that need a
clear reason, a rollback path, and a small verification afterwards.
`;

const ADMIN_REGISTRATION_TOKENS_BODY = String.raw`
## What registration tokens are for

Registration tokens control special signup and onboarding flows. Use them for
private cohorts, managed classrooms, migrations, pilots, and sites where
ordinary email signup is restricted.

## Create or update a token

1. Open the Admin tab.
2. Open **Registration Tokens**.
3. Create a token or edit an existing one.
4. Confirm intended limits, expiration, and account effects.
5. Test the signup path with a non-admin account before sharing it widely.

If general email signup should be disabled, configure that in **Site
Settings**. Registration tokens are the targeted exception mechanism.

## Safety

Tokens grant access to the site. Keep names and descriptions clear enough that
another admin can tell why the token exists and when it should be removed.
`;

const ADMIN_MEMBERSHIP_AND_LICENSES_BODY = String.raw`
## What membership tiers and software licenses are for

Membership tiers describe site-level capabilities and usage limits. Software
licenses describe purchasable or assignable license packages. Together they
control many commercial and access-policy workflows.

## Membership tiers

Use **Membership Tiers** to define or adjust standard capability bundles. Pay
special attention to dedicated-host fields such as host creation, project-host
tier, and dedicated-host usage limits. Creating hosts still also requires
normal billing and admission checks.

## Software licenses

Use **Software Licenses** to manage license tiers and concrete licenses. License
configuration can control project upgrades, max project hosts, and other
resource limits.

## Safety

Small-looking changes can affect future purchases, existing users, or dedicated
host access. Record the old value before changing limits, then verify with an
account that should receive the updated capability.
`;

const ADMIN_MANAGED_EGRESS_BODY = String.raw`
## What Network Egress is for

Network Egress tracks managed egress that CoCalc attributes to accounts,
projects, and categories. It gives admins an operational view into recent
network usage so they can investigate unexpected traffic, understand limit
pressure, and connect support reports to concrete account or project activity.

## Review site-wide egress

1. Open the Admin tab.
2. Open **Network Egress**.
3. Choose the time range that matches the support or operations question.
4. Review top accounts, top projects, categories, and recent events.
5. Drill into the relevant user or project when the aggregate view points to a
   specific owner.

The site-wide view is for triage. It helps answer "who or what is producing
traffic right now?" before deciding whether the next step is account support,
project inspection, membership limits, or infrastructure investigation.

## Account-level egress

The admin user detail view also exposes recent and historical managed egress
for a specific account. Use the account-level view when a user asks why they
are over a managed-egress limit, or when you need to correlate traffic with
that account's projects and membership entitlements.

## Safety

Managed egress data can reveal operational behavior of user projects. Treat it
as support and abuse-investigation data. Prefer summarizing categories and
amounts rather than copying raw event details into tickets unless the ticket
needs that evidence.
`;

const ADMIN_SSO_BODY = String.raw`
## What SSO administration is for

SSO administration configures single sign-on providers and domain policies for
a CoCalc site. Use it when an institution or organization needs SAML login,
domain-managed signup behavior, or a policy that requires users from a domain
to use a specific identity provider.

## Configure an SSO provider

1. Open the Admin tab.
2. Open **SSO Providers & Domains**.
3. Add or edit the provider.
4. Paste metadata XML when available so the form can fill the entity ID, SSO
   URL, and signing certificate.
5. Save the provider, then test sign-in with a non-admin account that belongs
   to the target domain.

Prefer metadata import over manual copy/paste. Manual fields are useful for
debugging, but metadata reduces transcription mistakes in certificates and
service URLs.

## Configure domain policy

Domain policies decide how users with matching email domains sign in. A domain
can allow passwords, require SSO, allow signup through SSO only, and optionally
require CoCalc-native 2FA. Keep policy names and notes clear enough that
another admin can understand why the rule exists.

## Safety

SSO policy changes can lock users out. Before requiring SSO for a domain,
verify that the provider works, that at least one admin has an alternate access
path, and that support knows how users should recover if their institutional
identity is unavailable.
`;

export const DOCS_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "teams"],
    body: ADMIN_OVERVIEW_BODY.trim(),
    category: "Admin",
    id: "admin.overview",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Admin tools connected to operational checks and site controls",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/overview",
    status: "ready",
    summary:
      "Understand the admin docs surface and the safety model for site operations.",
    title: "Admin operations overview",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> News manager.",
        executable: true,
        id: "admin.news.open",
        label: "Open news manager",
      },
      {
        description: "Open the Admin -> News editor for a new system notice.",
        executable: true,
        id: "admin.news.create-system",
        label: "Create system notice",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_NEWS_BODY.trim(),
    category: "Admin",
    id: "admin.news",
    image: docsIcon(
      "/public/docs/docs-browser-74a65d58.webp",
      "A site-wide message card prepared for CoCalc users",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/news",
    status: "ready",
    summary:
      "Create public news, events, and in-app system notices for a CoCalc site.",
    title: "Manage news and system notices",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Site Settings section.",
        executable: true,
        id: "admin.site-settings.open",
        label: "Open site settings",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_SITE_SETTINGS_BODY.trim(),
    category: "Admin",
    id: "admin.site-settings",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "Site configuration controls with cloud and runtime settings",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/site-settings",
    status: "ready",
    summary:
      "Use the admin site settings section and configuration wizards safely.",
    title: "Configure site settings",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> User Search section.",
        executable: true,
        id: "admin.users.open",
        label: "Open user search",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_USERS_BODY.trim(),
    category: "Admin",
    id: "admin.users",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "Admin user cards with account support controls",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/users",
    status: "ready",
    summary:
      "Find accounts and use impersonation, password reset, 2FA removal, ban, project, and billing tools.",
    title: "Manage users as an admin",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_CLI_BODY.trim(),
    category: "Admin",
    id: "admin.cocalc-cli",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "An admin terminal inspecting bays, accounts, and project hosts",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/cocalc-cli",
    status: "ready",
    summary:
      "Use cocalc-cli for admin inspection, fresh auth, bay listing, account location, and rehome smoke tests.",
    title: "Admin cocalc-cli cookbook",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Bay Operations section.",
        executable: true,
        id: "admin.bay-ops.open",
        label: "Open bay operations",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_BAY_OPS_BODY.trim(),
    category: "Admin",
    id: "admin.bay-ops",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Bay operation status with ownership and rehome checks",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/bay-ops",
    status: "ready",
    summary:
      "Inspect bay health, ownership counts, rehome operations, backup health, and load projections.",
    title: "Inspect bay operations",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> RootFS Images section.",
        executable: true,
        id: "admin.rootfs.open",
        label: "Open RootFS images",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_ROOTFS_BODY.trim(),
    category: "Admin",
    id: "admin.rootfs",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "Runtime image catalog entries cached across project hosts",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/rootfs",
    status: "ready",
    summary:
      "Manage runtime image catalog entries, host scans, visibility, blocking, deletion, and retention.",
    title: "Administer RootFS images",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Backup Shards section.",
        executable: true,
        id: "admin.project-backup-shards.open",
        label: "Open backup shards",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_BACKUP_SHARDS_BODY.trim(),
    category: "Admin",
    id: "admin.project-backup-shards",
    image: docsIcon(
      "/public/docs/project-files-6c4ff552.webp",
      "Backup shard storage routes connected to project folders",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/project-backup-shards",
    status: "ready",
    summary:
      "Inspect project backup shard configuration and connect shard health to bay operations.",
    title: "Review backup shards",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Registration Tokens section.",
        executable: true,
        id: "admin.registration-tokens.open",
        label: "Open registration tokens",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_REGISTRATION_TOKENS_BODY.trim(),
    category: "Admin",
    id: "admin.registration-tokens",
    image: docsIcon(
      "/public/docs/project-secrets-ea9872ae.webp",
      "A registration token card granting controlled site access",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/registration-tokens",
    status: "ready",
    summary:
      "Create and review targeted signup tokens for cohorts, classrooms, pilots, and restricted sites.",
    title: "Manage registration tokens",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Membership Tiers section.",
        executable: true,
        id: "admin.membership-tiers.open",
        label: "Open membership tiers",
      },
      {
        description: "Open the Admin -> Software Licenses section.",
        executable: true,
        id: "admin.software-licenses.open",
        label: "Open software licenses",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_MEMBERSHIP_AND_LICENSES_BODY.trim(),
    category: "Admin",
    id: "admin.membership-licenses",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "Membership and license controls for account capabilities",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/membership-licenses",
    status: "ready",
    summary:
      "Understand membership tiers, software licenses, dedicated-host limits, and commercial access policies.",
    title: "Manage membership and licenses",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Network Egress section.",
        executable: true,
        id: "admin.managed-egress.open",
        label: "Open network egress",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_MANAGED_EGRESS_BODY.trim(),
    category: "Admin",
    id: "admin.managed-egress",
    image: docsIcon(
      "/public/docs/connectivity-eaca154f.webp",
      "Network egress activity grouped by accounts, projects, and categories",
    ),
    lastReviewed: "2026-05-27",
    slug: "admin/managed-egress",
    status: "ready",
    summary:
      "Use the admin Network Egress overview to investigate recent account, project, and category network usage.",
    title: "Monitor network egress",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> SSO Providers & Domains section.",
        executable: true,
        id: "admin.sso.open",
        label: "Open SSO settings",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_SSO_BODY.trim(),
    category: "Admin",
    id: "admin.sso",
    image: docsIcon(
      "/public/docs/http-api-5067e8ed.webp",
      "An identity provider connection with domain policy controls",
    ),
    lastReviewed: "2026-05-27",
    slug: "admin/sso",
    status: "ready",
    summary:
      "Configure SSO providers and domain policies without locking users out.",
    title: "Configure SSO providers and domains",
    visibility: "admin",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CREATE_PROJECT_BODY.trim(),
    category: "Projects",
    id: "projects.create-project",
    image: docsIcon(
      "/public/docs/create-project-5b221552.webp",
      "A new CoCalc project folder with notebook, terminal, and chat tools",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/create-project",
    status: "ready",
    summary:
      "Create a durable Linux workspace for files, notebooks, terminals, chat, and agents.",
    title: "Create a project",
  },
  {
    actions: [
      {
        description:
          "Open the project Settings -> Environment -> Secrets panel.",
        executable: true,
        id: "settings.environment.secrets",
        label: "Open project secrets",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: PROJECT_SECRETS_BODY.trim(),
    category: "Projects",
    id: "projects.project-secrets",
    image: docsIcon(
      "/public/docs/project-secrets-ea9872ae.webp",
      "Project secrets mounted as protected read-only files",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/project-secrets",
    status: "ready",
    summary:
      "Store API keys and credentials as encrypted, read-only files mounted into the running project.",
    title: "Project secrets",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: AI_CREDENTIALS_BODY.trim(),
    category: "AI",
    id: "ai.connect-credentials",
    image: docsIcon(
      "/public/docs/connect-ai-access-522e86e1.webp",
      "AI access connected securely to a CoCalc project",
    ),
    lastReviewed: "2026-05-24",
    slug: "ai/connect-credentials",
    status: "ready",
    summary: "Connect ChatGPT or OpenAI API access for Codex and project code.",
    title: "Connect AI access",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: COCALC_CLI_BODY.trim(),
    category: "CLI",
    id: "cli.use-cocalc-cli",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "A terminal automating project docs, notebooks, and browser tasks",
    ),
    lastReviewed: "2026-05-24",
    slug: "cli/use-cocalc-cli",
    status: "ready",
    summary:
      "Use the CoCalc CLI for authenticated docs, browser, notebook, and project automation.",
    title: "Use the CoCalc CLI",
  },
  {
    audiences: ["agents", "researchers", "teams"],
    body: HTTP_API_BODY.trim(),
    category: "API",
    id: "api.http-api",
    image: docsIcon(
      "/public/docs/http-api-5067e8ed.webp",
      "A guarded HTTP API gateway with keys and connected endpoints",
    ),
    lastReviewed: "2026-05-24",
    slug: "api/http-api",
    status: "ready",
    summary:
      "Use the limited CoCalc HTTP API carefully, and prefer cocalc-cli for most automation.",
    title: "CoCalc HTTP API and API keys",
  },
  {
    actions: [
      {
        description: "Open a terminal in the active project.",
        executable: true,
        id: "project.terminal.open",
        label: "Open terminal",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: OPEN_TERMINAL_BODY.trim(),
    category: "Projects",
    id: "projects.open-terminal",
    image: docsIcon(
      "/public/docs/open-terminal-5c56d2b5.webp",
      "A project folder opening a durable terminal session",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/open-terminal",
    status: "ready",
    summary:
      "Use durable collaborative terminals backed by real project Linux processes.",
    title: "Open a terminal",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: USE_TERMINAL_BODY.trim(),
    category: "Terminal",
    id: "terminal.use-terminal",
    image: docsIcon(
      "/public/docs/terminal-56905fa2.webp",
      "Hand-drawn terminal opening project files",
    ),
    lastReviewed: "2026-05-25",
    slug: "terminal/use-terminal",
    status: "ready",
    summary:
      "Use persistent collaborative Linux shell sessions inside CoCalc projects.",
    title: "Use terminals",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PROJECT_FILES_BODY.trim(),
    category: "Files",
    id: "files.project-files",
    image: docsIcon(
      "/public/docs/project-files-6c4ff552.webp",
      "A shared project folder with notebooks, scripts, data, and output",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/project-files",
    status: "ready",
    summary:
      "Use the project filesystem as the shared place for notebooks, scripts, datasets, and output.",
    title: "Work with project files",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: FILE_EXPLORER_BODY.trim(),
    category: "Files",
    id: "files.explorer",
    image: docsIcon(
      "/public/docs/file-explorer-d0e7d92d.webp",
      "A project file browser with folders, file types, and search",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/explorer",
    status: "ready",
    summary: "Create, open, upload, rename, move, and organize project files.",
    title: "Use the file explorer",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: MARKDOWN_BODY.trim(),
    category: "Files",
    id: "files.markdown",
    image: docsIcon(
      "/public/docs/markdown-dab5a1ac.webp",
      "A Markdown document with headings, checklists, and a code block",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/markdown",
    status: "ready",
    summary:
      "Write README files, notes, instructions, math, code blocks, and collaborative documentation.",
    title: "Use Markdown",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: SLIDES_BODY.trim(),
    category: "Files",
    id: "files.slides",
    image: docsIcon(
      "/public/docs/slides-84a00de7.webp",
      "Presentation slides with charts, images, and a projected screen",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/slides",
    status: "ready",
    summary:
      "Create presentation slides that live with the project files they explain.",
    title: "Create slides",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: WHITEBOARD_BODY.trim(),
    category: "Files",
    id: "files.whiteboard",
    image: docsIcon(
      "/public/docs/whiteboard-d2b02f98.webp",
      "A collaborative whiteboard with sticky notes, sketches, and arrows",
    ),
    lastReviewed: "2026-05-25",
    slug: "files/whiteboard",
    status: "ready",
    summary:
      "Sketch diagrams, lecture notes, and visual plans in a collaborative project file.",
    title: "Use whiteboards",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PROJECT_LIST_BODY.trim(),
    category: "Projects",
    id: "projects.project-list",
    image: docsIcon(
      "/public/docs/create-project-5b221552.webp",
      "A projects page with recent work and a create-project control",
    ),
    lastReviewed: "2026-05-25",
    slug: "projects/project-list",
    status: "ready",
    summary:
      "Find, open, create, and organize the CoCalc projects you can access.",
    title: "Use the projects page",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TASKS_BODY.trim(),
    category: "Projects",
    id: "projects.tasks",
    image: docsIcon(
      "/public/docs/tasks-07a6952f.webp",
      "A project task list with checked items, tags, and progress",
    ),
    lastReviewed: "2026-05-25",
    slug: "projects/tasks",
    status: "ready",
    summary:
      "Use task files for shared checklists, project plans, and durable TODO lists.",
    title: "Use task files",
  },
  {
    actions: [
      {
        description: "Create a Jupyter notebook in the active project.",
        executable: true,
        id: "project.jupyter.create",
        label: "Create notebook",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CREATE_JUPYTER_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.create-notebook",
    image: docsIcon(
      "/public/docs/create-jupyter-ddc9795c.webp",
      "A new Jupyter notebook with code cells and a kernel gear",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/create-notebook",
    status: "ready",
    summary:
      "Create notebooks that keep running and capturing output after browser disconnects.",
    title: "Create a Jupyter notebook",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: USE_JUPYTER_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.use-jupyter",
    image: docsIcon(
      "/public/docs/use-jupyter-bcc9b49c.webp",
      "A collaborative Jupyter notebook with output and a running kernel",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/use-jupyter",
    status: "ready",
    summary:
      "Use collaborative durable Jupyter notebooks inside CoCalc projects.",
    title: "Use Jupyter notebooks",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: JUPYTER_KERNEL_TERMINATED_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.jupyter-kernel-terminated",
    image: docsIcon(
      "/public/docs/memory-troubleshooting-7f40cd1d.webp",
      "A memory gauge warning about a stressed notebook kernel",
    ),
    lastReviewed: "2026-05-25",
    slug: "troubleshooting/jupyter-kernel-terminated",
    status: "ready",
    summary:
      "Recover from Jupyter kernels that crash, restart, or fail to start.",
    title: "Jupyter kernel terminated",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CUSTOM_JUPYTER_KERNELS_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.custom-kernels",
    image: docsIcon(
      "/public/docs/custom-jupyter-kernels-58a40bde.webp",
      "A custom Jupyter kernel connected to an isolated Python environment",
    ),
    lastReviewed: "2026-05-24",
    slug: "jupyter/custom-kernels",
    status: "ready",
    summary:
      "Create a custom Jupyter kernel backed by a uv-managed Python virtual environment.",
    title: "Custom Jupyter kernels with uv",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: PYTHON_BODY.trim(),
    category: "Python",
    id: "python.use-python",
    image: docsIcon(
      "/public/docs/python-93480a33.webp",
      "Python work across notebooks, scripts, terminals, and plots",
    ),
    lastReviewed: "2026-05-24",
    slug: "python/use-python",
    status: "ready",
    summary:
      "Use real Python through notebooks, scripts, terminals, virtual environments, and papers.",
    title: "Use Python in CoCalc",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: LATEX_BODY.trim(),
    category: "LaTeX",
    id: "latex.build-papers",
    image: docsIcon(
      "/public/docs/latex-15ab38f8.webp",
      "A LaTeX paper with formulas, references, and a compiled PDF",
    ),
    lastReviewed: "2026-05-25",
    slug: "latex/build-papers",
    status: "ready",
    summary:
      "Write and build LaTeX papers, assignments, reports, figures, and bibliographies.",
    title: "Build LaTeX documents",
  },
  {
    audiences: ["instructors", "researchers", "students"],
    body: R_MARKDOWN_BODY.trim(),
    category: "R",
    id: "editors.r-markdown",
    image: docsIcon(
      "/public/docs/python-93480a33.webp",
      "A reproducible report combining prose, code chunks, plots, and output",
    ),
    lastReviewed: "2026-05-25",
    slug: "editors/r-markdown",
    status: "ready",
    summary:
      "Write reproducible R reports with Markdown prose, R chunks, plots, and rendered output.",
    title: "Use R Markdown",
  },
  {
    actions: [
      {
        description: "Open project Settings -> Environment -> Runtime Image.",
        executable: true,
        id: "settings.runtime.rootfs",
        label: "Open runtime image",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: ROOTFS_BODY.trim(),
    category: "Projects",
    id: "projects.runtime-image",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "A layered runtime image that defines a project's software stack",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/runtime-image",
    status: "ready",
    summary:
      "Choose, customize, and reuse the Linux software stack for a project.",
    title: "Runtime images and RootFS",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: MEMORY_TROUBLESHOOTING_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.memory",
    image: docsIcon(
      "/public/docs/memory-troubleshooting-7f40cd1d.webp",
      "A memory gauge warning about a stressed notebook kernel",
    ),
    lastReviewed: "2026-05-24",
    slug: "troubleshooting/memory",
    status: "ready",
    summary:
      "Diagnose low-memory warnings, out-of-memory kills, and notebook kernel restarts.",
    title: "Low memory and out-of-memory crashes",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CONNECTIVITY_TROUBLESHOOTING_BODY.trim(),
    category: "Troubleshooting",
    id: "troubleshooting.connectivity",
    image: docsIcon(
      "/public/docs/connectivity-eaca154f.webp",
      "A browser reconnecting to CoCalc services",
    ),
    lastReviewed: "2026-05-25",
    slug: "troubleshooting/connectivity",
    status: "ready",
    summary:
      "Diagnose sign-in, websocket, stale browser state, and network connection problems.",
    title: "Connectivity and browser troubleshooting",
  },
  {
    actions: [
      {
        description: "Open the top-level Project Hosts page.",
        executable: true,
        id: "hosts.open",
        label: "Open project hosts",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOSTS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.project-hosts",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "A project host running several project folders",
    ),
    lastReviewed: "2026-05-24",
    slug: "hosts/project-hosts",
    status: "ready",
    summary:
      "Run projects on dedicated or cloud-backed compute for courses, research, and agent sandboxes.",
    title: "Use project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Access tab.",
        executable: true,
        id: "hosts.access.open",
        label: "Open host access",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_ACCESS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.access-and-ram",
    image: docsIcon(
      "/public/docs/project-hosts-access-ram-9245deeb.webp",
      "A project host access panel with delegated users and resource limits",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/access-and-ram",
    status: "ready",
    summary:
      "Delegate host access, understand shared-pool tiers, and set per-project RAM policy.",
    title: "Manage project host access and RAM",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Projects tab.",
        executable: true,
        id: "hosts.move.open",
        label: "Open host projects",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_MOVE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.move-projects",
    image: docsIcon(
      "/public/docs/project-hosts-move-47c2a6e8.webp",
      "A project folder moving between two project hosts across regions",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/move-projects",
    status: "ready",
    summary:
      "Move projects between hosts while accounting for backups, snapshots, region changes, and SSH.",
    title: "Move projects between hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.lifecycle.open",
        label: "Open host lifecycle",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_LIFECYCLE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.lifecycle",
    image: docsIcon(
      "/public/docs/project-hosts-lifecycle-6d603bd0.webp",
      "A project host with start stop restart deprovision and delete controls",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/lifecycle",
    status: "ready",
    summary:
      "Understand start, stop, restart, drain, deprovision, and delete actions for project hosts.",
    title: "Project host lifecycle actions",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.spot-recovery.open",
        label: "Open host details",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SPOT_RECOVERY_BODY.trim(),
    category: "Project hosts",
    id: "hosts.spot-recovery",
    image: docsIcon(
      "/public/docs/project-hosts-spot-recovery-75af618c.webp",
      "A spot host recovering through retries and standard fallback",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/spot-recovery",
    status: "ready",
    summary:
      "Explain spot retry windows, standard fallback, probes, and returning from fallback to spot.",
    title: "Spot recovery strategy for project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer.",
        executable: true,
        id: "hosts.change-rules.open",
        label: "Open host details",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_CHANGE_RULES_BODY.trim(),
    category: "Project hosts",
    id: "hosts.change-rules",
    image: docsIcon(
      "/public/docs/project-hosts-change-rules-40b02147.webp",
      "Project host settings grouped by online change restart and deprovision",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/change-rules",
    status: "ready",
    summary:
      "Know which host edits are online, which require restart, and which require deprovision.",
    title: "What can change on a project host and when",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Reliability tab.",
        executable: true,
        id: "hosts.reliability.open",
        label: "Open reliability",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_RELIABILITY_BODY.trim(),
    category: "Project hosts",
    id: "hosts.reliability",
    image: docsIcon(
      "/public/docs/project-hosts-reliability-e1f428a6.webp",
      "A project host with a reliability gauge and recent availability bars",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/reliability",
    status: "ready",
    summary:
      "Read host reliability, availability, outage exposure, planned downtime, and day-grid signals.",
    title: "Understand project host reliability",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Runtime tab.",
        executable: true,
        id: "hosts.runtime.open",
        label: "Open runtime",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SOFTWARE_LIFECYCLE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.software-lifecycle",
    image: docsIcon(
      "/public/docs/project-hosts-software-lifecycle-29c58052.webp",
      "A project host with software packages daemon health and reconcile arrows",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/software-lifecycle",
    status: "ready",
    summary:
      "Understand runtime software, managed daemons, reconcile, upgrades, drift, and rollbacks.",
    title: "Project host software and daemon lifecycle",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Storage tab.",
        executable: true,
        id: "hosts.storage.open",
        label: "Open storage",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_STORAGE_BODY.trim(),
    category: "Project hosts",
    id: "hosts.storage",
    image: docsIcon(
      "/public/docs/project-hosts-storage-cad76e1f.webp",
      "A project host with disks backups snapshots and protected project folders",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/storage",
    status: "ready",
    summary:
      "Understand host disk capacity, storage mode, backups, snapshots, and online disk growth.",
    title: "Project host storage, backups, and snapshots",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Storage tab.",
        executable: true,
        id: "hosts.scratch.open",
        label: "Open scratch settings",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_SHARED_SCRATCH_BODY.trim(),
    category: "Project hosts",
    id: "hosts.shared-scratch",
    image: docsIcon(
      "/public/docs/project-hosts-shared-scratch-8409afa7.webp",
      "A host-scoped scratch disk shared by several project folders",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/shared-scratch",
    status: "ready",
    summary:
      "Use host-scoped /scratch storage without confusing it with project storage, backups, or moves.",
    title: "Shared scratch disks on project hosts",
  },
  {
    actions: [
      {
        description: "Open a project host drawer on the Logs tab.",
        executable: true,
        id: "hosts.logs.open",
        label: "Open logs",
        parameters: projectHostActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOST_LOGS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.logs",
    image: docsIcon(
      "/public/docs/project-hosts-logs-df53d17e.webp",
      "A project host with logs diagnostics warnings and a magnifying glass",
    ),
    lastReviewed: "2026-05-27",
    slug: "hosts/logs",
    status: "ready",
    summary:
      "Use host logs with runtime and reliability state to debug provisioning, daemon, and provider issues.",
    title: "Debug project hosts with logs",
  },
  {
    actions: [
      {
        description: "Open project Settings -> People.",
        executable: true,
        id: "settings.people.collaborators",
        label: "Manage collaborators",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["instructors", "researchers", "students", "teams"],
    body: COLLABORATORS_BODY.trim(),
    category: "Projects",
    id: "projects.collaborators",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "Collaborators sharing a project folder with realtime cursors",
    ),
    lastReviewed: "2026-05-24",
    slug: "projects/collaborators",
    status: "ready",
    summary:
      "Invite people into a shared project with realtime files, notebooks, terminals, and chat.",
    title: "Add project collaborators",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CHAT_BODY.trim(),
    category: "Collaboration",
    id: "collaboration.chat",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A project chat conversation beside shared project files",
    ),
    lastReviewed: "2026-05-25",
    slug: "collaboration/chat",
    status: "ready",
    summary:
      "Discuss project work with collaborators and AI assistants in durable chat files.",
    title: "Use chat",
  },
  {
    audiences: ["instructors", "researchers", "students", "teams"],
    body: MENTIONS_BODY.trim(),
    category: "Collaboration",
    id: "collaboration.mentions",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A collaborator mention notification linked to project context",
    ),
    lastReviewed: "2026-05-25",
    slug: "collaboration/mentions",
    status: "ready",
    summary:
      "Notify collaborators with @mentions and return to the relevant project context.",
    title: "Use mentions",
  },
  {
    actions: [
      {
        description: "Open TimeTravel for the active file.",
        executable: true,
        id: "file.timetravel.open",
        label: "Open TimeTravel",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TIMETRAVEL_BODY.trim(),
    category: "Files",
    id: "files.timetravel",
    image: docsIcon(
      "/public/docs/timetravel-0f06290b.webp",
      "A TimeTravel timeline with Git revisions, snapshots, and restore points",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/timetravel",
    status: "ready",
    summary: "Inspect, compare, and recover the history of files in a project.",
    title: "Use TimeTravel",
  },
  {
    audiences: ["agents", "researchers", "students", "teams"],
    body: GIT_BODY.trim(),
    category: "Files",
    id: "files.git",
    image: docsIcon(
      "/public/docs/git-a53df3e8.webp",
      "Git branch history beside project files",
    ),
    lastReviewed: "2026-05-24",
    slug: "files/git",
    status: "ready",
    summary:
      "Use Git for repository history alongside TimeTravel for file-focused recovery.",
    title: "Use Git",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_WORKFLOW_BODY.trim(),
    category: "Teaching",
    id: "teaching.course-workflow",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-25",
    slug: "teaching/course-workflow",
    status: "ready",
    summary:
      "Run computational courses with student projects, assignments, collection, grading, and feedback.",
    title: "Teach a course",
  },
  {
    actions: [
      {
        description: "Open course assignment creation.",
        executable: false,
        id: "course.assignment.create",
        label: "Create assignment",
      },
    ],
    audiences: ["agents", "instructors"],
    body: COURSE_ASSIGNMENT_BODY.trim(),
    category: "Teaching",
    id: "teaching.create-assignment",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-24",
    slug: "teaching/create-assignment",
    status: "ready",
    summary:
      "Assign, collect, grade, and return computational work in student projects.",
    title: "Create a course assignment",
  },
  {
    audiences: ["agents", "instructors"],
    body: NBGRADER_BODY.trim(),
    category: "Teaching",
    id: "teaching.nbgrader",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-25",
    slug: "teaching/nbgrader",
    status: "ready",
    summary:
      "Use nbgrader for structured Jupyter notebook grading in CoCalc courses.",
    title: "Use nbgrader",
  },
  {
    actions: [
      {
        description: "Open Codex chat in the active project.",
        executable: true,
        id: "project.codex.open",
        label: "Open Codex",
        parameters: projectActionParameters(),
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_CHAT_BODY.trim(),
    category: "AI",
    id: "ai.codex-chat",
    image: docsIcon(
      "/public/docs/codex-chat-3008e11e.webp",
      "Codex chat working with project files, terminals, and notebooks",
    ),
    lastReviewed: "2026-05-24",
    slug: "ai/codex-chat",
    status: "ready",
    summary:
      "Use Codex inside a durable project workspace with files, terminals, and notebooks.",
    title: "Open Codex chat",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: DOCS_BROWSER_BODY.trim(),
    category: "Docs",
    id: "docs.browser",
    image: docsIcon(
      "/public/docs/docs-browser-74a65d58.webp",
      "A searchable docs browser beside a project folder",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/browser",
    status: "ready",
    summary:
      "Search version-matched CoCalc-ai docs from the public site or inside a project.",
    title: "Use the docs browser",
  },
  {
    audiences: ["agents", "teams"],
    body: DOCS_ACTIONS_BODY.trim(),
    category: "Docs",
    id: "docs.executable-actions",
    image: docsIcon(
      "/public/docs/executable-docs-actions-195b983b.webp",
      "Docs actions launching settings, terminal, and notebook panels",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/executable-actions",
    status: "ready",
    summary:
      "Use stable docs action ids to open the right UI from docs or Codex.",
    title: "Use executable docs actions",
  },
  {
    audiences: ["agents", "teams"],
    body: BROWSER_AUTOMATION_BODY.trim(),
    category: "Docs",
    id: "docs.browser-automation",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Browser automation inspecting a project page with a checklist",
    ),
    lastReviewed: "2026-05-24",
    slug: "documentation/browser-automation",
    status: "ready",
    summary:
      "Use scoped browser-session automation to inspect UI and verify docs.",
    title: "Use browser-session automation",
  },
];

const DOCS_ACTION_IDS = new Set<DocsActionId>(
  DOCS_ENTRIES.flatMap(
    (entry) => entry.actions?.map((action) => action.id) ?? [],
  ),
);

export function docsPath(slug?: string): string {
  return slug ? `/docs/${slug.replace(/^\/+/, "")}` : "/docs";
}

export function docsEntryVisibility(entry: DocsEntry): DocsVisibility {
  return entry.visibility ?? "public";
}

export function isDocsEntryVisible(
  entry: DocsEntry,
  access: DocsAccess = {},
): boolean {
  switch (docsEntryVisibility(entry)) {
    case "admin":
      return access.includeAdmin === true;
    case "signed-in":
      return access.includeSignedIn === true || access.includeAdmin === true;
    case "public":
    default:
      return true;
  }
}

export function listDocsEntries(access: DocsAccess = {}): DocsEntry[] {
  return DOCS_ENTRIES.filter((entry) => isDocsEntryVisible(entry, access));
}

export function getDocsEntry(
  slugOrId: string,
  access: DocsAccess = {},
): DocsEntry | undefined {
  const normalized = slugOrId
    .replace(/^\/+/, "")
    .replace(/^docs\//, "")
    .replace(/\/+$/, "");
  return listDocsEntries(access).find(
    (entry) => entry.id === slugOrId || entry.slug === normalized,
  );
}

export function isDocsActionId(value: unknown): value is DocsActionId {
  return DOCS_ACTION_IDS.has(value as DocsActionId);
}

export function getDocsAction(
  actionId: string,
  access: DocsAccess = {},
): DocsAction | undefined {
  for (const entry of listDocsEntries(access)) {
    const action = entry.actions?.find(
      (candidate) => candidate.id === actionId,
    );
    if (action) return action;
  }
  return undefined;
}

export function listDocsActions(access: DocsAccess = {}): DocsActionSummary[] {
  return listDocsEntries(access).flatMap((entry) =>
    (entry.actions ?? []).map((action) => ({
      ...action,
      entryId: entry.id,
      entrySlug: entry.slug,
      entryTitle: entry.title,
    })),
  );
}

export function searchDocsEntries(
  query: string,
  limit = 8,
  access: DocsAccess = {},
): DocsSearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = listDocsEntries(access);

  if (terms.length === 0) {
    return entries.slice(0, limit).map((entry) => ({
      ...entry,
      score: 0,
    }));
  }

  const fieldScore = (
    value: string | undefined,
    weight: number,
    phraseWeight = 0,
  ): number => {
    if (!value) return 0;
    const haystack = value.toLowerCase();
    const termScore = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? weight : 0),
      0,
    );
    return (
      termScore + (phraseWeight && haystack.includes(query) ? phraseWeight : 0)
    );
  };

  return entries
    .map((entry) => {
      const actionsText = entry.actions
        ?.map((action) => `${action.id} ${action.label} ${action.description}`)
        .join(" ");
      const score =
        fieldScore(entry.title, 8, 8) +
        fieldScore(entry.summary, 4, 4) +
        fieldScore(actionsText, 3) +
        fieldScore(entry.category, 2) +
        fieldScore(entry.audiences.join(" "), 1) +
        fieldScore(entry.body, 1);
      return { ...entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
