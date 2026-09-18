# Named-Agent Sessions And Observable Coordination

Date: 2026-09-18

Status: focused architecture and implementation plan. This does not change the
approved personal-agent messaging release contract.

## Executive Decision

Build three things:

1. **Named-agent complete graphs.** A human creates an **Agent Session** from a
   set of their registered named agents. Every active member may message every
   other active member in both directions without creating N-squared personal
   connection grants.
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
- human-approved direct agent messaging;
- authenticated sender attribution and exact target routing;
- multibay account-home and project-owner authority;
- `accepted`, `rejected`, and `unknown` RPC outcomes;
- existing ACP queueing, runtime admission, and project startup rules;
- Codex subagent lifecycle, activity, reconciliation, and stop-all behavior; and
- named-agent membership limits and ACP resource limits.

The missing pieces are an economical way to authorize a set of edges and a
human interface that makes the resulting traffic understandable.

## Product Boundaries

### Named Agents Are The Network Principals

Only existing registered named agents may join an Agent Session. They retain
their stable UUID, project, `.chat` path, thread, account-specific `@name`, and
normal execution principal.

A session never creates an agent, names an unnamed thread, changes a named-agent
quota, or silently retargets a name. Member records bind stable agent UUIDs, not
mutable display names.

### Agent Sessions Are Complete Graphs

An Agent Session is an account-owned set of at least two named agents. While the
session is active, every ordered pair of active members is authorized for an
ordinary message:

```text
allowed(A, B) = active(session) && member(A) && member(B) && A != B
```

The complete graph is semantic. The database stores one session and one row per
member, not one grant per edge. Adding one member intentionally adds both
directions between that member and every existing member. Removing one member
removes all of its session edges for future sends.

Session authority is additional to existing personal links:

- Inside an active session, the session membership authorizes the send.
- Outside a session, current directional personal-link rules remain unchanged.
- Closing a session does not delete or alter separately approved personal links.
- A session send does not create a permanent personal link.

The first release supports only agents personally named by the same account and
turns running as that same authenticated human principal. It does not connect
different humans or accounts.

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

### Fresh Authentication

Fresh auth is required only when an action creates or reactivates a bridge across
project boundaries:

- Creating a session whose members span multiple projects requires fresh auth.
- Adding a member from a new project requires fresh auth.
- Resuming a paused cross-project session requires fresh auth.
- Same-project creation and same-project membership edits do not require fresh
  auth because the participating agents already operate inside the same project
  collaborator boundary.
- Pausing, removing a member, and closing never require fresh auth.
- Individual sends never require repeated fresh auth.

The confirmation must say that all selected agents can contact one another and
list the projects being bridged. A conversational "yes" is never authorization.

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
- existing AI usage and credit-spend limits; and
- the existing `codex_max_concurrent_subagents` setting, normalized to 1-16.

Add only fixed defensive limits required by the new operation: a hard server cap
on session members, bounded session mutation rate, and bounded broadcast fanout.
The effective member limit is the minimum of the tier entitlement and hard cap.
Do not introduce separate tier fields for TTL, message count, fanout, history, or
subagent count until measured use demonstrates a need.

## Authority And Storage

### Authoritative Records

Store session authority on the account home bay beside the existing personal
agent names, controls, requests, and grants:

```text
agent_personal_sessions
  session_id UUID primary key
  account_id UUID
  title TEXT nullable
  state active | paused | closed
  generation UUID
  created_by UUID
  created_at TIMESTAMPTZ
  updated_at TIMESTAMPTZ
  closed_at TIMESTAMPTZ nullable

agent_personal_session_members
  session_id UUID
  agent_id UUID
  project_id UUID
  added_by UUID
  added_at TIMESTAMPTZ
  removed_at TIMESTAMPTZ nullable
  primary key (session_id, agent_id)
```

These are logical fields, not a migration specification. Account IDs and remote
project-owned agent IDs may not have local foreign keys when their authority is
owned by another bay.

