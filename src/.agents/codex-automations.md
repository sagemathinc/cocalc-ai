# Codex Automations

Status: Phase 1 done. Daily thread-attached automations are implemented.

Next high-priority work:

- finish Launchpad move/delete/clone lifecycle and scheduler rehydration
- keep clone/fork handling as best-effort until project cloning itself is fixed
- then add richer recurrence, starting with weekdays-only schedules

Goal: add durable scheduled Codex automations to chat threads, while keeping
the thread itself as the delivery surface and the Agents panel as the control
surface.

## Product Direction

Do not copy the Codex app "findings inbox" model.

In CoCalc, the better model is:

- a schedule is attached to a chat thread
- each scheduled run produces a normal assistant turn in that thread
- the existing activity log, links, diffs, and follow-up conversation all stay
  in the same place
- the Agents panel provides visibility, filtering, pause/resume, and "run now"

This fits the current ACP architecture much better than a separate inbox.

## Acceptance Scenarios

### Daily Briefing

1. User opens an ACP chat thread and configures:
   - prompt: `What is the exact status of the project we're working on? What should we do next?`
   - schedule: daily at `05:00`
   - timezone: `America/Los_Angeles`
2. The backend persists the automation.
3. The next day at 5:00 AM, a normal Codex turn is created in that thread.
4. When the user opens the thread in the morning, the full answer is already
   there, with the usual activity log and observability.
5. The thread banner says when it last ran and when it will run next.

### Hacker News Monitor

1. User configures a thread to run daily with:
   `Tell me about recent articles on Hacker News that are relevant to my work in this git repo at ...`
2. Every run appends a normal assistant answer to the same thread.
3. The user can continue the conversation about any one run in that same
   thread.
4. If the user stops looking at the thread, the automation becomes easy to
   discover and optionally pauses itself after a configurable unattended period.

### Restart Safety

1. A project-host or Lite restart happens while an automation is idle and
   waiting for its next scheduled time.
2. The automation is not lost because its config and next run time are durable.
3. After restart, due or overdue automations are detected and enqueued.
4. If a restart happens while a scheduled run is actively executing, the
   durable ACP worker/job path handles it the same way as ordinary Codex turns.

### Daily Security Checkup

1. User configures a thread to run daily with a prompt like:
   `Check all running exposed apps in this project for obvious security issues, risky configuration, missing auth, stale dependencies, or suspicious logs. Summarize concrete findings and recommended fixes.`
2. Each day, Codex inspects the current exposed services and app configuration
   and appends a normal assistant turn to the same thread.
3. If there are no findings, phase 1 can still post the full result; later
   phases may support "only post when materially changed".
4. The user can then discuss or act on the findings directly in the same
   thread.

### Weekly System Maintenance

1. User configures a thread to run weekly with a prompt like:
   `Do routine system maintenance for this project: check for upgrades, excessive log growth, unhealthy services, container issues, disk pressure, and obvious cleanup opportunities. Recommend or apply safe maintenance steps.`
2. The run happens on a weekly schedule and leaves a full normal Codex turn in
   the thread.
3. The thread becomes the durable maintenance record, including follow-up
   discussion and decisions.

## Why This Is Not Just "Loop With a Longer Sleep"

The current loop system is close in spirit but not the right persistence model.

Today:

- loop config is explicitly "for this send" in
  `src/packages/frontend/chat/composer.tsx`
- loop state is consumed inside one ACP evaluation loop in
  `src/packages/lite/hub/acp/index.ts`
- `scheduled` currently means "persist state and then `sleep(...)` in memory"
- there is no durable `next_run_at_ms`
- there is no persistent automation prompt separate from the one-shot send

That is fine for short autonomous reruns. It is not a real durable daily
scheduler.

The right approach is:

- keep the current loop feature as one-shot autonomous continuation
- add a separate thread-level automation layer for recurring schedules
- reuse the existing durable ACP jobs/workers for actual execution

## Core Design Principles

- Thread is the delivery surface.
- Agents panel is the control surface.
- Scheduled runs should look like normal Codex turns once they fire.
- Schedules must be durable across browser close and server restart.
- The system must never require a Lite ACP worker to stay alive all day just to
  wait for the next run time.
