# Notebooks

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

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
