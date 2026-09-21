# ACP Harness Integration Plan

Created: 2026-09-19. Revised: 2026-09-21 after scope discussion.

Status: implementation in progress. The isolated ACP client and deterministic
qualification tools are implemented. Opt-in admission, sidecar launching and
durable chat wiring have passed a live deterministic-fixture check, including
two-turn reuse and cancellation. Experimental Agents workspace creation has now
passed browser submission, reload, follow-up and interruption using a fixture.
Manual full-project snapshot recovery passed; home-only restore exposed an
existing rootfs staging failure. OpenCode and Pi have passed
real-process, local-fake-provider smoke tests, including network-disabled tests.
Pi also passed actual local Qwen inference in a separate network-disabled
container. Durable OpenCode resume, same-project queued agent messaging, external
text-editor convergence, and supported ACP form questions through the persistent
QA UI have live evidence. This is not the full release qualification below;
the real local model also works through the durable browser path, but that path
has not yet been qualified with public egress blocked.
See [implementation checkpoint](acp-harness-progress-2026-09-21.md).
Implementation base: `feature/my-agents-workspace` (PR #640), initially
`d0775fa58f`. Development branch: `feature/acp-harnesses`.

## Product Decision

CoCalc provides the persistent, collaborative, recoverable project around the
customer's chosen agent. **ACP is the standard integration path; native Codex
remains the optimized, unchanged default.** This is not a new harness, a model
certification program, or an editor that asks permission for every edit.

Customers can already run harnesses in a project terminal. Our additional value
is the Agents workspace, persistent chat, useful output rendering, reconnect,
artifacts, agent networks, and eventually scheduled execution through the same
runtime path. Support a model/harness combination when the harness supports the
model and exposes compatible ACP, directly or through a bridge. Customers choose
and evaluate task quality; CoCalc is responsible for faithful integration,
durability, resource limits and enforcement of CoCalc authority.

**First deliverable:** run an operator-installed ACP harness in a containerized
CoCalc project, using project-managed configuration and credentials, full-access
execution, persistent chat, streaming progress, cancellation, browser reconnection,
and verified project snapshot recovery. Demonstrate customer-local inference
without a required cloud service. Extend the Agents workspace from PR #640.

Initial users have no collaborators or only highly trusted ones. The project is a
meaningful boundary compared with an agent on a personal laptop: it should not
inherit unrelated host files or credentials. Inside the project it is deliberately
powerful. Do not claim private per-agent files or secrets in a shared project.

### Scope Boundary

| Required initially                                                 | Later / not a first-release gate                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Containerized execution, operator-installed pinned executables     | Containerless cocalc-plus support                           |
| Custom launch profiles, project-managed credentials                | Managed broker, subscription login, authentication wizard   |
| Full-access execution within project authority                     | Universal enforced read-only mode, per-tool approval UI     |
| Durable chat, streaming, cancel, reconnect, honest recovery        | Exact cross-harness migration or automatic failover         |
| Existing identities and agent networks                             | A second identity/grant system or replacement scheduler     |
| Git review, file persistence, editor convergence, snapshot restore | Per-edit TimeTravel qualification or elaborate tool-diff UI |
| Local inference/private gateway demonstration                      | Installation marketplace and automated setup/update wizard  |

Scheduling is a follow-up through existing automation machinery, not a prerequisite
for the first interactive slice. Qualify unattended startup, configuration binding,
authority and failure handling before advertising ACP scheduling. Preserve native
Codex automations throughout.

## Architecture And Existing Code

```text
Existing Agents workspace / chat / artifacts / agent networks
                            |
       CoCalc durable admission, events, history and authority
                            |
                   Runtime adapter contract
                    /                    \
            Native Codex              Generic ACP client
                    |                    |
            Codex app-server       Harness + optional ACP bridge
                    |                    |
               Configured provider / customer-local inference
```

Keep project-host Conat transport. ACP normally runs over stdio between the
supervised worker and a process inside the project container, not a browser-owned
process or new public listener. Browser disconnect must not stop execution. Reuse
project-host execution and run identity machinery, not a privileged host launcher.

Existing boundaries are useful but still Codex-specific:

- [Runtime types](../packages/ai/acp/types.ts) take Codex configuration and goals.
- [Execution service](../packages/lite/hub/acp/index.ts) constructs Codex directly
  and contains Codex-specific recovery behavior.
- [Native adapter](../packages/ai/acp/codex-app-server.ts) stays intact.
- [Shared events](../packages/conat/ai/acp/types.ts) remain the frontend transport
  boundary and evolve additively.
- [Project-host execution](../packages/project-host/codex/codex-project.ts) has
  reusable lifecycle/identity machinery, not a universal launcher yet.
- [Legacy ACP handler](../packages/ai/acp/codex-handler.ts) and
  [file/terminal adapters](../packages/ai/acp/adapters.ts) need qualification before
  reuse. The handler currently cancels permissions; existing adapters do not prove
  generic streaming, cancellation or protocol compatibility.
- [New-agent defaults](../packages/frontend/agents/new-agent-defaults.ts) still
  copy Codex configuration. Extend this workspace, not a parallel creation flow.

### Configuration And Identity

Keep named CoCalc identity, runtime profile, native runtime session, admitted run,
and agent-network membership separate. Reuse #640 contracts. Native children do
not automatically acquire independently authorized CoCalc identities or grants.

Introduce versioned discriminated configuration (`codex-native` and `acp`) with
validated runtime-specific fields. Existing threads without a discriminator retain
native Codex behavior. Do not relabel `CodexSessionConfig` as universal or perform
a mass rename/refactor before delivering the first slice.

Initial profiles contain executable, structured arguments, nonsecret environment,
working-directory rules, harness/bridge versions and project configuration
locations. Do not put secret values in profiles, launch arguments, chat metadata
or diagnostics. Installation is an explicit operator action; viewing a catalog or
submitting a turn never implicitly installs a mutable `latest` package. Support
operator-provided offline artifacts; review provenance and redistribution licenses
before shipping curated binaries.

Persist the effective profile revision at admission. Bind native sessions and
retained runtimes to project, principal and profile; project-based adapter lookup
must not mix harnesses or authorities. Configuration changes affect future
admissions, not running processes. Record effective runtime/version, model/provider,
credential mode and capabilities without credential values.

Changing harness starts a new native session, optionally with a visible context
handoff, not an exact resume. Model/provider changes use supported controls and
respect data-routing policy. No silent provider, harness or account fallback.
Preserve native Codex credential selection and accounting behavior.

### Runtime Contract And Capabilities

Define neutral initialization, new/load session, prompt, cancel, capability discovery
and disposal. Steering, goals, forking and descendant management remain optional;
do not force ACP harnesses to emulate Codex or remove native Codex features.

Start with a pinned stable ACP v1 SDK and verify released versions before coding.
Do not depend on draft v2 or assume upstream main-branch extensions have shipped.
Audit dependency changes across packages. Prefer negotiated upstream extensions
over a private protocol dialect.

Capabilities intersect advertisement, implementation and site policy. Unsupported
controls have explanations. Validate attachments before sending; never drop them.
Render supported model/mode controls rather than Codex presets. Allow explicit
model identifiers where supported without mandatory external catalog discovery.
Usage/background status can be unknown, not invented as zero. Bound untrusted
adapter metadata; it is neither executable UI nor authorization.

## Execution Policy And Human Questions

### Full Access First

The first mode is full access (YOLO) **inside the existing project boundary**.
Configure supported harness modes accordingly. No per-tool approval workflow.
Handle remaining ACP permission requests deterministically under that policy,
using protocol-defined outcomes. Unsupported interactions must fail clearly rather
than hang, silently change modes, or fabricate support.

Tool permission is not CoCalc authorization: the handler cannot grant account
access, new network links, connectors, billing privileges or host access. Full
access does not authorize arbitrary privileged client callbacks or new host mounts.

**Questions differ from permissions.** Reuse the current QA/attention UI and durable
response machinery for supported structured task questions. Missing instructions
still need a human answer in YOLO mode. Bind questions/replies to principal, run
and native session, handle cancellation/stale replies, and preserve answers in
visible history. Do not route ordinary tool approvals through QA by default.
CoCalc authentication and grant flows remain typed and separate; never request
secrets through chat. Unsupported elicitation fails explicitly.

### Read-Only Container Follow-Up

Investigate a dedicated Podman execution container mounting project data read-only,
with separately bounded writable scratch/runtime storage. This can enforce
filesystem restrictions independently of harness behavior; reuse existing machinery
rather than building a new sandbox. It does not gate initial full-access delivery.

Check alternate writable mounts, symlinks, inherited sockets, CLI/API write grants,
and delegation to writable project processes. A read-only mount does not stop an
authorized API write. Define the promise narrowly (project data read-only), distinct
from preventing network side effects. Only offer the mode after its restrictions
are tested; a harness mode label alone is insufficient. Do not alter native Codex
modes incidentally as part of this work.

### Network Restriction Follow-Up

Investigate project-wide or agent-container network-disabled and allowlisted modes
using current container/network controls. Define the scope explicitly: project-wide
restrictions can affect collaborators; agent restrictions must cover descendants
and cannot be bypassed through unrestricted terminals, proxies or tool callbacks.

Explain how inference and required CoCalc services remain reachable. Allowlisting
requires DNS, redirect, private endpoint and egress enforcement policy, not merely
a provider URL. An optional local gateway/broker may help later, not a first-release
dependency. An allowed inference endpoint still receives prompts; this is not a
universal non-exfiltration guarantee.

## Credentials And CoCalc Authority

First-release credentials use harness project configuration or operator-provided
environment. Explicitly disclose project sharing and possible backup/snapshot
inclusion. Customer binaries and bridges are executable code with project access;
do not inject account-wide or site credentials into unqualified custom harnesses.
Diagnostics are bounded and redacted; content logging is not the default.

Keep existing run-scoped CLI identities and tool grants. Peer messages are
attributed agent input, not human instructions or permission grants. Recheck
authority at asynchronous delivery and queued execution. Do not inherit another
account's busy runtime just because the named agent/thread matches. MCP can follow
where useful; the existing authorized CLI should work without a new connector
catalog. Enforce tool authority at the service, not only in supplied configuration.

Follow [scalable architecture](scalable-architecture.md): account home bays own
account configuration/grants, project owning bays authorize actions, and assigned
project hosts execute them. Route ownership explicitly. Keep steady-state ACP
and inference traffic off the hub. No new grant system for agent networks.

Managed brokering, subscription authentication and setup wizards are later work.
If added, preserve native provider protocols, approved fixed routes, lease/revocation
and resource/spend limits, protected upstream secrets and explicit private-endpoint
policies. A broker hides an upstream key; it does not isolate same-UID agents or
prevent authorized spending. Do not assume subscription OAuth is an API key.

## Persistence, Recovery And Workspace Correctness

CoCalc owns admission, queueing, history and browser replay; the harness owns native
context and compaction. Keep native session files in supported durable storage.
Do not substitute rendered chat or parse Codex rollout formats for other harnesses.

Persist operation IDs before delivery and associate native IDs where available.
Distinguish starting, running, awaiting input, completed, cancelled, failed and
outcome unknown. Respect prompt stop reasons: acknowledgment is not completion.
Track background work separately from foreground completion.

Bound frames, buffering, stderr and replay; implement backpressure. Deduplicate by
stable identity where available, never text alone. After ambiguous delivery,
reconcile if supported; otherwise show uncertainty and require explicit continuation.
Do not inherit Codex-specific automatic resubmission for ACP. Browser reconnect
and native session resume are different; unsupported resume must be visible.

Permit long turns without a short overall deadline. Use suitable startup/request/
stall limits. Separate requested from confirmed cancellation; supervise process
groups and descendants. Do not claim all background work stopped without evidence.

Preserve live versus queued agent-network policy. Unsupported steering is reported,
not silently queued or simulated with cancel-plus-reprompt. Test completion/steering
races, account binding and duplicate prevention.

### Recovery Over Edit Micromanagement

Use existing git diffs and artifact views. New tool-diff UI and per-edit TimeTravel
qualification are not gates. Required: writes persist, open editors converge via
supported synchronization, artifacts remain usable, and project snapshot/restore
works for harness-written files. ACP file callbacks must not blindly overwrite
unsaved collaborative state. Diff notifications alone do not establish history.

The operational target is automatic snapshots every 15 minutes. Verify the actual
schedule, retention and restore path instead of assuming every deployment has it.
Recovery copies must not be deletable by ordinary project agent authority. Test
destructive changes and restore in disposable projects; reuse existing snapshots,
not a second ACP-specific backup service.

Snapshots make destruction recoverable, not impossible: intervening work can be
lost, failed snapshots matter, and external actions/disclosure cannot be undone.
This still greatly reduces the risk of losing years of unprotected work. Do not
claim application/database-consistent recovery without separate evidence.

## Implementation Sequence

Use reviewable increments, not one giant implementation PR. Stack the initial PR
on #640 while it is open, then reconcile the base with merged main.

### 1. Contract And Regression Baseline

- Inventory configuration, launch, events, attention, admission, recovery, billing,
  identity/network delivery and UI coupling.
- Add the discriminator and narrow runtime-selection boundary; preserve serialized
  native defaults rather than moving the entire Codex implementation.
- Build a deterministic fake ACP executable covering handshake, streaming, tools,
  questions, policy-driven permissions, cancel, malformed frames and crash races.
- Exit: native tests pass; generic requests cannot accidentally enter Codex-only
  recovery, session handling, credentials or funding paths.

### 2. Containerized End-To-End Slice

- Launch an operator-installed executable with structured arguments inside the
  project container, without shell interpolation or implicit installation.
- Implement negotiation, supervised stdio, bounded normalized events, persistent
  chat, session binding, task questions and policy-driven permission responses.
- Add minimal custom-profile selection to existing agent creation/settings; show
  harness/model and capability gaps. Native Codex stays the default.
- Start with OpenCode. Investigate Pi's ACP bridge early: RPC/SDK support is not
  evidence of native ACP. Qualify a maintained bridge or explicitly budget a thin
  adapter, not a separate CoCalc architecture. Use another released ACP harness
  as the second target if Pi is blocked.
- Exit: create an agent, prompt, stream, edit a file, answer a supported question,
  cancel and reconnect the browser without losing the live operation.

### 3. On-Prem, Recovery And Agent Networks

- Demonstrate local inference/private gateway with public egress blocked after
  provisioning. Startup, model selection and execution must not require cloud
  login, public catalogs, downloads, hosted inference or telemetry delivery. Audit
  both CoCalc and the selected harness configuration for this demonstration.
- Exercise worker/project restart, supported native resume, ambiguous-delivery UI,
  editor convergence, artifact reopen and restore after destructive file changes.
- Exercise authorized network messages, queueing, supported steering, stale replies
  and account isolation through #640's contracts.
- Exit: two real harnesses use the same runtime/UI contract; at least one uses
  local inference. Publish exact tested versions and capability gaps. No model
  intelligence threshold is required for customer-configured models.

### 4. Opt-In Release And Follow-Ups

- Release additively for containerized projects; document custom profiles,
  project-shared credentials, offline provisioning and lifecycle limitations.
- Use fixtures/fake providers for most tests plus a small, explicitly budgeted
  real integration matrix. Never spend inference tokens merely on discovery.
- Disable new ACP admissions for rollback without removing cancellation, history
  or recovery. Do not silently downgrade incompatible native session formats.
- Follow up separately on scheduling, read-only containers, network restrictions,
  curated installation and managed credentials. None is a hidden prerequisite.

## Validation Gates

- Native regression: resume, goals, attention, steering, credentials, funding,
  descendants, artifacts, automations and agent networks remain covered.
- Protocol: pinned versions, capability gaps, stop reasons, malformed/oversized
  frames, stderr separation, backpressure and unsupported attachment rejection.
- Durability: browser disconnect, worker kill, project restart, uncertain delivery,
  queueing, replay and long idle periods; no unsafe automatic resubmission.
- Policy: deterministic full-access permissions, interactive task questions,
  unsupported requests do not hang, no additional CoCalc authority.
- Isolation: correct container launch, no unrelated host mounts/secrets,
  principal/session binding and revoked grants at async boundaries.
- Workspace: saved files, editor convergence, git review, artifacts, actual
  snapshot cadence and restore from agent-inaccessible recovery storage.
- Product: two harnesses, local inference, useful normalized output, visible
  unknown states and redacted versioned diagnostics. Do not promise preservation
  of every harness-specific UI extension through ACP.
- Accessibility: follow [existing guidance](accessibility.md), theme, role/name
  tests, keyboard/focus, narrow layout, zoom and light/dark checks.
- Checks: focused tests/typechecks, frontend lint and dependency consistency.
  Record versions, commands, live budgets, outcomes and residual gaps.

## Explicit Non-Goals

- Replacing native Codex with ACP, building a harness, or requiring codex-router.
- Certifying every model, silent provider fallback, or exact cross-harness resume.
- A new scheduler, simulated native goals/subagents, or parallel grants system.
- Per-tool approval UX, a new diff-review product, or per-edit history guarantees
  as prerequisites for full-access ACP.
- Managed-service polish, cocalc-plus, universal read-only/network enforcement in
  the first release, or depending on draft protocol features.
- Claims of private per-agent secrets or tamper-proof history in shared projects.

## References

Initial research: 2026-09-19; OpenCode/Pi documentation rechecked in the 2026-09-21
discussion. Verify released versions before implementation; these references
describe integration surfaces, not CoCalc qualification results.

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [Authentication](https://agentclientprotocol.com/protocol/v1/authentication) and
  [elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)
- [ACP v2 migration](https://agentclientprotocol.com/protocol/v2/migration)
- [OpenCode ACP](https://opencode.ai/docs/acp/) and
  [providers](https://opencode.ai/docs/providers/)
- [Pi integration modes](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Gemini ACP](https://geminicli.com/docs/cli/acp-mode/)
- [Agents workspace PR #640](https://github.com/sagemathinc/cocalc-ai/pull/640)
