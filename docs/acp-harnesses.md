# Experimental ACP Harnesses

CoCalc can run an operator-installed ACP v1 harness in a containerized project
and present its conversation in the Agents workspace. Native Codex remains the
default, separate integration. This feature is currently for operator testing;
see the [qualification record](../src/.agents/acp-harness-progress-2026-09-21.md)
for evidence and unresolved release gates.

Known pinned-harness limitation: `pi-acp@0.0.33` with Pi `0.86.1` returned
`end_turn` with no answer or error event when a local provider rejected inference
with HTTP 401. Successful Pi inference is qualified, but this provider-error path
is not. Do not interpret an empty completed turn as proof that inference succeeded.
OpenCode `1.18.31` surfaced the same rejection correctly. Require a bridge fix or
requalification before relying on Pi for unattended error reporting.
An [experimental operator patch](../src/.agents/acp-harness-patches/README.md)
passes standalone rejection and normal-inference probes, plus a durable HTTP 401
chat test whose error remains visible after reload. It is not an upstream release
or automatically installed replacement, and does not qualify every Pi error path.

OpenCode `1.18.31` returned `end_turn` when canceled during simulated provider
retry backoff, rather than confirming `cancelled`. CoCalc tracks interruption
independently and reports uncertain completion instead of success in this case.
Inspect the workspace before explicitly continuing; do not assume that a cancel
request proves all background work or external actions stopped.

## Execution And Trust

The harness runs with full project access. It can use its own filesystem, shell
and network tools, not just ACP callbacks. CoCalc supplies the project container
boundary; a harness permission dialog is not that boundary. Supported tool
permission requests receive a per-request full-access response without an
interactive approval workflow.

Use a disposable project first. Credentials and files inside a project must be
treated as accessible to its trusted collaborators and agents. Do not put secrets
in launch-profile fields: profiles and arguments are shared chat configuration.
Configure the provider through the installed harness's project-local settings
and supported project secret mechanisms instead. CoCalc does not import Codex
subscriptions or silently charge CoCalc billing for a custom harness.

Snapshots provide recovery for filesystem changes, not protection against data
exfiltration, external actions or loss of work since the last snapshot. Check
actual snapshot availability and test restore before relying on it. Generic
read-only and network-allowlist modes are not part of this experimental UI.
The launcher retains the project's existing network boundary.

## Operator Setup

### Turn Context And Artifacts

Normal prompts include non-secret project, chat, thread and producing-message
metadata for the current turn. This context is refreshed even when the harness
process is retained; it is not an authorization grant. Native slash commands are
passed through unchanged. The harness must use its existing scoped runtime
identity rather than fall back to account credentials.

Ordinary text and file links remain the default. Explicit artifact publication
can use the installed CLI's `project chat artifact publish` command with
`--experimental` and the exact current-turn context. Update the host's tools
artifact as well as its project-host artifact: older tools may not include this
command. If publication is unavailable or fails, report that and offer a normal
file link, not a direct `.chat` edit. Creating a file alone does not publish an
artifact, and publishing proposed actions does not authorize their execution.

This path has live fixture coverage for publication, scoped readback and opening
the saved file after a browser reload. It is not a claim of automatic artifact
generation or full native Codex workbench parity.

### Setup Steps

1. Deploy a compatible frontend and project host. Set
   `COCALC_ACP_HARNESSES=1` in the project-host environment and restart that host
   using its normal deployment procedure. Only enable test hosts initially.
   Old hosts fail the versioned ACP request rather than falling back to Codex.
2. Install a pinned harness and any required adapter inside the project/image.
   Install explicitly as the project user; CoCalc does not invoke package
   installers when a conversation starts. Check dependency/runtime requirements
   and provider configuration before creating an agent.
3. In **New Agent**, choose the disposable project and the custom ACP runtime.
   Enter a descriptive harness name, installed revision, absolute executable
   path, and one argument per line. Arguments are passed directly, not interpreted
   as a shell command. The working directory comes from the chosen project path.
