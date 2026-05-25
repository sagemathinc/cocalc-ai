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

export interface DocsEntry {
  actions?: DocsAction[];
  audiences: DocsAudience[];
  body: string;
  category: string;
  id: string;
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
that code needs at runtime but collaborators should not casually paste into a
file.

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

Secrets are exposed as environment variables to project processes that opt into
the project environment. In a terminal, notebook, or script, read the value using
the standard environment-variable mechanism for your language.

~~~python
import os

token = os.environ["MY_API_TOKEN"]
~~~

Use clear uppercase names such as \`OPENAI_API_KEY\`, \`HF_TOKEN\`, or
\`DATABASE_URL\`. Avoid putting secrets in source files, notebook outputs, chat
messages, or command history.

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

const PROJECT_HOSTS_BODY = String.raw`
## What project hosts are for

A project host is compute capacity that can run CoCalc projects. Hosts can be
local, cloud-backed, or dedicated to heavier workloads such as long-running
research computations, courses, or agent sandboxes.

## Create or choose a host

1. Open the project host administration area.
2. Configure a cloud provider or local host.
3. Refresh the provider catalog if needed.
4. Choose a machine type, region, disk size, and lifecycle policy.
5. Start the host and wait for bootstrap to finish.
6. Move or create projects on the host when it is ready.

Use enough disk space for runtime images and project data. Very small disks can
fail during image bootstrap or package installation.

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
    lastReviewed: "2026-05-24",
    slug: "projects/project-secrets",
    status: "ready",
    summary:
      "Store API keys and credentials in the project environment instead of notebooks, scripts, or chat.",
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
    lastReviewed: "2026-05-24",
    slug: "projects/runtime-image",
    status: "ready",
    summary:
      "Choose, customize, and reuse the Linux software stack for a project.",
    title: "Runtime images and RootFS",
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

  return DOCS_ENTRIES.map((entry) => {
    const haystack = [
      entry.title,
      entry.summary,
      entry.category,
      entry.audiences.join(" "),
      entry.actions
        ?.map((action) => `${action.id} ${action.label} ${action.description}`)
        .join(" "),
      entry.body,
    ]
      .join("\n")
      .toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { ...entry, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
