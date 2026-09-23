# Claude Code ACP Integration Plan

Date: 2026-09-21

Status: implementation in progress. The 2026-09-22 qualification record pins
the first adapter candidate and documents the current credential/tool isolation
blocker.

Current subscription work is specified in
`src/.agents/claude-subscription-support-plan-2026-09-23.md`. The foundation
below is a historical implementation snapshot; the qualified API-key adapter
is now pinned to `0.81.1`, and account API-key selection is available in the
Claude preview. Pro/Max subscription login remains unimplemented.

### Implemented Foundation (2026-09-22)

- Added a provider-neutral account credential broker with home-bay routing,
  account/provider mutation leases, exact-ID reads, verified-before-publish
  create/reconnect, identity checks, revocation, and bounded safe metadata.
- Added a verified Anthropic API-key adapter. Verification uses a bounded
  models-list request and stores only encrypted payload plus a safe fingerprint
  and billing metadata.
- Pinned and probed `@agentclientprotocol/claude-agent-acp@0.79.0` against
  CoCalc's ACP v1 client without inference or subscription authentication.
- Added version-2 qualified ACP profiles. Persisted chat state contains no
  executable or arguments; the project host resolves the pinned read-only
  executable and mandatory `--hide-claude-auth` argument from trusted code.
- Added the project-owned key launch path. The qualified entrypoint reads
  `/run/secrets/cocalc/ANTHROPIC_API_KEY` only after sidecar creation, so the
  value is absent from chat metadata, Podman arguments, and project-host env.
- Added a provider-neutral fixed-origin HTTP credential relay and sidecar
  loopback bridge. The durable account key remains in project-host memory; the
  sidecar receives only a short-lived capability usable against the admitted
  provider policy.
- Added exact-ID Anthropic account-key relay admission through the existing
  host/home-bay credential route, including project-host/account authorization,
  provider-profile validation, authority recheck, and fail-closed teardown.

Account-key selection is now account-local and pinned into admitted turns by
authenticated server code. A credential ID from shared thread metadata,
generic ACP profile data, or a collaborator-controlled config must never reach
relay admission.

Depends on:

- `feature/my-agents-workspace` / PR 640
- the generic ACP runtime described in
  `src/.agents/acp-runtime-integration-plan-2026-09-19.md`

## Objective

Make Claude Code a first-class CoCalc agent rather than an example of custom
ACP configuration.

A user should be able to:

1. Choose **Claude Code** from the New Agent catalog.
2. Select a project and working directory.
3. Install or verify a CoCalc-qualified, pinned Claude ACP runtime.
4. Connect a personal Claude Pro/Max subscription, configure an Anthropic API
   credential, or select an operator-supported enterprise provider.
5. Start a persistent graphical Claude conversation with streaming tool
   progress, cancellation, browser reconnection, and clear billing identity.
6. Return later and continue the same conversation without exposing account
   credentials to project collaborators, project files, snapshots, or custom
   harnesses.

The implementation should preserve the generic ACP foundation. Claude support
is a curated product integration layered on that foundation, not a Claude-only
fork of the chat stack.

## Product Position

CoCalc should offer three deliberately different levels of support:

1. **First-party Codex**: the existing deeply integrated runtime.
2. **CoCalc-qualified agents**: initially Claude Code, then selected harnesses
   such as OpenCode and Pi. These have pinned manifests, tested capabilities,
   guided installation, credential integration, and compatibility guarantees.
3. **Custom ACP agent**: an advanced escape hatch where the user supplies an
   executable and configuration. It receives project-managed configuration
   only and carries no CoCalc compatibility guarantee.

Ordinary users should not see executable paths, argument arrays, environment
maps, or raw ACP capability switches when creating Claude Code. Those remain
in the advanced custom-agent flow.

"Qualified" means CoCalc tests a specific adapter/runtime combination. It does
not mean CoCalc audits or guarantees every action performed by Claude or every
model response.

## Release Definition

The first public release is complete when a user can create, authenticate,
run, stop, reload, and resume a Claude Code agent through the CoCalc UI using a
supported Anthropic billing method, with exact credential attribution and no
regression to Codex or custom ACP agents.

The first release is interactive. Scheduled automation, credential sharing,
automatic credential failover, a general agent marketplace, and central CoCalc
billing for Anthropic are follow-up work.

## Supported Authentication And Billing Modes

Authentication method and billing source are separate, explicit product data.
CoCalc must never guess which account will be charged from ambient environment
variables.

