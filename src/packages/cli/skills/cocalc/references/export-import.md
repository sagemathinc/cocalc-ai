# Export and import

Part of the CoCalc skill (`../SKILL.md`). In examples, `cocalc` stands for the CLI command the runtime gives you.

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
