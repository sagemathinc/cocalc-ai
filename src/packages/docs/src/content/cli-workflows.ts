/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CLI_TEXT_WORKFLOW_BODY = `
## Edit the live document

Use the text API for Markdown and source files that are open collaboratively in
CoCalc. It reads the live document, which can differ from the disk copy. Use the
notebook, task, chat, or other document-specific API for structured documents.

Complete the [quickstart](/docs/cli/getting-started) first. This Bash recipe edits
an existing text file, replacing exactly one occurrence of \`Status: draft\` with
\`Status: reviewed\`. Use a scratch copy to learn the workflow.

## Step 1: Select the project and inspect the API

Replace the project placeholder with the full ID from \`project list\`, and set
\`TEXT_PATH\` to the existing file's path inside that project:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export TEXT_PATH='/home/user/notes.md'

cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc exec-api
~~~

Use the absolute path inside the remote project, adjusting \`/home/user\` if
needed. Relative text paths resolve against the CLI computer's home directory,
not the remote project's home.

Confirm the project before editing. \`exec-api\` describes the API bundled with
your installed CLI. JavaScript passed to \`cocalc exec\` runs in the CLI process;
its \`api.text\` methods access the selected project's collaborative state.

## Step 2: Read, check, and replace one passage

The quoted heredoc keeps your shell from interpreting the JavaScript. The
script reads its selection from the exported variables:

~~~bash
cocalc --profile "$CLI_PROFILE" --json exec --stdin <<'JS'
const projectIdentifier = process.env.PROJECT_ID;
const path = process.env.TEXT_PATH;
if (!projectIdentifier || !path) {
  throw new Error("Set PROJECT_ID and TEXT_PATH first");
}
const doc = api.text.open({ projectIdentifier, path });
if (!doc.getAssociation().supportsTextApi) {
  throw new Error("Use the document-specific API for this file type");
}
const before = await doc.read();
const oldText = "Status: draft";
const newText = "Status: reviewed";
const matches = before.text.split(oldText).length - 1;
if (matches !== 1) {
  throw new Error(\`Expected one matching passage; found \${matches}\`);
}
const changed = await doc.replace(oldText, newText, {
  expectedLatestVersionId: before.latestVersionId,
  expectedHash: before.hash,
  saveToDisk: true,
});
if (changed.replaceCount !== 1) {
  throw new Error("The requested replacement was not confirmed");
}
return {
  project_id: changed.project.project_id,
  path: changed.path,
  replaceCount: changed.replaceCount,
  latestVersionId: changed.latestVersionId,
  hash: changed.hash,
};
JS
~~~

Require successful command completion and \`ok:true\`. Inspect \`data.result\` for
the intended project/path and \`replaceCount:1\`. Script return values from
\`cocalc exec\` are nested under \`data.result\`, not directly under \`data\`.

## Step 3: Read back and review

~~~bash
cocalc --profile "$CLI_PROFILE" --json exec --stdin <<'JS'
const projectIdentifier = process.env.PROJECT_ID;
const path = process.env.TEXT_PATH;
if (!projectIdentifier || !path) {
  throw new Error("Set PROJECT_ID and TEXT_PATH first");
}
return await api.text.open({ projectIdentifier, path }).read();
JS
~~~

Review the returned text or open the file in CoCalc. If the edit command times
out, read back before retrying: the edit may already have reached the document.
The recipe deliberately refuses to replace zero or multiple matching passages.

## Concurrency and saving

\`expectedLatestVersionId\` and \`expectedHash\` compare your read with the session's
current state before the edit. They are optimistic checks, not an exclusive
editing lock. On a mismatch, read the latest document and reconsider the edit;
do not remove the checks just to make the command succeed.

\`write\` replaces the text, \`append\` adds text, and \`replace\` changes a matching
passage. \`replace\` changes the first match unless \`all:true\` is supplied.
Writes save to disk by default. \`saveToDisk:false\` still changes and saves the
live collaborative state; it is not a dry run. A disk-save failure can occur
after the live edit, so review both states before attempting recovery.

The document facade returned by \`api.text.open()\` has no public \`close()\` method.
Its methods manage their session leases. Do not add a guessed \`doc.close()\` call.

For shell-process results and retry decisions, see
[scripting and results](/docs/cli/scripting-and-results). For notebooks, use the
[live notebook workflow](/docs/cli/notebook-workflows).
`;

