# Codex Host Restart Session Recovery

Status: proposed

Goal: automatically continue long-running Codex work after a project-host VM
restart, especially for spot-instance interruptions, so users can return later
and find their Codex thread still progressing.

This plan targets the product experience where:

1. a user starts a long-running Codex turn or loop on a project-host,
2. the host VM is stopped by the cloud provider or rebooted for maintenance,
3. the host comes back,
4. the Codex thread resumes automatically from persisted workspace state and
   session context,
5. the user sees a short explanation that recovery happened.

This is not about restoring the exact killed Unix process tree. That is not
possible after VM termination. The real product goal is session-level recovery:

- preserve files and outputs written before the interruption
- preserve the Codex session/thread identity
- enqueue a recovery continuation turn
- let Codex inspect the workspace and continue from there

## Why This Is Feasible

The current ACP architecture already has most of the hard primitives:

- durable queued/running job state in `src/packages/lite/hub/sqlite/acp-jobs.ts`
- running-turn leases with `session_id`, thread identity, and heartbeats in
  `src/packages/lite/hub/sqlite/acp-turns.ts`
- detached ACP worker startup recovery in
  `src/packages/lite/hub/acp/index.ts`
- Codex app-server `thread/resume` support in
  `src/packages/ai/acp/codex-app-server.ts`
- loop state persistence in thread config, documented in
  `src/.agents/codex-loop-state-machine.md`

Today, restart recovery mostly does:

- mark live turns interrupted
- append interruption text to chat rows
- stop loop state
- in some cases requeue jobs only when the running job lost its lease before
  startup completed

The main change is to convert selected restart/interruption cases from
`interrupt-and-stop` into `interrupt-and-continue`.

## Product Requirements

### Required UX

After a restart-worthy interruption, the user should see:

1. the old in-flight turn marked as interrupted, with a short explanation
2. a new continuation turn automatically started in the same thread
3. optional lightweight thread status such as:
   - `Project host restarted; Codex is resuming automatically.`

The continuation turn should use a short recovery prompt that tells Codex what
happened and what to do next.

### Required Behavioral Semantics

- User interrupt means stop. Never auto-resume that.
- Manual host stop means stop. Never auto-resume that.
- Spot interruption means auto-resume when restore policy allows it.
- Admin reboot / maintenance restart may auto-resume when explicitly marked as
  restart-safe.
- Worker-only crash without full host restart should usually continue to use the
  existing worker recovery path, but may also auto-resume when the owning turn
  is clearly orphaned.

### Non-Goals

- Restoring shell subprocesses, Python interpreter memory, or terminal state
- Exactly-once side-effect guarantees across VM death
- Hiding the interruption entirely from the user

## Recommended UX Design

Use both a visible chat notice and a hidden recovery prompt.

### Visible Notice

On the interrupted assistant message, append a clear explanation such as:

`Conversation interrupted because the project host restarted.`

Then add a lightweight thread/system status note:

`Project host restarted. Codex is resuming automatically from the current workspace state.`

This should be concise and non-annoying.

### Hidden Recovery Prompt

Do not force a fake visible user message unless needed. Instead, enqueue the
next turn with a hidden prefix similar to:

```md
The project host restarted unexpectedly, likely due to a spot interruption or maintenance reboot.

Continue the task from the current workspace state.
Do not assume in-memory process state survived.
Before repeating side effects, inspect files, command outputs, and artifacts already produced.
If work was partially completed, pick up from the next safe step and briefly mention what you inferred.
```

This gives Codex the exact context it needs without cluttering the transcript.

## Recommended Recovery Semantics

### One-Off Turns

For a single long-running turn:

1. mark the old turn interrupted
2. preserve the old streamed output and summary state exactly as today
3. enqueue a new continuation turn in the same thread using the same
   `session_id`
4. prepend the hidden recovery prompt

This is the highest-value path and should be implemented first.

### Looping Turns

For loop-enabled threads:

1. do not clear `loop_config`
2. do not force `loop_state.status = stopped`
3. instead transition the loop to a recoverable paused/scheduled state
4. enqueue the next iteration with a recovery prompt suffix that includes the
   loop intent

The loop state machine should gain a restart-aware transition:

- `running -> recovering -> scheduled -> running`

instead of today's `running -> stopped` on restart/interruption.

## Architecture Changes

### 1. Add Explicit Recovery Classification

Today, recovery reasons are mostly free-form strings such as:

- `server restart`
- `ACP worker stopped unexpectedly`
- `backend lost live Codex turn`

That is not rich enough for auto-resume policy.

Add a normalized recovery classification, for example:

