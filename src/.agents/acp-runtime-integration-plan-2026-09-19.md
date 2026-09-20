# ACP Runtime Integration Plan

Date: 2026-09-19

Status: proposed; documentation only. No harness has been qualified in CoCalc by
this plan. Baseline: `origin/main` at `c02607101b`.

## Product Decision

CoCalc provides a reliable, persistent, collaborative environment for the
customer's chosen agent. **ACP is the standard integration path; native Codex
remains an optimized path. Model-quality certification is optional, not the
admission gate.**

Support "model X with harness Y" when Y supports X and exposes a compatible ACP
interface, directly or through an adapter. Do not promise arbitrary combinations
that the harness itself cannot run. Customers should not need CoCalc to benchmark
their preferred model before they can use it.

This is an expansion of CoCalc, not a replacement of the working Codex integration
or a new agent harness. Preserve the complete product: persistent projects,
collaboration, artifacts, TimeTravel, agent identity, messaging, and connectors.
Different runtimes may offer different additional capabilities, clearly exposed
rather than silently simulated or reduced to the lowest common denominator.

### Responsibility Boundary

| Owner                      | Responsibility                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CoCalc                     | Correct protocol integration, durable orchestration, faithful UI, installation/configuration, resource limits, credential handling, and enforcement of CoCalc authority. |
| Harness/adapter maintainer | Model integration, prompts, tools, reasoning formats, compaction, and the harness's internal execution behavior.                                                         |
| Customer                   | Choice of model/harness/provider and evaluation of task quality, cost, and suitability.                                                                                  |

CoCalc still tests that its integration does not lose inputs, fabricate completion,
misroute credentials, or degrade native harness behavior. That is different from
certifying model intelligence. We remain responsible for CoCalc's recommended
defaults and any explicit claims we make about them.

## Scope And Starting Point

Ship a generic ACP runtime alongside native Codex, curated launch profiles, a
customer-configured ACP option, explicit capability reporting, and usable
authentication/configuration. Do not require a separate bespoke integration for
each model. Validate against more than one harness so the adapter is genuinely
generic.

Current source has useful boundaries but is not already a generic ACP client:

- [Runtime interfaces](../packages/ai/acp/types.ts) expose evaluation, steering,
  interruption, and status, but contain Codex-specific configuration and goals.
- [Native Codex adapter](../packages/ai/acp/codex-app-server.ts) handles app-server
  lifecycle and authentication; retain this implementation.
- [Execution service](../packages/lite/hub/acp/index.ts) constructs Codex directly
  and coordinates chat persistence, attention, recovery, and work tracking.
- [Shared event types](../packages/conat/ai/acp/types.ts) already provide a CoCalc
  transport boundary. Do not replace project-host Conat transport with raw ACP.
- [Project-host launcher](../packages/project-host/codex/codex-project.ts) manages
  project execution, run identity, and credentials. Generalize appropriate parts
  rather than bypassing them with an unrelated subprocess launcher.
- [Site-funded proxy](../packages/project-host/codex/site-funded-proxy.ts) is a
  precedent for keeping upstream keys outside the project container, not a
  ready-made universal provider proxy.
- [Legacy ACP handlers](../packages/ai/acp/codex-handler.ts) and
  [execution adapters](../packages/ai/acp/adapters.ts) are reusable candidates,
  not proof of compatibility with current ACP versions.

