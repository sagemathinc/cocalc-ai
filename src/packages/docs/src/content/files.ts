/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const TIMETRAVEL_BODY = String.raw`
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

export const PROJECT_FILES_BODY = String.raw`
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

export const MARKDOWN_BODY = String.raw`
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

export const LATEX_BODY = String.raw`
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

## Edit a formula with Agent

In the LaTeX editor's **Rich Text** mode, rendered formulas have an agent
editing shortcut. Use it to request a change to one formula while keeping the
surrounding document in view.

1. Switch the editor to **Rich Text** and find the rendered formula.
2. Hold **Shift** and click the formula, or focus it and press **Shift+Enter**.
3. In **Edit formula with Agent**, check the formula preview and describe the
   change. For example: "Replace the finite sum with an integral, keeping the
   same variable names."
4. Choose **Edit with Agent** to send the request to the agent chat.
5. Review the changed source and rebuild the document to check its PDF output.

The request includes the formula's current source and location. If the formula
belongs to an included file, that file is identified as the edit target. The
agent is instructed to edit the live document, preserve the existing formula
delimiters and style, and verify its work. The shortcut requires an editable
formula; read-only source does not open the edit request.

## Troubleshooting

If the PDF does not build, start with the first meaningful LaTeX error rather
than later follow-up errors. Clean auxiliary files when stale build state is
suspect. For large documents, isolate failing sections in a small test file
before changing the full paper.

## Ask Agent about a LaTeX build error

When **Recent agent sessions** is shown, select the conversation that should
receive the request. The confirmation button submits it to that conversation;
follow the response there and review any changes.

An error entry with a source line can offer **Fix with Agent...** and
**Ask Agent for a Hint...**, depending on the AI access allowed in the project.

1. Build the document and find the first useful error in the errors panel.
2. Choose **Fix with Agent...** to request a repair, or **Ask Agent for a
   Hint...** to request debugging guidance.
3. Review the displayed error context and choose the recent agent session
   when the selector is shown.
4. Confirm with **Send to Agent** for a repair, or **Ask Agent** for a hint.
5. Follow the response in the agent chat. Review any edits and rebuild the PDF
   to check the result.

The repair request identifies the document, the reported error file and line,
the error message, and the configured build command. This helps the agent
locate an error in an included file and reproduce the build. It is instructed
to use the live document when available. Warnings and errors without a source
line do not receive this particular error-row shortcut.
`;

export const R_MARKDOWN_BODY = String.raw`
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

## Ask Agent to repair a render failure

A failed R Markdown render can offer **Fix with Agent...** below the error
output when AI help is available. Use that control to carry the render failure
into an agent conversation.

1. Render the document and inspect the error output in the build log.
2. Choose **Fix with Agent...**. If you want debugging guidance first and the
   option is available, choose **Ask Agent for a Hint...**.
3. Review the error context in the confirmation and select a recent agent
   session when shown.
4. Confirm with **Send to Agent** or **Ask Agent**, then follow the request in
   the agent chat.
5. Inspect any changed source and render the document again to check the result.

The request includes the render error and build command. When the log identifies
a source-line range, that range is also supplied. The agent is directed to read
the live document before editing. Ordinary informational output from a
successful render does not trigger this failed-build shortcut.

## Reproducibility

Keep package setup, data paths, and rendering commands explicit. For classes or
shared research projects, prefer a runtime image or setup script so the R
environment is reproducible across projects.
`;

export const TASKS_BODY = String.raw`
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

export const SLIDES_BODY = String.raw`
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

export const WHITEBOARD_BODY = String.raw`
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