export const CLI_NOTEBOOK_WORKFLOW_BODY = `
## Work with a live notebook

The project Jupyter commands inspect and edit the live notebook without requiring
an open browser tab. Use them instead of rewriting \`.ipynb\` JSON while CoCalc
is editing the document. This recipe inserts one cell in an existing scratch
notebook, runs it, inspects its output, and saves it.

## Step 1: Select the notebook and confirm its kernel

In Bash, use the profile from the [quickstart](/docs/cli/getting-started), the
full project ID, and an existing scratch notebook with a Python kernel:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export NOTEBOOK_PATH='/home/user/scratch/cli-demo.ipynb'

cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json project jupyter kernel \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH"
cocalc --profile "$CLI_PROFILE" --json project jupyter cells \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH"
~~~

Use the absolute remote notebook path, adjusting \`/home/user\` if needed;
relative notebook paths resolve against the CLI computer's home directory.
Confirm the project, path, kernel, and existing cells. \`cells\` includes each
cell's full input. Use \`project jupyter --help\` to inspect your version's commands.

## Step 2: Insert and run one cell

Run this insertion once:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project jupyter insert \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH" \\
  --at-end --type code --input 'print(2 + 3)'
~~~

Copy \`data.cell.id\` into \`CELL_ID\`, then run that cell:

~~~bash
export CELL_ID='REPLACE_WITH_RETURNED_CELL_ID'

cocalc --profile "$CLI_PROFILE" --json project jupyter run \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH" \\
  --cell-id "$CELL_ID"
~~~

Require successful command completion, \`ok:true\`, and \`data.error_count:0\`.
This command follows execution by default. \`--jsonl\` is a different, streaming
output format; do not parse it as one JSON result.

## Step 3: Inspect output and save

~~~bash
cocalc --profile "$CLI_PROFILE" --json project jupyter outputs \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH" \\
  --cell-id "$CELL_ID"

cocalc --profile "$CLI_PROFILE" --json project jupyter save \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH"
~~~

The selected cell's output should contain \`5\`; saving should report
\`data.saved:true\`. \`outputs --cell-id\` returns that cell's input, output, and
metadata. Inspect this read-back rather than inferring notebook contents from
successful command submission alone.

Prefer cell IDs when retaining selections across commands. Cell indexes are
zero-based and can shift when collaborators insert or move cells. IDs identify
cells but do not lock their contents.

## Follow a long run after disconnecting

For long-running code, replace the \`run\` command in step 2 with a detached
submission; do not execute both unless you intend to run the cell twice:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project jupyter run \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH" \\
  --cell-id "$CELL_ID" --detach
~~~

Retain \`data.run_id\` as \`RUN_ID\`. Detach waits for a backend acknowledgment,
not completion. Follow that exact run:

~~~bash
export RUN_ID='REPLACE_WITH_RETURNED_RUN_ID'

cocalc --profile "$CLI_PROFILE" --json project jupyter live \\
  --project "$PROJECT_ID" --path "$NOTEBOOK_PATH" \\
  --run-id "$RUN_ID" --timeout 20m
~~~

Require the matching \`data.run_id\`, \`data.follow:true\`, successful command
completion, and \`data.error_count:0\`; then inspect outputs and save. The \`live\`
command can return cell errors without setting a failing process exit code.
\`--no-follow\` only retrieves the available snapshot and cannot establish completion.

If following times out or disconnects, inspect the retained run before submitting
another one. Without an explicit ID, selection prefers a currently running run,
then the most recently updated retained run; it may not be the run you started.

\`--allow-errors\` relaxes the following \`run\` command's error-exit rule. It does
not make erroneous output successful or guarantee that later cells execute.
Detached or noninteractive code should not depend on answering kernel input prompts.

For JavaScript notebook scripts, inspect \`project jupyter exec --help\`. Consume
the run's output iterator, check errors, and release its client handle with
\`run.close()\` in \`finally\`. Closing a handle does not interrupt the kernel.
Use \`project jupyter interrupt\` deliberately to interrupt work; it affects the
notebook kernel, not just one local CLI waiter.
`;

