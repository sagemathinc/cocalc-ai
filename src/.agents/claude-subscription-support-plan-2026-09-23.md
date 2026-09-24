# Claude Subscription Support Plan

Date: 2026-09-23

Status: experimental login and isolated controller with a mediated project
shell tool are implemented on the unreleased feature branch; Pro/Max billing,
runtime behavior, and credential isolation are not verified. See
`src/.agents/claude-subscription-offline-qualification-2026-09-23.md`.

## Implementation Note (2026-09-23)

`AcpHarnessClient` now has an opt-in `claude-subscription-controller` session
policy. It pins the reported adapter name/version, sends `tools: []`, empty
settings/skills/plugins/agents/MCP configuration in Claude session metadata,
and refuses a prompt unless the adapter has pushed an explicit Pro/Max account
status. Fixture tests cover missing status, API-key status, and an unqualified
adapter. The existing API-key path does not opt in and is unchanged.

This policy is **not a credential-isolation boundary** and is not connected to
the production launcher. The adapter's status push is asynchronous and is not
provider billing proof; it can also become stale after a session opens. The
current sidecar still mounts project data and secrets, so it must not be used
for personal subscription login. No Connect flow, credential store, isolated
controller, mediated project tool plane, or live Pro/Max test exists yet.
At this point subscription selection remained disabled; the later experimental
canary below is not a release qualification.

## Implementation Note (2026-09-24)

The feature branch now has a first-party Claude CLI sign-in action, account-home
credential storage, account-local credential selection, exact-ID admission, and
an isolated controller launch path. The controller uses a trusted base image,
not the project rootfs, with a separate network and no project/secret mount.
The ACP client disables built-in tools and exposes one CoCalc project-shell MCP
tool over a private socket. The project host executes commands in the regular
project container, not the credential-bearing controller. The client refuses a
prompt without an explicit Pro/Max status report. Fake CLI, bundle, MCP bridge,
controller-argument, and UI selection tests pass. This is an **experimental
coding canary**, not proof of credential isolation. The adapter status is not
billing proof and model-controlled tool access has not been live-qualified.

This development host has neither the pinned 0.81.1 managed harness package nor
a local Podman image. A live Pro/Max account is also not available to this run.
An isolated no-account probe of the real 0.81.1 adapter completed ACP
`session/new` with the mediated MCP server configured. The real Claude CLI also
produced an authorization URL through the sign-in service, then canceled
without publishing a credential. These probes used no model inference.
Credential publication with a real account, container launch, a project-tool
turn, refresh, billing, and adversarial prompts remain untested. Do not release
or claim end-to-end support until the provider and security exit gates below
pass.

## Goal

Let a CoCalc user connect their own Claude Pro or Max account and run the
qualified Claude ACP agent in CoCalc, with subscription usage rather than an
accidental Anthropic Console API charge. The user should see the selected
billing identity before every turn. Project collaborators must not be able to
use that personal subscription, and model-controlled project tools must not be
able to read or copy its login material.

This is a focused continuation of
`src/.agents/claude-code-acp-integration-plan-2026-09-21.md`, not a replacement
for the working API-key path. It is a product priority because API-key costs
make Claude impractical for many individual users.

## Current Baseline

- `CLAUDE_CODE_QUALIFICATION` in
  `src/packages/util/ai/qualified-harnesses.ts` allows Anthropic API keys and
  explicitly blocks subscriptions. Its pinned ACP invocation includes
  `--hide-claude-auth`; the upstream adapter explicitly refuses claude.ai
  subscriptions with that option. A subscription profile therefore needs a
  separately qualified launch/auth configuration, not just a new dropdown
  choice.
- `src/packages/project-host/acp/qualified-harness-entry.ts` supports a
  project `ANTHROPIC_API_KEY` secret or an account API-key relay. Neither is
  subscription authentication. The relay's HTTP-key substitution is not a
  proven way to transport, refresh, or isolate Claude login credentials.
- The account credential broker and home-bay routing can provide the durable
  lifecycle foundation. Exact-ID turn admission and account ownership should
  be reused, not replaced with project files or a shared chat setting.