### Personal Claude Pro/Max

- Account-scoped and owned by the signed-in CoCalc user.
- Connected through a typed provider login flow, not by pasting tokens into a
  chat, project secret, or generic form.
- Never available to another project collaborator for submitting a turn.
- Multiple named profiles are supported by stable credential ID from the first
  schema version, even if the initial UI emphasizes one profile.
- Default display names are privacy-preserving: `Claude`, `Claude - 2`, and so
  on. Email addresses are not shown in the chat bar unless the user explicitly
  chooses an email-like custom label.

### Anthropic Console API

- Supported as an explicit alternative, never as a silent fallback from a
  failed Pro/Max login.
- May be account-scoped for a personal key or project-scoped for a team-managed
  key.
- A project-owned key can use the project's existing trusted secret boundary.
  An account-owned key remains gated on credential/tool isolation just like a
  personal subscription.
- UI must state that Anthropic API billing applies.
- Existing secret-setting components and project-secret authorization are
  reused rather than introducing a new plaintext key store.

### Bedrock, Vertex And Enterprise Gateways

- Represented as distinct provider profiles with distinct labels and required
  configuration.
- Primarily project-, site-, or operator-managed rather than personal
  subscription credentials.
- Enabled only after the corresponding runtime path is qualified.
- On-prem administrators can disable providers, pin endpoints, and preinstall
  the Claude runtime.

## Terms And Provider Policy

Seek written confirmation from Anthropic that the intended integration is
permitted, while recognizing that vendors using the supported Claude Agent SDK
may not receive an individualized answer. The product and legal review should
evaluate the published terms and established SDK integration model rather than
making an unanswered inquiry the only release criterion.

The UI must link to the applicable Anthropic terms and clearly state that:

- each credential belongs to the individual user;
- CoCalc does not pool, resell, or share subscriptions;
- the credential is used only to run that user's selected Claude agent;
- collaborators cannot spend against the credential;
- CoCalc uses the maintained Claude Agent SDK/ACP adapter as intended.

Do not imply Anthropic endorsement. Re-check the published terms and SDK policy
before each rollout expansion, and retain a provider kill switch. Engineering
and qualification may proceed while confirmation is pending.

## Authority And Ownership

Follow `src/.agents/scalable-architecture.md`:

- The account home bay is authoritative for account-owned Claude credentials.
- The project owning bay authorizes access to the project and routes execution.
- The project host executes the ACP runtime and receives only the exact
  credential required for an admitted turn.
- Steady-state ACP traffic remains between the client and project host; the hub
  does not become a data-plane proxy.

Each Claude agent instance records an owner account ID. A collaborator may view
the shared transcript according to project permissions, but cannot submit a
turn using the owner's personal Claude credential. A collaborator must select
their own credential or create their own agent instance.

The server validates credential ownership from authenticated request identity.
It never trusts a credential ID persisted in shared chat configuration.

## Credential Architecture

Use the encrypted `external_credentials` registry and central account-home-bay
routing as the provider-neutral source of truth. Do not duplicate the Codex
registry schema, and do not couple Claude lifecycle code to Codex `auth.json`
semantics.

Build a provider-neutral credential broker with provider-specific adapters:

- `validate`: validate provider identity and determine billing/auth mode;
- `stageLogin`: create isolated temporary login state;
- `publish`: atomically publish verified state to an exact credential ID;
- `materialize`: prepare the minimum runtime credential representation;
- `refresh`: synchronize provider rotation against the same credential ID;
- `revoke`: invalidate central and local state;
- `describe`: return safe display metadata only.

Credential lifecycle operations use an account-and-provider-wide distributed
lease. Login, add, reconnect, refresh, and revoke cannot race across project
hosts or bays.

### Required Invariants

- Credential IDs are validated opaque UUIDs and never interpolated into paths
  without canonical containment checks.
- New credentials are staged outside the live cache and verified before
  publication.
- Reconnect targets one exact credential and verifies that provider identity
  remains compatible before replacement.
- Revocation fails closed. A revoked explicit credential does not fall back to
  another credential.
- A turn resolves and pins an exact credential ID at admission. Queueing,
  retries, default changes, and browser reconnection do not silently switch it.
- A pinned credential is revalidated when execution begins.
- Local credential state is per-account and per-credential, never an
  account-level directory mounted wholesale.
