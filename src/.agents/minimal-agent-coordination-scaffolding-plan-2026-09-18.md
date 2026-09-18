# Minimal Agent Coordination Scaffolding

Date: 2026-09-18

Status: proposed architecture and staged implementation plan. This is not a
release contract and does not change the approved personal-agent messaging
contract.

## Executive Decision

Add the smallest platform layer that lets a bounded group of agents discover and
message one another directly:

1. A human creates a short-lived **coordination session** containing a bounded
   set of agents.
2. Every participant receives the same minimal primitives: list peers, send one
   ordinary message, send a bounded broadcast, and inspect a prior attempt.
3. Messages enter the recipient's existing execution queue. There is no central
   coordinator, task graph, workflow engine, or messaging-specific retry worker.
4. The model decides whether to delegate, ask a peer, disagree, converge, or
   form an informal hierarchy. CoCalc supplies identity, authority, routing,
   limits, attribution, and human inspection, not the organization chart.
5. Existing named agents are the first participants. Ephemeral task agents can
   join later through the same session contract without becoming named agents or
   consuming the named-agent account entitlement.

This is intentionally narrower than a general coordination platform. The first
useful experiment is not a board, planner, supervisor agent, shared memory, or
durable task scheduler. It is a secure and observable `send_message(peer, text)`
primitive between agents that a human explicitly grouped together.

## Design Input