4. Prefer **Create and configure first** to
   register the agent without sending the initial prompt (typed text is kept as
   a draft). Open **ACP: [harness name] settings** in the chat toolbar, then
   use **Load model and mode options** before
   the first prompt to discover supported selectors. This explicitly starts and
   cleans up a temporary harness session with project access; it sends no prompt
   and does not load or replace the conversation's native session. Without
   discovery or advertised controls, project configuration determines the model.
5. Select the intended model, then submit a short text prompt. Check output,
   interrupt behavior and browser reload before using longer tasks.
   Selectors affect newly submitted turns, not running or already queued turns.
   Use a fresh conversation when changing the installed runtime profile/version;
   do not assume native sessions can migrate across harnesses or versions.

For OpenCode 1.18.31, the tested launch shape is an absolute path to `opencode`
with one argument, `acp`. For Pi 0.86.1, the tested adapter is `pi-acp@0.0.33`,
launched by its absolute executable path with no extra arguments. These are
tested pins, not automatic installation recipes or a promise about newer
versions. Install both Pi and its adapter so their normal dependency resolution
works inside the project.

A wrapper executable is useful for project-specific configuration, but stdout
must contain only the ACP JSON protocol. Send diagnostics to stderr. Do not
embed a provider key in the wrapper's arguments or copy host/account credentials
into it. A wrapper must preserve the child's lifecycle and terminate its own
background processes when stopped.

## Supported Conversation Features

- Durable text conversation, streamed text/tool activity, browser reconnection,
  sequential follow-up and cancellation.
- Native session loading when the harness advertises compatible support. An
  uncertain execution is not automatically resubmitted; inspect its state before
  deliberately sending again.
- Harness-advertised model/configuration controls, with legacy mode support.
  These describe harness behavior; they do not change container isolation.
- Required-string ACP form questions through CoCalc's persistent QA interface,
  including bounded enumerated choices. Optional/non-string schemas and URL/auth
  elicitation are not supported. Never enter credentials in a QA response.
- Authorized queued agent-network messages through the existing network
  permissions and scoped identity. Immediate steering/guidance is not supported
  on this runtime path.

Images/attachments, generic scheduled automations, Codex goals and native Codex
payment/recovery options are not supported by this initial adapter. Unsupported
options fail explicitly instead of being silently interpreted as native Codex.
ACP extensions and model quality vary by harness; this is not universal protocol
or model certification.

## Local Or Offline Inference

Configure the harness to use the customer's local model service or private
OpenAI-compatible gateway. Pin/download packages and model weights during
explicit provisioning; do not depend on runtime downloads, hosted login or
public model catalogs in an offline deployment.

Two separate qualification tools are available under
`src/packages/ai/acp/__tests__`:

- `harness-provider-smoke.ts` exercises real Pi/OpenCode processes against a
  deterministic simulated provider, including file writes and follow-up. Its
  `--require-loopback-only` option verifies an already isolated namespace.
- `harness-local-model-smoke.ts` exercises Pi against an actual operator-supplied
  llama.cpp server and GGUF model. It requires a loopback-only Linux namespace
  and does not download anything or supply real credentials.

Neither flag creates isolation. Run these bundled probes in a separately
provisioned disposable `--network=none` container with compatible runtimes and
writable scratch space. The qualification record contains the exact tested
versions/checksums and limits. Passing standalone offline probes is not proof
that the complete CoCalc deployment is air-gapped.

### Build And Run The Probes

From a prepared source checkout, build portable CommonJS bundles. These commands
use the existing frontend development dependency on esbuild; they do not install
a harness or call a model:

```sh
pnpm -C src/packages/frontend exec esbuild ../ai/acp/__tests__/harness-provider-smoke.ts --bundle --platform=node --format=cjs --outfile=/tmp/cocalc-harness-provider-smoke.cjs
pnpm -C src/packages/frontend exec esbuild ../ai/acp/__tests__/harness-local-model-smoke.ts --bundle --platform=node --format=cjs --outfile=/tmp/cocalc-harness-local-model-smoke.cjs
```

Transfer the needed bundle into a disposable project with its pinned harness
already installed. Run **one** of these provider probes there, replacing the
absolute executable path with the actual project path:

