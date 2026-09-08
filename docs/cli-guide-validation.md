# Validating the public CLI guides

The CLI chapter is shared by the public docs browser and the documentation
bundled in the CLI. Its landing page is `cli.use-cocalc-cli`; the foundation
pages are `cli.getting-started`, `cli.authentication-and-targets`,
`cli.command-reference`, and `cli.scripting-and-results`.

## Registry and rendering

After the normal repository dependency setup, build and verify the docs package:

```sh
pnpm -C src/packages/docs run verify
```

When adding a page, add both its entry in
`src/packages/docs/src/entries/automation.ts` and its ID in the ordered
`DOCS_ENTRY_IDS` list in `src/packages/docs/src/entries/index.ts`. An entry
omitted from that list is invisible to the registry and its verifier.

Check that each page is visible by ID and slug, and that realistic queries find
it. From the repository root after building the docs package:

```sh
node <<'JS'
const assert = require("node:assert/strict");
const docs = require("./src/packages/docs/dist");
const access = { siteProfile: "cocalc-ai" };
for (const [query, id] of [
  ["install CLI", "cli.getting-started"],
  ["auth bootstrap", "cli.authentication-and-targets"],
  ["exec-api", "cli.command-reference"],
  ["exit_code", "cli.scripting-and-results"],
  ["api.text", "cli.collaborative-text"],
  ["notebook detach", "cli.notebook-workflows"],
  ["browser target-resolve", "cli.browser-workflows"],
  ["automation upsert", "cli.scheduled-agents"],
  ["workspace notices", "cli.workspaces-and-notices"],
  ["build-timeout", "cli.builds-and-versions"],
]) {
  const entry = docs.getDocsEntry(id, access);
  assert(entry, id);
  assert.equal(docs.getDocsEntry(entry.slug, access)?.id, id);
  assert(docs.searchDocsEntries(query, 3, access).some((e) => e.id === id));
}
console.log("PASS: CLI guide registration and discovery");
JS
```

With the CLI built from the same checkout, verify `docs list --category CLI`,
`docs show cli/getting-started --json`, and the discovery queries above. A
pre-existing installed CLI has its own bundled docs and cannot validate a new
source change. Check the changed pages in the running docs browser, including
navigation, code fences, copied commands, and narrow-window readability.
A standalone Markdown preview checks content formatting; it does not test the
full CoCalc renderer or prove remote commands work.

## Executable examples

Do not treat a documentation build as a test of installation, authentication,
or remote execution. Keep these distinct acceptance checks:

1. On a disposable machine or appropriate platform test environment, install
   the released CLI, check PATH, and run the unauthenticated docs commands.
   Record platform, release/channel, and version. Test Windows in PowerShell.
2. On a personal computer, complete browser-approved login, check the selected
   account/profile and nested `data.check.ok`, and list a designated test
   project's files. Avoid personal account login inside shared projects.
3. Run the scripting guide's Bash example with `jq`. Confirm successful stdout
   is preserved and a remote nonzero exit is rejected. Locally replace
   `cocalc` with a shell function returning synthetic fixtures to test malformed
   JSON, empty output, missing fields, multiple envelopes, and CLI failures
   without creating remote work.
4. In an authorized test project, retain operation IDs and exercise successful
   and failed terminal results, a wait timeout followed by `op get`, and
   deliberate cancellation. Test asynchronous execution separately through its
   `job_id`; it is not an operation ID.

Record what actually ran, its command/output, and what remains untested. Do not
run a mutation on a live account merely to check documentation formatting.

## Source ownership for future revisions

Recheck the implementation when changing these claims:

| Guide claim                                   | Implementation                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Installation, platform and channel defaults   | `src/packages/cli/install.sh`, `install.ps1`                                            |
| Login, status checks, elevation and bootstrap | `src/packages/cli/src/bin/commands/auth.ts`                                             |
| Profile and origin inheritance                | `src/packages/cli/src/core/auth-config.ts`                                              |
| Project selection and execution               | `src/packages/cli/src/bin/commands/project/basic.ts`, `src/bin/core/project-resolve.ts` |
| JSON envelopes and stdout/stderr              | `src/packages/cli/src/bin/core/cli-output.ts`                                           |
| Operation completion versus success           | `src/packages/cli/src/bin/commands/op.ts`, `src/bin/core/lro.ts`                        |
| Asynchronous execution retention              | `src/packages/backend/execute-code.ts`                                                  |
| Local evaluation and typed backend APIs       | `src/packages/cli/src/bin/commands/exec.ts`                                             |
| Browser target resolution and script API      | `src/packages/cli/src/bin/commands/browser.ts`                                          |
| Codex streaming output exceptions             | `src/packages/cli/src/bin/commands/project/codex.ts`                                    |

## Workflow acceptance matrix

The workflow guides add six public CLI entries. Validate the documented recipes
against both command parsing and result semantics; verify live behavior only in
an appropriate test project.

| Guide               | Local source/fixture checks                                                                                                                   | Live acceptance                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Collaborative text  | One match succeeds; zero/multiple matches and stale version/hash reject; disk-save failure can follow a live edit.                            | Edit a scratch document open in another browser; read back, verify disk state, and exercise a concurrent change.       |
| Notebooks           | Run rejects cell errors unless allowed; live reports its error count; detach requests acknowledgment without following; client handles close. | Insert one cell, run, inspect output, save, and follow the retained run after a disconnect.                            |
| Browser workflows   | Target errors and assertion failures remain nested; posture and exact target reach the handler.                                               | Discover the intended session, inspect the declaration, verify a stable UI action and an intentional failed assertion. |
| Scheduled agents    | Required title, disabled draft, default enabling, daily/all-days normalization, and unacknowledged-run limit.                                 | Inspect the disabled draft, activate deliberately, review one result, pause, and confirm no duplicate scheduling.      |
| Workspaces          | A message returns its durable ID; opening can fail after the persistence step.                                                                | Create a scratch record, send one notice, open it, verify no agent turn starts, and remove the record.                 |
| Builds and versions | Completion exit codes and wait timeout without cancellation.                                                                                  | Build a saved supported document and inspect artifacts; distinguish local wait from project deadline.                  |

Keep service boundaries explicit in fixture tests. A stubbed kernel or browser
proves the CLI handler's contract, not the remote service's behavior. Source
review is also required for statements such as workspace message non-dispatch,
managed skill overrides, and automation session isolation.

Workflow source entry points are `cli/src/api/text.ts`,
`cli/src/bin/commands/project/jupyter.ts`, `cli/src/bin/core/project-jupyter.ts`,
`cli/src/bin/commands/project/chat.ts`, `lite/hub/acp/automation-schedule.ts`,
`lite/hub/acp/automation-request-config.ts`, `cli/src/bin/commands/workspaces.ts`,
`cli/src/bin/core/workspace-chat.ts`, `conat/workspaces.ts`,
`cli/src/bin/commands/project/document-build.ts`, and
`project-host/codex/codex-project.ts`, all relative to `src/packages/`.
