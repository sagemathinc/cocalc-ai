/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CLI_GETTING_STARTED_BODY = `
## Choose where you are running the CLI

On your own computer, install the CLI and sign in using the steps below. You need
an existing CoCalc-ai account and a project that you can access.

Inside a CoCalc project or an agent session started by CoCalc, first try
\`cocalc --version\` and \`cocalc auth status --check\`. Use the supplied project or
agent authentication. Do not save a personal account login in a shared project.
See [authentication and targeting](/docs/cli/authentication-and-targets).

## 1. Install on your own computer

For Linux (x64 or ARM64) or Apple Silicon macOS, open Terminal and run:

~~~sh
curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash
~~~

Follow the installer's printed PATH instruction if the command is not found.
The standalone macOS installer currently supports Apple Silicon, not Intel Macs.

For native Windows x64, open PowerShell and run:

~~~powershell
irm https://software.cocalc.ai/software/cocalc/install.ps1 -OutFile install-cocalc.ps1
.\\install-cocalc.ps1 -AddToPath
~~~

Open a new terminal after adding the command to PATH. Then check:

~~~sh
cocalc --version
cocalc --help
~~~

The standalone download includes its runtime; you do not need to build the
repository. The Unix installer defaults to the \`latest\` channel and Windows to
\`stable\`. Available commands can therefore differ between installed releases.
Use your installed command's help to check an option before relying on it.

## 2. Read a page before signing in

These commands read documentation bundled with the CLI and need no login:

~~~sh
cocalc docs list --category CLI
cocalc docs show cli/use-cocalc-cli
cocalc docs search "project secrets"
~~~

Bundled documentation describes that CLI build. Updating the website does not
update an already installed CLI.

## 3. Sign in on your own computer

Create a named profile for this site:

~~~sh
cocalc --profile cocalc-ai --api https://cocalc.ai auth login
~~~

Leave the command running. Open the approval URL printed in your terminal,
sign in to the intended account, and approve the CLI login. Return to the
terminal and wait for completion. The CLI saves the profile and makes it current.

Check the saved profile:

~~~sh
cocalc --profile cocalc-ai --json auth status --check
~~~

Confirm \`data.selected_profile\`, the account identity, and
\`data.check.ok: true\`. The outer \`ok: true\` only means the status command
returned a result. Without \`--check\`, the command describes configuration
without testing the connection.

Login may save your account's routed site address. Continue using the profile
without repeating \`--api\` on every command.

## 4. Find and inspect a project

~~~sh
cocalc --profile cocalc-ai project list
~~~

Copy the full \`project_id\` for the project you intend to use. Replace
\`PROJECT_ID\` in these commands with that value:

~~~sh
cocalc --profile cocalc-ai project get --project PROJECT_ID
cocalc --profile cocalc-ai project file list --project PROJECT_ID .
~~~

Confirm the project ID and title before doing further work. A successful listing
is your first project operation; an empty project can return an empty list.
A full ID avoids ambiguous project names.

To save this project as the default for the current local directory:

~~~sh
cocalc --profile cocalc-ai project use --project PROJECT_ID
cocalc --profile cocalc-ai project get
~~~

This creates \`.cocalc-project\` in that directory. It does not save credentials.
Use explicit \`--project\` arguments in scripts that may run from other directories.

## Next steps

- [Authentication and targeting](/docs/cli/authentication-and-targets):
  profiles, environment credentials, project context, and fresh authentication.
- [Find the right command](/docs/cli/command-reference):
  files, collaborative documents, notebooks, agents, browsers, and operations.
- [Use the CLI in scripts](/docs/cli/scripting-and-results):
  JSON, errors, remote exit codes, and recovery after a timeout.
`;