- `user_interrupt`
- `manual_host_stop`
- `host_restart`
- `spot_interruption`
- `worker_restart`
- `backend_restart`
- `unknown_failure`

This can live as:

- additional fields on `acp_turns` finalization metadata, or
- additional fields on the repair/recovery function arguments, or
- a new recovery-event table if we want long-term auditability

Recommended minimum: thread/job metadata plus structured reason enums.

### 2. Add Restart-Resume Policy

We already have host-level interruption restore policy. Add ACP-level policy
rules that decide whether a turn is eligible for automatic continuation.

Suggested defaults:

- one-off Codex turns: `resume_on_host_restart = true`
- loop turns: `resume_on_host_restart = true`
- command-only ACP jobs: `resume_on_host_restart = false` at first

This can initially be hardcoded in ACP logic. If needed later, expose it as a
chat/thread-level setting.

### 3. Preserve Resume Intent in Job State

Extend `acp_jobs` so recovery can distinguish:

- the original user request
- a queued recovery continuation of that request

Suggested new fields:

- `recovery_parent_op_id`
- `recovery_reason`
- `recovery_count`
- `recovery_started_at`
- `resume_session_id`
- `recovery_prompt_json` or `request_patch_json`

Recommended simpler first version:

- leave the original row interrupted/completed for auditability
- enqueue a new job row for the continuation turn
- tie it back using `recovery_parent_op_id`

This is cleaner than mutating the original running row back into `queued`.

### 4. Add Synthetic Recovery Enqueue API

Create a backend-only helper, conceptually:

- `enqueueRecoveredAcpTurn(parentJob, recoveryReason, recoveryPromptPrefix)`

Responsibilities:

- copy the needed execution metadata from the prior job
- preserve `thread_id`
- preserve `session_id`
- generate a fresh assistant message id/date for the resumed turn
- mark the row as a recovery continuation of the previous turn
- attach prompt patching instructions

This helper should live near the durable queue logic, not in the frontend.

### 5. Change Startup Recovery Path

Today, startup recovery in `src/packages/lite/hub/acp/index.ts` mainly repairs
or interrupts orphaned turns.

Change it so that for restart-worthy turns it does:

1. repair the interrupted old turn in chat
2. finalize the old lease as aborted/interrupted
3. enqueue a recovery continuation job
4. wake the detached worker

The natural insertion point is the existing startup recovery path:

- `recoverDetachedWorkerStartupState(...)`
- `recoverOrphanedAcpTurns(...)`
- `recoverCurrentWorkerStuckAcpTurns(...)`

Instead of making those functions only terminalize state, introduce a branch:

- `interrupt only`
- `interrupt and continue`

## Recovery Decision Logic

### Safe Auto-Resume Conditions

Auto-resume only when all are true:

1. the host or worker owning the turn is definitely gone
2. the interruption reason is restart-worthy
3. the turn was not explicitly user-stopped
4. the thread is still in a state where continuation makes sense
5. no newer user message has superseded the interrupted turn
6. we have a valid `session_id` or enough chat context to continue cleanly

### Must Not Auto-Resume

- user clicked Interrupt / Stop
- host desired state is `stopped`
- chat thread was manually continued in a conflicting way after interruption
- same turn already has a queued/running recovery child

### Duplicate Prevention

Use a dedupe key such as:

- `(project_id, path, thread_id, recovery_parent_op_id)`

or:

- `(project_id, path, assistant_message_date, recovery_reason, generation)`

so repeated restart-recovery scans do not enqueue multiple continuation turns.

## Session Handling

### Use the Same Codex Session

This feature is only compelling if the continuation turn reuses the same Codex
session when possible.

That means:

- carry forward `session_id`
- call app-server `thread/resume`
- enqueue the recovery prompt as the next user input in that thread

This is already aligned with how `CodexAppServerAgent` resolves a session via
`session_id` and calls `thread/resume`.

### Fallback When Session Resume Fails

If `thread/resume` fails:

1. still continue from the workspace state
2. start a fresh Codex thread
3. inject a slightly stronger recovery prompt that mentions the prior session
   could not be resumed

This fallback is important for resilience and should be explicit in logs.

## Loop Recovery Design

Loop recovery needs separate handling because the current interruption flow
often stops the loop.

Recommended changes:

1. Add `restart_recovery_pending` to `AcpLoopState`
2. On host restart, if an active looped turn is interrupted:
   - preserve `loop_config`
   - preserve iteration counters
   - set `restart_recovery_pending = true`
3. Enqueue the next turn with:
   - same loop id
   - same or incremented iteration depending on where we were in the step
   - recovery prompt prefix