The immediate design input is Noam Brown's September 17, 2026 interview,
[Agent swarms, alignment, & recursive self-improvement](https://www.dwarkesh.com/p/noam-brown).
The relevant claims are:

- Coordinator/child scaffolds impose avoidable constraints. Children often
  cannot talk laterally or ask a clarification without abandoning their work.
- A productive alternative is to bake in little structure: give agents a
  primitive way to message another agent and let stronger models learn how to
  coordinate.
- Useful behavior can emerge from that primitive, including questions,
  disagreement, explanation, convergence, broadcast, and informal hierarchy.
- Context can be forked into temporary agents and useful results merged back.
- Coordination is not free. Parallel speedup is domain-dependent and usually
  sublinear, and early models found incoming messages disruptive.
- Highly cooperative agents can also cooperate in unintended ways. Messaging
  therefore increases the importance of sandboxing, explicit authority,
  bounded resources, monitoring, and defense in depth.

These are strong reasons to expose a stable primitive, not reasons to imitate an
unpublished training system or assume that a large swarm is automatically useful.
The plan optimizes for future models that already know how to use direct peer
messaging while remaining safe and understandable for current models and humans.

## Relationship To Existing Work

This plan extends, rather than replaces:

- [Agent Messaging As RPC](agent-messaging-rpc-spec.md), including
  `accepted`/`rejected`/`unknown`, caller-generated attempt IDs, bounded
  inspection, no automatic retry, and ordinary queueing behind active work.
- [Agent Messaging Release Contract](agent-messaging-release-contract.md),
  including authenticated human scope, directional personal links, authoritative
  bay ownership, fresh-auth approval, and the rule that message content grants
  no authority.
- [Agent messaging reviewer map](agent-messaging-security-map.md), including
  credential, lifecycle, filesystem, attachment, and resource boundaries.
- [Codex Subagent Activity UX And Implementation Plan](codex-subagent-activity-ux-plan-2026-08-13.md),
  which already defines bounded subagent activity and human visibility.
- The existing `guidance` Slate element in
  [`guidance.tsx`](../packages/frontend/editors/slate/elements/guidance.tsx),
  which demonstrates fenced Markdown parsing, editable and static rendering,
  state presentation, and Markdown round trips.

A broader coordination/workflow design remains useful for future revisioned work,
review workflows, evidence, and protected effects. It is deliberately not the
first implementation slice here. Direct communication should be qualified before
CoCalc builds a workflow system around it.

## Goals

- Let an agent contact any authorized peer in its current coordination session
  without routing every exchange through a manager.
- Make clarification, disagreement, result sharing, and bounded broadcast cheap.
- Preserve a clear distinction between durable named agents and ephemeral
  execution workers.
- Preserve the current human principal, project admission, and multibay rules.
- Make every intentionally sent inter-agent message attributable and inspectable
  without flooding the normal human transcript.
- Bound fanout, payloads, concurrency, lifetime, spending, and recursive spawn.
- Give future models a small, stable tool surface that resembles the primitive
  they are likely to encounter during multi-agent training.
- Allow the platform to measure whether coordination helps before expanding it.

## Non-Goals

- No required coordinator, manager hierarchy, role taxonomy, or fixed team shape.
- No planner, DAG executor, distributed lock service, generic task board, or
  exactly-once workflow engine.
- No messaging-specific offline outbox or automatic retry loop.
- No global shared scratchpad or automatic transcript synchronization.
- No authority conveyed by prose, agent-generated JSON, Markdown metadata,
  artifact state, a known UUID, or membership labels.
- No automatic permission expansion when an agent spawns or contacts another.
- No collection or exposure of private chain of thought. Only intentionally sent
  messages, explicit results, tool activity, and operational metadata are shown.
- No cross-account sessions in the first release.
- No attempt to make collaborators sharing one project Unix account mutually
  isolated. Stronger isolation requires distinct sandboxes.
- No claim that more agents improve every task or justify their additional cost.

## Product Invariants

### 1. Communication Is Primitive; Authority Is Not

The model-facing operation should remain conceptually simple:

```ts
send_message({ to: peer_id, text, reply_to? })
```

The platform-facing operation still performs authenticated identity resolution,
session membership checks, current project/account checks, route resolution,
admission, size and rate limits, and attempt recording. The simple model API must
not imply a weak backend contract.

Messages are attributed external input. A recipient may reason about them, but
must not interpret them as system policy, human approval, a tool grant, or a
credential. Protected effects continue through existing authorized executors.

### 2. No Required Manager

Every participant may directly contact any other participant permitted by the
session policy. Parent/child provenance is retained for audit, stopping, cost,
and capability attenuation, but it is not the required message route.

The platform may provide a root agent as an initial contact and human-facing
anchor. It must not require all messages or decisions to pass through that root.

### 3. Human Approval Is Amortized, Not Removed

The human approves one bounded session policy rather than approving every edge
in an N-agent graph. The approval names the allowed participant set or allowed
spawn scope, human principal, projects, expiry, limits, and any outward egress.

Joining a session is not a general connection grant. It authorizes direct sends
only within that session and only while all current checks pass. Existing
personal-agent connections remain the mechanism for communication between
independently authorized named agents outside a session.

### 4. Ordinary Messages Do Not Interrupt

The default send wakes an idle recipient or enters its existing queue behind the
current turn. It does not steer active work. This avoids recreating the early
failure mode where frequent peer messages continually interrupt reasoning.

Guidance remains a separate, explicit permission and is excluded from the first
session slice. A future session may allow it for selected edges, never implicitly
for all peers.

### 5. Outcomes Remain Honest

Each target in a send or broadcast returns one of:

- `accepted`: the recipient execution system admitted the operation;
- `rejected`: this attempt definitively was not admitted; or
- `unknown`: admission cannot be established or ruled out.

Accepted does not mean read, correct, complete, durable forever, or answered.
Unknown does not authorize an automatic retry. Completion is a separate message,
result, or observed execution state.

### 6. Capabilities Only Narrow

A child or peer cannot acquire more project, tool, network, messaging, or spending
authority than the human-approved session and its own execution principal allow.
A spawned worker receives the intersection of:

- the session policy;
- the spawning participant's delegable scope;
- the destination project's current policy; and
- the runtime's own sandbox and tool policy.

No participant receives reusable human account credentials.

### 7. Human Legibility Is A First-Class Boundary

Humans must be able to see who contacted whom, when, under which session, with
what admission result, and what content was intentionally sent. The compact view
should not pretend to expose hidden reasoning or every internal token.

## Core Objects

### Named Agent

The existing durable registered agent identity bound to a project, `.chat` path,
and thread. It appears in the Agents UI, has a personal account alias, and counts
against the named-agent entitlement.

No schema or quota semantic should be overloaded to represent a temporary worker.

### Coordination Session

A human-authorized, finite context in which participants may communicate directly.
Suggested internal fields:

```ts
interface CoordinationSession {
  session_id: string;
  account_id: string;
  approved_by: string;
  root_agent_id: string;
  project_scope: string[];
  state: "active" | "paused" | "closed" | "expired";
  max_participants: number;
  max_spawn_depth: number;
  max_messages: number;
  max_broadcast_fanout: number;
  allow_external_egress: boolean;
  created_at: string;
  expires_at: string;
  generation: string;
}
```

The exact storage representation is an implementation decision. The semantics
are not: finite scope, one authenticated human principal, explicit limits,
revocation generation, and no hidden authority in model-authored fields.

### Participant

A session-local endpoint referring to either a named agent or an ephemeral task
agent. It has a stable ID for the life of the session, display metadata, ancestry,
an exact execution endpoint, and lifecycle status.

```ts
interface CoordinationParticipant {
  participant_id: string;
  session_id: string;
  kind: "named-agent" | "task-agent";
  agent_id?: string;
  parent_participant_id?: string;
  project_id: string;
  path: string;
  thread_id: string;
  run_id: string;
  depth: number;
  state: "starting" | "ready" | "busy" | "completed" | "failed" | "stopped";
  joined_at: string;
  expires_at: string;
}
```

The trusted service assigns these fields. Models may suggest display labels but
cannot mint participant identity, ancestry, or membership.

### Task Agent

An ephemeral execution participant created for one coordination session. It does
not appear in the main Agents list, does not receive an account-unique `@name`,
and does not consume the named-agent quota. It has:

- a parent and complete ancestry;
- one human execution principal;
- an exact project/runtime binding;
- a maximum lifetime and spawn depth;
- a scoped session credential; and
- explicit completed, stopped, expired, and failed states.

The implementation should adapt the runtime's existing subagent mechanism rather
than invent a second model runner. If the active model/runtime cannot expose a
subagent as a messageable endpoint, the session still works with named agents.

### Message Attempt

A single bounded attempt to admit one intentional message to one recipient. It
reuses the current RPC semantics and includes trusted session metadata:

```ts
interface CoordinationMessageAttempt {
  attempt_id: string;
  session_id: string;
  session_generation: string;
  source_participant_id: string;
  target_participant_id: string;
  body: string;
  reply_to_attempt_id?: string;
  application_correlation_id?: string;
}
```

Application correlation is useful for agents but conveys no idempotency or
authority. The platform's authenticated source, exact target, session generation,
and attempt ID are trusted metadata and must not be inferred from the body.

## Minimal Tool Surface

Expose stable, runtime-neutral operations. Names can differ by adapter, but the
semantics should remain small and unsurprising.

| Operation                          | Semantics                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `peers()`                          | List active participants the caller may contact, with compact capabilities and status. No project browsing.                     |
| `send(to, text, reply_to?)`        | Make one bounded ordinary RPC attempt to one exact peer.                                                                        |
| `broadcast(to[], text)`            | Expand a bounded recipient list into independent send attempts and return a result for every target. No atomic broadcast claim. |
| `inspect(attempt_id, to)`          | Read available admission evidence for the caller's own attempt. Never starts work.                                              |
| `complete(summary?, result_refs?)` | Mark an ephemeral participant complete and publish intentional result references. It grants no merge authority.                 |

Later, when task-agent identity is qualified:

| Operation                             | Semantics                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `spawn(task, context_refs?, limits?)` | Create one child within the remaining session and parent limits. Return a participant ID or an honest failed/unknown outcome.    |
| `stop(participant_id)`                | Request authorized cancellation of a descendant. This is separate from messaging and does not retract prior messages or effects. |

Do not add `assign_role`, `create_plan`, `vote`, `elect_manager`, `merge_answer`,
or domain-specific task types to the platform protocol. Models can express those
coordination patterns in ordinary messages and artifacts. Promote a new primitive
only after repeated evidence that it needs platform-level semantics.

## Delivery And Execution Semantics

### Direct Send

1. The caller generates and records an attempt ID before network submission.
2. Trusted infrastructure authenticates the participant and current runtime.
3. The authoritative service verifies active session generation, sender and
   target membership, exact human principal, project access, expiry, message
   budget, payload size, and rate limits.
4. Current route and recipient execution eligibility are resolved.
5. One bounded submission is made through the recipient's existing ACP path.
6. The operation returns accepted, rejected, or unknown with inspectable evidence.
7. No generic reconnect layer or session service retries the mutating operation.

The recipient sees the message as attributed external input. The model context
should clearly distinguish peer, human, system, and tool content. A peer message
must not be interpolated into system instructions.

### Broadcast

Broadcast is a convenience expansion, not a new delivery guarantee. The caller
supplies an explicit recipient list obtained from `peers()`. The service enforces
fanout limits and returns one independent outcome per target. Partial acceptance
is normal and visible. Broadcast must not enumerate undisclosed agents or infer
membership from account/project contents.

The first slice should cap broadcast below the session participant maximum and
apply per-source and per-session rate limits. A large swarm must use a later,
separately qualified fanout mechanism rather than turning one RPC request into
unbounded memory or Conat pressure.

### Receiving While Busy

Use the existing execution queue. Do not add a polling loop that repeatedly
injects messages into a running turn. Multiple queued peer messages may be
presented as a bounded chronological batch at the next safe turn boundary, but
the original sender, target, attempt, and reply relationships must remain
available for inspection.

If batching is added, it is a context presentation optimization, not a new
message state. Truncation should produce references to inspect the original
messages rather than silently dropping attribution.

### Replies And Completion

A reply is an explicit send and requires current session authority in the reverse
direction. Session membership supplies that bounded reverse direction; personal
links outside the session remain directional as today.

A result or `complete` operation records intentional output and references. It
does not prove correctness or perform a merge. The requesting agent or human
decides what to do with it under their own authority.

## Forking Context And Merging Results

Future runtimes are likely to fork existing context into temporary agents. CoCalc
should support this without treating hidden model state as a portable platform
object.

The spawn adapter should accept a bounded context manifest containing references
such as:

- parent conversation/thread and an explicit message range;
- selected files, snapshots, blobs, artifacts, or commits;
- a compact task prompt; and
- the session and parent participant identities.

It should not blindly duplicate every transcript, secret, browser session, open
file, or environment variable. Reference resolution occurs under the child
principal and project policy. Large data uses existing file/blob paths rather
than message bodies.

"Merge" initially means an agent sends a summary, patch, artifact, proof, or
other result reference back to a peer. Applying a patch, merging a branch,
publishing a file, or changing external state remains an existing protected
operation. There is no generic platform `merge minds` primitive.

## Human Transcript UX

The current raw presentation of agent-to-agent traffic is not adequate for
routine human inspection. Add a first-party Slate element for an intentional
inter-agent message, following the architecture of the `guidance` element.

### `agent-message` Element

An agent message renders by default as a compact card:

```text
@reviewer -> @builder                         Accepted
The failing case is in attachment-reservations.test.ts ...
```

The card should show:

- sender and recipient display names with distinct agent styling;
- ordinary, reply, or broadcast-copy context;
- a truthful admission/execution label;
- timestamp and a compact one- or two-line body preview; and
- an affordance to inspect details.

Clicking or keyboard-activating the card opens an inspector containing:

- the complete intentionally sent body;
- source, target, session, participant, run, attempt, and correlation IDs;
- parent/reply relationship;
- accepted, rejected, or unknown admission evidence;
- known queued/running/completed execution observation, labeled separately;
- timestamps and project/thread links the current human may access; and
- a copyable diagnostic representation with credentials and secrets omitted.

The default card must be visually quieter than a human message and much quieter
than a tool transcript. Repeated messages can collapse under a "3 agent messages"
summary while remaining individually inspectable. Questions directed at the
current human must remain prominent and must not be collapsed as background
traffic.

### Trust Boundary

The Slate node is presentation, not authority. Trusted attribution and delivery
state come from protected chat/message metadata or an authorized lookup keyed by
message ID. They do not come from editable Markdown attributes.

A fenced representation is still useful for editing, static rendering, and
export, for example:

````markdown
```agent-message
@reviewer -> @builder

The failing case is in attachment-reservations.test.ts ...
```
````

When arbitrary Markdown containing this fence lacks trusted record metadata, it
must render as an unverified quoted agent message or ordinary fenced content. It
must not display an authenticated badge, accepted state, project access, or a
working attempt inspector merely because text claims those fields.

The Markdown exporter should preserve readable sender/recipient labels and body,
but never emit credentials, internal RPC subjects, reusable capabilities, or
private project locators. Static/public viewers must degrade safely when the
viewer cannot inspect the underlying record.

### Implementation Shape

The likely frontend path is:

1. Add `elements/agent-message.tsx` beside `guidance.tsx` with editable and static
   renderers and theme-aware `UI_COLORS`.
2. Register the type in `types.ts`, `types-ssr.ts`, and the public viewer with a
   safe fallback.
3. Extend Markdown-to-Slate fenced-code parsing for `agent-message`.
4. Carry a trusted, non-user-authored agent-message reference from chat row
   metadata into the render model.
5. Add an accessible inspector drawer/modal shared by the Agents page and the
   ordinary `.chat` editor.
6. Test keyboard activation, screen-reader labels, light/dark themes, untrusted
   fence fallback, missing/expired records, and narrow layouts.

Do not encode the whole RPC envelope in Slate descendants. That makes operational
metadata editable, bloats sync state, and creates two sources of truth.

## Human Control Surface

The Agents page should show a compact coordination activity section for the
selected named agent, not add every worker to the main agent list.

Required controls:

- start a session by selecting two or more eligible named agents;
- inspect participants, ancestry, active/idle/completed state, age, and limits;
- pause new sends/spawns without pretending to cancel admitted work;
- close the session and revoke future admissions;
- stop an authorized descendant;
- inspect message flow as a list or lightweight graph; and
- see aggregate messages, attempts, unknown outcomes, runtime, and cost.

The graph is an observability view, not a workflow editor. It should be loaded on
demand and summarize high-volume edges. The human transcript remains the primary
place to inspect message content in context.

## Authorization Model

### Session Creation

Creating or materially expanding a session is a first-party human action. The
server derives the human identity and verifies:

- ownership/eligibility for the root named agent;
- the same human's current collaborator eligibility in every selected project;
- current named-agent identity and project ownership routes;
- membership and resource limits; and
- fresh authentication when the policy crosses the same threshold as creating
  personal communication links.

An agent may request that the human create or expand a session, but conversational
approval is never sufficient.

### In-Session Sends

The receiving side verifies immediately before admission:

- authentic participant runtime identity;
- active session ID and generation;
- source and exact target membership;
- current account and project eligibility;
- unexpired, unpaused limits and budget; and
- current destination route and execution admission policy.

Closing or pausing a session prevents new admissions. It does not retract content
already written, cancel admitted turns, reverse file changes, or erase audit data.

### Egress

The first slice permits sends only to session participants. Contacting a named
agent outside the session uses an existing personal connection. External network
access, email, publishing, project mutation, and other effects remain governed by
their own tool and project policies.

If session egress is added later, it must name exact destination classes and be
separately visible to the human. Never interpret "ask somebody else" as blanket
permission to discover accounts, projects, or services.

## Ownership And Multibay Routing

Apply the architecture rules in [scalable-architecture.md](scalable-architecture.md):

- The account home bay is authoritative for the human's session approval,
  account limits, personal aliases, and account-level pause/revocation.
- A project owning bay is authoritative for its named agent identity, project
  access, project policy, and participant execution endpoint.
- The current host/bay placement is authoritative for project-host admission and
  runtime attachment.
- Cross-bay operations use the existing inter-bay control plane and explicit
  ownership resolution. A stale local row or route is not authority.
- Human credentials are never copied to another bay or project host. Workers use
  short-lived, narrowly scoped runtime credentials.
- Steady-state model, file, and tool traffic continues directly between the
  client/runtime and project host where possible. The hub authorizes and routes;
  it does not become a proxy for all worker data.

A session spanning projects has distributed execution, not distributed authority.
The home bay owns the session policy. Each project owner still makes its own
current admission decision. If required authority cannot be checked within the
bounded deadline, fail closed with rejected or unknown semantics rather than
silently accepting on cached membership.

The physical table layout, short-lived permit mechanism, and authorization
freshness window must be settled with a failure-mode review before coding the
cross-bay slice.

## Resource And Safety Boundaries

The session policy must bound at least:

- participants and recursive depth;
- simultaneous running task agents;
- session lifetime and idle lifetime;
- UTF-8 bytes per message;
- sends per participant and per session over time;
- total messages and broadcast fanout;
- queued execution admission and project starts;
- context manifest bytes and attachment counts;
- model tokens, runtime, and spend where the runtime can enforce them; and
- retained attempt/message metadata.

Defaults should be intentionally small. A reasonable experiment might start with
2-8 named participants, no dynamic spawn, no guidance, 32 KiB messages, a bounded
session TTL, and broadcast to at most 8 explicit peers. These are qualification
inputs, not final product constants.

Reject before expensive preparation whenever possible. A failed or overloaded
recipient must not block unrelated recipients. No indefinite waits, unbounded
in-memory fanout, or recursive automatic retry.

### Threats To Qualify

| Threat                                                 | Required boundary                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Agent text claims human approval or a broader role     | Treat body as untrusted content; enforce protected grants outside the transcript.                                            |
| Compromised worker contacts arbitrary agents           | Exact active-session membership and target checks at admission.                                                              |
| Child widens its tools, projects, network, or budget   | Monotonic capability intersection and server-assigned ancestry.                                                              |
| Spawn explosion or message storm                       | Participant, depth, rate, fanout, queue, runtime, and spend limits with overload rejection.                                  |
| Message loops                                          | Attempt/reply/causation observability, rate limits, duplicate warnings, and human stop/pause; no automatic transport replay. |
| Unknown admission is blindly retried                   | Explicit unknown state, inspect-only operation, and duplicate-risk warning.                                                  |
| Stale session survives pause, move, restore, or rehome | Generation/placement fencing and current authoritative checks.                                                               |
| Model-authored Markdown forges a trusted card          | Trusted row metadata; unverified rendering for arbitrary fences.                                                             |
| Cooperative agents hide harmful behavior               | Durable intentional-message audit, sandboxing, protected effects, anomaly metrics, and defense in depth.                     |
| Human UI becomes unusable at volume                    | Compact grouped cards, on-demand detail, summaries, and bounded retention.                                                   |

Communication observability is not a substitute for secure sandboxes or aligned
models. Conversely, do not train or prompt models to hide ordinary coordination
merely to make the UI quieter. Preserve the intentionally sent messages and solve
human overload in presentation.

## Persistence And Retention

Persist only what needs durable authority or honest inspection:

- session policy, state, generation, approval, limits, and timestamps;
- participant identity, ancestry, exact endpoint, lifecycle, and expiry;
- bounded attempt evidence and intentional-message references;
- explicit completion/result references; and
- audit events for create, expand, pause, close, spawn, stop, and denied actions.

Reuse existing ACP queues and chat storage for admitted execution and transcript
content. Do not create a second messaging backlog that retries unavailable
recipients. Do not duplicate complete chat transcripts in session tables.

Retention must be long enough to support advertised inspection and security
review, but bounded. After attempt evidence expires, inspection returns unknown;
it must not infer rejection. Closed session metadata can compact participant and
edge summaries while preserving required audit records and chat messages under
their existing retention rules.

## Implementation Stages

### Stage 0: Lock The Contract

- [ ] Approve terminology: internal `coordination session` and
      `participant`; choose the human-facing label after testing.
- [ ] Specify session lifecycle, generation, limits, and authority owner.
- [ ] Specify exact send/broadcast outcomes using the existing RPC contract.
- [ ] Decide fresh-auth requirements and account/project eligibility checks.
- [ ] Define the trusted chat-row metadata needed by the `agent-message` view.
- [ ] Add threat-model and multibay failure tables before schema work.
- [ ] Define telemetry with no message bodies or secrets in routine logs.

Exit criterion: one reviewed protocol document and test matrix, with no ambiguity
about who authorizes a session, which bay is authoritative, or what `accepted`
means.

### Stage 1: Named-Agent Session Experiment

This is the recommended first implementation slice.

- [ ] A human selects 2-8 of their eligible registered named agents and creates
      one finite session.
- [ ] The service stores one session policy and participant set, not N-squared
      personal-link rows.
- [ ] Each runtime can call `peers`, direct `send`, bounded `broadcast`, and
      `inspect` through its existing scoped identity.
- [ ] Ordinary sends use the current RPC/ACP admission path and queue semantics.
- [ ] Existing personal-agent messaging continues unchanged outside the session.
- [ ] The human can pause and close the session and inspect per-target outcomes.
- [ ] The `.chat` transcript renders trusted compact `agent-message` cards with
      an accessible detail inspector.
- [ ] The Agents page shows one compact session/activity summary for the selected
      agent; it does not add participant tabs or a workflow board.

Exit criterion: three named agents can clarify, disagree, reply, and broadcast
without a manager relay; all traffic is bounded, attributable, inspectable, and
correct across one-bay and multibay project placement.

### Stage 2: Ephemeral Task Agents

- [ ] Adapt the existing model runtime's subagent lifecycle to issue a scoped
      participant identity and exact parent ancestry.
- [ ] Add `spawn`, `complete`, and descendant `stop` with strict depth,
      concurrency, TTL, context, and spend limits.
- [ ] Make task agents peers inside their session, including lateral direct sends.
- [ ] Keep task agents out of the named-agent registry, account alias namespace,
      and named-agent entitlement.
- [ ] Reconcile runtime restarts, stopped parents, expired sessions, and lost spawn
      acknowledgments without blind replay.
- [ ] Reuse the subagent activity UI for lifecycle and cost; link intentional
      peer messages to transcript cards.

Exit criterion: a root can fork two bounded workers, the workers can communicate
laterally, each can return a result, and session shutdown reliably prevents new
work without claiming to undo admitted effects.

### Stage 3: Context And Volume Controls

- [ ] Add explicit bounded context manifests for spawn/fork.
- [ ] Batch queued peer messages at safe turn boundaries while retaining original
      inspectable records.
- [ ] Add compact edge summaries and an on-demand communication graph.
- [ ] Add tier-aware participant, concurrency, token, runtime, and spend limits.
- [ ] Qualify larger fanout separately with load and failure testing.

Exit criterion: useful coordination remains legible and bounded under realistic
message volume, project movement, host failure, and session expiry.

### Stage 4: Evidence-Driven Extensions

Only after measurements should CoCalc consider reusable teams, broader egress,
specialized result contracts, persistent shared artifacts, or higher-level
workflow tools. Any added primitive must solve observed failure modes better than
ordinary peer messaging and artifacts.

## Test Matrix

### Protocol And Authorization

- A participant can list only peers in its active session.
- A direct peer send succeeds without a personal N-squared link.
- The same send outside the session is rejected unless a personal link allows it.
- Paused, closed, expired, wrong-generation, wrong-human, and removed-collaborator
  sessions reject new admissions.
- A known participant ID, session ID, project path, or forged body field conveys
  no authority.
- A child cannot widen projects, tools, network, guidance, spend, depth, or TTL.
- Reverse replies work within an active session but do not create a permanent
  reverse personal link.

### Outcomes And Failure

- Idle recipients wake; busy recipients queue without steering.
- Lost acknowledgment after possible admission returns unknown.
- Inspection never creates, retries, wakes, or steers work.
- Explicit retry after unknown has a new attempt ID and a duplicate warning.
- Broadcast reports accepted, rejected, and unknown independently per recipient.
- Project move, host change, restore, restart, and route staleness do not revive
  obsolete session or runtime authority.
- Closing the browser does not cancel an accepted send or leave an unbounded
  server wait.

### Load And Abuse

- Participant, recursion, message, byte, fanout, rate, queue, and concurrency
  limits reject predictably before resource exhaustion.
- One unavailable recipient does not delay unrelated broadcast recipients beyond
  the bounded call contract.
- Message loops become rate-limited and visible; no infrastructure retry amplifies
  them.
- Session pause/close remains responsive under maximum qualified load.
- Routine logs and metrics contain no message body, credential, or private file
  content.

### Transcript UX

- Trusted messages render sender, recipient, and state correctly in editable,
  static, and server-rendered views.
- Clicking and keyboard activation open the same authorized inspector.
- Arbitrary `agent-message` fences cannot forge trusted attribution or delivery.
- Missing, expired, inaccessible, and legacy metadata degrade honestly.
- Compact groups remain expandable and preserve every intentional message.
- Screen-reader labels, focus order, contrast, light/dark themes, browser zoom,
  and narrow desktop layouts meet the frontend accessibility requirements.

### Task Agents

- Spawned workers do not appear in the named-agent list or consume its quota.
- Parent death does not silently transfer authority or ownership.
- Lost spawn acknowledgment never causes an automatic duplicate child.
- Completed/stopped/expired workers cannot send or spawn again.
- Lateral worker communication is allowed only inside the exact active session.
- Result references are reauthorized when opened or applied.

## Observability And Evaluation

Measure whether the primitive helps rather than assuming swarm size is success.
Aggregate, privacy-preserving metrics should include:

- session creation, size, lifetime, and project count;
- direct sends, replies, broadcasts, and messages per useful completion;
- accepted, rejected, and unknown rates and admission latency;
- queue delay and time to first useful peer response;
- spawned/completed/failed/stopped workers, depth, and concurrency;
- token, runtime, and cost overhead relative to single-agent baselines;
- duplicate work after explicit unknown retries;
- human pauses, stops, expansions, and inspector use;
- rate-limit, fanout, capability, and authority denials; and
- task success/latency comparisons for domains with different parallelizability.

Do not use message content or private chain of thought in routine telemetry.
Qualitative, opt-in studies can examine whether agents clarify, share discoveries,
challenge incorrect answers, converge, or merely duplicate work.

## Decisions Required Before Stage 1

1. Is the human-facing object called a **session**, **team**, or **group**? Keep
   `coordination session` as the technical term unless a better contract emerges.
2. Does creating a session always require fresh auth, or only sessions crossing
   projects or adding egress? The first implementation should choose the stricter
   behavior if the boundary is uncertain.
3. What is the authoritative storage and permit mechanism for a session spanning
   multiple owning bays?
4. Which exact chat-row fields hold the trusted `agent-message` reference and
   which authorized endpoint supplies inspector details?
5. What qualified defaults apply to participant count, TTL, messages, fanout,
   rate, queue admission, and retained evidence?
6. Which runtime subagent API can supply an exact execution identity, ancestry,
   bounded context manifest, and stop/recovery semantics for Stage 2?
7. Which membership tiers control simultaneous task agents and aggregate spend?
   Named-agent limits and task-agent concurrency should remain separate products.

## Acceptance Criteria For The Minimal Product

The minimal coordination layer is ready for a controlled experiment when:

1. One human can authorize a finite group of existing named agents without
   creating every directional personal link.
2. Every agent gets a discoverable direct-message primitive and no required
   coordinator.
3. Busy recipients are not interrupted, and every submission has honest bounded
   outcomes with no automatic retry.
4. Session membership cannot be used to browse projects, acquire tools, widen
   permissions, or contact outsiders.
5. Humans can pause/close the session and inspect every intentionally sent message
   through a compact, accessible transcript card.
6. Cross-project and cross-bay routing follows authoritative ownership and fails
   closed when current authorization cannot be established.
7. Resource limits and overload behavior survive fault and load tests.
8. Existing personal-agent messaging, named-agent quotas, `.chat` collaboration,
   and normal project execution continue to behave unchanged.
9. Telemetry can answer whether direct lateral communication improves outcomes,
   latency, or human effort enough to justify Stage 2.

The strategic bet is deliberately small: future models may arrive already good
at organizing themselves, so CoCalc should provide a secure place to do that
rather than hard-code today's preferred organization. The platform's durable
value is the surrounding boundary: identity, scope, execution, artifacts,
collaboration, observability, and human control.