- Only verified provider state is synchronized back to the central registry.
- Credentials and login artifacts never enter project home, project secrets,
  chat configuration, TimeTravel, backups, logs, analytics, or exception text.
- Account deletion and account rehoming include external Claude credentials.

## Blocking Security Design: Separate Credentials From Agent Tools

This is the most important release gate.

Qualification on 2026-09-22 established that adapter version `0.79.0` runs
Claude's built-in Bash, file, and subagent tools through the Claude Agent SDK
runtime. ACP receives permission and rendering events but cannot relocate all
of those tools into CoCalc callbacks. The preferred architecture below
therefore requires upstream SDK/adapter support or a different controller
boundary; it is not achievable by only enabling today's ACP terminal methods.
See `src/.agents/claude-code-acp-qualification-2026-09-22.md`.

A process that can read a long-lived Pro/Max credential and also run
model-controlled shell commands may be induced to print or exfiltrate that
credential. Merely mounting the credential into the Claude sidecar with mode
`0600` is not sufficient when Claude and its tool subprocesses run as the same
user.

The qualification spike must establish one of these architectures:

### Preferred Architecture

Run the Claude controller/adapter in a protected sidecar that can access the
credential, while all filesystem and terminal tools execute through bounded
ACP client callbacks in the ordinary project container. The project container
does not mount the credential directory and receives no credential environment
variables or inherited file descriptors.

This requires implementing and testing the relevant ACP filesystem and terminal
callbacks in CoCalc rather than rejecting them. Paths remain confined to the
project, terminal processes use project resource limits, and cancellation kills
the complete process tree.

### Acceptable Alternative

Use operating-system isolation inside the sidecar so the controller identity
can read the credential but tool processes run as an unprivileged identity
that cannot read controller files, inspect controller `/proc` state, signal the
controller, inherit secrets, or access a credential-bearing socket.

This alternative needs an adversarial test suite and a security review. A UID
change by itself is not enough.

### HTTP API Credential Relay

API credentials have a simpler isolation option that does not require moving
Claude's built-in tools. Keep the durable key in project-host memory behind a
mode-0600 Unix-socket relay. Give one ACP sidecar only a random short-lived
capability and a local provider base URL. The relay fixes the upstream origin
and allowed path prefix, strips caller authorization headers, injects the
durable key, streams responses without following redirects, and closes with
the runtime. Model-controlled shell tools may use the admitted provider
session, but cannot read the durable credential; an exfiltrated capability is
useless after teardown and cannot address another origin.

This architecture is applicable to account-owned Anthropic API keys and other
HTTP providers. It does not by itself solve Claude Pro/Max credentials if the
native client cannot use a supported provider relay or brokered login flow.

### Non-Solution

Warnings, hidden paths, file permissions readable by the runtime user, and
redacting normal logs do not provide credential isolation.

If neither architecture is feasible with the maintained Claude ACP adapter,
personal Pro/Max support must not be generally released. Project-owned API
credentials may still be offered to explicitly trusted projects, with a clear
statement that the selected agent process can use that credential.

Custom ACP agents never receive account-owned credentials under any mode.

## Runtime And Package Qualification

Qualify the maintained `@agentclientprotocol/claude-agent-acp` implementation
and its official Anthropic Claude Agent SDK dependency. Do not rely on an
unversioned `npx -y` command at turn startup.

Maintain a catalog manifest containing:

- CoCalc integration ID and display metadata;
- exact adapter and SDK versions;
- package source, integrity hash, and supported platforms;
- ACP protocol/capability expectations;
- install and launch commands without user-controlled interpolation;
- known compatible CoCalc project-host versions;
- migration and rollback metadata.

Record the exact ACP schema and SDK version in the compatibility matrix. CoCalc
currently targets ACP v1 while ACP v2 is emerging; upgrading the protocol is a
separate reviewed migration, not an incidental consequence of updating the
Claude adapter.

Installation is an explicit operation with progress and failure reporting. It
targets a managed project cache or prebuilt project image, is reproducible, and
supports rollback to the previous qualified version. On-prem operators can
preinstall and pin the package globally.

Keep large harness payloads out of the universal tools bundle. The pinned
Claude Agent SDK currently contributes an architecture-specific executable of
about 220 MB, so use a separately versioned managed-harness artifact or host
cache instead of adding both architectures to every tools image.

An existing user-installed binary may be detected and offered through Custom
ACP, but is not silently treated as the qualified Claude runtime.

## ACP Capability Work

