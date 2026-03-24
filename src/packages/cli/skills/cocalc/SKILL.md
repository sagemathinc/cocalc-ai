---
name: cocalc
description: Use when working with CoCalc-native documents and workflows, especially `.tasks`, `.chat`, `.board`, and `.slides` files. Prefer this skill when an agent should operate on live collaborative documents through `cocalc exec`, inspect document history through `api.timetravel`, or use CoCalc export/import for structured local transformations and archives.
---

# CoCalc

Use the CoCalc backend exec API first when it can solve the task. Fall back to export/import when the document type is export-oriented or the work is a bulk local transformation. Use browser exec only for UI/navigation/testing work.

## Decision Order

Prefer these paths in this order:

1. `cocalc exec-api` + `cocalc exec`
2. `cocalc project jupyter ...` for notebook cell listing, mutation, execution, and live-run inspection
3. `cocalc export ...` / `cocalc import ...`
4. `cocalc browser exec-api` + `cocalc browser exec`

This is the key rule:

- Use backend exec for live collaborative document operations.
- Use `cocalc project jupyter` for durable notebook operations that must keep working even if the browser refreshes or disconnects.
- Use export/import for archive, bulk transformation, or document types that do not yet have a live backend API.
- Use browser exec only when the task is inherently about the browser UI or when notebook work needs ephemeral UI context such as the active cell, selection, or viewport.

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

- `cocalc project jupyter --path <ipynb> cells`
- `cocalc project jupyter --path <ipynb> set ...`
- `cocalc project jupyter --path <ipynb> insert ...`
- `cocalc project jupyter --path <ipynb> delete ...`
- `cocalc project jupyter --path <ipynb> move ...`
- `cocalc project jupyter --path <ipynb> run ...`
- `cocalc project jupyter --path <ipynb> live ...`
- `cocalc project jupyter --path <ipynb> exec-api`
- `cocalc project jupyter --path <ipynb> exec --file <script.js>`

This is the preferred path because it survives browser refreshes/disconnects and does not require reverse-engineering frontend notebook state.

Use the direct commands for one-step operations. For multi-step notebook work, prefer `project jupyter exec` so one local JavaScript script can reuse the same bound notebook API instead of shelling several separate commands.

Example:

```bash
cocalc project jupyter --path scratch/demo.ipynb exec-api
cocalc project jupyter --path scratch/demo.ipynb exec --file ./tool.js
```

Where `tool.js` looks like:

```js
let { cells } = await api.notebook.listCells();
let anchor = cells[cells.length - 1];
let inserted = await api.notebook.insertCell({
  afterId: anchor.id,
  input: "2 + 3",
  cellType: "code",
});
let session = await api.notebook.run({ cellIds: [inserted.cell.id] });
let batches = [];
for await (let batch of session.iter) batches.push(batch);
await session.close();
return { inserted: inserted.cell.id, batches: batches.length };
```

Use `cocalc project jupyter exec-api` to inspect the current ambient notebook API declaration before writing a multi-step script.

Use `cocalc browser exec` for notebook work only when you need transient UI context such as:

- which notebook tab is currently active
- which cell is selected
- cursor/scroll/viewport state

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

### Chat Export

Chat is export-only right now.

Use:

- `messages.jsonl` as the canonical machine-readable source
- `transcript.md` as the human-readable view
- `--scope current-thread|all-non-archived-threads|all-threads`
- `--include-blobs` when the archive should be self-contained

Do not plan on importing chats back.

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

- "Mark this task done and add a note explaining the fix."
- "Find the version of this document from last week that mentioned elliptic curves."
- "Export this chat so another agent can analyze it."
- "Convert this slides file into another format by exporting it first."
- "Work on this CoCalc document through the backend exec API rather than the browser UI."
