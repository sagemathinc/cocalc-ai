---
name: cocalc
description: Use when working with CoCalc-native documents and workflows, including complete project-side builds of `.tex`, `.Rnw`, `.Rtex`, `.Rmd`, and `.qmd` documents; live `.tasks`, `.chat`, `.board`, and `.slides` files; notebook operations; document history; and CoCalc export/import workflows.
---

# CoCalc

Use the CoCalc backend exec API first when it can solve the task. Fall back to export/import when the document type is export-oriented or the work is a bulk local transformation. Use browser exec only for UI/navigation/testing work.

When the user asks to use CoCalc docs, treat the bundled docs as the source of
truth for this CoCalc instance. Query the docs first, read the relevant page,
then answer from that page instead of guessing from source code or memory.

## Decision Order

Prefer these paths in this order:

1. `cocalc docs ...` when the user asks a CoCalc usage question or explicitly asks to use docs
2. `cocalc rootfs recipe ls` / `cocalc rootfs recipe explain ...` / `cocalc rootfs recipe run ... --here` when asked to install software, language stacks, Jupyter kernels, app launchers, IDEs, or project-wide tooling
3. `cocalc project build ...` when compiling or verifying supported LaTeX-based, R Markdown, or Quarto documents
4. `cocalc exec-api` + `cocalc exec`
5. `cocalc project jupyter ...` for notebook cell listing, mutation, execution, and live-run inspection
6. `cocalc export ...` / `cocalc import ...`
7. `cocalc browser exec-api` + `cocalc browser exec`

## Software Installs: Check RootFS Recipes First

When asked to install software, language runtimes, Jupyter kernels, app launchers,
IDEs, or larger toolchains in a CoCalc project, check the built-in RootFS recipes
before hand-writing `apt`, `pip`, `curl`, or similar install commands:

```bash
cocalc rootfs recipe ls
cocalc rootfs recipe explain <recipe-or-module>
```

If a matching recipe exists and the user wants it installed into the current
project, prefer:

```bash
cocalc rootfs recipe run <recipe-or-module> --here
```

This runs recipe commands locally in the current project and writes portable
RootFS publish metadata under `/home/user/.cocalc/rootfs-recipes/`.

Use explicit filesystem recipes or module registries when needed:

```bash
cocalc rootfs recipe run ./recipe.yaml --here
cocalc rootfs recipe run my/module --module-dir ./rootfs-recipes --here
```

Fall back to manual installs only when no recipe fits, the recipe is unsuitable
for the request, or the user explicitly asks for a custom/manual installation. If
a recipe fails, inspect its output and fix the immediate issue before abandoning
it.

This is the key rule:

- Use `cocalc docs search/show/actions` for version-matched product documentation.
- Use backend exec for live collaborative document operations.
- Use `cocalc project build` for complete supported document pipelines, not one compiler stage in isolation.
- Use `cocalc project jupyter` for durable notebook operations that must keep working even if the browser refreshes or disconnects.
- Use export/import for archive, bulk transformation, or document types that do not yet have a live backend API.
- Use browser exec only when the task is inherently about the browser UI or when notebook work needs ephemeral UI context such as the active cell, selection, or viewport.

## Document Builds: Use The Complete Project Pipeline

When creating, editing, or verifying a supported document, inspect the installed
command first and then run the complete project-side build:

```bash
cocalc project build -h
cocalc project build path/to/paper.tex
```

Supported source extensions are:

- `.tex` for LaTeX, including required SageTeX and PythonTeX stages
- `.Rnw` and `.Rtex` for Knitr followed by the complete LaTeX pipeline
- `.Rmd` for R Markdown rendering
- `.qmd` for Quarto rendering

This is the same authoritative pipeline used by CoCalc editors. It runs on the
project, does not require an open browser, waits for completion by default, and
returns a nonzero process status when compilation or verification fails. Do not
substitute `pdflatex`, `latexmk`, `Rscript`, or `quarto` alone when the goal is to
verify the full CoCalc build pipeline.