The current generic client already provides initialization, text prompts,
streaming updates, session load, cancellation, settings discovery, QA form
questions, and full-access permission selection. Claude qualification must
exercise and selectively add:

- typed ACP authentication negotiation;
- terminal/device login status where required by the adapter;
- typed session failures and provider-auth failures;
- foreground and background terminal execution through the isolated project
  tool plane;
- bounded filesystem callbacks through the project tool plane;
- model and effort controls;
- slash commands;
- images and attachments;
- TODO/plan progress;
- subagent transcripts and background-agent state;
- MCP server configuration, if supported without exposing credentials;
- complete cancellation, including subprocesses and subagents.

Do not claim support merely because the adapter advertises a capability. Each
capability needs a deterministic transcript test and at least one live
qualification test against the pinned runtime.

The permission callback remains a policy handler, not an interactive approval
system. In full-access project mode CoCalc selects the appropriate allow option
and logs the decision. A future enforced read-only mode uses a read-only project
mount or separate tool executor; changing a label is not enforcement.

## Authentication Flow

Add a first-party **Connect Claude** flow rather than exposing adapter terminal
output directly.

1. The user chooses a billing/authentication method.
2. CoCalc creates a login session bound to account, provider, requested action,
   exact target credential if reconnecting, nonce, and expiration.
3. Login runs in an isolated staging home with no project filesystem access.
4. The UI opens or presents the provider-authorized URL and device information
   through typed fields.
5. The UI polls typed status and supports cancel/retry.
6. Completion verifies provider identity and billing mode before atomic
   publication.
7. Only safe metadata is returned to the browser.

Never ask the user to paste an OAuth token, refresh token, cookie, or one-time
code into chat or a generic question response. If the provider requires manual
code entry, implement it as a typed, purpose-specific authentication action and
never persist the value.

Require CoCalc fresh authentication for reconnect, revoke, delete, and other
high-impact credential mutations. Enforce one active Claude login per account
and provider centrally, not with process-local state.

The UI must make provider billing unmistakable. In particular, detect and warn
when an API-key environment configuration would override an intended Pro/Max
subscription login.

## Session And Turn Semantics

An admitted Claude turn records:

- agent profile ID and pinned profile revision;
- adapter and SDK version;
- exact credential ID and billing mode;
- model and effort/mode settings;
- project, path, submitting account, and operation ID;
- native Claude session ID when resuming.

A retained runtime may be reused only when its adapter version, execution
policy, tool-plane identity, and exact credential ID remain compatible.

- The same credential can reuse a healthy runtime after authority
  revalidation.
- A revoked credential rejects the next turn.
- Changing credentials or runtime version takes effect on the next turn and
  replaces the runtime.
- Replacement is refused while background commands or subagents remain active.
- Internal retries retain the admitted credential ID.
- A credential change does not silently continue a native Claude conversation
  under a different provider identity. Start a new native session or require an
  explicit supported migration.

When settings change during a running turn, the chat bar visibly labels them
**Next turn**. The active turn's activity metadata remains unchanged.

## User Experience

### New Agent

Add a catalog card for **Claude Code** with:

- a concise capability and billing description;
- project and working-directory selection;
- installation status and explicit Install/Update action;
- authentication-method and credential-profile selection;
- model/mode selection populated from live capability discovery;
- a clear Full access execution statement;
- disabled creation with actionable errors when runtime, auth, or host
  capability is missing.

Move executable, arguments, environment, and raw ACP settings behind **Custom
ACP agent**.

### Account Credentials

Add a consistent Claude section to AI/Agent credentials:

- Connect Claude subscription;
- Add Anthropic API credential;
- profile label, status, billing method, created, last verified, and last used;
- rename, reconnect, revoke, and delete;
- stable initial sorting by last used without rows moving while labels are
  edited;
- safe generated labels instead of default email display.

### Chat

The agent bar shows:

- Claude Code and qualified runtime version;
- selected credential label and billing source;
- model and mode;
- **Next turn** state for settings changed during execution.

The activity log records the exact non-secret execution identity. Error states
distinguish login required, revoked credentials, quota/usage exhaustion, API
billing failures, provider outage, adapter failure, and project-host failure.

The transcript renders tool progress, plans, images, subagents, questions, and
background activity without reducing unknown ACP content to misleading plain
text.

### Accessibility

