# Sponsored Projects Runtime Slots Plan

Status: minimum release-worthy phases nearly complete, 2026-05-14.

Implementation notes:

- Phase 0 complete.
- Phase 1 complete.
- Phase 2 complete, including batched cross-bay runtime slot heartbeats.
- Phase 3 is being completed: start/restart slot exhaustion propagates as a
  structured LRO result with privacy-filtered visible project details, frontend
  stop actions, sponsor upgrade routing, and CLI rendering. Explicit
  sponsor-change actions remain Phase 5 follow-up work.
- Phase 4 complete: project owners, runtime sponsors, and administrators can
  disable ordinary collaborator starts that consume the runtime sponsor's
  simultaneous running-project slots.
- Runtime sponsor resolution enforces the core invariant that explicit runtime
  sponsors and `usage_account_id` sponsors must be current project
  owners/collaborators; otherwise resolution falls back to the project owner.

This document defines a phased design for limiting simultaneous running projects
without making collaboration confusing. It is a follow-up to
`SEC-START-001` in
`release-security-abuse-scoreboard-2026-05-11.md`.

Related documents:

- `/home/user/cocalc-ai/src/.agents/scalable-architecture.md`
- `/home/user/cocalc-ai/src/.agents/membership-usage-limits-release-spec-2026-04-25.md`
- `/home/user/cocalc-ai/src/.agents/shared-host-stopping-eviction-spec-2026-04-29.md`
- `/home/user/cocalc-ai/docs/membership.md`

## Problem

CoCalc projects are collaborative. A project may be owned by one account, used
by several collaborators, started manually, started by UI navigation, or started
automatically by SSH/HTTP/app access.

A simple limit such as "owner may run at most N projects" is not enough:

- collaborators can consume the owner's running-project slots
- a collaborator who upgrades cannot necessarily start a project they use
- the owner can be blocked by invited users
- attributing by the clicking account makes project behavior depend on who
  happened to start it
- autostart makes slot exhaustion harder to explain

The release requirement is not perfect billing. The release requirement is a
clear, enforceable abuse guardrail that users can understand.

## Product Model

### Core Concept: Runtime Sponsor

Every running project has one **runtime sponsor**.

The runtime sponsor is the account whose membership is used for simultaneous
running-project admission, shared-compute priority and RAM limits for that project. The sponsor is not used for disk space or egress metering.

User-facing wording:

> This project runs on Alice's membership. Alice can run 2 of 3 sponsored
> projects right now.

This is intentionally explicit. It avoids hidden behavior where a project starts
with different limits depending on who clicked "Start".

### Relationship To Existing `usage_account_id`

The current `projects.usage_account_id` field means:

> Optional account id that should be charged membership usage, storage, and
> managed egress for this project.

That is close to, but not exactly the same as, "runtime sponsor".

Recommended release interpretation:

- define `runtime_sponsor_account_id` as a logical concept immediately
- for the first implementation, resolve it as
  `projects.usage_account_id ?? projects.owner_account_id`
- do not expose the database field name in the UI
- call it "compute sponsor" or "runtime sponsor" in user-facing copy

Recommended future refinement:

- consider a separate `projects.runtime_sponsor_account_id` if we need runtime
  sponsorship to differ from storage/egress attribution
- until that need is demonstrated, avoid adding a second project-level sponsor
  column

## Goals

1. Prevent one high-entitlement account from implicitly sponsoring unbounded
   simultaneous compute for many free collaborators.
2. Make blocked starts explainable in one or two sentences.
3. Let a paid collaborator intentionally sponsor a project they need to run.
4. Keep project behavior stable regardless of which collaborator clicks start.
5. Preserve low-latency project start when the sponsor has available slots.
6. Work in the multibay architecture.
7. Avoid automatic destructive/annoying behavior by default.

## Non-Goals

1. Perfect real-time global accounting under every network partition.
2. Per-second runtime billing.
3. Splitting storage, egress, and runtime sponsorship in the first phase.
4. Automatically solving every course/team product policy.
5. Automatically stopping an arbitrary existing project without explicit policy.

## User-Facing Rules

### Start Rule

Starting or restarting a project consumes one slot from the project's runtime
sponsor.

The sponsor is stable project metadata, not the actor who clicked start.

### Collaborator Starts

Collaborators may start a project if:

- they have project permission to start it
- the project allows collaborator starts using the current sponsor
- the sponsor has a free runtime slot

If the sponsor is full, the collaborator sees:

- who sponsors the project
- the sponsor's current slot usage
- which running sponsored projects could be stopped, if visible/allowed
- upgrade or "use my membership" options when applicable

### Owner Starts

The owner is subject to the same sponsor-slot rule. If collaborators have filled
the sponsor's slots, the owner sees the same slot-management UI.

