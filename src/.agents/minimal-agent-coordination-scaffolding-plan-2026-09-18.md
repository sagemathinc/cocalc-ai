# Named-Agent Sessions And Observable Coordination

Date: 2026-09-18

Status: implemented on `feature/my-agents-workspace` for PR #640. This replaces
the brief experimental directional-link model before it becomes a compatibility
contract. Deployment qualification and production measurement are recorded
separately below rather than treated as additional authority models.

## Executive Decision

Build three things:

1. **Named-agent complete graphs.** A human creates an **Agent Session** from a
   set of their registered named agents and, when needed, explicitly approved
   external agents. Every active member may message every other active member in
   both directions. A two-member session is the normal one-to-one case. The
   human chooses whether messages queue behind active turns or may interrupt
   them as live guidance.
2. **Excellent observability.** Agent-to-agent messages render as compact,
   inspectable first-party Slate elements. Session management shows membership,
   state, activity, and honest delivery/execution evidence without exposing
   private reasoning or flooding the transcript.
3. **Codex-native subagents behind each named agent.** Codex remains responsible
   for spawning, coordinating, limiting, reconciling, and stopping its subagents.
   CoCalc treats them as an implementation detail of the named agent, not as new
   platform identities or session members.

This is the complete scope. CoCalc supplies a bounded communication graph,
identity, authorization, routing, and human visibility. It does not supply a
manager hierarchy, task scheduler, workflow language, or worker-agent platform.

## Motivation