Before implementing these screens, follow `src/.agents/accessibility.md`.
Authentication dialogs must manage and restore focus, expose status changes in
an appropriate live region, work entirely by keyboard, remain usable at 200%
zoom and 320 CSS pixels, and use theme-aware `UI_COLORS`. Tests query controls
by accessible role and name and cover Escape, focus restoration, errors, and
loading state.

## Observability And Audit

Record non-secret structured events for:

- install, update, and runtime version selection;
- login start, success, cancel, timeout, and verified billing mode;
- credential selection, refresh, revocation, and cache cleanup;
- turn admission, runtime reuse/replacement, execution, cancellation, and
  failure class;
- ACP capability negotiation and unsupported events.

Never log provider tokens, cookies, authorization headers, complete login URLs
containing secrets, credential payloads, or unredacted adapter stderr.

Expose operator metrics for auth failures, adapter crashes, turn latency,
abandoned login sessions, stale materializations, unsupported ACP messages, and
runtime-version distribution.

## Implementation Sequence

### Phase 0: Provider And Isolation Qualification

- Pin a candidate Claude ACP adapter and Claude Agent SDK version.
- Verify the adapter against CoCalc's exact ACP schema/SDK version and record
  any v1 extension or v2 migration requirements.
- Document actual login protocols, credential file layout, refresh behavior,
  environment precedence, logout behavior, and native session persistence.
- Determine whether ACP callbacks can place all model-controlled filesystem and
  terminal work outside the credential-bearing controller.
- Build adversarial probes that ask tools to enumerate home, environment,
  `/proc`, open descriptors, sockets, and credential paths.
- Confirm cancellation and background-process behavior.
- Obtain or begin Anthropic terms confirmation.

Exit gate: a reviewed credential/tool isolation design and a reproducible
adapter manifest. Do not build the account login UI before this decision.

### Phase 1: Provider-Neutral Credential Broker

- Extract provider-neutral lifecycle interfaces around
  `external_credentials` and account-home-bay routing.
- Add distributed leases, exact-ID staging/publication, materialization,
  refresh, revocation, and GC.
- Add Claude provider validation and safe metadata.
- Add host capability/version gates so old hosts fail closed.
- Add project-host authorization that binds submitting account, project, agent,
  and exact credential.

Exit gate: focused multibay and adversarial tests pass; security review finds
no cross-account, cross-project, path, race, downgrade, or revocation bypass.

### Phase 2: Claude Runtime And ACP Capabilities

- Implement the selected controller/tool-plane separation.
- Add missing ACP auth, filesystem, terminal, session-failure, image, plan,
  command, and subagent support required by the pinned adapter.
- Add exact turn-admission pinning and runtime compatibility keys.
- Add native session resume, browser reconnect, cancellation, and crash
  recovery.
- Add deterministic fake-provider and fake-adapter fixtures.

Exit gate: the full conversation lifecycle passes without network access, and
live qualification passes with disposable Anthropic credentials.

### Phase 3: Curated Installation And Product UI

- Add the signed/pinned catalog manifest and explicit project installation.
- Add Claude credential management and typed login UI.
- Add the New Agent Claude card and guided setup.
- Add chat-bar billing identity, model/mode controls, **Next turn** state,
  activity metadata, and actionable errors.
- Add operator settings for enablement, versions, providers, and preinstall.

Exit gate: frontend lint, accessibility coverage, browser audits, narrow-width,
zoom, light/dark theme, keyboard, and real-browser end-to-end flows pass.

### Phase 4: Qualification And Controlled Rollout

- Merge current base branch changes and run the complete TypeScript build.
- Run frontend lint and focused AI, chat, frontend, project-host, Conat,
  credential, and server tests.
- Qualify Pro/Max, Console API, and each enabled enterprise provider separately.
- Test on a dedicated host allowlist, then an account allowlist, before
  site-wide enablement.
- Publish user and operator documentation, supported-version policy, known
  limitations, and rollback instructions.
- Complete security and provider-terms reviews.

Exit gate: no critical or high security findings, no Codex regression, and
successful rollback rehearsal.

## Pull Request Decomposition

Prefer reviewable, independently tested changes rather than one large PR:

1. **Qualification and manifest**: probes, pinned versions, capability matrix,
   and architecture decision records.
2. **Credential broker**: provider-neutral storage/lifecycle and Claude
   provider implementation.
3. **Isolated runtime**: controller/tool separation and required ACP client
   capabilities.
4. **Session semantics**: exact admission pinning, runtime reuse, reconnect,
   cancellation, and failure typing.