export const FILE_EXPLORER_BODY = String.raw`
## What the file explorer is for

The file explorer is the project file browser. Use it to create, open, upload,
rename, move, delete, and organize the files that make up a CoCalc project.

## Work efficiently

Use folders for related work, descriptive filenames for humans and agents, and
the search and new-file controls when a project grows. The explorer is also a
good starting point for creating terminals, notebooks, scripts, LaTeX files,
slides, whiteboards, and task files.

## Find a retained file when its path is unknown

On CoCalc AI, use snapshot or backup search when you remember a name or text
but cannot find the file in the current folders. These searches require the
corresponding snapshot or backup service and retained data for your project.

1. In a project you can edit, open **Find** (the magnifying-glass icon) in the
   activity bar. In **Find in**, choose **Home** to start from the project's HOME
   paths before selecting an archive tab.
2. Choose **Snapshots**, then **Files** to search filenames or
   **Contents** to search text. To search backup filenames, choose **Backups**.
   Backup **Contents** search is disabled. Use **Choose** to narrow the search
   to an ordinary project folder under HOME. Snapshot and backup searches only
   cover HOME.
3. Before entering your query, set **Subdirectories** to include nested folders,
   **Hidden** to include dotfiles and hidden directories, and **Case sensitive**
   when capitalization matters. For snapshot **Contents**, leave **Regexp** off
   for literal text; turn off **Git ignore** to include ignored files.
4. Enter a filename fragment such as \`measurements\`, or a filename glob such as
   \`*.csv\`, then choose **Search**. For snapshot **Contents**, enter a distinctive
   text fragment instead. Check each result's path and retained version.

**Filter results** narrows the displayed matches; use the main search field to
change the filename or contents query. Clear **Filter results** before
interpreting an empty result. Also check the folder, search mode, and options,
and read any error. An empty result
means no match was displayed for that search, not that the file has never been
retained.

Backup search can stop at a result, time, or other limit. Its incomplete-search
warning means more matches may exist. Refine the query, select a smaller folder,
or turn off **Subdirectories** and search likely folders individually. Snapshot
content search also has output limits; a missing warning does not establish an
exhaustive search.

If you already know the file's path, see [TimeTravel](/docs/files/timetravel)
for inspecting its history. Finding a retained match does not restore or replace
the current file.

## Files are shared project state

Files opened from the explorer are visible to collaborators and tools in the
same project. For credentials, use project secrets instead of ordinary project
files.
`;

export const GIT_BODY = String.raw`
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

## Set up and commit from a Codex thread

Open the Codex thread's menu and choose **Git browser**. On phones, open
**Chat tools** using the ellipsis button, then choose **Thread actions**
to open the thread menu. Check the displayed
repository path before using its actions. If the folder is not a repository,
**Initialize Git Repo** creates one. **Ask Agent to Set Up Repo** asks the thread's
agent to initialize it, choose a \`.gitignore\`, stage appropriate source files,
make the first commit, and summarize inclusions and exclusions.

In the commit selector, choose **HEAD** (**Uncommitted changes (git diff HEAD)**)
to open **Commit changes**, then inspect **Uncommitted files**:

1. **Commit** with a message runs \`git commit -a\` directly with that message.
2. **Commit** with an empty message asks the agent to create the commit.
3. **Commit with AI Summary** asks the agent to commit and write the message;
   if you supplied text, the prompt requests that text as the first line.

These actions include all tracked changes, not only the file currently shown.
Untracked files are excluded. Use **Add** beside an untracked file when it should
be included, or **Ignore** when it belongs in \`.gitignore\`; review the resulting
file list before committing. Agent actions need an available Codex thread.

After an agent request, inspect its response and the resulting commit in the
Git browser. Sending the request is not proof that a commit succeeded. Review
commits and use TimeTravel for file-level recovery as described below.

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

export const PYTHON_BODY = String.raw`
## What Python in CoCalc is for

Python runs in the project's computing environment. Hosted CoCalc AI projects
use Linux; local CoCalc Plus uses your computer's operating system and installed
software. You can work with notebooks, scripts, terminals, virtual environments,
and the tools available in that environment.

## Common ways to use Python

1. Create a Jupyter notebook for exploratory work.
2. Edit \`.py\` files for scripts, modules, and packages.
3. Use the available Python interpreter and package manager in a terminal,
   such as \`python3\`, \`uv\`, \`pip\`, or \`conda\`.
4. Use Python from LaTeX workflows such as PythonTeX when the document needs code.
5. Install alternate Python versions or virtual environments when needed.

Keep environment setup commands in a script or README when other people or
agents need to reproduce the project. For an isolated notebook environment, see
[Custom Jupyter kernels with uv](/docs/jupyter/custom-kernels) and check the
recipe's operating-system requirements.

## Why this matters in CoCalc

CoCalc lets Python move naturally from notebook to script to paper in one
durable workspace. The same project can contain experiments, production scripts,
package installs, plots, papers, terminals, and Codex-driven automation.
`;