The command builds saved project files. If a source is open with unsaved
collaborative changes, save it before starting the CLI build. A successful
process status means the complete selected pipeline succeeded; missing tools,
unsupported inputs, compiler failures, cancellation, stale-source rejection,
and timeouts are failures. Inspect human output or use the CLI's JSON mode for
the build ID, stages, diagnostics, artifacts, and final state.

Timeouts have separate meanings:

```bash
# Limit how long this CLI invocation waits. This does not cancel the build.
cocalc --timeout 20m project build path/to/paper.tex

# Set the project-side whole-build deadline. Expiry terminates the active stage.
cocalc project build path/to/paper.tex --build-timeout 15m
```

Use `--detach` when submission without waiting is intentional. Keep the returned
build ID so status can be inspected later. Treat `cocalc project build -h` and
the project service capability response as authoritative if available options
or supported formats differ from this bundled guidance.

## CoCalc Docs First

Use the docs CLI exactly as exposed by `cocalc docs --help`. Do not invent nested
commands such as `cocalc docs project secrets`.

Recommended lookup flow:

```bash
cocalc docs search "project secrets" --json
cocalc docs show projects/project-secrets --json
```

If the docs entry includes an action id, inspect it when relevant:

```bash
cocalc docs action settings.environment.secrets --json
cocalc docs actions --json
```

For UI tasks in the live browser session, prefer stable docs actions over raw
browser scripts:

```bash
cocalc browser action docs-list
cocalc browser action docs settings.environment.secrets
```

Use docs actions when the user asks you to open the UI, when opening the UI
would materially help, or when verifying that the docs still match the product.
If the user only asks for an explanation, summarize the docs and mention the
action id rather than opening UI without a reason.

When answering from docs:

- Always read `docs show <slug-or-id>` for the selected result before answering.
- Prefer the highest-scoring directly relevant result, not just the first broad match.
- Include the stable action id when the entry has one.
- Do not repeat examples from memory if the shown docs say something different.
- If the docs are stale or contradict the visible product, say that plainly and
  verify with browser actions or source inspection before giving final guidance.

Adding, replacing, deleting, or copying a project secret requests a runtime
refresh without requiring a project restart. A saved change is not proof that
the running mount was updated: inspect the returned `runtime_refresh` status.
A host can cache the change for the next start or report `retry_pending` when
the runtime refresh has not been confirmed. Recheck the runtime refresh before claiming the
new value is active. A program that already cached a credential may still need
its own reload. Never advise a project restart merely to apply a secret update.

Example answer shape for a usage question:

```text
The docs page `projects/project-secrets` says to edit this in Settings ->
Environment -> Secrets. The stable action id is
`settings.environment.secrets`, which can open that panel in the current browser
session.
```

## Backend Exec First

Inspect the current backend API first:

```bash
cocalc exec-api
```

Then run short JavaScript snippets with:

```bash
cocalc exec '...'
```

Return JSON-serializable values only.

Current high-value namespaces:

- `api.tasks`
- `api.timetravel`
- `api.export`
- `api.import`

## Notebooks: Prefer `project jupyter`

For notebook work, prefer the backend/project-host path:

```bash
cocalc project jupyter -h
```

Use this for:

- listing stable notebook cells
- setting or replacing cell input
- inserting and deleting cells
- running code cells
- following live run output

Current commands:

- `cocalc project jupyter cells --path <ipynb>`
- `cocalc project jupyter set --path <ipynb> ...`
- `cocalc project jupyter insert --path <ipynb> ...`
- `cocalc project jupyter delete --path <ipynb> ...`
- `cocalc project jupyter move --path <ipynb> ...`
- `cocalc project jupyter run --path <ipynb> ...`
- `cocalc project jupyter live --path <ipynb> ...`
- `cocalc project jupyter exec-api`
- `cocalc project jupyter exec --path <ipynb> --file <script.js>`
- `cocalc project jupyter exec --path <ipynb> --stdin`

This path survives browser refreshes and disconnects while the project runtime and kernel remain running, and does not require reverse-engineering frontend notebook state. Stopping the runtime or restarting the kernel interrupts its work.

Hard rule for live notebook work:

- Treat the live in-memory notebook as the source of truth.
- Do not read or edit `.ipynb` JSON directly to inspect or mutate a live notebook unless the user explicitly asks for filesystem-level work.
- Use `cocalc project jupyter cells/set/insert/move/delete/run/live/exec` for live notebook inspection and mutation.

Use the direct commands for one-step operations. For multi-step notebook work, prefer `project jupyter exec` so one local JavaScript script can reuse the same bound notebook API instead of shelling several separate commands. Use `--stdin` for one-off shell snippets or heredocs and `--file` for saved scripts.

Example:

```bash
cocalc project jupyter exec-api
cocalc project jupyter exec --path scratch/demo.ipynb --file ./tool.js
cocalc project jupyter exec --path scratch/demo.ipynb --stdin <<'EOF'
let inserted = await api.notebook.insertCell({
  atEnd: true,
  input: "2 + 3",
  cellType: "code",
});
let run = await api.notebook.run({ cellIds: [inserted.cell.id] });
await run.close();
return { inserted: inserted.cell.id, run_id: run.run_id };
EOF
```

Where `tool.js` looks like:

```js
let inserted = await api.notebook.insertCell({
  atEnd: true,
  input: "2 + 3",
  cellType: "code",
});
let run = await api.notebook.run({ cellIds: [inserted.cell.id] });
await run.close();
return { inserted: inserted.cell.id, run_id: run.run_id };
```

Use `cocalc project jupyter exec-api` to inspect the current ambient notebook API declaration before writing a multi-step script. Important naming detail: `api.notebook.run(...)` returns `run.run_id`, while `api.notebook.live(...)` accepts `runId`.

Use `cocalc browser exec` for notebook work only when you need transient UI context such as:

- which notebook tab is currently active
- which cell is selected
- cursor/scroll/viewport state

## Codex Activity Logs

For persisted Codex activity/thinking logs in a `.chat` thread, use the backend
chat command instead of scraping the UI:

- `cocalc project chat activity --path <chat-path> --thread-id <id>`
- `cocalc project chat activity --path <chat-path> --thread-id <id> --message-id <assistant-message-id>`

This reads the ACP activity log directly from the Conat AKV store and returns
the store/key plus persisted events for the selected turn. If `--message-id` is
omitted, it uses the latest persisted activity log in the thread.

### Tasks

Use `api.tasks` for normal live task operations. This goes through the collaborative sync/session path, not direct filesystem edits.

Example:

```bash
cocalc --json exec '
  const doc = api.tasks.open({ path: "scratch/project/a.tasks" });
  const snapshot = await doc.getSnapshot();
  return snapshot.tasks;
'
```

Typical operations:

- `doc.getSnapshot(...)`
- `doc.getTask(taskId)`
- `doc.setDone(taskId, true)`
- `doc.appendToDescription(taskId, "...")`
- `doc.updateTask(taskId, { ... })`
- `doc.createTask({ ... })`

Prefer this over export/import when the change is targeted and the document type already has a live API.

### TimeTravel

Use `api.timetravel` for retrospective queries over live document history.

Example:

```bash
cocalc --json exec '
  const tt = api.timetravel.open({ path: "scratch/project/a.md" });
  let history = await tt.listVersions();
  for (const version of [...history.versions].sort((a, b) => b.index - a.index)) {
    const snapshot = await tt.readVersion(version.id);
    if ((snapshot.text ?? "").includes("secret")) {
      return { version, text: snapshot.text };
    }
  }
  return { found: false, loaded: history.versions.length, hasFullHistory: history.hasFullHistory };
'
```

Do not load the full history by default. Start with the versions already available, search those, and only call `loadMoreHistory()` if the user actually needs deeper history or the first pass does not find what they asked for.

### Export And Import From Backend Exec

Use `api.export` and `api.import` when a script needs archive generation or structured bundle workflows.

Example round trip:

```bash
cocalc --json exec '
  const exported = await api.export.tasks({ path: "scratch/project/a.tasks" });
  const imported = await api.import.tasks({ sourcePath: exported.outputPath, dryRun: true });
  return { exported, imported };
'
```

Important:

