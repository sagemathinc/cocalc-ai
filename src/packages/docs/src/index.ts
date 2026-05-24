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

export const DOCS_ENTRIES: DocsEntry[] = [
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
    actions: [
      {
        description: "Open project Settings -> People.",
        executable: false,
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
        executable: false,
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
        executable: false,
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
