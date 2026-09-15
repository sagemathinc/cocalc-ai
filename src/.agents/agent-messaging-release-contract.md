# Agent Messaging Release Contract

Date: September 15, 2026. Status: **draft for William's approval**.

This is the proposed product and authorization contract for the first controlled
release, not a statement that the implementation satisfies it. William decides
product requirements. Reviewers assess implementation against approved requirements
and separately identify residual risks or recommend changes. No SOC-2 policy
change is proposed here.

Once approved, this document takes precedence over earlier messaging prototypes
and plans where they differ. Unresolved decisions in section 10 remain unresolved;
neither an implementation default nor a reviewer assumption settles them. A review
must identify its contract revision, implementation SHA, and comparison base.

## 1. Scope And Architecture

**C1.** Release human-approved, human-scoped, single-attempt agent RPC messaging,
with named destinations, bounded attachments, native CoCalc recipients, and
external agent login for sending. Optimize for one human coordinating many agents
while preserving distinct humans' execution principals.

Keep the integrated deployment. The conceptual messaging service owns identity,
connection authorization, bounded routing, and attempt evidence. The CoCalc
adapter owns project/thread resolution, membership, placement, startup, funding,
execution admission, and project file staging. A receiving adapter cannot choose
another human's authority from message text. Both communication permission and
local execution permission are required.

This boundary is an architectural guide, not a requirement to extract a service,
add another database, or implement an adapter SDK before release. Future desktop
or other platform adapters must implement the same authorization and admission
contract. Ease of extraction has not been demonstrated.

Out of scope: federation, external receiving daemons, an offline mailbox, a
messaging outbox, automatic delivery retries, exactly-once execution, a durable
task scheduler, and a new agent workspace UI.

## 2. Trust Model And Authority

**C2.** Project collaborators are trusted participants with broad project
filesystem and execution authority. They are not mutually isolated tenants inside
the shared project OS user. Human-scoped API authorization must still be enforced,
but does not promise secrecy of credentials or prompts from a collaborator who
can inspect the same execution environment. Removing a collaborator does not
recall data already copied or undo actions already performed.

Unrelated accounts/projects, external installations, and message-supplied claims
must not acquire authority merely by knowing a name, UUID, path, or RPC subject.
Received text and attachments are agent-provided content, not human approval.
Trust in collaborators does not eliminate resource isolation between projects or
accounts on shared infrastructure.

**C3.** Resolve authoritative ownership: account home bay for personal names,
approvals and account controls; project owning bay for project state and native
identities; host owning bay/current placement for host actions. External identity
and installation authority belongs to its owning account. A local database row
or stale route alone is not proof of authority. One-bay deployments use the same
rules. No human credentials are copied between bays.

## 3. Identity, Human Scope, And Approval

**C4.** Stable UUIDs identify agents; account-unique short names are aliases.
Renaming must not silently retarget an existing mention or connection. Names and
metadata aid selection, not authorization. A shared thread can have different
personal names and connections for different humans. Registration provenance
alone must not select the execution or billing principal.

Human-approved external installations have their own identities and narrowly
scoped credentials, not the ability to impersonate arbitrary native threads.
Revoking an installation does not require deleting its identity/history. Messaging
credentials do not grant general account, project-browsing, or administrative API
access. Lease recovery requires current issuance authority; it must not silently
undo explicit revocation.

**C5.** Every turn has a fixed authenticated principal. A human turn uses its
sender. In this release, a personal connection approved by P connects a source
running as P to a target running as P; P must qualify in both projects. Different
source/target human principals and cross-account invitation workflows are deferred.
External sending uses the human principal bound by its approved installation.
Runtime sponsorship and payment remain governed by existing platform policy;
the execution principal need not be the runtime sponsor.

Cross-human steering is rejected server-side. Another human may queue a separate
turn under their own authority. Continuations retain their original principal.
Scheduled automation uses the last authenticated human who saved its settings;
background status updates do not transfer responsibility. Queued work must never
inherit another human's authority because settings or a shared session changed.

**C6.** Creating, renewing, or expanding communication permission requires explicit
human approval through first-party fresh-auth flows. A selected mention can open
that flow, but selecting, typing, or receiving a mention is not itself approval.
Name an unnamed source as part of setup. Cancellation preserves private drafts
and does not send the message. Agent approval requests use the typed approval
flow, not a conversational "yes" interpreted as authority.