- Attention policy should be separate from schedule policy.
- Default behavior should make forgotten automations visible and easy to pause.

## Product Model

Introduce a new thread-scoped concept:

- `automation_config`
- `automation_state`

This should be separate from:

- `loop_config`
- `loop_state`

Reason:

- loops are per-send autonomous continuation
- automations are persistent recurring schedules

The schedule should belong to the thread, not to any one message.

## UX

### Thread Configuration

Add a new "Schedule" / "Automation" control near the existing Codex loop
controls in `src/packages/frontend/chat/composer.tsx` or in the thread header.

Suggested first automation form:

- enabled
- title
  - e.g. `Daily HN scan`
- prompt
  - stored with the automation, not inferred from the last user send
- schedule type
  - MVP: `daily`
- local time
  - e.g. `05:00`
- timezone
  - explicit, not implicit browser-local only
- run mode
  - MVP: `append a normal turn every run`
- attention policy
  - pause after `N` unattended runs
  - or require acknowledgment every `N` days

### Thread Surface

Show a persistent thread banner in `src/packages/frontend/chat/chatroom.tsx`
when the selected thread has an automation.

Suggested content:

- `Scheduled daily at 5:00 AM`
- `Next run <TimeAgo ... />`
- `Last run <TimeAgo ... />`
- `Paused because no acknowledgment for 7 days`
- buttons: `Run now`, `Pause`, `Resume`, `Edit`

Use:

- `TimeAgo`
- existing time formatting helpers or `Time`

### Delivery in the Thread

When a run fires, create:

- a compact synthetic user/system row such as
  `Scheduled run: Daily HN scan`
- followed by a normal assistant turn

Important:

- do not re-post the full automation prompt text every day unless explicitly
  desired
- keep the thread readable
- keep the assistant turn fully normal, with the same observability as any
  ordinary Codex turn

### Agents Panel

Add a dedicated Automations section to the existing Agents UI in:

- `src/packages/frontend/project/page/flyouts/agents.tsx`
- possibly also `src/packages/frontend/project/page/agent-dock.tsx`

This section should list:

- title
- thread link
- enabled / paused / error state
- next run
- last run
- unread automated outputs
- last error
- quick actions: `Open`, `Run now`, `Pause`, `Resume`

Do not force this into `AgentSessionRecord` if it makes the model confusing.
Automations are not the same thing as live session records.

## Attention Policy

Do not make "must confirm every 3 days" the only behavior.

Treat attention as a separate policy with explicit state.

Recommended MVP policy:

- automation keeps running normally
- every automated run increments `unacknowledged_runs`
- a human reply in the thread or an explicit `Acknowledge` action resets it
- if `unacknowledged_runs >= limit`, automation pauses and surfaces in the
  Agents panel and thread banner

Also track:

- `last_acknowledged_at_ms`
- `last_human_message_at_ms`

Possible later options:

- pause after `N` days without acknowledgment
- "only post if materially changed"
- auto-archive no-op runs

## Durable Data Model

### Chat Thread Metadata

Extend `src/packages/chat/src/index.ts` with new types roughly like:

```ts
export interface ChatThreadAutomationConfig {
  enabled: boolean;
  automation_id?: string;
  title?: string;
  prompt: string;
  schedule_type: "daily";
  local_time: string; // "HH:MM"
  timezone: string; // IANA tz, e.g. America/Los_Angeles
  pause_after_unacknowledged_runs?: number;
}

export interface ChatThreadAutomationState {
  automation_id: string;
  status: "active" | "running" | "paused" | "error";
  next_run_at_ms?: number;
  last_run_started_at_ms?: number;
  last_run_finished_at_ms?: number;
  last_acknowledged_at_ms?: number;
  last_human_message_at_ms?: number;
  unacknowledged_runs?: number;
  paused_reason?: string;
  last_error?: string;
  last_job_op_id?: string;
  last_message_id?: string;
}
```

Store the authoritative automation definition in the thread config row, and
also mirror enough runtime state there for the chat UI and host recovery logic
to render/use it without querying a separate admin-only table.

### Durable Scheduler Table

Add a new sqlite table in:

