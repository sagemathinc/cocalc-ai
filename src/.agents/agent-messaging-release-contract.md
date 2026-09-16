# Agent Messaging Release Contract

Date: September 15, 2026. Status: **approved review contract**, incorporating
William's explicit restart-boundary decision and agreement on bounded resource
policy. Approval defines the requirements for review; it is not release approval.

This is the proposed product and authorization contract for the first controlled
release, not a statement that the implementation satisfies it. William decides
product requirements. Reviewers assess implementation against approved requirements
and separately identify residual risks or recommend changes. No SOC-2 policy
change is proposed here.

This document takes precedence over earlier messaging prototypes and plans where
they differ. Section 10 distinguishes declared requirements from
implementation choices and verification tasks. Neither an implementation default
nor a reviewer assumption changes those requirements. A review must identify its
contract revision, implementation SHA, and comparison base.

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

**Required restart boundary (declared by William):** after committing a removal
or downgrade, the user must explicitly restart the project if they need to ensure
the old CoCalc-managed authority can no longer be exercised. Once that restart
successfully completes, the removed user's CoCalc account has no CoCalc-managed
project access and a read-only user's CoCalc account cannot write or execute with
its former collaborator privileges. Pre-restart agent and other project-local
processes must be stopped. Old sessions, cached grants, CoCalc-managed
credentials, scheduled jobs, or queued/recovered work must not restore those
former privileges. Work may resume only under currently valid permissions and
execution policy. A still-valid CoCalc credential is not permission to keep old
rights.
The same process-termination boundary applies when restarting to enforce a changed
agent execution mode. Agent execution mode is resolved again at admission; unlike
the collaborator map, it is not restored from a project-start authority snapshot.
This is not a requirement to invalidate every unrelated login or installation.

Suggested membership UI copy: "Removing or downgrading a collaborator does not
automatically stop their running work. Restart the project after making the change
to terminate old execution and CoCalc-managed access. Restart does not undo files
they changed or remove project-local credentials such as
`~/.ssh/authorized_keys`; audit or restore persistent project contents when the
former collaborator is not trusted."

Failure of this boundary is **P0 and release-blocking**, as specified by William.
It is a declared requirement, not a verified implementation claim. Review/test
the full project-facing paths necessary to support that promise, not only agent
messaging; report any broader platform gap privately rather than narrowing the
promise to make a messaging test pass. A failed/incomplete restart must not be
reported as having established the boundary.

Restart does not undo prior writes, revoke copies of data already taken, undo
external effects, or promise to terminate work on another computer/project.
Persistent project contents are shared user-controlled state, not an account
authorization database. Restart therefore does not remove or attribute
project-local bearer credentials such as keys in `~/.ssh/authorized_keys`, nor
does it detect scripts, binaries, scheduled tasks, or other persistent changes a
former collaborator may have created. Those credentials continue to mean what
the project owner configured them to mean; they are not treated as the removed
account's CoCalc-managed authority. If a former collaborator may have left
untrusted persistent state, the owner must audit or restore project contents,
remove or rotate project-local credentials, and then restart. This limitation is
part of the trusted-collaborator model rather than a claim that restart sanitizes
the filesystem. William explicitly approved this persistent project-local SSH key
behavior on September 16, 2026.
A message already admitted at another project follows that project's execution
lifecycle. These limits do not permit continued old CoCalc-managed authority in
the restarted project. See verification task D3.

Project movement uses stop-before-move semantics: the old project container and
agent do not keep running normally through the move. Verify this lifecycle and
any host-side controllers or queued work rather than assume a surviving old agent.
Route new receives to the current adapter and require current placement authority
for new credential issuance. Separately examine copied credentials and existing
connections, if applicable; container termination alone does not prove a bearer
credential is unusable elsewhere. Do not impose a new instantaneous credential
invalidation mechanism merely by assuming adversarial collaborators or a surviving
container. D1 now requests evidence about this lifecycle, not a choice between
immediate cancellation and ten minutes. Restore must not silently resurrect
revoked approvals or credentials or bypass the required restart boundary.

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
per-message limits alone do not establish a process memory bound. William agrees
with conservative configurable limits and clear limit-reached errors. Choose,
test and document initial aggregate limits and retention durations under D2;
the earlier suggested numbers are not individually approved or measured capacity.

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
tamper-proof project transcripts, automatic instantaneous cancellation on a
permission edit alone, or guaranteed replies. Do require the explicit restart
boundary in C8, including termination of old project-local processes and no
revival of former authority. Do check that scoped credentials, human principals,
unrelated tenants, operational limits and approved lifetime rules are enforced.

Report unspecified policy as an open decision, not a silently assumed requirement.
Follow SECURITY.md for private findings/fixes. Do not publish report details to
the public PR. No fixes are authorized by this documentation task.

## 10. Decisions And Verification Before Release

### D1. Project Movement: Verify The Actual Lifecycle

Do not ask the maintainer to choose a lifetime for an assumed agent that keeps
running after its container has stopped. Trace stop, container teardown, host-side
controllers, credential renewal, placement change and any queued work. Distinguish
normal operation from copied/stolen credentials, and state the actual preconditions
for any remaining old-host authority. Separate a credentials-lifetime observation
from a demonstrated violation of C8. If a policy choice remains after this
inspection, explain the concrete scenario to William rather than invent a rule.
Document any authorization freshness windows; none can extend old privileges
beyond the successful restart boundary.

### D2. Bounded Resources: Direction Agreed, Defaults To Qualify

William agrees to conservative configurable limits and clear errors, with values
chosen, tested and documented before release. Starting candidates: host/project
concurrency 4/2; 2 active sends per principal; 60 messages and 128 MiB attachment
transfer per minute per principal and destination project; 256 MiB destination
attachment scratch. These numbers remain proposals, not approved exact limits or
measured capacity claims. Specify actual enforcement scope, storage cleanup,
durable cardinality and retention policy, and record test evidence. Escalate
substantial product tradeoffs rather than silently expanding the architecture.

### D3. Restart Boundary: Requirement Settled, Verification Outstanding

Implementations must satisfy C8. Restart after removal/downgrade must stop old
project-local execution and prevent CoCalc-managed permissions returning through
terminals, agents, existing sessions, credentials, automation or queue recovery.
Persistent project content and unattributed project-local credentials remain
subject to the explicit limitation in C8; restart is not filesystem sanitization.
Test ordinary restarts and the equivalent stop/start boundary during project
moves, including already-connected clients and outstanding work. Failure is P0,
not an optional hardening recommendation or permission to wait for a token TTL.
No such full-platform verification is claimed in this document.

William approved this contract for independent review. The restart rule and
resource-policy direction above are decisions, not open questions. Review may
identify implementation gaps. Release qualification must include the exact
enforced resource policy and evidence for the declared restart boundary. Later
requirement changes need an explicit revision, not inference from code.