Permissions are directional. "Communication in both directions" creates two
explicit directional permissions, not a special one-time reply capability.
Finite expiry and never-expiring permissions are supported; neither bypasses
revocation, membership, account, site, or execution checks. Users can globally
inspect, pause and revoke their permissions, and inspect/revoke installations.

## 4. Permission Changes And Execution Boundaries

**C7.** An admission is the recipient execution system acknowledging responsibility
for an ordinary queued/running turn. It is not message discovery, project startup,
attachment preparation, chat persistence alone, or successful completion.

When a membership downgrade/removal commits at its authority, subsequent execution
authorization decisions must use the new membership. Work already authorized and
in flight may cross that boundary; no distributed instantaneous cancellation is
promised. Work accepted but not started rechecks membership before execution.
Running work is not automatically stopped by a membership change.

Resolve current agent execution mode/configuration after startup at final
admission preparation, rather than treating pre-startup preparation as current.
Configuration changes apply to later admissions, not retroactively to already
admitted/running turns. Queued work's membership recheck is separate from its
admission-time configuration snapshot. Any intentional authorization caching or
gap between authorization and submission needs a stated, tested upper bound; the
credential TTL is not automatically permission to cache authorization that long.

**C8.** Connection pause/revocation/expiry blocks later authorization decisions at
the connection authority. Recheck before final admission, including after startup
or attachment preparation. Already authorized in-flight admission may finish;
accepted work is not silently canceled. Revocation does not retract a received
message. Resuming a connection never replays work.

Suggested membership UI copy: "Prevents new agent work from being authorized
under this account. Already-running work is not stopped. Previously authorized
work may still be in flight."

William's intended operational remedy for stopping ongoing project work is an
explicit project restart. Before documenting it as a guarantee, verify that local
processes stop and queued/restored work cannot resume under removed authority.
Restart cannot undo external effects or guarantee termination of work launched on
other computers. Broader file/terminal/session revocation promises are not defined
by this messaging contract. See decision D3.

Host movement must route new receives to the current adapter and require current
placement authority for new credential issuance. The validity window for existing
source credentials after movement is explicitly undecided (D1). Restore must not
silently resurrect revoked approvals or credentials.

## 5. Outcomes And Conversations

**C9.** Each explicit send is one attempt, with a distinct attempt ID and no
automatic transport resubmission that could repeat admission.

| Outcome  | Meaning                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------- |
| accepted | Recipient execution system acknowledged admission; not completion.                                |
| rejected | This attempt is known not to have been admitted. Report any partial chat/file effects separately. |
| unknown  | Admission cannot be determined, including a lost acknowledgment. Not evidence of rejection.       |

An unavailable/disallowed project start or known exhausted admission capacity
fails before copying attachments or writing the incoming chat. Startup may outlive
the request deadline, but must not cause late delivery after that attempt aborts.
Inspection only reads retained evidence and never starts projects or turns.
Evidence loss/restart can yield unknown. Explicit retries after unknown may
duplicate work; neither attempt IDs nor inspection imply exactly-once execution.

**C10.** For delegated tasks, bidirectional approval is the normal offered workflow,
never an implicit permission. A request can ask for an initial response by a
deadline and subsequent progress/result messages. These are correlated ordinary
sends: "started", "unavailable", or "cannot find that commit" are application
responses, distinct from transport acceptance.

This release does not guarantee response deadlines or periodic updates. A missed
deadline means "no response observed", not "delivery failed". Instructions and
correlation metadata support this convention; automated deadline monitoring and
notifications are follow-up features, not a hidden durable scheduler requirement.

## 6. Files And Resource Admission

**C11.** Attach at most 16 regular files and 32 MiB total file content per message.
Same-project references can be live paths, explicitly labeled as such. Across
projects, send selected bounded snapshots, not source paths or project browsing
authority. Use native MsgPack binary data, not base64. Validate manifests, sizes
and file types; stage into isolated destination scratch directories with actual
local paths supplied to the recipient. A failed attachment send must not silently
become text-only. Upload/preparation alone never starts an agent turn.

Bounded hub relay through existing authenticated routes is allowed. Large
streaming file operations and a new east-west host network are not required.
Scratch attachments are ephemeral and not backed up; recipients must copy them
into durable project storage if needed. Ambiguous admission must not delete files
that possibly accepted work still needs.

**C12.** Fail fast when startup, execution, or resource admission is unavailable.
Use existing autostart, runtime sponsor, model funding, quota, and execution gates;
never stop another project to make room. Approval copy must explain that incoming
messages can start a project and consume storage, compute and model budget.