5. **Product UI**: catalog/install, credential management, New Agent, chat bar,
   and activity rendering.
6. **Release hardening**: multibay tests, accessibility/browser qualification,
   telemetry, documentation, and rollout controls.

Security-sensitive code receives an explicit private security review before
merge. If implementation uncovers a vulnerability in deployed code, follow
`SECURITY.md` and move that fix to a private advisory fork rather than exposing
it in the feature PR.

## Validation Matrix

At minimum, automate these cases:

- first Pro/Max connection, second profile, rename, reconnect, revoke, delete;
- API key, Bedrock, and Vertex modes enabled independently;
- billing source is correct and visible for every mode;
- subscription login cannot silently become API billing;
- collaborator cannot select, inject, or spend another user's credential;
- shared chat configuration cannot inject a hidden credential ID;
- custom ACP agent cannot request an account-owned credential;
- credential paths reject traversal, symlinks, and malformed IDs;
- concurrent add/reconnect/refresh/revoke retains exact identity;
- host disconnect, bay failover, account rehome, and stale host version;
- admitted queued turn remains pinned after settings change;
- internal retry retains exact credential ID;
- same-credential follow-up reuses a compatible runtime;
- credential or adapter change replaces only an idle runtime;
- active background command/subagent prevents unsafe replacement;
- revocation rejects the next turn and removes local materialization;
- credential refresh never updates a different profile;
- credential and login data are absent from project files, snapshots, backups,
  logs, analytics, protocol transcripts, and error messages;
- model-controlled tools cannot read controller credentials, environment,
  descriptors, process memory, or protected sockets;
- load, reconnect, cancel, crash recovery, and project restart;
- malformed and unknown ACP messages fail safely without losing the transcript;
- Codex behavior and the generic custom-ACP path remain unchanged.

Live qualification additionally covers quota exhaustion, expired login,
provider outage, account logout, native session resume, model switching, image
input, slash commands, subagents, and long-running background tasks.

## Rollback

Rollout controls must allow operators to:

- hide the Claude catalog entry and block new Claude starts;
- disable one auth/billing method without disabling all Claude agents;
- pin or roll back the qualified adapter version;
- terminate Claude runtimes and revoke local credential materializations;
- preserve existing chat transcripts for export and diagnosis;
- leave Codex and custom ACP agents operational.

Disabling the feature must not delete central credentials automatically.
Credential deletion remains an explicit, fresh-authenticated user action.

## Explicit Non-Goals For The First Release

- CoCalc reselling or centrally billing Anthropic usage.
- Sharing a personal Claude subscription with collaborators.
- Automatic failover among Claude credentials.
- Automatic conversion of Codex sessions into Claude sessions.
- Supporting arbitrary Claude adapter versions as qualified runtimes.
- A general third-party agent marketplace.
- Scheduled or unattended Claude agents.
- Full read-only or network-denied execution policy.
- `cocalc-plus` support.
- A promise to display provider usage limits unless Anthropic exposes a stable,
  typed source for them.

## Decisions Still Required

1. What upstream SDK hook, credential helper/proxy, or hardened process boundary
   can separate the credential-bearing controller from every model-controlled
   tool? The current adapter cannot route all built-in tools through ACP.
2. What exact Pro/Max login and refresh flow is supported by the pinned
   Anthropic SDK, and is it approved for hosted CoCalc use?
3. Which native Claude session artifacts are safe and necessary to persist?
4. Does changing credential, model family, or provider require a new native
   Claude session?
5. Which ACP extensions are stable enough to expose in the first release?
6. The first live rollout should use project-owned API credentials. What exact
   evidence is required before account-owned API keys or subscriptions are
   enabled?
7. Which enterprise provider is the first on-prem qualification target?

## References

- Generic CoCalc ACP plan:
  `src/.agents/acp-runtime-integration-plan-2026-09-19.md`
- Current operator documentation: `docs/acp-harnesses.md`
- Claude qualification record:
  `src/.agents/claude-code-acp-qualification-2026-09-22.md`
- CoCalc security policy: `SECURITY.md`
- CoCalc scalable architecture: `src/.agents/scalable-architecture.md`
- CoCalc accessibility requirements: `src/.agents/accessibility.md`
- Claude ACP adapter:
  <https://github.com/agentclientprotocol/claude-agent-acp>
- Agent Client Protocol: <https://agentclientprotocol.com/>
- Claude Code setup:
  <https://docs.anthropic.com/en/docs/claude-code/getting-started>