export const CLI_AUTHENTICATION_BODY = `
## Select credentials and a project separately

An authentication profile selects the account and site used for a request.
A project selector chooses the project within that context. A browser selector
chooses a browser session. Setting one does not prove the other two are correct.

For work from your own computer, start with the
[CLI quickstart](/docs/cli/getting-started), then keep the profile explicit:

~~~sh
cocalc --profile cocalc-ai --json auth status --check
cocalc --profile cocalc-ai project get --project PROJECT_ID
~~~

Replace \`PROJECT_ID\` with a project ID from \`project list\`.
Inspect the account, site, project ID, and title before a write.

## Saved profiles and environment authentication

Profile selection follows:

1. The explicit \`--profile\` option.
2. \`COCALC_PROFILE\`, when set.
3. The current saved profile, or the environment profile when
   \`COCALC_CLI_AGENT_MODE=1\`.

Use \`--profile env\` to select environment-based authentication explicitly.
For an existing saved profile, explicit command-line options override saved
values, and ambient authentication defaults are disabled. A saved profile's
API URL therefore takes precedence over the environment API fallback.

If you explicitly change \`--api\` to another origin, credentials stored for the
profile's original origin are not inherited. Sign in to the intended site using
its own profile instead of assuming a saved login applies everywhere.

~~~sh
cocalc auth --help
cocalc --profile cocalc-ai auth status
cocalc --profile cocalc-ai auth status --check
~~~

Status output is diagnostic information, not something to paste into a public
issue without review. Check \`data.check.ok\` when using JSON.
See [scripting and results](/docs/cli/scripting-and-results).

## Project context is local to the directory

~~~sh
cocalc --profile cocalc-ai project use --project PROJECT_ID
cocalc --profile cocalc-ai project get
cocalc project unuse
~~~

\`project use\` writes \`.cocalc-project\` in the current local directory.
\`project unuse\` removes that selection. The general project resolver reads
the current directory's context; it does not search parent directories.
An explicit \`--project\` takes precedence.

Names are convenient interactively, but full project IDs are more reliable in
automation. Do not assume \`COCALC_PROJECT_ID\` is a universal replacement for
\`--project\`: environment targeting is supported by particular command and
agent paths, while the general resolver uses an explicit target or local context.

## Use the authentication supplied to a CoCalc agent

CoCalc agent sessions may already carry scoped credentials, project context,
and a browser ID. Check that context before starting a separate login flow.
A personal account profile stored in a shared project can expose account access
to collaborators; use the supplied project or agent identity there.

For local source development, load the environment for the running server in
the same shell before CLI operations:

~~~sh
cd src
eval "$(pnpm -s dev:hub:env)"
~~~

For a Lite development server, use \`dev:lite:env\` instead. Refresh this
environment after restarting or switching servers. These are repository
development commands, not installation steps for users of the hosted site.

## Login, elevation, and bootstrap serve different purposes

| Command | Purpose |
| --- | --- |
| \`auth login\` | Browser-approved sign-in and a saved profile. |
| \`auth status --check\` | Check the effective connection and credentials. |
| \`auth elevate\` | Request fresh authentication for an existing interactive login. |
| \`auth bootstrap\` | Sign in, elevate, and validate in one flow. |

When an operation reports that fresh authentication is required:

~~~sh
cocalc --profile cocalc-ai auth elevate
~~~

Follow the printed browser approval and passkey or TOTP challenge. The default
elevation lasts eight hours; \`--short\` requests fifteen minutes. To perform
login, elevation, and verification together on your own computer:

~~~sh
cocalc --profile cocalc-ai --api https://cocalc.ai auth bootstrap
~~~

API keys, bearer tokens, and project-scoped credentials do not replace the
cookie-backed interactive session required for fresh authentication.
An unattended script should report the approval requirement to its operator.
Do not repeatedly retry an approval-dependent operation as though it were a
temporary network failure.

## Browser targets need their own check

Start with discovery and resolution before sending browser actions:

~~~sh
cocalc browser session list --help
cocalc browser target-resolve --help
~~~

Use explicit project and browser selectors supported by the command. Browser
availability and permissions also depend on the running site and session;
a valid account login alone does not establish that a browser action can run.
`;