- The generic ACP session, streaming, cancellation, and reconnect stack has
  already been exercised with the Claude API-key path. Do not rewrite it for
  this feature.
- The pinned adapter advertises a subscription-specific terminal login only
  without `--hide-claude-auth` in a local-browser environment. In remote mode
  it advertises a generic TUI login. CoCalc currently advertises no ACP
  terminal-auth capability and sends no Claude session options. These are
  implementation gaps, not proof that subscription login is impossible.

## Provider And Cost Gate: Prove Before Product Work

Anthropic's [June 2026 Help Center update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says that a proposed separate Agent SDK credit was paused and that, for now,
Agent SDK and third-party app usage still draws from subscription limits. This
is current provider guidance, not a permanent pricing guarantee. The
[maintained ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
uses the Claude Agent SDK, and its
[release history](https://github.com/agentclientprotocol/claude-agent-acp/releases)
documents the `--hide-claude-auth` restriction. Recheck both before rollout.

Before building a CoCalc login flow, use a disposable Pro/Max account to run a
bounded qualification turn with a pinned adapter in an isolated test home:

1. Authenticate through an upstream-supported Claude login flow, without
   pasting credentials into CoCalc chat or extracting private tokens.
2. Run one cheap prompt through the same ACP/SDK invocation intended for
   CoCalc; record adapter and SDK versions, auth-status output, model, and
   whether a Console API key or Anthropic API billing account exists.
3. Confirm the turn uses the subscriber's Claude plan and does not debit
   Console API usage. Verify from provider account surfaces, not only from
   model output or adapter labels. Test with `ANTHROPIC_API_KEY` and other
   API-billing overrides absent; then deliberately test that a conflicting
   setting is rejected, never silently selected.
4. Check the current provider policy and terms for hosted third-party ACP/SDK
   use. Record the dated sources and any unresolved ambiguity. Do not promise
   unlimited usage or no extra charge: provider limits, optional extra usage,
   and billing policy can change.

**Stop condition:** if subscription use is unsupported, cannot be distinguished
from API billing, or cannot be verified cheaply and reliably, do not expose a
CoCalc subscription option. Keep the existing API-key mode available while
investigating or seeking provider guidance. Do not route subscription tokens
through the API-key relay as an unverified shortcut.

## Architecture Decision: Protect The Login From Tools

The model can run Claude's built-in shell and file tools through the current
Agent SDK adapter. Merely mounting a login file into the ACP sidecar would let
those tools potentially read it. The account API-key relay is not proof that
native subscription auth has the same boundary.

Run a short, time-boxed architecture spike against the pinned adapter and SDK:

1. Trace exactly where native login state is read, written, refreshed, and
   inherited, including child processes, environment, home directory, and
   logs. Determine whether the SDK offers a supported credential callback or
   network broker that keeps refresh credentials outside tool processes.
2. Prefer a credential-bearing controller isolated from the project, with all
   model-controlled tools executed by a separate project tool plane. This is
   viable only if the adapter/SDK can route **all** relevant built-in tools
   through that plane or disable them in favor of equivalent mediated tools.
3. Otherwise evaluate a hardened process boundary inside the runtime:
   controller and tool processes must have separate identities, filesystem
   views, process namespaces, and network/IPC rights. Prove that tools cannot
   read controller memory, `/proc`, descriptors, auth files, refresh endpoints,
   or credential-bearing sockets. A UID change alone is insufficient.
4. Reject any design that depends only on warnings, path hiding, redaction, or
   permissions shared by controller and tools. Do not reverse-engineer Claude
   login or distribute extracted tokens.

Record one selected design and a runnable adversarial test. If neither
supported design is viable, **do not ship personal subscription support**;
the terminal remains the separate user-managed escape hatch. This decision is
independent of the experimental full-project-trust warning for API keys.

## Implementation Sequence

### 1. Subscription Credential Lifecycle

- Add a distinct `claude-subscription` credential kind to the provider-neutral
  account broker, owned by the account's home bay. Keep Pro/Max distinct from
  Anthropic Console API keys in storage, UI, audit events, and billing labels.
- Implement a first-party **Connect Claude subscription** flow around the
  upstream-supported login method. Bind its temporary session to account,
  provider, nonce, expiry, and intended credential ID. Login runs in an
  isolated staging home with no project mount. The UI shows the provider URL
  and typed status; it never accepts a pasted password, token, cookie, or
  one-time code in chat. If the provider requires code entry, build a dedicated
  short-lived auth action.
- Publish only after confirming Claude subscription identity. Store encrypted
  credential material centrally with minimum necessary safe metadata. Do not
  copy it to project secrets, project files, snapshots, browser state, shared
  chat metadata, or generic harness configuration.
- Support reconnect, logout/revoke, and refresh with exact-ID leases and fresh
  CoCalc auth for sensitive mutations. A failed refresh returns an actionable
  reconnect state; it must not fall back to an API key.

### 2. Qualified Subscription Runtime

- Add a separately pinned Claude subscription launch profile with only the
  required auth capabilities; do not remove `--hide-claude-auth` from the
  existing API-key profile by accident. Gate by compatible adapter/SDK/host
  versions and the selected isolation design.
- At each turn admission, resolve the submitting account and exact credential
  ID server-side, check active ownership and entitlement, and bind the turn to
  `billingMode=claude-subscription`. Shared thread data cannot supply an
  account credential ID. No collaborator, network message, or scheduled job
  may borrow another user's subscription.
- Strip API-key/Console/Bedrock/Vertex override variables and config from the
  subscription runtime. If the runtime reports a different auth source, stop
  before sending a prompt. Pin native session identity to credential and
  billing mode; credential changes require a safe new session or a verified
  migration, never silent reuse.
- Keep cancellation, browser reconnect, and transcript persistence from the
  ACP path. Revocation stops new turns and tears down credential access for
  existing runtimes according to a defined bounded policy.

### 3. Product UI

- Present **Claude subscription (Pro/Max)** and **Anthropic API key** as
  separate choices at New Agent and in chat settings. Show who owns the
  credential, which plan/billing mode was verified, and that changes apply on
  the next turn. Never label a subscription turn as API billed or vice versa.
- Provide Connect, reconnect, disconnect, and auth-error recovery through
  typed first-party UI. Display provider terms and a warning that plan limits
  and extra-usage rules are controlled by Anthropic, not CoCalc.
- Hide or disable subscription choice until the selected host and account are
  qualified. Preserve the API-key path and Codex behavior. Do not present a
  subscription option that launches with a project secret.

### 4. Validation And Rollout

- Fake-provider tests: expiry, refresh races, canceled login, duplicate login,
  lost auth status, provider errors, secret-free logs, and no API fallback.
- Authorization tests: cross-account and cross-bay selection, collaborator
  submission, shared-chat tampering, revoked credentials, queue/retry identity,
  host restart, and model-controlled tool attempts to access login state.
- Live canary with a disposable Pro/Max account: connect, first turn, follow-up,
  reconnect, cancellation, browser reload, credential switch, quota exhaustion,
  and explicit billing-source cross-check against Anthropic account surfaces.
  Put a strict prompt/usage budget on qualification so testing cannot repeat
  the expensive API-key surprise.
- Run focused frontend accessibility/lint, package typechecks, project-host and
  broker tests, and Codex/custom-ACP regression tests. Perform an independent
  security review of the chosen boundary. Roll out to a host/account allowlist
  first with separate subscription kill switch and adapter rollback.

## Deliverables And Exit Gates

1. **Evidence PR:** dated provider-policy review, pinned adapter probe,
   subscription-vs-API billing evidence, and the selected isolation decision.
   No user-facing login yet.
2. **Broker/login PR:** account-owned subscription lifecycle, typed login UI,
   home-bay routing, and fail-closed auth tests. No agent launch yet.
3. **Runtime PR:** proven credential/tool boundary, separate qualified profile,
   exact admission pinning, and adversarial tests.
4. **Product/qualification PR:** billing UI, end-to-end canary, documentation,
   rollout controls, and regression evidence.

The release gate is a live subscription-backed ACP turn with verified billing
source, no project/tool access to login material, no collaborator spending,
and no silent API-key fallback. If any part fails, keep Pro/Max disabled rather
than treating an API-key turn as subscription support.