- `src/packages/lite/hub/sqlite/acp-automations.ts`

Suggested fields:

- `automation_id`
- `project_id`
- `path`
- `thread_id`
- `account_id`
- `title`
- `prompt`
- `schedule_type`
- `timezone`
- `local_time`
- `enabled`
- `status`
- `next_run_at`
- `last_run_started_at`
- `last_run_finished_at`
- `last_acknowledged_at`
- `last_human_message_at`
- `unacknowledged_runs`
- `pause_after_unacknowledged_runs`
- `paused_reason`
- `last_error`
- `last_job_op_id`
- `updated_at`
- `created_at`

Constraints:

- unique on `(project_id, path, thread_id)` for MVP, i.e. one automation per
  thread
- index on `(enabled, status, next_run_at)`

Reason for a dedicated table instead of only syncdb:

- scheduler code must scan/filter due automations efficiently
- sqlite is already the durable ACP control plane
- thread metadata remains the authoritative project-scoped automation config,
  while sqlite is the host-local scheduler index and execution cache

### Authority Model

Automation configuration must move with the project.

Therefore:

- thread metadata stored with the project is the authoritative source of
  automation definition
- host-local sqlite is a derived scheduler index / execution cache
- host-local rows must be rebuildable from project data

This matters for Launchpad because projects can be deleted, moved between
hosts, and cloned/forked.

## Scheduling Semantics

### Daily Time Computation

For a daily schedule:

1. Parse local time like `05:00`.
2. Combine it with the configured IANA timezone.
3. Compute the next future wall-clock occurrence.
4. Persist the resulting `next_run_at_ms`.

Rules:

- if current time is before the target today, schedule today
- otherwise schedule tomorrow
- after each run completes, compute the next future occurrence again
- if the server was down and the run is overdue, execute once on recovery and
  then schedule the next future occurrence

Do not enqueue multiple catch-up runs for days that were missed while the host
was down.

## Execution Architecture

### Separation of Responsibilities

Use three layers:

1. durable automation ledger (`acp_automations`)
2. durable execution queue (`acp_jobs`)
3. detached ACP worker for actual Codex execution

### Who Waits for the Next Scheduled Time?

Do not keep the ACP worker alive for hours just to wait.

Instead:

- the next run time is persisted in sqlite
- a lightweight scheduler poller in the main Lite / project-host process checks
  for due automations
- when a due automation is found, it enqueues a normal ACP job and ensures the
  detached worker is running
- if the main process restarts, it rescans on startup and picks up overdue
  automations

This preserves the current Lite worker idle-exit design.

### Enqueueing a Scheduled Run

When an automation is due:

1. create a compact synthetic user/system chat row for the scheduled run
2. enqueue a normal ACP job into `acp_jobs`
3. link the job back to `automation_id`
4. mark automation state `running`
5. project the updated `automation_state` into the thread config row

The actual assistant turn should use the same durable ACP path as any other
Codex turn.

### Completion

When the job finishes:

1. mark automation `last_run_finished_at_ms`
2. update `last_job_op_id` and `last_message_id`
3. increment `unacknowledged_runs`
4. compute and persist the next `next_run_at_ms`
5. if attention policy is exceeded, pause instead of scheduling the next run
6. mirror the new `automation_state` into thread metadata

### Acknowledgment

Reset `unacknowledged_runs` when:

- the user explicitly clicks `Acknowledge`
- or the user sends a human-authored message in the thread

This is more reliable than trying to infer true "read" semantics from tab
visibility alone.

## Project Lifecycle Semantics

### Delete

If a project is deleted:

- project-stored automation metadata disappears with the project
- host-local scheduler rows for that project are removed during cleanup

### Move to Another Host

If a Launchpad project moves to another host:

- automation definitions move with the project because they live in project
  metadata
- the source host drops its local scheduler/runtime rows for that project
- the destination host rebuilds its local scheduler index from project metadata
- enabled automations remain enabled and continue normally

Do not attempt to migrate a live in-flight automation run across hosts. Treat an
active move as interrupting the current run, then let the destination host
resume future scheduled runs from durable state.

Policy:

- move preserves and reactivates automations

### Clone / Fork

If a project is cloned or forked:

- clone the automation definitions
- clear runtime state such as `last_run_*`, `last_job_op_id`,
  `unacknowledged_runs`, and `last_error`
- do not leave the cloned automation enabled by default
- mark it as paused/disabled until explicitly confirmed in the new project

Suggested paused reason:

- `cloned_project_requires_confirmation`

Policy:

- clone/fork preserves definitions, but requires explicit re-enable

## Failure Semantics

If a scheduled run fails:

- keep the failed assistant turn/error visible in the thread
- persist `last_error`
- surface the automation as `error` in the Agents panel
- keep `Run now` available

Suggested default:

- do not disable the automation after a single transient error
- leave it enabled unless the user pauses it
- still compute the next daily run unless repeated-failure policy is later
  added

## State Machine

```mermaid
stateDiagram-v2
  [*] --> Active
  Active --> Due: next_run_at reached
  Due --> Running: synthetic turn + acp_job enqueued
  Running --> Active: run succeeded, next_run_at recomputed
  Running --> Error: run failed
  Active --> Paused: unattended policy exceeded
  Error --> Active: user resumes or next run policy continues
  Paused --> Active: user resumes
```

## Component Diagram

```mermaid
flowchart TD
  Thread[Chat thread]
  Meta[(thread metadata)]
  Auto[(acp_automations sqlite)]
  Jobs[(acp_jobs sqlite)]
  Api[Lite / project-host process]
  Worker[Detached ACP worker]
  Codex[Codex subprocess or container]
  Agents[Agents panel]

  Thread <-->|render banner / turns| Meta
  Agents <-->|list / control| Meta
  Api -->|poll due automations| Auto
  Api -->|enqueue run| Jobs
  Api -->|project state| Meta
  Api -->|ensure worker running| Worker
  Worker -->|claim job| Jobs
  Worker -->|write assistant turn| Thread
  Worker -->|update automation state| Auto
  Worker -->|project state| Meta
  Worker -->|run turn| Codex
```

## Recommended Implementation Phases

### Phase 1: Daily Schedule MVP

Status: done.

Deliver:

- one automation per thread
- daily schedule only
- explicit timezone
- compact scheduled-run row in thread
- full normal assistant turn output
- thread banner with next/last run
- Agents panel listing
- pause/resume/run-now
- pause after `N` unacknowledged runs

Files likely touched:

- `src/packages/chat/src/index.ts`
- `src/packages/frontend/chat/actions.ts`
- `src/packages/frontend/chat/chatroom.tsx`
- `src/packages/frontend/chat/composer.tsx`
- `src/packages/frontend/project/page/flyouts/agents.tsx`
- `src/packages/lite/hub/sqlite/acp-automations.ts`
- `src/packages/lite/hub/acp/index.ts`
- `src/packages/conat/ai/acp/types.ts`

### Phase 2: Delivery Refinements

Possible additions:

- only post when materially changed
- explicit no-op result mode
- richer pause policies
- richer banner and notifications

### Phase 3: Richer Recurrence

Possible additions:

- weekdays only
- multiple times per day
- weekly schedules
- cron-like advanced mode

Do not start with cron syntax.

## Open Questions

- whether the synthetic scheduled-run row should be a normal chat row with a
  special sender or a dedicated event type
  - ANS: I think normal chat row - that means it is automatically searchable (which could be useful) and it is just a message after all.
- whether `Run now` should preserve the normal daily anchor or reset the next
  run relative to "now"
  - ANS: I think preserve. If use wants to change params, they can just change them directly.
- whether "unacknowledged" should reset only on explicit acknowledgment or also
  on any human reply in the thread
  - ANS: any human reply; the goal is just preventing pointless work that is never used
- whether a thread should ever support more than one automation
  - ANS: I think no. It's easy to have lots of threads. If you really needed more than one in a thread, there's probably better ways to share that context (e.g., a shared markdown file) or put in a conditional.

## Recommendation

Implement Phase 1 exactly as a thread-attached daily automation feature,
separate from loop mode.

This gives:

- the right user experience for scheduled Codex work
- strong reuse of the durable ACP jobs/workers architecture
- good visibility in both the thread and the Agents panel
- a clean path to richer recurrence and delivery policies later