export const CLI_BROWSER_WORKFLOW_BODY = `
## Resolve the browser before testing it

Use browser commands for UI inspection, navigation, and testing. Use the project
and document APIs for work that should continue independently of a browser tab.
A valid account login does not by itself select the right browser or authorize
every browser action.

## Step 1: Discover and verify an existing session

Sign in using the [quickstart](/docs/cli/getting-started), open the intended
project in CoCalc, and list browser sessions:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'

cocalc --profile "$CLI_PROFILE" --json browser session list
~~~

Choose the session you intend to test and copy its full browser ID:

~~~bash
export BROWSER_ID='REPLACE_WITH_BROWSER_ID'

cocalc --profile "$CLI_PROFILE" --json browser target-resolve \\
  --project-id "$PROJECT_ID" --browser "$BROWSER_ID" \\
  --active-only --require-discovery
~~~

This resolves the target without performing a browser action. Confirm
\`data.browser_id\` and \`data.resolved.project_id\`, and require no
\`data.resolved.project_error\`. An outer \`ok:true\` can accompany a project
resolution error. The active project reported by the session can differ from
your explicit target; inspect that difference before acting.

For a local source-development server, reload its matching \`dev:hub:env\` or
\`dev:lite:env\` in the current shell before discovery. See
[authentication and targets](/docs/cli/authentication-and-targets).

## Step 2: Read the session's API and inspect the page

~~~bash
cocalc --profile "$CLI_PROFILE" browser exec-api \\
  --browser "$BROWSER_ID" --session-project-id "$PROJECT_ID" --active-only

cocalc --profile "$CLI_PROFILE" --json browser exec \\
  --project-id "$PROJECT_ID" --browser "$BROWSER_ID" --posture prod \\
  'return { projectId: api.projectId, pageUrl: api.pageUrl };'
~~~

For synchronous browser exec, check outer \`ok:true\`, \`data.ok:true\`, the selected
browser/project, and the returned \`data.result\`. This example inspects the page;
it does not demonstrate that a later UI action will be permitted or succeed.

The declaration comes from the running browser session. In constrained QuickJS
mode, \`window\`, \`document\`, and top-level \`await\` are unavailable. The exposed
API calls behave synchronously from the script's point of view. For example,
after inspecting the page and choosing an expected visible string:

~~~bash
cocalc --profile "$CLI_PROFILE" --json browser exec \\
  --project-id "$PROJECT_ID" --browser "$BROWSER_ID" --posture prod \\
  'return api.waitForText({ includes: "REPLACE_WITH_VISIBLE_TEXT", timeout_ms: 5000 });'
~~~

Require \`data.result.ok:true\` for this assertion. A successful exec envelope can
contain an unsuccessful assertion result.

## Step 3: Use a stable action and verify its result

Discover documented UI destinations before inventing selectors:

~~~bash
cocalc docs actions --executable
cocalc docs action settings.environment.secrets
cocalc browser action docs --help
~~~

When opening the project's secrets settings is the intended UI action:

~~~bash
cocalc --profile "$CLI_PROFILE" --json browser action docs \\
  settings.environment.secrets \\
  --project-id "$PROJECT_ID" --browser "$BROWSER_ID"
~~~

Opening settings does not modify a secret. Inspect the returned action result
and then verify the visible destination. Prefer a stable action ID over a
selector tied to incidental page layout.

## Policies and capabilities

Without an explicit posture or \`COCALC_BROWSER_POSTURE\` override, CLI posture
defaults to \`dev\` for loopback targets and \`prod\` otherwise. The
site also enforces its own automation and raw-execution policy. Choosing a
posture or supplying \`--allow-raw-exec\` cannot override a server-side denial.
Read the returned declaration and policy information; do not assume every
session exposes the same API or that a stale browser has received new code.

Local Playwright session spawning is not supported in standalone CLI binaries.
An existing browser session and a source-built CLI have different capabilities.
Check \`browser session --help\` and your installed build before choosing a test
strategy.

## Recover asynchronous browser work

\`browser exec --async\` returns an \`exec_id\`. Keep that ID and the browser ID.
Use these commands to inspect, wait, or deliberately request cancellation:

~~~bash
cocalc --profile "$CLI_PROFILE" --json browser exec-get "$EXEC_ID" \\
  --browser "$BROWSER_ID"
cocalc --profile "$CLI_PROFILE" --json browser exec-wait "$EXEC_ID" \\
  --browser "$BROWSER_ID" --timeout 5m
cocalc --profile "$CLI_PROFILE" --json browser exec-cancel "$EXEC_ID" \\
  --browser "$BROWSER_ID"
~~~

Set \`EXEC_ID\` to the returned ID before running these examples. An \`exec_id\` is
neither a project execution \`job_id\` nor a hub operation \`op_id\`. A wait timeout
does not cancel the execution. Read its current state before resubmitting work.
Even a completed execution still needs the script-specific assertion checks.

\`browser action batch\` runs steps sequentially and can leave earlier actions
applied when a later one fails. Inspect \`failed_steps\` and individual step
results rather than treating a successful outer response as an atomic batch
success. \`--continue-on-error\` changes whether later steps are attempted; it
does not roll back earlier ones.

## Collect evidence for a failed UI test

~~~bash
cocalc --profile "$CLI_PROFILE" --json browser logs tail \\
  --browser "$BROWSER_ID" --lines 50
cocalc --profile "$CLI_PROFILE" --json browser logs uncaught \\
  --browser "$BROWSER_ID" --no-follow --lines 50
cocalc browser network summary --help
cocalc browser network trace --help
~~~

Record the target, relevant logs, expected UI state, and observed state. Network
capture may need to be enabled before reproducing an issue; an empty buffer
does not establish that no requests failed. Limit and review captured data
before sharing it. Clear or stop capture deliberately when finished.
`;