export const CLI_COMMAND_REFERENCE_BODY = `
## Discover commands for your installed version

Use help at each level. These commands do not perform the operation they describe:

~~~sh
cocalc --help
cocalc project --help
cocalc project file --help
cocalc project jupyter --help
cocalc browser --help
~~~

The table below is a navigation guide, not a promise that every subcommand is
available in every installed release or deployment. Run the relevant command
with \`--help\` for its arguments, selectors, defaults, and examples.

## Choose a command family

| Task | Start with |
| --- | --- |
| Find documentation and agent context | \`cocalc docs --help\` |
| Sign in, inspect profiles, request fresh authentication | \`cocalc auth --help\` |
| Find, select, start, or inspect projects | \`cocalc project --help\` |
| List, read, upload, download, and search files | \`cocalc project file --help\` |
| Run a shell command or retrieve its asynchronous result | \`cocalc project exec --help\` |
| Work with a persistent terminal session | \`cocalc project terminal --help\` |
| Inspect, edit, run, and save live notebooks | \`cocalc project jupyter --help\` |
| Build supported documents | \`cocalc project build --help\` |
| Work with project chats and scheduled agent tasks | \`cocalc project chat --help\` |
| Start project Codex work | \`cocalc project codex --help\` |
| Inspect and control active Codex sessions | \`cocalc codex --help\` |
| Manage workspaces and select one in a browser | \`cocalc workspaces --help\` |
| Edit collaborative task documents | \`cocalc tasks --help\` |
| Script supported collaborative document APIs | \`cocalc exec --help\` |
| Export or import structured document archives | \`cocalc export --help\`, \`cocalc import --help\` |
| Discover and automate a browser session | \`cocalc browser --help\` |
| Inspect or wait for long-running operations | \`cocalc op --help\` |
| Browse and copy published shares | \`cocalc share --help\` |
| Inspect account resources and notifications | \`cocalc account --help\`, \`cocalc notifications --help\` |
| Work with membership packages and seats | \`cocalc membership --help\` |
| Manage host and compute resources | \`cocalc host --help\`, \`cocalc vm --help\` |
| Inspect software artifacts and RootFS catalogs | \`cocalc software --help\`, \`cocalc rootfs --help\` |
| Manage the local CLI daemon | \`cocalc daemon --help\` |
| Run local CoCalc distributions | \`cocalc plus\`, \`cocalc launchpad\` (may install the selected distribution when first invoked) |

Operator and developer surfaces also include \`admin\`, \`bay\`, \`rocket\`,
\`cloudflare\`, \`dev\`, \`load\`, \`persist\`, \`legacy-migration\`, and
\`migrate\`. These have different permissions and side effects from ordinary
project work. Begin with their help and the relevant operator documentation.

## Three different ways to execute code

| Command | Where the code runs | Typical use |
| --- | --- | --- |
| \`cocalc project exec\` | A process inside the selected project | Run existing software or a script; use \`--bash\` when shell interpretation is needed. |
| \`cocalc exec\` | The local CLI process, with a typed \`api\` object that accesses CoCalc services | Work with supported collaborative documents and workspaces. |
| \`cocalc browser exec\` | A constrained scripting environment controlling a browser session | Inspect or act on the browser through its exposed API. |

For the backend API declaration bundled with your CLI:

~~~sh
cocalc exec-api
~~~

Its supported namespaces include \`api.tasks\`, \`api.text\`,
\`api.timetravel\`, \`api.export\`, \`api.import\`, and \`api.workspaces\`.
For a text document open collaboratively in CoCalc, inspect \`api.text\` before
replacing the file on disk. For notebooks, start with \`project jupyter\`
instead of editing raw notebook JSON.

For the browser API declaration provided by a running browser session:

~~~sh
cocalc browser exec-api --help
~~~

Follow that command's target options to retrieve the declaration for your
session. Browser exec is not an unrestricted page JavaScript console:
do not assume \`window\`, \`document\`, or top-level \`await\` are available.
Use the exposed API and command examples.

## Find documentation and stable UI actions

~~~sh
cocalc docs search "notebook"
cocalc docs skill-context --query "project secrets"
cocalc docs actions --executable
cocalc docs action settings.environment.secrets
~~~

\`docs skill-context\` prints selected documentation for an agent; it does not
install or update an agent skill. \`docs action\` describes an action without
executing it. Browser commands can execute supported action IDs after you
resolve an appropriate browser target.

The CLI's bundled docs and backend declaration describe the installed build.
A browser declaration comes from a running session and can differ. If a command
or method is missing, compare the installed CLI, server, and browser versions
before treating the difference as an authentication failure.

## Before automating a workflow

Complete the [quickstart](/docs/cli/getting-started), confirm
[authentication and targets](/docs/cli/authentication-and-targets), and use the
[result checks](/docs/cli/scripting-and-results) for scripts. Keep returned
operation IDs and document revisions when a workflow needs to recover or
continue later.
`;