```sh
node cocalc-harness-provider-smoke.cjs /absolute/path/to/opencode
node cocalc-harness-provider-smoke.cjs /absolute/path/to/pi-acp pi
```

The trailing `pi` selects Pi configuration; omit it for OpenCode. For example,
append `--provider-reject` to check authentication failure reporting without a
real key. Append `--require-loopback-only` only inside an already provisioned
network-isolated test container. Each provider probe creates a fresh temporary
HOME and workspace; the test's file writes do not target the project's real work.

For actual local inference, provision the model and server first, then run inside
the separate loopback-only container:

```sh
node cocalc-harness-local-model-smoke.cjs /absolute/path/to/pi-acp /absolute/path/to/llama-server /absolute/path/to/model.gguf
```

The local-model probe starts its own server on port 18995. Do not run overlapping
copies in the same network namespace. Neither probe is a production launcher or
a substitute for testing the durable chat UI.

### Simulated Provider Failures

The provider smoke tool also accepts one optional fault mode per invocation:

| Flag                 | Check                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--provider-reject`  | HTTP 401 must produce a classified rejection, not an empty successful answer.                                    |
| `--provider-retry`   | One task-inference HTTP 503, followed by successful file-write and same-session follow-up.                       |
| `--provider-exhaust` | Repeated task-inference HTTP 503 must eventually reject within the probe's budget.                               |
| `--provider-cancel`  | Cancel during task-inference retry, require `cancelled`, and observe three seconds without another task request. |

These use fresh temporary harness homes, fake credentials and a loopback provider;
they do not validate a real API key or pay for inference. Discovery is checked to
make no inference request. The 90-second overall budget belongs to this probe,
not to normal long-running CoCalc turns.

The unmodified pinned Pi bridge intentionally fails `--provider-reject`; the
experimental patch passes rejection, retry, exhaustion and cancellation checks.
Pinned OpenCode passes rejection, retry and exhaustion but intentionally fails
the strict cancellation result check described above. Do not weaken the checks
or mistake those expected failures for qualification passes. These standalone
probes are distinct from durable worker/browser tests and do not establish
indefinite cessation of background activity.

A live browser-to-worker check also completed Pi/local-Qwen inference with
public egress blocked in the disposable project's network namespace. The harness
sidecar shared that namespace; only loopback and the existing CoCalc host
transport were allowed. The completed answer survived browser reload. This was
temporary operator-applied test containment, not a shipped network-policy UI or
proof that the host/control plane can run fully air-gapped. No paid inference or
real account credentials were used.

## Disable Or Roll Back

Disable the host opt-in to reject new ACP work. Keep compatible host software
available while existing runtimes drain so cancellation and persisted history
remain accessible. Do not delete chats or provider/session directories as a
substitute for rollback, and do not convert failed ACP requests to Codex.

Report the installed executable/adapter revisions, profile identifier, project
and operation IDs, and a redacted error when diagnosing a failure. Do not paste
provider keys, auth files, full process environments or unreviewed raw protocol
logs. Project-host errors intentionally avoid logging launch arguments.

## Failure Checklist

- **Execution is not enabled:** verify the opt-in on the project host that owns
  the project, not just the hub or browser. Keep native Codex separate; do not
  change payment settings to work around an ACP admission error.
- **Startup or protocol failure:** check the absolute executable, argument order,
  project working directory and pinned adapter version. Launch stdout must be
  ACP protocol only. Inspect bounded, redacted stderr locally rather than
  posting environment dumps or auth files.
- **Harness rejected the request:** check its project-managed provider/model
  configuration. The displayed error is deliberately sanitized. Use the local
  rejection probe to distinguish a bridge-reporting problem from real provider
  configuration; the probe does not validate your real key.
- **Unknown outcome after interruption:** inspect files and persisted activity
  before choosing to resubmit. A cancellation request is not proof that an
  external action was undone, and browser reload is not permission to replay it.
- **Apparently missing container state during operator diagnostics:** use the
  same Podman runtime directory and bundled container configuration as the
  running host. A different `XDG_RUNTIME_DIR` can make an existing crun state
  appear missing. Do not delete state or kill processes based on that error
  alone. Production launchers already obtain this environment via `podmanEnv()`.