export const CLI_SCHEDULED_AGENTS_BODY = `
## Give a scheduled task its own thread

You need project access, working Codex authentication in that project, and a CLI
version with \`project chat automation\`. Scheduled agent runs perform real work
and use the configured model. This recipe creates a disabled draft first.

In Bash, set the profile, full project ID, chat path, a supported model, and an
existing working directory inside the project:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export CHAT_PATH='/home/user/daily-check.chat'
export AGENT_MODEL='REPLACE_WITH_SUPPORTED_MODEL'
export PROJECT_WORKDIR='/home/user'

cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
~~~

## Step 1: Create a dedicated thread

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat thread create \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" \\
  --name "Daily project check" --agent-kind acp \\
  --model "$AGENT_MODEL" --reasoning medium \\
  --session-mode read-only --workdir "$PROJECT_WORKDIR"
~~~

Check \`data.created:true\`, retain \`data.thread.thread_id\` as \`THREAD_ID\`, and
inspect \`data.thread.acp_config\`. Scheduled runs use the thread's model,
reasoning, working directory, and access mode, but get their own Codex session
instead of resuming its interactive session. Write a self-contained task prompt.

## Step 2: Save and inspect a disabled draft

~~~bash
export THREAD_ID='REPLACE_WITH_RETURNED_THREAD_ID'

cocalc --profile "$CLI_PROFILE" --json project chat automation upsert \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID" \\
  --title "Daily project check" \\
  --prompt "Inspect this project without changing files. Summarize unfinished work and report any failures." \\
  --local-time 09:00 --timezone Europe/Madrid \\
  --pause-after-unacknowledged-runs 7 --disabled

cocalc --profile "$CLI_PROFILE" --json project chat automation status \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

Always provide a nonempty \`--title\`; the backend requires it even though the CLI
option is not marked required. Replace the example time and timezone with your
intended schedule.

Check both outer \`ok:true\` and \`data.ok:true\`, then confirm
\`data.config.enabled:false\`, the title, prompt, daily local time, timezone, and
\`data.state.status:"paused"\`. A successful status request with \`data.config:null\`
means the thread has no saved automation.

## Step 3: Activate when ready

To enable the reviewed daily task:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat automation resume \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

Inspect \`data.ok\`, \`data.config.enabled\`, \`data.state.status\`, and
\`data.state.next_run_at_ms\`. To deliberately request an immediate run:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat automation run-now \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

\`run-now\` can execute even while the schedule is paused. Its response confirms
submission or an already active run, not completion. Read automation status and
the chat result afterward. Retain \`data.state.last_job_op_id\`, check the last-run
timestamps and \`last_error\`, and review the actual result before counting it as
successful. Admission can fail inside an otherwise successful CLI response, so
check \`data.ok\` as well as the outer envelope.

## Update, pause, or remove a schedule

Read the current configuration before using \`upsert\` again. Supply the complete
intended title, prompt, local time, timezone, and unacknowledged-run limit.
**Upsert replaces configuration and enables the task unless \`--disabled\` is
supplied.** Omitted optional settings return to defaults, including an
unacknowledged-run limit of seven.

This CLI form creates a daily Codex schedule for every day of the week. It can
overwrite an existing command-based, interval, or restricted-weekday configuration; use
the appropriate schedule UI for those forms rather than this daily recipe.

Pause future scheduled runs:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat automation pause \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

After reviewing results, reset the unacknowledged-run counter:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat automation acknowledge \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

Acknowledgment does not resume a paused task. If the unacknowledged-run limit
paused it, acknowledge and then resume when appropriate.

To remove the schedule, while retaining the chat thread:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project chat automation delete \\
  --project "$PROJECT_ID" --path "$CHAT_PATH" --thread-id "$THREAD_ID"
~~~

Check \`data.ok:true\` and \`data.config:null\`. Pausing or deleting the schedule
does not cancel an already running job. For general operation recovery, see
[scripting and results](/docs/cli/scripting-and-results).
`;