The home bay is authoritative for session state, generation, membership, the
human principal, and the membership-tier limit. A project owning bay remains
authoritative for the registered agent identity, project access, and current
endpoint. The current host/bay remains authoritative for runtime admission.

Extend current attempt/inbox evidence with nullable `session_id`,
`session_generation`, and authorization kind. A send is authorized by either an
exact personal link or an exact Agent Session membership check, never an
ambiguous mixture inferred after submission.

### Send Authorization

Extend the existing personal-agent control path with session authorization
rather than building another messaging service:

1. Authenticate the source named agent and fixed runtime principal.
2. Route to the source account's home bay.
3. Verify active session generation and active source/target membership.
4. Verify both UUIDs still resolve to active agents personally named by this
   account.
5. Resolve the target project's current owning bay and endpoint.
6. Recheck the human's current access to source and target projects.
7. Apply current account, project, messaging, and runtime limits.
8. Use the existing one-use target admission protocol and ACP submission path.

Do not materialize N-squared grants. Do not send reusable human credentials or a
general session capability to project hosts. The downstream authorization is
bound to the exact source, target, principal, session generation, request, host,
and deadline using the existing narrow admission pattern.

Failure to resolve current home-bay, project-owner, or host authority fails
closed. One-bay Launchpad uses the same logical ownership model.

### Revocation Semantics

Pause, removal, close, collaborator removal, agent retirement, and account
security changes prevent future admissions once observed by the authoritative
check. They do not retract saved text, cancel already admitted work, reverse
filesystem effects, or erase audit history.

Canceling admitted work remains a separate authorized ACP action. The UI must
not describe session pause or close as cancellation.

## Agent-Facing Interface

Keep the model-facing interface close to the primitive that future models are
likely to know. Reuse current commands and identity instead of adding a workflow
SDK.

### Peer Discovery

Extend destination discovery to return:

- existing personal-link destinations; and
- named peers from every active Agent Session containing the source.

Each result identifies its authorization source as `personal` or `session` and
includes the session ID/title when applicable. Duplicate destinations reached by
multiple authorities collapse to one peer with all applicable sources. Knowing a
peer or session ID conveys no authority.

### Direct Send

Continue using the existing send operation. The caller may select an exact named
peer and, when needed, an exact session authorization source. The server assigns
source identity and never accepts it from message text.

Ordinary sends wake an idle agent or queue behind its active turn. They do not
interrupt active reasoning. Session authority does not permit guidance in the
first release.

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
and uses the same per-target authorization and admission checks. Partial success
is normal and visible. There is no account-wide or implicit "all agents" target.

### Session Requests And Human Authorization

An agent may issue a typed request proposing a title and exact named members.
That request opens the same first-party review UI as human-initiated creation; it
does not create or authorize the session. The human may edit, approve, or reject
the proposal. Cross-project approval uses fresh auth.

Session activation, expansion, pause/resume, member removal, and close remain
human control-plane actions in the first release. Prose alone never changes
membership.

## Excellent Observability

Observability has two surfaces: the `.chat` transcript and Agent Session
management. Neither surface is an authority source.

### Message Correlation And Inspection

Current RPC chat rows already contain an `agent_rpc` map with source, target,
attempt, link, attachment, and file-reference correlation. Extend it with:

```ts
agent_rpc: {
  version: 3;
  source: AgentSource;
  target: AgentEndpoint;
  attempt_id: string;
  authorization: {
    kind: "personal" | "session";
    link_id?: string;
    session_id?: string;
    session_generation?: string;
  };
}
```

The syncdoc metadata is a rendering and correlation hint, not proof of authority.
The authoritative attempt/session record remains in protected control-plane
storage. Add a bounded, read-only inspection endpoint that verifies the current
human may inspect the exact target agent/thread and returns current evidence for
the referenced attempt. It never starts, retries, wakes, or steers work.

If authoritative evidence is unavailable, the UI says **Unverified or expired**.
It never promotes editable chat metadata into an authenticated claim.

### Slate `agent-message` Element

