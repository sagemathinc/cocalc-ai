/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const CLAUDE_CODE_BODY = String.raw`
## Experimental preview

Claude Code can work in a CoCalc project from the Agents workspace. This is an
experimental preview: availability depends on the site's configuration, and
some capabilities differ from Codex. Start in a project whose files you can
restore and whose collaborators and code you trust.

See [Agent features: Codex and Claude Code](/docs/ai/agent-features) for the
feature-by-feature comparison, including known messaging limitations.

## Start a conversation

1. Choose **New Agent** under **Agents** in the sidebar, and select a project.
   If CoCalc opened the new-agent request box for you, that first form has no
   runtime choice and starts a Codex agent; once it has started, choose
   **New Agent** for Claude Code.
2. Select **Claude** and open its settings icon to configure Claude Code.
3. Choose a credential in settings: a project API-key secret, an account API key, or a
   connected Claude Pro/Max subscription, where offered by the site.
4. For a project key, use the Claude API-key dialog. For a subscription, use
   **Connect Claude Pro/Max** and complete the sign-in flow.
   Never paste credentials or login codes into a chat message.
5. Choose the model and effort in the composer before your first turn. Available
   options load automatically; loading is not a request to reconnect your account.
   Paste an image or ask Claude to inspect a small file and run a test.

Your selected credential is bound when a turn is admitted. Changing the
selection applies to subsequent turns; it does not change an already admitted
turn. A model saved under a different credential may be unavailable; choose a
model advertised by the current session.

## Composer settings and subscription usage

The composer shows the project and working directory, advertised model and
effort selectors, and payment method for your next turn. **Fast on** appears
only when fast mode is selected. Use the settings icon or payment method to
open settings. **Speed** offers **Standard** and **Fast** where available.
Model options load automatically when needed; **Refresh** in settings retries
discovery. If the host cannot report the model, CoCalc says it is unavailable
rather than guessing. Settings do not change a turn already running or queued.

Hover over or keyboard-focus **Claude subscription** to see your five-hour and
weekly usage percentages and reset times. These are account-wide subscription
windows, not a per-agent token budget. Claude reports them with each response
during a turn, and CoCalc saves the latest report with your subscription, so
the popover opens instantly. It shows when the numbers were updated: they are
as of your most recent Claude turn in CoCalc, and do not include use elsewhere
(claude.ai or other apps) since then. A window that has reset since that turn
says so. **View usage on Claude** opens Claude's own, always-current usage
page. API-key modes do not have subscription usage bars.

In settings, expand the help sections for access, billing, and runtime details.

### Claude account connectors

claude.ai connectors are not available with subscriptions connected now: the
long-lived token CoCalc stores (see below) can run models but cannot load your
claude.ai connectors. Subscriptions connected earlier, with a full sign-in,
still load them by default; for those, turn off **Use my claude.ai
connectors** in Claude settings to exclude them from your next turn. That
choice does not affect a running or already queued turn, disconnect services
on claude.ai, or disable CoCalc's project tools.

## Security model

### Project access and approvals

Claude has full project access. It can read and edit files, run commands,
access project secrets, and send project content to external services. CoCalc
does not ask for approval before each tool or shell command. The project is
the collaboration and execution trust boundary: only use this preview with
collaborators, repository instructions, skills, and code you trust.

Credential isolation protects the credential material described below. It does
not make project contents confidential from Claude, its provider, or other
project collaborators, and it does not protect against destructive commands.

### Project API-key secret

The selected ANTHROPIC_API_KEY is a project secret. Project collaborators and
code running in the project can read, copy, and use the key. Anthropic bills
the key owner. Removing the secret from CoCalc cannot revoke copies already
made; revoke or rotate the key with the provider when necessary.

### Account API key

CoCalc keeps the account-stored key value outside the project and uses a
provider relay to attach it to API requests. Project code does not receive the
key value from this relay. However, while the relay is active, project code
and collaborators can use it to make provider requests and incur charges on
the key owner's account. Selecting this mode authorizes that project-level
use of your billing authority. Hidden key bytes do not mean exclusive use by
one agent or a separate spending allowance for each collaborator.

The Claude session is pinned to the selected CoCalc relay; project settings
must not silently select another credential or provider route. The relay
revalidates its exact account credential before each new provider request and
rejects requests when authority cannot be verified. Revocation cannot undo
requests already accepted by the provider. A retained session may keep the
relay available between turns; stop the agent session or revoke the credential
when you no longer authorize its use.

### Claude Pro/Max subscription

Connecting runs Claude's own long-lived token sign-in (the same as
\`claude setup-token\`): you sign in on Claude's site and paste the code back,
and CoCalc stores the resulting token, valid for one year, encrypted with your
account. Unlike a normal sign-in it has no refresh token, so any number of
agents can use it at the same time without signing you out. The token only
runs models: it cannot report your email or plan to CoCalc, and it cannot load
claude.ai connectors. Use it with a Claude Pro or Max subscription; Team and
Enterprise plans are not supported here, so use an Anthropic API key instead.
Since CoCalc cannot read the plan, you can name the subscription (for example
"Max 20x") under the credential picker in Claude settings.
Disconnecting removes CoCalc's copy; revoke the token itself from your Claude
account if you suspect it was exposed.

Subscription credentials are account-owned and used in a separate controller,
outside the project filesystem. Claude's project commands execute through a
scoped tool bridge into the project. Ordinary project commands should not be
able to read or export that login state. This boundary does not prevent Claude
from accessing project files or using other credentials exposed inside the
project.

Work accepted by this agent consumes the selected subscription's usage
allowance. Agent Network authorization and recipient payment authorization
are separate requirements: a valid sender identity does not select a recipient's
subscription. The network account must first send a human message in the
recipient thread with its selected subscription. Network turns then reuse that
privately stored selection and connectors choice, with authorization rechecked
at delivery. Never work around a rejected delivery by borrowing another
account's credentials.

CoCalc checks credential authority when admitting and running work and before
mediated project commands. Disconnect prevents future authorized use; it
cannot undo completed work or provider usage. Provider-side session revocation
is also appropriate if you suspect credential compromise.

### Billing and cancellation

Check the displayed credential before starting work.
Provider plan limits and any enabled extra-usage billing apply; CoCalc does
not promise a hard spending cap. Configure limits at the provider and monitor
usage there. Subscription access and API-key billing are distinct choices.

Cancel stops the current turn and cancels its mediated project commands.
Controller disposal disables the project bridge and closes the scoped CLI
lease even if container removal needs retry: credential renewal stops and
the lease files are removed. This is not a promise that a CLI token previously
copied by project code becomes instantly invalid; its existing expiry and
revocation rules still apply. Cancellation cannot roll back file changes,
external requests, or charges already incurred. Managed-command descendants
are terminated even if they detach into another session. Project-owned terminal
services have a separate lifecycle and may require separate cleanup.

## Capabilities and current limits

- Text and pasted images are supported.
- The CoCalc skill supplies project-aware CLI guidance. In subscription mode,
  it is preloaded as instructions rather than registered as a separate Skill
  tool. Skill references and project CLAUDE.md files are read through the
  project command tool.
- Project commands receive a scoped CoCalc CLI credential. This is separate
  from the Anthropic credential; CLI actions remain limited by its authority.
- Subscription project commands are managed jobs. A short tool wait does not
  kill a running build. See the execution lifecycle below.
- Live guidance requires adapter support; other messages queue. Automations
  and goal workflows are not yet supported by this integration.
- A background subprocess finishing does not automatically wake a completed
  CoCalc turn. Ask Claude to wait for completion or explicitly check its status.
- Registered Claude agents can discover network peers and exchange messages
  through project tools on updated hosts. Live messages can guide busy Claude
  recipients; idle recipients resume with their own subscription selection.
  Claude-to-Claude delivery is live-verified; mixed Claude/Codex and cross-project
  paths have automated coverage but still need live qualification.
  Account API-key network turns are rejected by admission. See the
  [coordination comparison](/docs/ai/agent-features#agent-coordination).

### Questions while work continues

Claude can ask nonblocking questions using the same durable question cards as
Codex. You can choose a suggested answer or enter your own while Claude keeps
working. Your answer is delivered to the active turn, or starts a continuation
if that turn has already finished. The continuation keeps the original turn's
subscription selection and rechecks authorization; it does not switch to Codex.

The subscription tool \`request_user_input_async\` saves up to three questions
and returns immediately. Claude should use it when other useful work can
continue, rather than waiting or polling for an answer. Questions are for
clarification, not passwords, login codes, authentication, or permission
escalation. See [goals and questions](/docs/ai/codex-goals) for the shared cards.

The subscription tool \`project_read_image\` lets Claude look at an image
saved in the project, such as a screenshot, plot, or rendered page, instead of
only reading text output. It accepts PNG, JPEG, GIF, and WebP files up to
800 KB and uses the same project access as \`project_exec\`. For SVG or PDF,
Claude renders a PNG first; for larger images, it saves a smaller or cropped
copy.

## Troubleshooting and agent-readable help

### Long commands and background services

In subscription mode, \`project_exec\` starts a command in the project and
returns its \`job_id\`, status, output, and \`next_cursor\`. Run builds and
tests in the foreground: do not add \`&\`, \`nohup\`, or \`setsid\` merely
to get past a tool wait. \`status: running\` means the command is still running,
not that it failed. Use \`project_exec_wait\` with the job ID and returned
cursor to read more output. Continue until the job has finished and
\`has_more\` is false. \`project_exec_cancel\` stops a job and waits for
cleanup; \`project_exec_list\` lists this controller's jobs.

\`yield_time_ms\` is the maximum wait for one tool response (0-30 seconds,
10 seconds by default). Output is batched until that interval expires, a page
fills, or the job finishes, rather than returning for each output chunk.
It is independent of \`timeout_ms\`, the command deadline: one hour by
default, configurable up to 24 hours. Four jobs can run concurrently per
controller. Output is paginated and bounded; \`output_truncated\` explicitly
reports lost older output. Redirect verbose build logs to a project file if
you need their full history. Completed output is retained for up to ten minutes,
with at most 32 jobs retained per controller.

If a start response is lost, list jobs before repeating the command. An optional
unique \`request_id\` permits retries of an identical start without running it
twice within the same controller. An expired result produces an error rather
than repeating that request. Job IDs and retry IDs do not carry across controller
restarts; reconnecting is not evidence that an earlier command never ran.

Jobs belong to their subscription controller, not to the individual tool call.
Cancellation, controller shutdown, or the command deadline stops owned jobs.
Authorization is rechecked on each tool call and periodically while jobs run;
loss of authorization stops them. A host failure closes or expires the command
supervisor's lease. Jobs are not automatically replayed after a project/host
restart. Do not end a turn while its required foreground work is still running
or promise an automatic follow-up notification.

Managed jobs require the current project-host runtime helper and a kernel with
cgroup v2 atomic kill support. Each command runs inside the existing project
container but in a separate root-owned job cgroup. Detached descendants are
terminated too, including on normal command completion. Detected leftover
processes produce a stderr note directing you to project terminal services.
There is no fallback
to process-group-only cancellation when containment is unavailable.

If \`cleanup_pending\` remains true with a \`cleanup_error\`, the runtime has
not confirmed that the job scope is empty. Do not treat this as successful
cancellation or start a replacement command. The controller blocks new jobs
and revokes its scoped CLI credential; an independent host sweep retries
orphan cleanup. Operators must resolve the runtime failure before retrying.
Updating the worker alone is not sufficient for this feature: update the
host bootstrap runtime helper as well, then validate managed execution and
cancellation on that host before enabling it for users.

After upgrading the helper, restart the test project to establish its verified
runtime generation. Job admission and project teardown share a host lifecycle
lock. Failed teardown leaves admission blocked across worker restarts until
cleanup succeeds; restarting just the worker does not clear that state. The
host sweep also enforces each job's persisted deadline if its supervisor is
alive but unresponsive. Host validation must include detached descendants,
concurrent admission/stop, supervisor failure, and project restart.
Admission checks cleanup only for its target project. A failed sweep records a
root-owned quarantine for that project; the periodic host sweep continues with
other projects and retries without waiting for exiting processes under the
lifecycle lock. A subsequent successful target sweep clears its quarantine.
Managed exec also disables new privilege gains before launching Podman. Validate
this with the host's actual rootless runtime; there is no fallback that relaxes
this restriction if namespace setup or exec fails.

For intentionally persistent services or interactive input, use CoCalc's
existing project terminal facilities: inspect \`project terminal --help\`
through the installed CLI. These are project-owned terminals, with a separate
lifecycle, not a way to extend a subscription controller's scoped CLI authority.
Use project-owned service configuration for persistent applications; do not
copy a turn's credential into a detached process. A project restart can stop
these processes too.

If a session fails after a restart, retain the error and agent identity and
report them to the site administrator. Avoid blindly resending a turn whose
execution outcome is uncertain. Missing model options, expired credentials,
and unavailable runtime setup should be resolved before retrying.

Resumed subscription turns receive current managed-job guidance. Project MCP
tool names include a version derived from the helper source so cached tool
definitions from an older controller do not reuse the same tool identity.

This page is part of the shared CoCalc documentation catalog, available to
humans at /docs/ai/claude-code and through the cocalc-cli docs commands. Agents
can search for "Claude Code" and read this entry instead of relying on a
short warning shown during setup.

    cocalc docs search "Claude Code"
    cocalc docs show ai/claude-code

See also [Agents](/docs/ai/my-agents) and
[AI access](/docs/ai/connect-credentials).
`;