The Agents workspace and session-based messaging work in
[PR #640](https://github.com/sagemathinc/cocalc-ai/pull/640) is related work, not
included in this plan-only diff. Integrate against its eventual shared identity
and messaging contracts; do not duplicate its UI or introduce a second grant
system. The broader connector implementation is separate: this plan provides the
runtime integration points and preserves connector authorization.

## Architecture

```text
CoCalc Agents / chat / artifacts / attention UI
                      |
     CoCalc run lifecycle and normalized events
                      |
          Runtime adapter interface
             /                   \
    Native Codex adapter       Generic ACP adapter
             |                   |
    Codex app-server         Selected harness + optional ACP bridge
             |                   |
      Selected model/provider, directly or through a credential broker
```

The project host owns the worker/process lifecycle. ACP normally runs over stdio
between the worker and harness in the approved execution environment. Browser
disconnects do not terminate the worker. No public ACP listener or browser-owned
agent process is required.

### Identity And Configuration

Keep these concepts separate in storage and code:

- Named CoCalc agent identity: stable identity used for permissions and messaging.
- Runtime profile: adapter kind, harness/bridge identity and pinned version,
  launch configuration, provider configuration, and credential references.
- Runtime session: opaque harness session identifier plus adapter/profile binding.
- CoCalc run: one admitted execution with a bound human principal and authority.
- Agent Session: the messaging coordination group, not an ACP or Codex session.

Introduce a versioned, discriminated runtime configuration, initially
`codex-native` and `acp`. Shared fields describe product intent; runtime-specific
fields remain namespaced and validated. Avoid relabeling `CodexSessionConfig` as a
universal configuration while retaining its assumptions.

Existing threads without a runtime setting resolve to native Codex. Record the
effective profile revision, runtime version, model/provider, authentication mode,
principal, and capability snapshot for each run, without storing credential
values in chat metadata.

Do not automatically migrate native session history between harnesses. Changing
harness requires an explicit new runtime session. Offer an optional, visible
context handoff; distinguish it from an exact resume. Provider/model changes
within a harness use its advertised controls and respect customer data-routing
policy. Never silently fall back to another provider, harness, or account.

### Shared Runtime Contract

Define neutral operations for initialization, session creation/resume, input
submission, cancellation, attention responses, capability discovery, and disposal.
Optional operations cover steering, goals, forking, and descendant management.
Keep native Codex extensions available without forcing all ACP agents to emulate
them. Internal names may be clarified incrementally; a mass rename is not a phase.

Normalize events for messages, tool calls, diffs, plans, attention, usage, session
state, background work, and errors. Preserve bounded adapter-specific metadata for
inspection, not as executable UI or authorization. Treat runtime/model output as
untrusted content. Report unavailable usage or child status as unknown, not zero.

### Capability Negotiation

Use the intersection of protocol advertisement, adapter implementation, and site
policy. Record which features have actually been exercised for curated versions;
advertisement alone is not certification. Re-negotiate after reconnect/version
changes. Unknown extensions must not crash rendering or become permissions.

| Capability                                    | CoCalc behavior                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Text, tool progress, completion, cancellation | Baseline interactive integration, with explicit failure if missing.                                                                         |
| Persistent resume/history                     | Restore when supported; otherwise visibly mark the runtime session non-resumable. Never create an empty replacement under the old identity. |
| Images/resources                              | Validate before submission; reject unsupported attachments instead of silently dropping them.                                               |
| Permissions and structured questions          | Map supported requests to CoCalc attention UI with request/session/run binding. Unsupported interactions fail explicitly.                   |
| Live steering                                 | Deliver only through a known advertised mechanism; distinguish injection from queueing and interruption.                                    |
| Models, modes, effort, slash commands         | Render advertised supported controls; do not hardcode Codex choices for ACP.                                                                |
| MCP/CoCalc tools                              | Supply only authorized per-run tools and credentials through supported transports.                                                          |
| Goals, subagents, terminals, costs            | Preserve available semantics and indicate gaps. Native Codex functionality must not regress.                                                |

Start with a pinned stable ACP v1 SDK and implemented capabilities. ACP v2 was
documented as draft during this investigation; design the adapter boundary for
version negotiation, but do not make draft v2 a first-release dependency. Audit
SDK import/dependency changes across packages before replacing the current
`@agentclientprotocol/sdk` dependency.

Use narrow, negotiated extensions where needed, preferably existing upstream
extensions. In particular, the Claude adapter's source documents steering and an
experimental goal extension; verify the selected release rather than assuming
everything on its main branch has shipped. Upstream generally useful improvements
instead of accumulating a private protocol dialect.

## Lifecycle And Persistence

CoCalc owns durable admission, queueing, run attribution, and browser replay. The
harness owns its native model context and compaction. Store native session files
where they survive project restart/backup according to the runtime's supported
layout, separately from credential storage. Do not parse Codex rollout formats for
other harnesses or treat rendered chat history as a replacement for native state.

For each admitted operation, persist a CoCalc operation ID before delivery and
retain its association with runtime session/message IDs when available. Normalize
states such as starting, running, awaiting input, completed, cancelled, failed,
and outcome unknown; track background work separately from foreground completion.
ACP v1's prompt response and v2's insertion acknowledgment have different meanings.
No adapter may equate an acknowledgment with completed work.

Use bounded event buffering, payload limits, backpressure, and replay cursors for
CoCalc consumers. Deduplicate runtime replay using available stable IDs and
adapter-specific rules; never deduplicate distinct messages just because their
text matches. Document gaps when a harness cannot provide stable replay identity.

Lost acknowledgments or a worker crash can leave input delivery uncertain. Inspect
and reconcile using supported runtime state; do not automatically resubmit an
ambiguous prompt, steering message, tool action, or permission decision. If safe
recovery is impossible, show the uncertainty and require an explicit continuation.
Do not claim exactly-once execution from ACP alone.

Process cleanup must account for background terminals and subagents, not merely the
ACP parent process. Track process groups/leases, bounded idle lifetimes, and safe
shutdown. Cancellation requests and confirmed cancellation are distinct. State
which descendants were stopped or could not be inspected.

### Long-Running Turns And Messaging

Support multi-hour/day turns without imposing a short whole-turn timeout. Use
appropriate startup, individual request, heartbeat, and stall limits instead.

Preserve human-selected live versus queued messaging policy. If a runtime cannot
steer a busy turn, report that before setup where possible and on attempted
delivery; do not silently queue a message that was requested as live. Cancellation
plus a new prompt is not equivalent to steering. Handle the race where the turn
finishes while a steer is submitted without delivering twice.

The receiving turn must belong to the authorized account, not just the right
agent/thread. Recheck run and session authority at asynchronous boundaries and
before queued execution. Peer messages remain agent-provided content, not human
instructions or permission grants. ACP does not replace CoCalc messaging authority.

## Credentials And Trust Boundaries

ACP standardizes client/harness communication, not isolation or secret storage.
Customer-selected binaries and ACP bridges are executable code; being in a registry
does not make them safe recipients of account-wide or site credentials.

### Supported Credential Modes

| Mode                                 | Guarantee and limitation                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer-managed project credentials | Easy compatibility using a harness's own configuration/login. Explicitly project-shared; files may enter snapshots, TimeTravel where applicable, and backups. Do not label this private per-agent access.                                                                        |
| Managed native in-process login      | Existing Codex precedent: trusted installed executable, login RPC, ephemeral auth store. Credentials reach that process; this is not a claim that they remain outside the container. Only offer equivalents where the harness supports them and the launch profile is qualified. |
| Managed inference broker             | Preferred for managed API keys: upstream secrets stay outside the project; the harness gets a revocable scoped capability and a configured provider endpoint. Requires provider/harness compatibility, not automatic support for every login type.                               |
| Customer-operated gateway            | Permit explicit approved endpoints and customer credential ownership, including self-hosted inference, without mandatory CoCalc-hosted model routing.                                                                                                                            |

Reuse account secret storage and host credential machinery where appropriate; do
not create plaintext credentials in profile records, launch arguments, diagnostics,
chat rows, or repository configuration. An auth wizard must explain the selected
storage mode before accepting credentials. Use typed login/approval flows and
secret inputs, never chat messages asking users to paste credentials.

For managed broker mode:

- Preserve the provider's native wire protocol. Credential brokering is not model
  translation and must not require codex-router.
- Bind capabilities to account, project, runtime/run lease, provider route, expiry,
  and allowed model/resource policy. Support revocation and concurrent-request,
  byte, duration, and spend limits appropriate to the funding source.
- Keep upstream keys in protected host/service storage and out of project
  snapshots/backups. Scope refresh and rotation; do not inject refresh tokens into
  project code merely to simplify login.
- Authorize fixed configured upstream routes, not arbitrary caller-controlled
  URLs or an unrestricted HTTP proxy. Define redirect, DNS, TLS, and private
  endpoint policy; self-hosted private endpoints require deliberate operator
  configuration rather than a universal public-network restriction.
- Redact credentials and sensitive headers; content logging is not the default.
  State which service sees prompts and which provider receives them. Never add an
  undisclosed fallback or route to OpenAI for a non-OpenAI configuration.
- Account for in-flight work on revocation and cap its residual exposure. Disabling
  discovery or removing an environment variable is not revocation.

The broker hides a reusable upstream secret; it does not stop an authorized
harness from sending its available context to the allowed provider or spending its
allowance. A same-UID peer may be able to use a runtime capability. A private
directory or short-lived token does not establish per-agent process isolation.
Stronger guarantees require a protected execution boundary and are not advertised
unless implemented and tested.

Subscription OAuth and native login are separate compatibility cases. Do not
assume a subscription can be converted to an API credential or safely proxied.
Ship only supported flows, and show unsupported managed modes honestly. Customers
may still use an explicitly disclosed project-managed flow where site policy
allows it. Existing native Codex credential paths remain unchanged initially.

### CoCalc Authority And Placement

Reuse run-scoped identity, credential leases, fresh-auth policies, and connector
grants. Neither a model name nor an ACP permission dialog confers CoCalc account,
project, messaging, billing, or connector authority. Keep human attention requests
bound to the initiating principal/run; stale or different-account approvals fail.
Native subagents do not silently become independently authorized CoCalc agents.

Follow [scalable architecture](scalable-architecture.md): account home bays own
account configuration and grants, project owning bays authorize project actions,
and assigned project hosts execute them. Route explicitly across ownership
boundaries. Keep ACP streams and steady-state inference traffic off the hub;
locate brokers on protected hosts or dedicated data-plane services. Lite's trusted
same-machine mode must describe its weaker isolation, not pretend to be a host.

## Installation And User Experience

Provide two clear entry points: **Choose a configured runtime** and **Add a custom
ACP runtime**. A profile is configuration, not another user-facing agent identity.
Most users choose a named agent and see its harness/model/provider in settings.

Curated profiles specify harness and adapter versions, executable provenance,
supported authentication modes, install/update/uninstall behavior, capabilities,
and known limitations. Install verified/pinned artifacts where available; never
silently run a mutable `latest` package during a turn. Stage updates, retain a
rollback version, and do not replace running processes. Include adapter dependencies
and license review in packaging; do not equate harness availability with a right
to redistribute it.

Custom profiles allow an explicit executable, arguments, working directory rules,
nonsecret environment settings, and secret references. Launch in the project
execution boundary, never as a privileged host command. Validate sizes and paths;
use structured arguments rather than shell interpolation. Installation is a
deliberate authorized action, not a side effect of viewing a catalog. Allow
operator-provided/offline artifacts and configurable registries for self-hosters.

The setup wizard should:

1. Select/install a harness and any ACP adapter, or configure a custom executable.
2. Select its supported authentication mode and explain storage/data routing.
3. Configure provider/model through supported harness options; permit explicitly
   entered model identifiers where the harness accepts them without catalog lookup.
4. Run a no-inference protocol/configuration check. Offer a separately confirmed,
   bounded paid smoke test rather than spending tokens on discovery.
5. Show negotiated capabilities, restart/resume behavior, missing features, and
   which CoCalc tools/connectors are authorized before enabling the profile.

Diagnostics should separate installation failure, authentication failure, protocol
mismatch, provider rejection, and a model's unsuccessful task result. Export
redacted diagnostics with exact versions and correlation IDs. Do not expose raw
protocol payloads to unauthorized project collaborators.

Keep the Agents page/chat/workbench coherent across runtimes. Render unsupported
controls as unavailable with explanations. Preserve tool progress, questions,
artifact links and lifecycle, and a useful inspection view rather than raw JSON.
Use the established theme and [accessibility requirements](accessibility.md), with
keyboard/focus tests, narrow layouts, zoom, and light/dark mode checks.

## CoCalc Features Above The Harness

Artifacts remain CoCalc-managed files and metadata, not a Codex tool-call format.
Expose creation/update operations through existing authorized CLI APIs and, where
useful, a thin MCP bridge. Preserve preview/current-versus-snapshot semantics,
editing, publishing permissions, and recovery. Verify TimeTravel and collaborative
edit behavior for each execution route, including direct harness filesystem writes;
ACP diff notifications alone do not establish persistent edit history.

Connections remain grants to stable identities/runs, not global access acquired by
installing a harness. Pass only approved tools/MCP configurations to a runtime and
enforce authority at the tool service as well. A prompt mentioning a connection is
not permission. Keep the existing CLI usable so ACP support does not wait for an
entire new MCP/connector catalog.

Goals and native subagents are capability-dependent. Preserve native Codex support;
map other harnesses' supported controls/events, but do not build a replacement
subagent scheduler, simulate unsupported budgets, or repeatedly reprompt an agent
to fake a native persistent goal.

## Implementation Sequence

### 1. Contract And Regression Baseline

- Inventory Codex coupling in configuration, worker launch, event handling,
  attention, scheduling, recovery, billing, identity, and UI.
- Add the runtime/profile discriminator and neutral interfaces incrementally.
  Keep native defaults and its existing serialized state compatible.
- Build a deterministic fake ACP agent covering streaming, permissions, tools,
  optional capabilities, cancellation, malformed output, and crash/replay races.
- Exit: existing native Codex tests pass; the new contract can express current
  behavior without routing Codex through ACP or removing features.

### 2. End-To-End Generic ACP Slice

- Implement pinned v1 negotiation, stdio transport, process supervision, bounded
  streams, normalized events, attention, and explicit recovery outcomes.
- Support custom project-configured ACP execution with disclosed credential mode.
- Exercise OpenCode and the Claude Agent SDK ACP adapter as contrasting initial
  candidates. They are test targets, not prerequisites hardcoded into the generic
  client. Use Gemini or another maintained implementation if a target blocks.
- Exit: both candidates work in the same CoCalc chat/workbench path for their
  advertised baseline; browser reconnect does not lose a running operation.

### 3. Managed Setup And Authority

- Add curated install profiles and the configuration/authentication wizard.
- Implement a narrow managed broker route for the selected API-backed candidate;
  reuse broker infrastructure without generalizing unsupported protocols blindly.
- Bind runtime leases to CoCalc principals, project ownership, messaging, and
  connector policies. Integrate session messaging work when available.
- Exit: managed upstream secrets stay outside project storage/container for the
  broker path; custom credentials are clearly labeled; revocation is exercised.

### 4. Product Completeness And Qualification

- Exercise artifact creation/edit/reopen, TimeTravel, CLI/MCP tools, live and queued
  messages, permission/questions UI, and background/descendant lifecycle.
- Add capability-aware runtime/model controls, diagnostic export, setup recovery,
  update/rollback, and documentation for customer-configured runtimes.
- Exit: release gates below pass for pinned curated integrations; unsupported
  features are visible rather than silently substituted. Record integration
  coverage separately from any optional model-quality evaluation.

### 5. Controlled Release

- Enable ACP additively on staging, then for opt-in users; native Codex remains the
  unchanged default. Follow with self-host packaging and configuration docs.
- Publish an integration matrix by harness/adapter version, protocol version,
  auth mode, and tested lifecycle capabilities, not a whitelist of approved models.
- Track failures by layer and keep diagnostics bounded. Disabling new ACP runs
  must not remove stop/revoke controls or the ability to read existing history.
- Roll back by disabling new admissions and reverting profiles, without rewriting
  native histories or deleting customer artifacts. Do not silently downgrade a
  runtime against an incompatible persisted session format.

## Validation And Release Gates

Most validation should use scripted ACP fixtures and fake provider endpoints,
not expensive model benchmarks. Use a small, explicitly budgeted live integration
matrix to confirm real authentication and runtime behavior. Customer-configured
models do not require a CoCalc quality score.

- Native Codex: existing resume, goals, attention, steering, credentials, funding,
  subagents, and artifact behavior remain covered and unchanged.
- Protocol: version negotiation, unsupported capabilities, optional extensions,
  messages/diffs/questions, malformed/oversized frames, backpressure, and stderr
  separation; no secret or untrusted markup execution through diagnostic UI.
- Durability: browser disconnect, worker kill, project/host restart, lost response,
  queued delivery, replay, compaction, and long idle intervals during live work.
  Assert no automatic duplicate submission after ambiguous delivery.
- Lifecycle: cancellation with child work, permission pending during cancellation,
  steering versus completion races, session close, cleanup, and unsupported resume.
- Authority: different-account busy turns, stale approvals, expired/revoked leases,
  session pause/remove while work is queued, connector denial, and no authority
  fallback to broad account credentials. Use barrier tests at async boundaries.
- Credentials: fake canary upstream secrets absent from project files, process
  environment, logs, and backup inputs in broker mode; distinguish that guarantee
  from native in-process auth. Verify route binding, quotas, refresh/revocation,
  redaction, and explicit private-endpoint policy.
- Product: two real harnesses using the same UI, project tools, artifacts and
  persistent workspace; graceful missing capabilities; accessibility tests by
  role/name, keyboard, focus, theme, narrow viewport, and zoom.
- Deployment: one-bay operation plus owner-routing tests for cross-bay access;
  no steady-state ACP/inference stream through a control-plane shortcut.

Run focused package tests/typechecks, frontend lint for interactive changes, and
dependency version checks as the implementation progresses. Record exact versions,
test commands, budgets, outcomes, and residual gaps; do not call a capability
production-ready based only on its README or a successful streamed answer.

## Future Ideas Explicitly Excluded

- Replacing native Codex with its ACP adapter, or rewriting the existing harness.
- Making codex-router a required layer; it may remain a separate optional path.
- Certifying every model's intelligence, reliability, or fitness for customer work.
- Universal cross-harness context migration, compaction, or exact resume.
- Implementing a new subagent scheduler, automatic multi-harness routing, or silent
  provider failover.
- Shipping every ACP registry entry as a CoCalc-maintained installation.
- Replacing CoCalc's frontend transport with AG-UI, or messaging with A2A.
- Implementing all connectors, a complete provider billing marketplace, or generic
  subscription-to-API translation as prerequisites for ACP support.
- Claiming private per-agent secrets or tamper-proof chat history inside a shared
  project without an actual isolation/authenticity boundary.
- Depending on draft ACP v2 features for the first release; add negotiated v2
  support later when justified by released implementations.

## References And Evidence

Research reviewed 2026-09-19; recheck upstream release versions at implementation.
These sources establish integration surfaces, not CoCalc qualification results.

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP agents](https://agentclientprotocol.com/get-started/agents) and
  [clients](https://agentclientprotocol.com/get-started/clients)
- [ACP v1 authentication](https://agentclientprotocol.com/protocol/v1/authentication)
  and [elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)
- [ACP v2 migration and draft status](https://agentclientprotocol.com/protocol/v2/migration)
- [OpenCode ACP](https://opencode.ai/docs/acp/) and
  [provider configuration](https://opencode.ai/docs/providers/)
- [Claude Agent SDK ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp),
  [steering example](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/examples/steering.ts),
  and [experimental goals](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/docs/goal-extension.md)
- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/)
- [Pi's scope and integration modes](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [JetBrains registry and custom ACP setup](https://www.jetbrains.com/help/webstorm/use-ai-agents-with-webstorm.html)