export const CLI_WORKSPACES_BODY = `
## Organize a directory inside a project

A workspace is a saved organizational record for a project directory. Creating
one does not create a project, clone a repository, or start an agent. Workspace
records are scoped to the selected project and account.

Use Bash variables \`CLI_PROFILE\` and \`PROJECT_ID\` as in the
[quickstart](/docs/cli/getting-started). Set \`WORKSPACE_ROOT\` to an absolute path
inside the project, not a path on your own computer:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export WORKSPACE_ROOT='/home/user/research'

cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json workspaces list \\
  --project "$PROJECT_ID"
~~~

## Step 1: Create only when the root has no workspace

If the list already contains that root, retain its workspace ID and update the
existing record. Repeating \`create\` for the same root replaces its saved metadata.
For a new workspace:

~~~bash
cocalc --profile "$CLI_PROFILE" --json workspaces create "$WORKSPACE_ROOT" \\
  --project "$PROJECT_ID" --title "Research" \\
  --description "Analysis and project notes" --pinned true
~~~

Retain \`data.workspace_id\` as \`WORKSPACE_ID\`. Confirm \`project_id\`, \`root_path\`,
title, and pinned state. Creating this record does not create or verify the
underlying directory.

## Step 2: Update and resolve

~~~bash
export WORKSPACE_ID='REPLACE_WITH_RETURNED_WORKSPACE_ID'

cocalc --profile "$CLI_PROFILE" --json workspaces update "$WORKSPACE_ID" \\
  --project "$PROJECT_ID" --title "Research review"
cocalc --profile "$CLI_PROFILE" --json workspaces resolve "$WORKSPACE_ROOT" \\
  --project "$PROJECT_ID"
~~~

Updates preserve unspecified fields. \`resolve\` returns the most specific
workspace matching the path, or \`data:null\`. It does not check whether the
path exists. Selecting a workspace in a browser is separate from editing this
persistent record.

## Step 3: Leave a durable message

~~~bash
cocalc --profile "$CLI_PROFILE" --json workspaces message "$WORKSPACE_ID" \\
  --project "$PROJECT_ID" "The analysis is ready for review."
~~~

Check \`data.result.ok:true\`. Retain \`data.result.message_id\` and
\`data.result.chat_path\`. The command creates or reuses the workspace's canonical
chat and its “Workspace notices” thread.

**A workspace message does not submit an agent prompt or start an agent turn.**
It records a notice for collaborators. Use the relevant agent workflow when the
intent is to execute work.

After [verifying a browser target](/docs/cli/browser-workflows), open the chat
separately with its browser ID:

~~~bash
cocalc --profile "$CLI_PROFILE" --json workspaces open-chat "$WORKSPACE_ID" \\
  --project "$PROJECT_ID" --browser "$BROWSER_ID"
~~~

With \`message --open\`, the message is saved before the browser is opened. A
browser-opening failure does not prove that the message was unsaved. Inspect
the chat before retrying to avoid duplicate notices.

## Card notices and cleanup

A card notice is distinct from a chat message:

~~~bash
cocalc --profile "$CLI_PROFILE" --json workspaces notify "$WORKSPACE_ID" \\
  --project "$PROJECT_ID" --level success "Ready for review."
cocalc --profile "$CLI_PROFILE" --json workspaces clear-notice "$WORKSPACE_ID" \\
  --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json workspaces update "$WORKSPACE_ID" \\
  --project "$PROJECT_ID" --pinned false
~~~

These operations do not start an agent. To remove the organizational record:

~~~bash
cocalc --profile "$CLI_PROFILE" --json workspaces delete "$WORKSPACE_ID" \\
  --project "$PROJECT_ID"
~~~

Check \`data.deleted:true\`. Project files and the chat file remain intact.
`;

