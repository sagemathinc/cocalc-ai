# Backend exec: tasks, TimeTravel, export, activity logs

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

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

## Agent Activity Logs

For persisted agent activity/thinking logs in a `.chat` thread, use the backend
chat command instead of scraping the UI:

- `cocalc project chat activity --path <chat-path> --thread-id <id>`
- `cocalc project chat activity --path <chat-path> --thread-id <id> --message-id <assistant-message-id>`

This reads the ACP activity log directly from the Conat AKV store and returns
the store/key plus persisted events for the selected turn. If `--message-id` is
omitted, it uses the latest persisted activity log in the thread.