Add a first-party `agent-message` element beside the existing
[`guidance` element](../packages/frontend/editors/slate/elements/guidance.tsx).
For a chat row carrying agent RPC correlation metadata, the message renderer
synthesizes this element from the row content plus an authorized inspection
result. Without that result, it renders the explicitly unverified state. The
default compact card shows:

```text
@reviewer -> @builder · Agent Session: Release review
Please check the authorization boundary in personal-store.ts.       Queued
```

The card includes:

- source and target names, with UUID fallback;
- Agent Session title when applicable;
- a short body preview and timestamp;
- truthful admission/execution state when verified; and
- a clear button/keyboard target to inspect details.

The card is visually quieter than a human message. Consecutive agent messages
may collapse into a count summary, but every message remains individually
expandable. Messages asking for human input remain prominent.

Clicking or keyboard-activating the card opens an inspector with:

- complete intentionally sent content;
- source, target, project, session, attempt, and correlation identifiers;
- personal-link or session authorization source;
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

Please check the authorization boundary in personal-store.ts.
```
````

An arbitrary user-authored fence renders only as an **Unverified agent-message
quote**. It cannot display authenticated badges, delivery state, session
membership, or a working inspector without a matching authorized control-plane
record.

The Slate node stores only presentation/reference data needed for rendering. It
does not duplicate credentials or make chat/syncdoc state authoritative.

### Session Management UI

Add an **Agent Sessions** view reachable from the Agents navigation menu and the
agent-specific overflow menu. It provides:

- create-session modal with named-agent search and project grouping;
- explicit cross-project/fresh-auth confirmation when required;
- session title, active/paused/closed state, members, projects, creator, and age;
- add/remove, pause/resume, and close controls;
- recent message activity with source, target, outcome, and time;
- per-member sent/received counts and last activity;
- direct links to member agents and inspectable message cards; and
- aggregate Codex subagent activity counts already reported for each named agent.

Do not build a visual workflow editor. A compact member list and chronological
activity view are sufficient for the first release; a complete graph diagram
adds little information and becomes noisy quickly.

All interactive cards and controls require semantic roles, accessible names,
keyboard operation, visible focus, focus restoration, theme-aware `UI_COLORS`,
and usable layout at browser zoom and narrow widths. Status must never be
communicated by color alone.

## Implementation Sequence

### Stage 1: Observable Existing Messages

- [ ] Add the Slate `agent-message` renderer and safe unverified-fence fallback.
- [ ] Add bounded authoritative message inspection.
- [ ] Render current personal/RPC messages with source/target attribution and
      honest admission/execution labels.
- [ ] Add focused accessibility, light/dark theme, edit, legacy, missing-evidence,
      and static-renderer tests.

Exit criterion: existing agent messages are pleasant to read and every displayed
security/delivery claim can be inspected or is explicitly labeled unverified.

### Stage 2: Same-Project Agent Sessions

- [ ] Add home-bay session/member schema and management API.
- [ ] Add `max_agent_session_members` to membership tiers and presentation.
- [ ] Build create/list/inspect/pause/close/add/remove UI.
- [ ] Authorize complete-graph direct sends without N-squared grant rows.
- [ ] Extend peer discovery and message metadata with session authorization.
- [ ] Add bounded explicit broadcast with per-target outcomes.

Exit criterion: one human can put at least three named agents in one project into
an Agent Session, and every pair can communicate bidirectionally with complete
observable history and no fresh-auth prompt.

### Stage 3: Cross-Project And Multibay Qualification

- [ ] Add fresh-auth creation, expansion, and resume flows for cross-project
      sessions.
- [ ] Route session checks through the account home bay and target admission
      through the current project owning bay/host.
- [ ] Test project movement, account-home changes, route staleness, host restart,
      collaborator removal, agent retirement/recovery, pause, and close.
- [ ] Load-test effective tier limits, broadcast fanout, and failure isolation.

Exit criterion: a cross-project session works across different owning bays with
no copied human credential, no stale-authority fallback, and truthful partial or
unknown outcomes during failures.

### Stage 4: UX Polish And Measurement

- [ ] Add session activity summaries to the Agents page without making it a
      second transcript.
- [ ] Tune grouping, labels, and empty/error states using real message traffic.
- [ ] Measure direct sends, replies, broadcast fanout, outcomes, queue delay,
      human inspection, session size, and aggregate runtime/cost.
- [ ] Compare coordinated results and latency against ordinary independent named
      agents before raising limits.

## Test And Release Gates

### Authorization

- Same-project session creation does not require fresh auth.
- Cross-project create/add/resume requires fresh auth and lists bridged projects.
- Pause/remove/close does not require fresh auth and blocks subsequent session
  authorizations without claiming to cancel an in-flight or admitted send.
- Both directions work for active member pairs without permanent personal links.
- Nonmembers, retired agents, wrong humans, external agents, forged session IDs,
  stale generations, and removed collaborators are rejected.
- Closing a session leaves unrelated personal links unchanged.

### Delivery

- Idle targets wake and busy targets queue without guidance.
- Accepted, rejected, and unknown remain distinct in API, CLI, and UI.
- Inspection never submits work; no mutating operation is automatically retried.
- Broadcast returns independent per-target outcomes and tolerates partial failure.
- One unavailable target does not block unrelated targets beyond bounded
  deadlines.

### Codex Subagents

- Session membership does not create, rename, enumerate, or credential subagents.
- Codex subagent activity remains attached to the parent named agent.
- A message initiated inside a parent runtime is attributed to the named agent,
  never presented as an independently authenticated worker.
- Existing concurrent-subagent, ACP, AI usage, and spending limits still apply.
- Existing stop-all and runtime reconciliation behavior is unchanged.

### Observability And Accessibility

- Verified cards resolve exact source, target, authorization source, and attempt.
- Forged/edited/legacy metadata cannot produce a trusted badge or authority.
- Missing or expired evidence degrades to an honest unverified state.
- Editable, static, and server-rendered views preserve readable content.
- Keyboard users can open/close inspectors and regain focus correctly.
- Screen-reader labels, status announcements, contrast, dark/light themes, 200%
  zoom, and narrow layouts pass focused checks.
- Routine logs and metrics contain no message body, credential, hidden prompt,
  or private file content.

### Multibay And Recovery

- Account home bay is the sole session-policy authority.
- Project owning bay and current host remain authoritative for identity/access and
  execution admission.
- Project move, host replacement, restore, route epoch change, and account rehome
  never revive stale session authorization.
- Lost acknowledgment after possible admission returns unknown and is not blindly
  retried.

## Acceptance Criteria

The plan is complete when:

1. A human can create an Agent Session from registered named agents with one
   clear complete-graph authorization action.
2. Same-project setup is lightweight and cross-project setup uses fresh auth.
3. Every active member can directly message every other member in both directions
   without N-squared grant rows or manager relay.
4. Existing personal links, named-agent limits, ACP admission, and Codex subagent
   behavior remain intact.
5. Agent messages are compact, readable, keyboard-accessible, and inspectable,
   with trusted and unverified states clearly distinguished.
6. The account home bay, project owning bay, and host enforce their existing
   authority boundaries with no reusable human credentials crossing bays.
7. One session-member entitlement plus existing platform limits bounds cost and
   abuse without a new worker-agent quota system.
8. Tests cover authorization, unknown outcomes, revocation, multibay movement,
   overload, forged presentation metadata, and accessibility.

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
- externally installed agents as session members;
- autonomous agent-created sessions or agent-controlled membership changes;
- session guidance/steering that interrupts active turns;
- automatic delivery retry, offline store-and-forward, or exactly-once claims;
- unbounded broadcast, account-wide discovery, or 1,000-agent swarm support;
- coordinator agents, role systems, voting, task DAGs, workflow builders, or
  distributed schedulers;
- artifact, Markdown, or chat prose that grants authority;
- chain-of-thought collection or supervision; and
- a mandatory complete-graph visualization.

Codex can continue improving its native subagent implementation independently.
CoCalc's stable contract remains deliberately smaller: named agents communicate
inside human-authorized Agent Sessions, and humans can clearly see what happened.