- `api.export.*` is local-file/archive oriented.
- `api.import.tasks` merges a tasks bundle back into a `.tasks` file.
- Use this for bulk transformations, audit trails, or workflows that are more natural on exported data than on a live session.

## Export / Import Workflows

Check support first:

```bash
cocalc export --help
cocalc import --help
```

Current support:

- Export:
  - `cocalc export chat <path>`
  - `cocalc export tasks <path>`
  - `cocalc export board <path>`
  - `cocalc export slides <path>`
- Import:
  - `cocalc import chat <bundle-or-dir>`
  - `cocalc import tasks <bundle-or-dir>`

Use export/import when:

- the document type does not yet have a live backend API
- the work is a bulk transformation or analysis pass
- a portable archive is needed
- another tool/agent needs a stable local tree of data

### Tasks Export / Import

Use `tasks.jsonl` as the canonical edit surface.

Recommended flow:

```bash
cocalc export tasks /path/to/file.tasks
unzip /path/to/file.tasks.cocalc-export.zip -d /tmp/tasks-export
# edit tasks.jsonl
cocalc import tasks /tmp/tasks-export/<root> --dry-run
cocalc import tasks /tmp/tasks-export/<root>
```

Prefer backend `api.tasks` for small targeted edits. Prefer export/import for bigger restructures.

### Chat Export / Import

Chat bundles can be imported into a `.chat` file. Export reads the source chat
and archived SQLite history locally; import writes the destination `.chat` file
locally. Run in the environment containing those files. `--project-id` supplies
project context for asset uploads and Codex session forking; it does not make a
local destination path remote.

```bash
cocalc export chat ./notes.chat --scope all-threads \
  --include-blobs --out ./notes-export.zip
cocalc import chat ./notes-export.zip --target ./imported.chat \
  --project-id "$COCALC_PROJECT_ID"
```

Use `messages.jsonl` for machine-readable messages and `transcript.md` for the
human-readable view. To export one thread, use `--scope current-thread` with
`--thread-id`. Other scopes are `all-non-archived-threads` and `all-threads`.

Import appends independent threads with fresh thread/message IDs, preserves
existing threads, and rebinds bundled assets to the target server. Repeating an
import creates another independent copy. Chat import has no `--dry-run` option;
choose a separate destination file when checking a bundle.

Add `--include-codex-context` to export resumable context when available. Restoring
it requires a local Codex session store and access to the target project's Codex
app-server; import installs a seed and forks a fresh session. Inspect returned
`warnings` and `codex_context_count` before claiming that context was restored.
A transcript alone is not resumable Codex context.

### Board And Slides Export

Board/slides are export-only right now.

Use these first:

- `document.json`
- `document.jsonl`
- `pages/index.json`
- `pages/<page>/page.json`
- `pages/<page>/content.md`
- `pages/<page>/speaker-notes.md` for slides

This is the preferred path for conversions such as turning slides into another presentation format.

## Browser Exec Is For UI Work

Inspect the browser API with:

```bash
cocalc browser exec-api
```

Use `cocalc browser exec` only when the task is specifically about:

- opening files or navigating UI state
- clicking, typing, scrolling, screenshots
- testing/debugging browser behavior
- browser-only inspection

Do not use browser exec for document operations that already have a backend API.

## Safety Rules

- Prefer `cocalc exec` over direct filesystem edits for live collaborative documents.
- Prefer `api.tasks` over export/import for simple task edits.
- Use `--dry-run` before `cocalc import tasks` unless the change is trivial.
- If import reports conflicts, stop and inspect instead of forcing overwrites.
- Do not promise import support for document types that are currently export-only.
- Do not dump large static type definitions into prompts. Point the agent to `cocalc exec-api` or `cocalc browser exec-api` instead.

## Trigger Examples

Use this skill for requests like:

- "Build this LaTeX paper with the same pipeline CoCalc uses and fix every error."
- "Render this R Markdown or Quarto document without opening a browser."
- "Mark this task done and add a note explaining the fix."
- "Find the version of this document from last week that mentioned elliptic curves."
- "Export this chat so another agent can analyze it."
- "Convert this slides file into another format by exporting it first."
- "Work on this CoCalc document through the backend exec API rather than the browser UI."