export const CLI_SCRIPTING_BODY = `
## Prefer JSON for ordinary command results

For ordinary, non-streaming commands, use \`--json\` or \`--output json\`.
The common success envelope is written to stdout:

~~~json
{
  "ok": true,
  "command": "project exec",
  "data": {
    "stdout": "hello\\n",
    "stderr": "",
    "exit_code": 0
  },
  "meta": {}
}
~~~

This is an abbreviated example: actual data and metadata depend on the command.
Caught command errors normally produce a nonzero CLI exit status and an
\`ok: false\` envelope on stderr, with \`error.code\` and \`error.message\`.
Some errors also include \`error.details\` or \`error.hint\`.

Keep stdout and stderr separate. Progress, diagnostics, and approval messages
can also appear on stderr, so do not assume the entire stderr stream is always
one JSON document. Argument-parser and startup failures can have a different
format from command-handler errors.

The common renderer implements JSON and human-readable output. Although
\`--output\` advertises YAML, do not rely on YAML output across commands.
\`--quiet\` suppresses human-formatted success output, not JSON results.

Streaming, passthrough, and declaration-printing commands have their own output
formats. In particular, \`project codex exec --stream --json\` can emit stream
messages on stdout before its final envelope. Do not use the single-document
parsing pattern below with \`--stream\` or \`--jsonl\`.

## Check the requested work, not just the envelope

| Command | Additional result check |
| --- | --- |
| \`auth status --check\` | \`data.check.ok\` is \`true\`. |
| \`project exec\` in JSON mode | \`data.exit_code\` is \`0\`. |
| Asynchronous \`project exec\` | \`data.status\` is \`completed\` and \`data.exit_code\` is \`0\`. |
| \`op wait\` | \`data.status\` is \`succeeded\`. |

JSON-mode \`project exec\` can exit locally with status zero and return
\`ok: true\` even when the process inside the project fails. Its output and
exit code are returned inside \`data\`.

The following Bash example requires \`jq\`. Set \`CLI_PROFILE\` to the saved
profile from the [quickstart](/docs/cli/getting-started), and \`PROJECT_ID\`
to the full ID from \`project list\`. It runs \`pwd\` in that project.

~~~bash
: "\${CLI_PROFILE:?Set CLI_PROFILE to your saved profile name}"
: "\${PROJECT_ID:?Set PROJECT_ID to the project ID}"

result=$(
  cocalc --profile "$CLI_PROFILE" --json \\
    project exec --project "$PROJECT_ID" -- pwd
) || exit "$?"

if ! printf '%s\\n' "$result" |
  jq -se '
    length == 1 and
    (.[0] | .ok == true and .data.exit_code == 0 and
     (.data.stdout | type == "string"))
  ' >/dev/null
then
  printf '%s\\n' "$result" >&2
  exit 1
fi

printf '%s\\n' "$result" | jq -j '.data.stdout'
~~~

## Retain operation IDs and check terminal status

Commands that submit a long-running operation can return an \`op_id\`.
Retain it so a later command can inspect the same operation.

Set \`OP_ID\` to the returned ID:

~~~sh
cocalc --profile "$CLI_PROFILE" --json op get "$OP_ID"
cocalc --profile "$CLI_PROFILE" --json --timeout 10m --poll-ms 2s op wait "$OP_ID"
~~~

\`op wait\` finishes at \`succeeded\`, \`failed\`, \`canceled\`, or \`expired\`.
It can return \`ok: true\` for any of these terminal states. In a script,
require both \`.ok == true\` and \`.data.status == "succeeded"\`.

A wait timeout does not cancel the operation. Inspect the retained ID before
submitting another mutation; otherwise you can duplicate work that is still
running. To request cancellation deliberately:

~~~sh
cocalc --profile "$CLI_PROFILE" --json op cancel "$OP_ID"
cocalc --profile "$CLI_PROFILE" --json op get "$OP_ID"
~~~

For \`op wait\`, global \`--timeout\` controls the wait budget,
\`--rpc-timeout\` controls individual requests, and \`--poll-ms\` controls
polling. Their defaults are 600 seconds, 30 seconds, and one second. These are
not a universal hard wall-clock deadline for every CLI command.

## Project execution uses a different job ID

Start a shell command asynchronously:

~~~sh
cocalc --profile "$CLI_PROFILE" --json \\
  project exec --project "$PROJECT_ID" --async --timeout 120 -- pwd
~~~

Retain the returned \`data.job_id\` as \`JOB_ID\`, then inspect or wait for it:

~~~sh
cocalc --profile "$CLI_PROFILE" --json \\
  project exec --project "$PROJECT_ID" --job-id "$JOB_ID"

cocalc --profile "$CLI_PROFILE" --json --timeout 10m \\
  project exec --project "$PROJECT_ID" --job-id "$JOB_ID" --wait
~~~

A \`job_id\` is not an \`op_id\`; do not pass it to \`op wait\`.
Job status and results are kept in memory, with a bounded cache for completed
results. Persist important outputs in your workflow and do not assume a job
can be recovered after a service restart or cache expiry.

Place global wait options before \`project\`. The subcommand's
\`project exec --timeout 120\` is a remote command limit in seconds.
Check command-specific help before copying timeout options to another workflow.
`;
