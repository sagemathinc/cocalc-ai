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

export type DocsActionId =
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
}

export interface DocsActionSummary extends DocsAction {
  entryId: string;
  entrySlug: string;
  entryTitle: string;
}

export interface DocsEntryImage {
  alt: string;
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
}

export interface DocsSearchResult extends DocsEntry {
  score: number;
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
3. Close idle notebooks, terminals, servers, and X11 apps.
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

## Create or choose a host

1. Open the project host administration area.
2. Configure a cloud provider. In self-hosted Launchpad or Rocket, configure a
   cloud provider or local host.
3. Refresh the provider catalog if needed.
4. Choose a machine type, region, disk size, and lifecycle policy.
5. Start the host and wait for bootstrap to finish.
6. Move or create projects on the host when it is ready.

Use enough disk space for runtime images and project data. Very small disks can
fail during image bootstrap or package installation.

Under **Access**, add people who are allowed to add their own projects to the
host. You can also configure the host so all projects on it may use more RAM.

## Long-running work

For research jobs, scheduled automation, or agent sandboxes, use a host with
enough CPU, RAM, disk, and restart behavior for the workload. Keep important
state in project files, a database, or another durable location rather than only
inside a process.

## Why this matters in CoCalc

Project hosts make CoCalc more than a shared web editor. They let the workspace
own real compute, run persistent services, use cloud machines economically, and
give agents a stable Linux environment to work in.
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

export const DOCS_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: CREATE_PROJECT_BODY.trim(),
    category: "Projects",
    id: "projects.create-project",
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
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: PROJECT_SECRETS_BODY.trim(),
    category: "Projects",
    id: "projects.project-secrets",
    image: {
      alt: "Project secrets mounted as protected read-only files",
      src: "/public/docs/project-secrets.svg",
      thumbnailSrc: "/public/docs/project-secrets.svg",
    },
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
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: OPEN_TERMINAL_BODY.trim(),
    category: "Projects",
    id: "projects.open-terminal",
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
    lastReviewed: "2026-05-24",
    slug: "files/project-files",
    status: "ready",
    summary:
      "Use the project filesystem as the shared place for notebooks, scripts, datasets, and output.",
    title: "Work with project files",
  },
  {
    actions: [
      {
        description: "Create a Jupyter notebook in the active project.",
        executable: true,
        id: "project.jupyter.create",
        label: "Create notebook",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CREATE_JUPYTER_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.create-notebook",
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
    lastReviewed: "2026-05-24",
    slug: "jupyter/use-jupyter",
    status: "ready",
    summary:
      "Use collaborative durable Jupyter notebooks inside CoCalc projects.",
    title: "Use Jupyter notebooks",
  },
  {
    audiences: ["agents", "instructors", "researchers", "students"],
    body: CUSTOM_JUPYTER_KERNELS_BODY.trim(),
    category: "Jupyter",
    id: "jupyter.custom-kernels",
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
    lastReviewed: "2026-05-24",
    slug: "python/use-python",
    status: "ready",
    summary:
      "Use real Python through notebooks, scripts, terminals, virtual environments, and papers.",
    title: "Use Python in CoCalc",
  },
  {
    actions: [
      {
        description: "Open project Settings -> Environment -> Runtime Image.",
        executable: true,
        id: "settings.runtime.rootfs",
        label: "Open runtime image",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: ROOTFS_BODY.trim(),
    category: "Projects",
    id: "projects.runtime-image",
    image: {
      alt: "A layered runtime image that defines a project's software stack",
      src: "/public/docs/runtime-image.svg",
      thumbnailSrc: "/public/docs/runtime-image.svg",
    },
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
    lastReviewed: "2026-05-25",
    slug: "troubleshooting/connectivity",
    status: "ready",
    summary:
      "Diagnose sign-in, websocket, stale browser state, and network connection problems.",
    title: "Connectivity and browser troubleshooting",
  },
  {
    audiences: ["agents", "instructors", "researchers", "teams"],
    body: PROJECT_HOSTS_BODY.trim(),
    category: "Project hosts",
    id: "hosts.project-hosts",
    lastReviewed: "2026-05-24",
    slug: "hosts/project-hosts",
    status: "ready",
    summary:
      "Run projects on local or cloud-backed compute for courses, research, and agent sandboxes.",
    title: "Use project hosts",
  },
  {
    actions: [
      {
        description: "Open project Settings -> People.",
        executable: true,
        id: "settings.people.collaborators",
        label: "Manage collaborators",
      },
    ],
    audiences: ["instructors", "researchers", "students", "teams"],
    body: COLLABORATORS_BODY.trim(),
    category: "Projects",
    id: "projects.collaborators",
    lastReviewed: "2026-05-24",
    slug: "projects/collaborators",
    status: "ready",
    summary:
      "Invite people into a shared project with realtime files, notebooks, terminals, and chat.",
    title: "Add project collaborators",
  },
  {
    actions: [
      {
        description: "Open TimeTravel for the active file.",
        executable: true,
        id: "file.timetravel.open",
        label: "Open TimeTravel",
      },
    ],
    audiences: ["agents", "instructors", "researchers", "students", "teams"],
    body: TIMETRAVEL_BODY.trim(),
    category: "Files",
    id: "files.timetravel",
    image: {
      alt: "A TimeTravel timeline with Git revisions, snapshots, and restore points",
      src: "/public/docs/timetravel.svg",
      thumbnailSrc: "/public/docs/timetravel.svg",
    },
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
    lastReviewed: "2026-05-24",
    slug: "files/git",
    status: "ready",
    summary:
      "Use Git for repository history alongside TimeTravel for file-focused recovery.",
    title: "Use Git",
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
    lastReviewed: "2026-05-24",
    slug: "teaching/create-assignment",
    status: "ready",
    summary:
      "Assign, collect, grade, and return computational work in student projects.",
    title: "Create a course assignment",
  },
  {
    actions: [
      {
        description: "Open Codex chat in the active project.",
        executable: true,
        id: "project.codex.open",
        label: "Open Codex",
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: CODEX_CHAT_BODY.trim(),
    category: "AI",
    id: "ai.codex-chat",
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

export function listDocsEntries(): DocsEntry[] {
  return [...DOCS_ENTRIES];
}

export function getDocsEntry(slugOrId: string): DocsEntry | undefined {
  const normalized = slugOrId
    .replace(/^\/+/, "")
    .replace(/^docs\//, "")
    .replace(/\/+$/, "");
  return DOCS_ENTRIES.find(
    (entry) => entry.id === slugOrId || entry.slug === normalized,
  );
}

export function isDocsActionId(value: unknown): value is DocsActionId {
  return DOCS_ACTION_IDS.has(value as DocsActionId);
}

export function getDocsAction(actionId: string): DocsAction | undefined {
  for (const entry of DOCS_ENTRIES) {
    const action = entry.actions?.find(
      (candidate) => candidate.id === actionId,
    );
    if (action) return action;
  }
  return undefined;
}

export function listDocsActions(): DocsActionSummary[] {
  return DOCS_ENTRIES.flatMap((entry) =>
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
): DocsSearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) {
    return DOCS_ENTRIES.slice(0, limit).map((entry) => ({
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

  return DOCS_ENTRIES.map((entry) => {
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