4. When the resumed turn starts, clear `restart_recovery_pending`

For the first version, it is acceptable to restart the current iteration rather
than infer the exact half-completed loop step. The recovery prompt should tell
Codex to inspect the workspace and continue conservatively.

## Chat Projection Changes

### Existing Interrupted Message

Keep the current interrupted message behavior. It is useful and already built.

### New Continuation Message

The recovery continuation should create a normal new assistant placeholder row,
just like any queued turn.

That means the user sees:

1. interrupted old turn
2. new queued/running continuation turn

This is a predictable mental model and avoids editing history in confusing ways.

### Optional Thread Banner

Add a small non-message banner/status record:

`Recovered after host restart at 3:14 PM.`

This is optional for the first iteration.

## Concrete Implementation Phases

### Phase 1: One-Off Auto-Continue

Deliver the highest-value case first.

Scope:

- one-off Codex turns only
- host restart / spot interruption only
- same session if possible
- hidden recovery prompt
- visible interrupted old turn

Work items:

1. Add structured recovery reason classification.
2. Add recovery-child enqueue helper.
3. Update startup recovery to enqueue continuation jobs for restart-worthy
   interrupted turns.
4. Add dedupe protection.
5. Add clear logs and metrics.

Acceptance scenario:

1. Start a long-running Codex turn on a spot host.
2. Kill the VM.
3. Wait for host auto-restore.
4. Confirm the thread shows:
   - interrupted old turn
   - new resumed turn
5. Confirm Codex continues from workspace artifacts rather than restarting from
   scratch.

### Phase 2: Loop Recovery

Scope:

- Codex loop threads
- preserve loop state across restart
- continue next loop step automatically

Work items:

1. Add restart-recovery loop state.
2. Stop converting restart interruptions into permanent loop stop.
3. Requeue loop continuation using existing loop metadata.

Acceptance scenario:

1. Start a multi-iteration Codex loop.
2. Kill the host mid-iteration.
3. Confirm the loop resumes automatically and continues iterating.

### Phase 3: Better UX and Policy

Scope:

- user-visible recovery status
- thread-level preferences if needed
- admin-maintenance restart policy
- richer audit trail

## Safety and Observability

### Logging

Every recovery enqueue should log:

- project id
- path
- thread id
- old op id
- new op id
- session id
- recovery reason
- whether `thread/resume` succeeded or fell back to new thread

### Metrics

Track at least:

- interrupted turns by reason
- auto-resumed turns by reason
- successful same-session resumes
- fresh-thread fallbacks
- recovered loops
- duplicate-recovery suppressions

### Hard Limits

To avoid pathological loops:

- limit automatic recovery retries per original turn
- exponential backoff if repeated host failures occur
- stop auto-resuming after N failures and require human action

Recommended initial default:

- max 3 auto-recovery attempts per interrupted turn

## Testing Plan

### Unit Tests

Add focused tests for:

- recovery classification
- dedupe of recovery continuation jobs
- preserving `session_id`
- hidden recovery prompt injection
- no auto-resume on user interrupt
- no auto-resume on manual host stop
- loop recovery state transitions

### Integration Tests

Lite / project-host restart tests should simulate:

1. running turn with lease and session id
2. worker restart
3. host restart recovery
4. resumed turn enqueued and started

### Live Manual Tests

Required live tests:

1. GCP spot interruption smoke test
2. manual host reboot by admin
3. long-running one-off Codex scientific workload
4. long-running looped Codex workload
5. interrupted turn with partially completed filesystem artifacts

## Open Questions

1. Should the recovery prompt be hidden-only, or should there also be a visible
   synthetic user/system message? [ANS: hidden is fine]
2. Should admin-triggered reboot always auto-resume, or only when explicitly
   marked restart-safe? [ANS: yes, always resume]
3. Should command-only ACP jobs get the same treatment later, or remain
   interrupted-only? [ANS: NO --  those should stay interrupted only; random bash processes are not "self healing" like agents are.]
4. Should we surface recovery attempt counts in the UI? [ANS: yes, definitely]

## Recommendation

Do this.

The implementation is not trivial, but it is much easier than building durable
Codex turns from scratch because the current ACP architecture already has:

- durable job rows
- turn leases
- detached workers
- startup recovery hooks
- session resume support

The right path is:

1. keep the current interrupted-turn repair logic
2. add structured restart-worthy recovery classification
3. enqueue a new continuation turn using the same `session_id`
4. prepend a short recovery prompt
5. teach loops to recover instead of stopping

This would make spot-backed long-running Codex usage dramatically more valuable
for scientific workloads.