This is expected, but must be legible. The owner can disable collaborator starts
or stop sponsored projects.

### Paid Collaborator Escape Hatch

A collaborator with sufficient membership should have an explicit action:

> Run this project using my membership.

First release can defer this action if needed, but the model should reserve the
space for it. The action should be explicit because it changes who sponsors
future starts of the project.

### Autostart

Autostart must not silently bypass sponsor-slot policy.

For SSH/HTTP/app/UI autostart:

- if the project has `autostart_enabled=false`, fail immediately
- if the sponsor has a free slot, start normally
- if the sponsor is full, fail with a clear structured denial

Do not auto-stop the oldest project by default in v1.

Future optional policy:

- sponsor-level "make room for autostart" setting
- only stop projects that are idle, not pinned, and sponsored by the same
  account
- default off

## Membership Entitlement

Add a membership usage limit:

```ts
max_sponsored_running_projects: number;
```

Meaning:

> Maximum number of simultaneously `starting` or `running` projects sponsored by
> this account on shared project hosts.

Suggested initial defaults for review:

- free: `1`
- standard/member: `3`
- instructor/pro: `10`
- admin/internal: explicit override

The exact numbers should be pricing/product decisions. The important design
choice is that the cap belongs to the sponsor account.

## Authority And Multibay Rule

The sponsor account's **home bay** is authoritative for sponsor-slot admission.

The project owning bay is authoritative for:

- project metadata
- collaborators
- project lifecycle state
- host placement

The project host is authoritative for:

- actual local runner state
- heartbeat/reconciliation for a running project

Start path in the multibay architecture:

1. Caller's bay receives start/restart request.
2. Request routes to the project owning bay.
3. Owning bay resolves project metadata and runtime sponsor.
4. Owning bay asks sponsor home bay to reserve a runtime slot.
5. If reservation succeeds, owning bay proceeds to host placement/start.
6. Project host heartbeats slot ownership while project is starting/running.
7. Stop/error/reconcile releases or expires the slot.

Do not enforce sponsor slots by direct local database reads unless the account
home bay is local or the deployment is explicitly one-bay Launchpad.

## Durable Slot Model

Use a durable table on the sponsor home bay, not an in-memory counter.

Proposed table:

```sql
project_runtime_slots (
  sponsor_account_id uuid not null,
  project_id uuid not null,
  owning_bay_id uuid not null,
  host_id uuid,
  state text not null,
  actor_account_id uuid,
  reason text,
  acquired_at timestamptz not null,
  heartbeat_at timestamptz not null,
  expires_at timestamptz not null,
  op_id uuid,
  metadata jsonb not null default '{}',
  primary key (sponsor_account_id, project_id)
)
```

Indexes:

- `(sponsor_account_id, state)`
- `(expires_at)`
- `(project_id)`
- `(owning_bay_id)`

Count states:

- `starting`
- `running`

Non-counting terminal states can either be deleted or retained briefly for
debugging:

- `released`
- `expired`
- `failed`

Acquire semantics:

- transaction on sponsor home bay
- delete/expire stale rows first
- count active rows for sponsor
- compare with effective membership limit
- upsert project row if this project already owns a slot
- otherwise insert a new slot

Release semantics:

- stop path releases explicitly
- start failure releases explicitly
- project-host heartbeat keeps the row fresh
- reconciliation expires rows when the host/bay crashes

This table is an admission-control table, not billing history. Billing/audit can
consume events from it later.

## Structured Denial

Project start should return a structured denial, not a generic error string.

Suggested shape:

```ts
{
  code: "runtime_sponsor_slots_exhausted",
  sponsor_account_id: string,
  sponsor_display_name?: string,
  limit: number,
  current: number,
  active_projects: Array<{
    project_id: string;
    title?: string;
    state: "starting" | "running";
    last_started?: string;
    can_stop: boolean;
  }>;
  can_change_sponsor: boolean;
  can_upgrade: boolean;
}
```

The UI should use this to show:

- "This project runs on Alice's membership."
- "Alice is using 3 of 3 running-project slots."
- stop buttons for projects the actor can stop
- a membership upgrade link when the actor is the sponsor
- a "use my membership" action when supported

## Phased Implementation

### Phase 0: Product/Terminology Decision

Deliverables:

- choose user-facing name: "runtime sponsor" or "compute sponsor" ANS: "runtime sponsor"
- decide whether v1 uses `usage_account_id ?? owner_account_id` ANS: yes as the default; but I think we should implement the full spec. This is gold.
- decide initial tier defaults ANS: your suggestions are fine -- free = 1, standard/student=3, pro=10.
- decide whether collaborator starts using owner/sponsor slots are enabled by
  default -- ANS: yes.