export const CLI_BUILDS_VERSIONS_BODY = `
## Build a saved document through CoCalc

\`project build\` runs the project's document pipeline without an open browser.
Use it for \`.tex\`, \`.Rnw\`, \`.Rtex\`, \`.Rmd\`, and \`.qmd\` sources. For example,
a LaTeX build can include required SageTeX or PythonTeX stages; one standalone
compiler invocation does not necessarily verify the complete document.

Use the profile and project ID from the [quickstart](/docs/cli/getting-started).
Save any collaborative edits first, and replace \`DOCUMENT_PATH\` with the source
path inside the project:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export DOCUMENT_PATH='/home/user/paper.tex'

cocalc project build --help
cocalc --profile "$CLI_PROFILE" --json --timeout 20m \\
  project build "$DOCUMENT_PATH" --project "$PROJECT_ID" \\
  --build-timeout 15m
~~~

The server's capability response determines the supported formats. The command
waits by default. Require successful command completion, \`ok:true\`,
\`data.state:"succeeded"\`, and \`data.wait_timed_out:false\`; then inspect
\`data.artifacts\`, diagnostics, and the generated document.

The global \`--timeout\` limits how long this CLI invocation waits. Expiry does
not cancel the build. \`--build-timeout\` sets the project-side whole-build
deadline. A failed build returns a nonzero exit status even in JSON mode;
a local wait timeout or timed-out build uses 124, and cancellation uses 130.

\`--detach\` submits without waiting and returns a \`build_id\`; this is not proof
of success. The current CLI exposes submission through \`project build\`, but no
companion build get/wait/cancel subcommands. Do not pass a build ID to \`op wait\`
or invent \`project build status\`. For unattended verification, prefer the
wait-for-completion invocation above. After an uncertain response, inspect the
project's build state before starting another build.

## Know which version supplies each interface

| Surface | Source of its behavior or content |
| --- | --- |
| \`cocalc --help\`, subcommand help | Installed CLI build. |
| \`cocalc docs search/show/skill-context\` | Documentation bundled with that CLI. |
| \`cocalc exec-api\` | Backend API declaration bundled with that CLI. |
| \`cocalc browser exec-api\` | Selected running browser session and its policy. |
| Project operations and build capabilities | Running project/server services. |
| CoCalc-provided agent skills | The applicable project-host runtime, unless locally overridden. |

When a documented command is absent, record \`cocalc --version\` and inspect its
help. A website update does not change docs already bundled in an installed
CLI, and updating the CLI does not refresh a stale browser session.

~~~sh
cocalc --version
cocalc docs list --category CLI
cocalc exec-api
cocalc docs skill-context --query "notebook"
~~~

\`docs skill-context\` prints selected docs; it does not install or update a
skill. In the managed Launchpad project runtime, built-in skills are mounted
read-only unless a project-local directory under \`.codex/skills/<skill-name>\`
overrides that skill. This applies to the managed runtime path, not every way
of running an agent or CLI. A local override can remain older than the supplied
skill. Review overrides deliberately rather than deleting them during a routine
CLI update.

## Report a reproducible problem

Include the installed version, relevant command help, selected project/browser
context, exact sanitized command, and the result checks you applied. Distinguish:

1. A command or option missing from the installed CLI.
2. Authentication or target-resolution failure.
3. A server capability or policy denial.
4. An operation accepted but failing later.
5. Successful execution with incorrect document or UI results.

Keep credentials and private document contents out of shared logs. For JSON
and recovery examples, use [scripting and results](/docs/cli/scripting-and-results).
For live source changes, maintainers should follow the repository's
\`docs/cli-guide-validation.md\` and record what actually ran.
`;