The design is inspired by Noam Brown's September 17, 2026 interview,
[Agent swarms, alignment, & recursive self-improvement](https://www.dwarkesh.com/p/noam-brown).
The useful product insight is narrow: direct lateral messaging lets capable
models ask questions, compare answers, disagree, converge, and organize without
forcing every exchange through a coordinator.

CoCalc already has the hard foundation:

- durable registered agent identities and personal names;
- authenticated direct agent messaging transport;
- authenticated sender attribution and exact target routing;
- multibay account-home and project-owner authority;
- `accepted`, `rejected`, and `unknown` RPC outcomes;
- existing ACP queueing, runtime admission, and project startup rules;
- Codex subagent lifecycle, activity, reconciliation, and stop-all behavior; and
- named-agent membership limits and ACP resource limits.

The missing pieces are an economical way to authorize a set of edges and a
human interface that makes the resulting traffic understandable.

## Product Boundaries

### Session Members Are Explicit Network Principals

An Agent Session has two explicit, discriminated member kinds:

- `registered`: an existing CoCalc named agent with its stable UUID, project,
  `.chat` path, thread, account-specific `@name`, and normal execution principal;
  and
- `external`: a separately enrolled external-agent identity with a stable UUID,
  installation identity, account owner, and session-capable authenticated inbox.

An external agent may join only through explicit human approval of the exact
session. Approval replaces the current per-target external destination dialog;
it does not create an account login, copy a human credential, or authorize any
other session. The external protocol must support both sending and receiving
before the member becomes active. Extend the existing scoped external credential
with bounded inbox polling/acknowledgment rather than pretending its current
send-only form is a complete-graph member.

A session never creates an agent, names an unnamed thread, changes a named-agent
quota, or silently retargets a name. Member records bind stable member UUIDs and
an explicit member kind, not mutable display names.

### Agent Sessions Are Complete Graphs

An Agent Session is an account-owned set of at least two named agents. While the
session is active, every ordered pair of active members is authorized to send
under the session's human-selected delivery policy:

```text
allowed(A, B) = active(session) && member(A) && member(B) && A != B
may_interrupt(A, B) = allowed(A, B) && delivery_mode(session) == live
```

The complete graph is semantic. The database stores one session and one row per
member, not one grant per edge. Adding one member intentionally adds both
directions between that member and every existing member. Removing one member
removes all of its session edges for future sends. Closing a session revokes all
of its edges for future sends.

Agent Sessions are the only user-facing and authoritative communication model:

- Two agents communicate through a two-member session.
- Communication is always bidirectional; there are no one-way grants.
- There is no separate connection, link, reply grant, or guidance grant concept.
- A send must be authorized by an exact active session containing both agents.
- The existing transport and one-use admission machinery may be reused, but
  legacy link records do not authorize new work.

The directional connection experiment has no compatibility requirement. Remove
its request/grant UI, API, CLI, and stored authority rather than hiding it behind
an advanced view or building migration UX. Development records may be discarded
by the schema transition. Previously rendered message text remains ordinary
historical transcript content and conveys no authority.

The first release supports registered agents personally named by one account,
external identities explicitly enrolled by that same account, and turns running
as that authenticated human principal. It does not connect different humans or
accounts. External enrollment is a narrow agent credential, not a second human
principal.

### Delivery Policy

Every Agent Session has one human-controlled delivery mode:

- `queued` is the default. A message wakes an idle target or waits behind its
  active turn.
- `live` wakes an idle target normally and delivers to a busy target through the
  existing guidance mechanism so long-running agents can communicate without
  waiting hours or days for a turn boundary.

Live mode grants every active member the stronger ability to steer every other
active member during a running turn. Creation and settings UI must state this
plainly and require an explicit human choice; a conversational instruction from
an agent cannot enable it. Changing the mode changes the session generation so
an authorization checked under an older policy cannot be reused.

This is a session-level policy in the first release. Do not add per-member,
per-edge, or autonomous agent-controlled delivery policy.

### Codex Subagents Stay Behind Their Named Agent

Codex already owns subagent behavior. The current integration tracks descendant
threads, reports activity, reconciles terminal state, preserves outstanding work,
supports stop-all, and passes a per-thread maximum concurrent subagent setting.
The existing account setting is normalized to 1-16 concurrent subagents.

Agent Sessions do not introduce a second implementation:

- A Codex subagent is not entered in the named-agent registry.
- It does not receive an `@name`, session membership, or independent CoCalc
  messaging credential.
- It does not consume a named-agent slot or a session-member slot.
- If it invokes a messaging tool available to its parent runtime, the message is
  authenticated and displayed as coming from the parent named agent.
- Replies target the parent named agent. Codex decides how to route or use them
  internally.
- Existing Codex and ACP concurrency, queue, runtime, and spending controls
  continue to apply.

Session membership neither enables nor disables Codex subagents. That remains a
Codex/thread configuration concern. CoCalc may display trusted aggregate
subagent activity for observability, but subagent thread IDs are not security
principals and do not become nodes in the session graph.

## Resolved Product Decisions

### Name

Use **Agent Session** in the UI and `agent session` in documentation. Use
`agent_session` in internal schema and protocol names. Avoid **team** and
**group**, which are easily confused with groups of human collaborators.

### Session Lifetime

Keep lifecycle simple:

- `active`: members may send through session authority;
- `paused`: no new session-authorized sends, but membership is retained; and
- `closed`: terminal state; create a new session rather than reopening it.

The first release has no automatic TTL or idle expiry. Project access, agent
identity, account security state, membership limits, and runtime admission are
still checked on every send. A generation changes on membership or state changes
so stale authorizations cannot silently survive an edit.

Changing delivery mode is a human session edit and changes the generation. It
does not cancel already admitted work or retract guidance already delivered.

### Fresh Authentication

Fresh auth is required only when an action creates or reactivates a bridge across
project boundaries:

- Creating a session whose members span multiple projects requires fresh auth.
- Adding the first registered member from a project not already represented in
  the session requires fresh auth. Adding another agent from a represented
  project does not: it does not expand the set of project security boundaries
  bridged by the session.
- Resuming a paused cross-project session requires fresh auth.
- Enabling live delivery on a cross-project session requires fresh auth because
  it grants every member stronger steering authority across project boundaries.
- Same-project creation and same-project membership edits do not require fresh
  auth, including enabling live delivery, because the participating agents
  already operate inside the same project collaborator boundary. Live delivery
  still requires explicit confirmation.
- Pausing, removing a member, and closing never require fresh auth.
- Changing live delivery back to queued never requires fresh auth.
- Individual sends never require repeated fresh auth.

The server determines whether an edit expands the represented project set from
the locked pre-mutation and proposed post-mutation state. It does not trust a
client-supplied `cross_project` flag. External-member approval always requires
the existing explicit external enrollment approval, but does not add repeated
fresh-auth prompts beyond any project-set expansion caused by the same mutation.

The confirmation must say that all selected agents can contact one another and
list the projects being bridged. It must explicitly describe the resulting
two-way prompt/data bridge between those projects. If live delivery is selected,
it must also say that every member may interrupt every other member's running
turns. A conversational "yes" is never authorization.

### Entitlements And Limits

Use one new membership-tier entitlement:

```text
usage_limits.max_agent_session_members
```

It limits the number of active members in any one Agent Session. The existing
`max_named_agents` entitlement still limits the account's total registered named
agents. Do not add task-agent or subagent membership entitlements in this plan.

Reuse existing limits wherever possible:

- the current 32 KiB agent-message payload limit;
- existing per-account and per-project ACP running/queued admission limits;
- existing agent-messaging concurrency, deadline, and rate limits;
- existing guidance admission and steering controls;
- existing AI usage and credit-spend limits; and
- the existing `codex_max_concurrent_subagents` setting, normalized to 1-16.

Add fixed defensive limits required by the new operation: a hard server cap on
session members, a hard per-account cap on active and retained sessions, bounded
overlapping memberships, bounded title length, paginated/bounded discovery and
activity results, bounded session mutation rate, bounded broadcast fanout, and
bounded outstanding proposals with TTL and rate limits. Closed-session and
operational evidence retention must be finite and documented.

The effective member limit is the minimum of the tier entitlement and hard cap.
`max_named_agents` already exists in the Agents workspace work and continues to
bound registered named agents. Do not introduce separate tier fields for
session count, TTL, message count, fanout, history, or subagent count until
measured use demonstrates a need; the other bounds are fixed safety constants.
Restrictive actions such as pause, remove, and close remain available even when
an account is over a creation limit or has opted out of new messaging.

## Authority And Storage

### Authoritative Records

Store session authority on the account home bay beside the named-agent registry:

```text
agent_sessions
  agent_session_id UUID primary key
  account_id UUID
  title TEXT nullable
  state active | paused | closed
  delivery_mode queued | live
  generation UUID
  created_by UUID
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  closed_at TIMESTAMPTZ nullable

agent_session_members
  agent_session_id UUID
  member_kind registered | external
  member_id UUID
  registered_agent_id UUID nullable
  project_id UUID nullable
  external_agent_id UUID nullable
  added_by UUID
  added_at TIMESTAMPTZ
  removed_at TIMESTAMPTZ nullable
  primary key (agent_session_id, member_kind, member_id)
  check exactly one member-kind identity is populated
```

These are logical fields, not a migration specification. Account IDs and remote
project-owned agent IDs may not have local foreign keys when their authority is
owned by another bay.

The home bay is authoritative for session state, delivery mode, generation,
membership, external enrollment, the human principal, the account-wide
messaging control generation, and the membership-tier limit. A project owning
bay remains authoritative for a registered agent identity, project access, and
current endpoint. The current host/bay remains authoritative for runtime
admission and whether a busy runtime can accept guidance. The external-agent
service remains authoritative for an external identity, installation, and inbox
credential.

Extend current bounded attempt/inbox evidence with `agent_session_id`, session
generation, account-control generation, configured delivery mode, and effective
delivery. Session authority is never inferred from names, message text, optional
legacy IDs, or editable transcript metadata.

### Send Authorization

Replace directional-link authorization in the existing agent messaging control
path with session authorization rather than building another messaging service.
Authorization is deliberately repeated at every asynchronous boundary, not
performed once and cached:

1. Authenticate the source member and derive its fixed runtime or external
   principal. Reject caller-supplied source, account principal, delivery mode,
   or guidance policy.
2. Route to the source account's home bay and verify the explicit
   `agent_session_id`, active session generation, account-control generation,
   delivery mode, and active source/target membership.
3. Resolve each discriminated member through its authoritative registry. For a
   registered target, resolve the current project owning bay and endpoint and
   recheck the human's current access to source and target projects. For an
   external target, resolve the enrolled installation and bounded inbox.
4. Apply current account, project, messaging, guidance, external-inbox, and
   runtime limits.
5. Bind a narrow permit to the exact `agent_session_id`, session generation,
   account-control generation, source identity and source run, target identity,
   target path/thread or external inbox, principal, route/host epoch, canonical
   body/attachment digest, request/attempt ID, configured delivery, and deadline.
6. Revalidate those bindings immediately before admission, after project startup
   and file validation, and again inside queued execution. A pause, member
   removal, close, account-wide revoke/pause, identity change, route change,
   deadline expiry, or body/attachment mismatch fails closed at the next guard.
7. Use the existing ACP submission path for registered targets and the bounded
   external inbox path for external targets.

Do not materialize N-squared grants. Do not send reusable human credentials or a
general session capability to project hosts or external installations. Preserve
the existing separate admission and execution guards rather than weakening them
to a single home-bay check.

Failure to resolve current home-bay, project-owner, or host authority fails
closed. One-bay Launchpad uses the same logical ownership model.

### Revocation Semantics

Pause, removal, close, collaborator removal, agent retirement, external-agent
revocation, and account security changes increment the applicable generation and
prevent future admissions once observed by the next authoritative guard. Retain
the existing account-wide pause/revoke control and generation. These actions do
not retract saved text, cancel already admitted work, reverse filesystem effects,
or erase retained operational evidence.

Canceling admitted work remains a separate authorized ACP action. The UI must
not describe session pause, delivery-mode change, or close as cancellation.

### Hard-Cutover Inventory

Before implementation is considered complete, classify every current agent
messaging route as session authority, bounded evidence, or deleted code:

- personal connection requests, grants, state changes, and their directory UI;
- RPC link grant/revoke/list operations and every `link_id` proof path;
- legacy identity messaging grants, delivery authorization, and admission paths;
- receipt/history records, which may remain bounded evidence but never authority;
- protocol-v2 envelopes, admission permits, and execution authorizations; and
- external-agent destination approval, CLI discovery/send commands, and docs.

The replacement wire format uses an explicit discriminated member kind and
mandatory `agent_session_id`. No route may interpret a missing session as a
legacy grant, an external destination, or "the only matching session." Preserve
the account-wide messaging pause/revoke generation independently of sessions.

## Agent-Facing Interface

Keep the model-facing interface close to the primitive that future models are
likely to know. Reuse current commands and identity instead of adding a workflow
SDK.

### Peer Discovery

Extend destination discovery to return:

- registered and external peers from every active Agent Session containing the
  source; and
- every applicable `agent_session_id`, title, and queued/live delivery mode for
  each peer.

Duplicate peers shared through multiple sessions collapse to one peer with all
applicable sessions. Knowing a peer or session ID conveys no authority.

### Direct Send

Continue using the existing send operation. The caller must select an exact peer
and supply `agent_session_id` explicitly, even when discovery finds only one
matching session. Do not use generic `session_id`, which is already overloaded
by the Codex runtime session. The server derives source identity, human
principal, and delivery policy; it rejects caller-supplied values for them.

Every direct send has a canonical idempotency binding over the authenticated
source/run, target, `agent_session_id`, body/attachment digest, and caller
idempotency key. A mutation has an equivalent binding over the locked prior
generation and requested change. Reusing a key with different bound input is an
error, not a replay.

The server derives delivery from the verified session; message text cannot
request or escalate it. Under a queued session, a send wakes an idle agent or
queues behind its active turn. Under a live session, a send wakes an idle agent
normally or is submitted as guidance to a busy target.

An external target receives through its authenticated inbox, recorded as
`external-inbox`; CoCalc does not claim to steer an external runtime. Live mode
still controls how that external member may send to busy registered members.
External transport keeps its narrower data boundary: it may exchange explicit
message bodies and supported snapshots, not live project-file references or
reusable project credentials.

If the target establishes before any possible admission that its runtime cannot
accept guidance, the system queues the message rather than dropping it and
records **queued fallback** as the effective delivery. It must not claim
immediate delivery. A rejected or unknown guidance admission is not silently
retried or queued: rejection remains rejected, and unknown remains unknown to
avoid duplicate work. Live guidance admission means only that the runtime
accepted the steering input, not that the model read, acted on, or completed it.

Before live steering, the target host must also prove that the busy target turn
belongs to the session's account principal. If the busy turn belongs to a
different account, live delivery fails definitively; it is not injected as
guidance and is not silently converted to queued delivery. Every model-facing
prompt labels peer content as agent-provided content, not a human instruction or
permission grant.

Every attempt retains current `accepted`, `rejected`, and `unknown` semantics:

- `accepted` means execution admission, not read or complete;
- `rejected` means this attempt was definitively not admitted; and
- `unknown` means admission cannot be established or ruled out.

There is no automatic retry. Inspection remains read-only. Retrying after unknown
uses a new attempt ID and can duplicate work.

### Bounded Broadcast

Provide one convenience operation that sends the same body to an explicit list
of active members in one session. It expands to independent direct attempts and
returns one outcome per target. It is not atomic, ordered, or exactly once.

Broadcast excludes the sender, cannot exceed the effective session-member limit,
and uses the same per-target authorization, delivery policy, and admission
checks. In a live session, a broadcast may therefore guide multiple busy agents;
the existing guidance and messaging limits apply independently to every target.
Partial success is normal and visible. There is no account-wide or implicit
"all agents" target.

The broadcast request and each expanded child have separate canonical
idempotency identities. Replaying the parent returns the same child mapping;
changing a target list or body under the same key is rejected.

### Session Requests And Human Authorization

An agent may issue a typed request proposing a title, exact members, and delivery
mode. That request opens the same first-party review UI as
human-initiated creation; it does not create or authorize the session. The human
may edit, approve, or reject the proposal. Cross-project approval uses fresh
auth, and live delivery always requires explicit human confirmation.

For an external agent, the enrollment flow proposes joining an exact existing or
new session instead of approving one target destination. The confirmation lists
all members and projects and explicitly states that session membership creates a
two-way prompt/data bridge to every member. Approval issues only a scoped
session-member credential and inbox capability.

Session activation, expansion, pause/resume, member removal, and close remain
human control-plane actions in the first release. Prose alone never changes
membership.

## Excellent Observability

Observability has two surfaces: the `.chat` transcript and Agent Session
management. Neither surface is an authority source.

### Message Correlation And Inspection

Current RPC chat rows already contain an `agent_rpc` map with source, target,
attempt, attachment, and file-reference correlation. Replace link authorization
metadata with exact session correlation:

```ts
type AgentRpc = {
  version: 3;
  source: RegisteredAgentSource | ExternalAgentSource;
  target: RegisteredAgentEndpoint | ExternalAgentEndpoint;
  attempt_id: string;
  agent_session_id: string;
  agent_session_generation: string;
  delivery: {
    configured: "queued" | "live";
    effective:
      | "idle-wake"
      | "queued"
      | "live-guidance"
      | "queued-fallback"
      | "external-inbox";
  };
};
```

The syncdoc metadata is a rendering and correlation hint, not proof of authority
or an authenticated historical record. A `.chat` file belongs to its project and
may be edited by anyone who can write that project. CoCalc deliberately does not
promise that displayed agent-message text, ordering, or metadata is a pristine
record of what happened.

Add a bounded, read-only inspection endpoint that verifies the current human may
inspect the exact target agent/thread and returns retained operational evidence
for the referenced attempt. The endpoint can report correlation, admission, and
execution observations still retained by the control plane; it cannot certify
that the current editable row is byte-for-byte historical content. It never
starts, retries, wakes, or steers work.

If evidence is unavailable, the UI says **Operational details unavailable or
expired**. If it is available, use **Correlated attempt**, not **Verified
message** or **Trusted content**. Edited or copied metadata never grants
authority, but CoCalc does not add immutable transcript snapshots, permanent
body attestations, or an append-only session-mutation ledger solely to
authenticate historical cards. Request digests retained during admission are
security fences for that operation, not permanent transcript signatures.

### Slate `agent-message` Element

Add a first-party `agent-message` element beside the existing
[`guidance` element](../packages/frontend/editors/slate/elements/guidance.tsx).
For a chat row carrying agent RPC correlation metadata, the message renderer
synthesizes this element from the row content plus any currently authorized
inspection result. Without that result, it renders the same readable content
with operational details unavailable. The
default compact card shows:

```text
@reviewer -> @builder · Agent Session: Release review
Please check the authorization boundary in session-store.ts.        Queued
```

The card includes:

- source and target names, with UUID fallback;
- Agent Session title when applicable;
- a short body preview and timestamp;
- configured and effective delivery when correlated evidence remains available;
- admission/execution observations clearly labeled as operational evidence; and
- a clear button/keyboard target to inspect details.

The card is visually quieter than a human message. Consecutive agent messages
may collapse into a count summary, but every message remains individually
expandable. Messages asking for human input remain prominent.

Clicking or keyboard-activating the card opens an inspector with:

- complete displayed content, labeled as editable project data rather than an
  authenticated copy of the original body;
- source, target, project, session, attempt, and correlation identifiers;
- correlated session and generation;
- configured session delivery mode and effective delivery path;
- admission state and separately labeled execution observation;
- timestamps, attachment/file-reference metadata, and accessible project/thread
  links; and
- a credential-free copyable diagnostic representation.

Do not show chain of thought, hidden prompts, reusable credentials, raw Conat
subjects, or another project's content.

### Markdown And Trust

Support a readable fenced export such as:

````markdown
```agent-message
@reviewer -> @builder

Please check the authorization boundary in session-store.ts.
```
````

An arbitrary user-authored fence renders only as an **Agent-message quote**. It
cannot display correlated operational status, delivery state, session
membership, or a working inspector without matching retained control-plane
evidence. Even with evidence, the UI does not certify the editable body as
immutable history.

The Slate node stores only presentation/reference data needed for rendering. It
does not duplicate credentials or make chat/syncdoc state authoritative.

### Session Management UI

Add an **Agent Sessions** view reachable from the Agents navigation menu and the
agent-specific overflow menu. It provides:

- create-session modal with named-agent search and project grouping;
- external-member enrollment/review with installation identity, inbox
  capability, and the full two-way session consequence;
- explicit cross-project/fresh-auth confirmation when required;
- queued/live delivery selector with queued as the default and an explicit live
  steering warning;
- session title, active/paused/closed state, delivery mode, members, projects,
  creator, and age;
- add/remove, pause/resume, and close controls;
- recent message activity with source, target, outcome, and time;
- per-member sent/received counts and last activity;
- direct links to member agents and inspectable message cards; and
- aggregate Codex subagent activity counts already reported for each named agent.

Rename user-facing **connections** entry points to **sessions**. Do not expose
directional requests, grants, link direction, or separate guidance permission in
the primary or advanced UI.

Do not build a visual workflow editor. A compact member list and chronological
activity view are sufficient for the first release; a complete graph diagram
adds little information and becomes noisy quickly.

All interactive cards and controls require semantic roles, accessible names,
keyboard operation, visible focus, focus restoration, theme-aware `UI_COLORS`,
and usable layout at browser zoom and narrow widths. Status must never be
communicated by color alone.

## Implementation Sequence

### Stage 1: Same-Project Session Cutover

- [x] Add home-bay session/member schema and management API.
- [x] Inventory every existing authority route in the account API, personal
      connection store, RPC link/grant service, receipt/protocol-v2 path, CLI,
      and external-agent destination flow. Delete directional authorization and
      all optional `link_id`/session fallback; retain only the account-wide
      pause/revoke control and generation.
- [x] Remove directional connection request/grant UI, API, CLI, schema, and
      authorization fallback; no migration UI is required.
- [x] Add `max_agent_session_members` to membership tiers and presentation.
- [x] Add fixed per-account/session/proposal bounds, pagination, proposal TTL,
      and canonical idempotency for mutations, direct sends, and broadcasts.
- [x] Build create/list/inspect/pause/close/add/remove UI.
- [x] Authorize complete-graph direct sends without N-squared grant rows.
- [x] Preserve authorization guards before admission, after startup/file
      validation, and at queued execution, bound to session/account generations,
      source run, target, route/host, request digest, and deadline.
- [x] Add queued/live session policy, generation invalidation, live guidance
      admission, and honest queued fallback.
- [x] Replace peer discovery and message metadata with exact session
      authorization and correlation.
- [x] Add the Slate `agent-message` renderer, bounded operational inspection,
      and honest editable-history fallback before enabling session sends.
- [x] Add focused authorization, delivery, accessibility, light/dark theme,
      edit, missing-evidence, and static-renderer tests.

Exit criterion: one human can put two named agents in one same-project session,
send in both directions with queued or live delivery, and inspect every displayed
security/delivery claim. No directional link path can authorize new work.

### Stage 2: Complete-Graph UX And Broadcast

- [x] Exercise add/remove with at least three agents and make the complete-graph
      consequence explicit in confirmation and session details.
- [x] Add bounded explicit broadcast with per-target outcomes.
- [x] Replace per-target external destination approval with session enrollment;
      add the authenticated bounded external inbox required for two-way
      membership and remove the old send-only authorization path.
- [x] Add chronological session activity, per-member counts, and links to
      inspectable message cards.
- [x] Tune grouping, empty/error states, keyboard behavior, zoom, and narrow
      layouts without adding a graph or workflow editor.

Exit criterion: at least three same-project agents communicate pairwise through
one session with clear membership, delivery policy, observable history, and
bounded broadcast fanout.

### Stage 3: Cross-Project Qualification

- [x] Add project-set-based fresh-auth creation, expansion, and resume flows for
      cross-project sessions. Adding another agent from an already represented
      project does not require fresh auth.
- [x] Route session checks through the account home bay and target admission
      through the current project owning bay/host.
- [x] Test route staleness, host restart, collaborator removal, agent and
      external-member retirement/recovery, delivery-mode changes, pause, and
      close.
- [ ] Load-test effective tier limits, broadcast fanout, and failure isolation.

Exit criterion: a cross-project session on the initial single-bay cocalc.ai
deployment has no copied human credential, no stale-authority fallback, and
truthful partial or unknown outcomes during failures.

### Stage 4: UX Polish And Measurement

- [x] Add session activity summaries to the Agents page without making it a
      second transcript.
- [x] Tune grouping, labels, and empty/error states using development message
      traffic.
- [ ] Measure direct sends, replies, broadcast fanout, outcomes, queue delay,
      live-guidance admission, queued fallback, human inspection, session size,
      and aggregate runtime/cost.
- [ ] Compare coordinated results and latency against ordinary independent named
      agents before raising limits.

### Deployment And Opt-In

The initial deployment target is the single-bay cocalc.ai site, and the
directional experiment has no user compatibility commitment. Make one hard
cutover: deploy the new schema and session-aware code everywhere, reject every
old directional authority path, then enable session creation. A temporary
deployment gate may prevent mixed-version admission while processes roll, but it
is not a permanent product feature flag.

Agent messaging is a normal site capability after cutover. A user opts in by
creating or approving an Agent Session; having named agents alone grants no
messaging authority. Existing experimental directional records are discarded.
Do not build migration, account-rehome, or cross-version fallback machinery for
unused experimental state.

## Test And Release Gates

### Authorization

- Same-project session creation does not require fresh auth.
- Cross-project creation, adding the first member from a newly represented
  project, and cross-project resume require fresh auth and list bridged projects.
- Adding another agent from a project already represented in the locked session
  state does not require fresh auth.
- Enabling live delivery across projects requires fresh auth; enabling it within
  one project requires explicit confirmation but not fresh auth.
- Pause/remove/close does not require fresh auth and blocks subsequent session
  authorizations without claiming to cancel an in-flight or admitted send.
- Queued/live mode changes require explicit human action, change the session
  generation, and cannot be requested through message prose.
- Live mode authorizes guidance only between current members of the exact active
  session; it does not create a separate guidance grant.
- Both directions work for every active member pair, including two-member
  sessions. One-way messaging cannot be configured.
- Nonmembers, retired agents, wrong humans, unapproved or revoked external
  agents, forged session IDs, stale session/account-control generations, and
  removed collaborators are rejected.
- Closing a session revokes both directions for future sends without claiming to
  cancel already admitted work.
- Removed legacy request/grant/link records cannot authorize a send.
- Every legacy grant, RPC-link, receipt, protocol-v2, and external-destination
  authority route is either deleted or requires an exact active
  `agent_session_id`; there is no optional fallback between authority types.
- PostgreSQL barrier tests race send against pause, remove, close, mode change,
  account-wide revoke, and identity/route changes before admission, after
  startup/file validation, and during queued execution.
- Concurrent create/add requests cannot bypass account, membership, overlap, or
  proposal limits, and changed input cannot reuse an idempotency key.
- Over-limit or messaging-opted-out accounts can still pause, remove, revoke an
  external member, and close sessions.

### Delivery

- Queued sessions wake idle targets and queue behind busy targets.
- Live sessions wake idle targets and guide busy targets through the existing
  guidance path.
- Live steering verifies that the busy turn belongs to the session account. A
  busy turn owned by another account is rejected without guidance injection or
  silent queued fallback.
- A target known not to support live guidance before possible admission queues
  the message and reports queued fallback rather than dropping it or claiming
  live delivery.
- Rejected or unknown live-guidance admission is never converted into queued
  fallback or automatically retried.
- Live guidance is rate-bounded, and broadcast fanout cannot bypass per-target
  guidance admission or steering controls.
- Accepted, rejected, and unknown remain distinct in API, CLI, and UI.
- Inspection never submits work; no mutating operation is automatically retried.
- Broadcast returns independent per-target outcomes and tolerates partial failure.
- Parent and child broadcast idempotency prevents duplicate fanout while
  rejecting changed target lists or content under a reused key.
- One unavailable target does not block unrelated targets beyond bounded
  deadlines.
- Approved external members can send to and receive from every session member;
  an external installation without a functioning two-way inbox cannot activate.

### Codex Subagents

- Session membership does not create, rename, enumerate, or credential subagents.
- Codex subagent activity remains attached to the parent named agent.
- A message initiated inside a parent runtime is attributed to the named agent,
  never presented as an independently authenticated worker.
- Existing concurrent-subagent, ACP, AI usage, and spending limits still apply.
- Existing stop-all and runtime reconciliation behavior is unchanged.

### Observability And Accessibility

- Correlated cards resolve retained source, target, session, generation, and
  attempt evidence without claiming immutable transcript history.
- Forged, edited, copied, or legacy metadata cannot grant authority or produce a
  correlated operational state without matching retained evidence.
- Missing or expired evidence degrades to readable content with operational
  details unavailable.
- Editing a body while preserving metadata demonstrates the explicit tradeoff:
  CoCalc may still identify a correlated attempt but never labels the body
  verified, trusted, or pristine.
- Editable, static, and server-rendered views preserve readable content.
- Keyboard users can open/close inspectors and regain focus correctly.
- Screen-reader labels, status announcements, contrast, dark/light themes, 200%
  zoom, and narrow layouts pass focused checks.
- Routine logs and metrics contain no message body, credential, hidden prompt,
  or private file content.

### Authority Boundaries And Recovery

- Account home bay is the sole session-policy authority.
- Project owning bay and current host remain authoritative for identity/access and
  execution admission.
- Host replacement, restore, and route epoch change never revive stale session
  authorization.
- Lost acknowledgment after possible admission returns unknown and is not blindly
  retried.

Full multibay project movement and account rehome qualification are not release
gates for the initial single-bay cocalc.ai deployment. The authority model must
not preclude them, but their migration protocol is future work rather than a
compatibility system for an unused directional experiment.

## Acceptance Criteria

The plan is complete when:

1. A human can create an Agent Session from registered named agents and
   explicitly enrolled external agents with one clear complete-graph
   authorization action.
2. Same-project setup is lightweight; fresh auth is required when the represented
   project set expands across a boundary, not for another agent from an already
   represented project.
3. Every active member can directly message every other member in both directions
   without N-squared grant rows or manager relay.
4. The human can configure queued or live delivery for the whole session; live
   delivery can interrupt long-running turns, while unsupported live delivery
   falls back visibly to the queue.
5. Directional connection requests and grants are absent from the product and
   cannot authorize new work; named-agent limits, ACP admission, and Codex
   subagent behavior remain intact.
6. Agent messages are compact, readable, keyboard-accessible, and inspectable,
   with correlated operational evidence clearly distinguished from editable,
   best-effort transcript content.
7. The account home bay, project owning bay, host, and external-agent service
   enforce their authority boundaries at every asynchronous handoff with no
   reusable human credentials crossing boundaries.
8. One session-member entitlement plus existing platform and fixed total-state
   limits bounds cost and abuse without a new worker-agent quota system.
9. Tests cover authorization races, idempotency, delivery-mode changes,
   cross-account live-steering rejection, guidance fallback, unknown outcomes,
   revocation, overload, external inboxes, edited presentation metadata, and
   accessibility.

## Future Ideas Explicitly Excluded From This Plan

The following may be reconsidered only after named-agent sessions are deployed,
measured, and shown to need them. They are not hidden requirements or later
stages of this plan:

- unnamed, ephemeral, or platform-managed worker-agent identities;
- adding Codex subagents as Agent Session members or message destinations;
- independent subagent credentials, aliases, inboxes, quotas, billing, routing,
  persistence, or cross-project communication;
- a CoCalc `spawn`, `fork`, `merge`, or worker-recovery protocol;
- automatic context cloning or shared global agent memory;
- cross-account or cross-human Agent Sessions;
- autonomous agent-created sessions or agent-controlled membership changes;
- one-way agent messaging, directional connection grants, or reply grants;
- per-member, per-edge, per-message, or agent-controlled delivery policies;
- automatic delivery retry, offline store-and-forward, or exactly-once claims;
- unbounded broadcast, account-wide discovery, or 1,000-agent swarm support;
- coordinator agents, role systems, voting, task DAGs, workflow builders, or
  distributed schedulers;
- artifact, Markdown, or chat prose that grants authority;
- immutable or cryptographically pristine `.chat` history, permanent
  message-body attestations, or append-only mutation logs whose purpose is to
  certify editable transcript content;
- first-release multibay project-move or account-rehome migration machinery;
- chain-of-thought collection or supervision; and
- a mandatory complete-graph visualization.

Codex can continue improving its native subagent implementation independently.
CoCalc's stable contract remains deliberately smaller: named agents communicate
inside human-authorized Agent Sessions, and humans can clearly see what happened.