Recommendation:

- use "compute sponsor" in UI
- use `runtime_sponsor_account_id` in code as the logical name
- back it with `usage_account_id ?? owner_account_id` for v1
- enable collaborator starts by default for existing collaboration semantics
- make the sponsor and slot consumption visible

### Phase 1: Read-Only Sponsor Resolution

Goal:

- make the model observable before blocking starts

Implementation:

- add a server helper that resolves:
  `runtime_sponsor_account_id = usage_account_id ?? owner_account_id`
- expose sponsor metadata in project settings/status APIs
- add membership limit key `max_sponsored_running_projects`
- show read-only "Compute sponsor" in project settings
- add admin/membership tier editor support for the new limit

Validation:

- resolver tests for owner fallback and `usage_account_id`
- multibay routing test that sponsor home bay is discoverable
- UI smoke test for project settings display

### Phase 2: Durable Slot Admission

Goal:

- enforce simultaneous running-project slots before expensive start work

Implementation:

- add `project_runtime_slots` table on account home bays
- add sponsor-home-bay RPC:
  - `reserveProjectRuntimeSlot`
  - `heartbeatProjectRuntimeSlot`
  - `releaseProjectRuntimeSlot`
  - `listProjectRuntimeSlots`
- enforce reservation before placement/start/restart
- release on stop/start-failure
- heartbeat from project-host or owning bay while starting/running
- expire stale slots with a short reconciliation worker

Important ordering:

- check project permission first
- reserve slot before expensive restore/placement/start work
- release if any later step fails

Validation:

- unit tests for acquire/release/expire race behavior
- one-bay start/restart tests
- inter-bay start test where project owning bay and sponsor home bay differ
- crash/reconcile test with stale heartbeat

### Phase 3: Blocked-Start UX

Goal:

- make slot exhaustion understandable and actionable

Implementation:

- return structured denial from start/restart/autostart paths
- frontend blocked-start modal lists sponsored active projects
- allow "Stop this project to free a slot" for projects actor can stop
- show upgrade path when actor is sponsor
- show "ask sponsor to stop a project or increase membership" when actor is not
  sponsor
- add CLI rendering for the same structured denial
- Phase 3 note: the first implementation uses an inline failed-start alert
  rather than a separate modal, because the start control already owns project
  lifecycle feedback. Explicit "use my membership" sponsor-change UI is
  deferred to Phase 5.

Validation:

- frontend test or smoke for denial modal
- CLI smoke for denial message
- permission test that collaborators cannot see private projects they cannot
  access, even if those projects consume sponsor slots

### Phase 4: Sponsor Controls

Goal:

- let owners/sponsors prevent accidental collaborator slot consumption

Implementation:

- project setting: `allow_collaborator_starts_using_sponsor`
- default true for backward compatibility
- owner/sponsor/admin can toggle
- if false, collaborator start attempts fail unless actor is sponsor or an
  explicit self-sponsor path exists
- add project settings explanation
- Phase 4 note: the first implementation treats unset as true, stores the
  setting on the authoritative project row, and enforces it on the owning bay
  before runtime-slot reservation.

Validation:

- collaborator start allowed/blocked tests
- owner and sponsor permission tests
- settings UI smoke

### Phase 5: Explicit Sponsor Change

Goal:

- let paid collaborators intentionally use their own membership for a shared
  project

Implementation options:

1. v1 simple reassignment:
   - action changes project sponsor to actor
   - requires actor project permission and actor confirmation
   - notifies project owner/sponsor

2. v2 per-start sponsorship:
   - actor sponsors only this runtime session
   - more complex because behavior depends on the active session sponsor

Recommendation:

- implement option 1 first if needed
- avoid per-start sponsorship until product need is clear

Security/policy requirements:

- never silently change sponsor
- show which account will sponsor future starts
- record durable audit event
- require fresh auth only if this becomes billing-sensitive enough to justify it - ANS: this is not billing sensitive at all; there's never ever any pay-as-you-go billing for running projects; that's entirely for dedicated hosts.

Validation:

- sponsor-change permission tests
- blocked-start flow can transition to sponsor-change
- storage/egress implications reviewed if still backed by `usage_account_id`

### Phase 6: Autostart Policy

Goal:

- make SSH/HTTP/app wake behavior predictable under slot limits

Implementation:

- project setting: `autostart_enabled`
- autostart checks sponsor slots exactly like manual start
- blocked autostart returns protocol-appropriate denial:
  - SSH: clear text error before disconnect
  - HTTP/app: 503 or product page explaining sponsor slots
  - UI open/terminal: blocked-start modal
- optional future sponsor setting:
  `autostart_make_room_by_stopping_idle_projects`