Bound ingress/reassembly, active operations, queued transport data, attempt
evidence, temporary storage, and durable control-plane growth. Limits must account
for aggregate human/project use, not be multiplied without bound by adding agent
identities/installations. A process-wide cap bounds physical resources; an account
cap must retain its meaning across load-balanced processes. Timeouts do not free
capacity still occupied by real work. No unlimited waiting queue is introduced.

Ordinary bounded contention can reject a request; perfect scheduling fairness is
not promised. Partitioning/budgets must prevent one principal from monopolizing
all retained evidence or unbounded shared work. Measure actual resource usage;
per-message limits alone do not establish a process memory bound. Numerical
aggregate limits and retention durations require approval under D2.

## 7. Transcript, Lifecycle, And UI

**C13.** Record and render the authenticated source agent separately from target
execution/billing authority. This is honest best-effort attribution at insertion,
not immutable evidence: project collaborators/agents can edit chat storage. Never
use mutable transcript metadata to authorize a send or execute as another human.

**C14.** Identity administration must have documented disable/recovery semantics.
Trusted collaborators' ability to alter shared project contents is not an
adversarial-isolation defect. A recovery operation must not silently acquire or
transfer someone else's personal approvals. Cardinality and retention controls
must not revive revoked authority when historical rows are removed.

Classify all retained tables by authoritative ownership and define relevant
project/account move, restore and deletion behavior. "Legacy" here means prior
unreleased experimental records, not an established production messaging product.
Inventory them before a maintainer-approved removal; do not automatically replay,
erase, or reinterpret pending/uncertain work to simplify migration.

**C15.** Account AI settings provides a default-off experimental UI opt-in. Off
hides naming, agent suggestions and setup, while preserving collaborator mentions,
readable existing content, and permission/installation management. Explain that
opting out does not revoke or pause existing permissions. This is discoverability,
not an authorization boundary; do not change users' preferences implicitly.

## 8. Operations And Release

**C16.** Keep new deployments fail-closed. Independently control messaging,
attachments, and external login. Document effective rollout/reload scope, in-flight
behavior, and how restrictive management remains available while admission is off.
A site admission gate is not a promise to kill already-running work instantly.

Qualify supported multiprocess and multibay topologies, not just a single-process
test. Document required deployment ordering or mixed-version support. Incompatible
peers reject without broader-credential or text-only fallback. Rollback never
replays uncertain work. No production deployment or enabling site gates without
William's explicit approval.

Release requires a remotely accessible exact review SHA/base, this approved
contract revision, independent review, reproducible evidence, and qualified
artifacts. Passing builds/smoke tests and default-off UI are not security approval.

## 9. Reviewer Instructions

Classify each observation as: contract violation; implementation/liveness defect;
residual risk within the accepted trust model; or proposed requirement change.
State prerequisites, affected boundary, impact, code revision, and evidence.
Separate mocked tests from real boundaries and source inspection from probes.

Do not require isolation between collaborators sharing a project OS user,
tamper-proof project transcripts, instantaneous cancellation of running work, or
guaranteed replies. Do check that scoped credentials, human principals, unrelated
tenants, operational limits and approved lifetime rules are enforced.

Report unspecified policy as an open decision, not a silently assumed requirement.
Follow SECURITY.md for private findings/fixes. Do not publish report details to
the public PR. No fixes are authorized by this documentation task.

## 10. Decisions Before Release Qualification

| ID  | Decision needed                                                                                          | Recommendation, not yet approved                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Existing source credential validity after project movement, plus maximum authorization freshness windows | Reject obsolete placement at subsequent authorization checks; retain already-admitted work. If a bounded old-credential window is chosen instead, state its duration, affected operations and non-renewability explicitly.                                                                                                                                                             |
| D2  | Aggregate resource limits, durable cardinality caps and retention periods                                | Start from current host/project concurrency 4/2; propose 2 active sends per principal, 60 messages and 128 MiB attachment transfer per minute per principal and destination project, and 256 MiB destination attachment scratch. Validate feasibility; storage enforcement/cleanup and durable record retention still need an explicit policy. These are not measured capacity claims. |
| D3  | Exact project-restart termination/resume guarantee and user-facing guidance                              | Verify existing process/queue behavior, then document restart as terminating project-local work without undoing external effects or resuming unauthorized work. Do not claim this is currently verified.                                                                                                                                                                               |

William's approval should record a contract revision and decisions or explicitly
defer them. Review may begin with open decisions, but cannot certify conformance
to an unspecified window or budget. After approval, changes to requirements need
an explicit revision rather than being inferred from whatever the code does.