Default:

- do not auto-stop projects to make room
- add make-room policy later only after pressure/idle semantics are well tested

Validation:

- SSH wake denial smoke
- HTTP/app wake denial smoke
- UI autostart denial smoke
- autostart disabled smoke

### Phase 7: Course/Team Polish

Goal:

- make sponsored projects viable for teaching/team workflows

Implementation:

- course/team UI explains "these projects run on instructor/team membership"
- instructor/team admin sees sponsored active-project usage
- bulk stop controls for course/team sponsored projects
- optional course-specific tier defaults
- optional "student may self-sponsor their project" policy

Validation:

- course create/copy workflows preserve expected sponsor
- instructor bulk stop works
- student blocked-start messaging is understandable

### Phase 8: Observability And Abuse Operations

Goal:

- make runtime-slot pressure visible to operators

Implementation:

- central logs for reserve/deny/release/expire
- CLI/admin report:
  - top sponsors by active slots
  - repeated denials
  - stale slot expirations
  - projects started by collaborators using someone else's sponsor
- Prometheus-style counters if needed:
  - `project_runtime_slot_reserved`
  - `project_runtime_slot_denied`
  - `project_runtime_slot_expired`
- scoreboard update when SEC-START-001 moves from blocked to guarded/done

Validation:

- denial report smoke
- stale-slot report smoke
- dashboard/CLI redaction review

## Release Recommendation

Minimum release-worthy implementation:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3

Strongly recommended before public launch:

5. Phase 4
6. Phase 6
7. Phase 8 basic CLI/admin reporting

Can defer:

- Phase 5 explicit sponsor change
- Phase 7 course/team polish beyond clear sponsor display
- automatic make-room autostart policy
- separate `runtime_sponsor_account_id` column

## Open Questions For Review

1. Should the first implementation use `usage_account_id ?? owner_account_id`,
   or should it add a separate runtime sponsor column immediately? Add runtime sponsor column.
2. Should collaborator starts using sponsor slots be enabled by default? YES
3. What are the initial tier defaults for `max_sponsored_running_projects`? See above -- 1, 3, 10 for now. It's easy for admins to adjust.
4. Should "use my membership for this project" be in the first release, or can
   users clone/copy out as the first workaround? ANS: it should be in the first release; being locked out and having to copy a lot of data, etc. (and even hitting your project limit) could be very frustrating. E.g., user is at their project limit and copying is tedious, and cloning isn't allowed since already at the limit. So too frustrated, especially given that they aren't running anything.
5. Should sponsor-slot denial be a hard block for always-running projects, or
   should always-running projects have a separate reserved-slot contract? ANS: the idea of an "always running" project should have been deleted. If not, it should be deleted systematically everywhere. We have replaced that by priorities.
6. Should autostart make-room behavior exist at launch, or remain explicitly
   off? ANS: this is fine to be explicitly off and not implemented -- it feels possibly too unpredictable to be useful.

## Risks

### User Confusion

Risk:

- "sponsor" is a new concept.

Mitigation:

- always show sponsor name near start/stop controls
- phrase limits as "projects running on Alice's membership"
- avoid exposing database names

### Over-Coupling To `usage_account_id`

Risk:

- runtime, storage, and egress sponsorship may need to diverge.

Mitigation:

- keep `runtime_sponsor_account_id` as the logical name in code
- isolate backing-field resolution behind one helper
- add a separate column later without changing user-facing language

### Cross-Bay Latency

Risk:

- every start requires sponsor home bay admission.

Mitigation:

- one RPC before expensive work is acceptable
- keep reservation RPC small and indexed
- project-host can heartbeat asynchronously after start begins

### Stale Slots

Risk:

- crashes can leave sponsors blocked.

Mitigation:

- short expiration window for `starting`
- heartbeat for `running`
- reconciliation worker
- admin/CLI repair command

### Privacy

Risk:

- slot-denial UI could leak names of projects the actor cannot access.

Mitigation:

- list only projects actor can see
- summarize hidden consumption as "other sponsored projects"
- admins can see full detail through admin paths

## Suggested First Code Targets

- `src/packages/util/db-schema/membership-tiers.ts`
- `src/packages/server/membership/resolve.ts`
- `src/packages/server/membership/project-defaults.ts`
- `src/packages/util/db-schema/projects.ts`
- `src/packages/server/projects/control/base.ts`
- `src/packages/server/conat/api/projects.ts`
- `src/packages/server/inter-bay/project-control.ts`
- `src/packages/server/inter-bay/service.ts`
- `src/packages/server/conat/host-registry.ts`
- `src/packages/frontend/project/settings`
- `src/packages/cli`

Exact paths should be rechecked before implementation because project lifecycle
code is actively moving.
