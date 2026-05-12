# Course Copy And Collection Plan

Status: proposed plan, 2026-05-12.

Goal: make course distribution and collection reliable at class scale by using
the new project copy LRO/worker infrastructure instead of frontend-only
per-student copy loops.

## Current State

The copy backend is already shaped for efficient fanout:

- `copy-worker.ts` reads `input.dests` and can process many destinations in one
  LRO.
- `copy.ts` accepts `dests[]`, creates or reuses one source backup, then queues
  one `project_copies` row per remote destination.
- `copy.ts` already separates same-host destinations from remote destinations:
  same-host copies use the project file server's btrfs/reflink-friendly copy
  path, while remote destinations use rustic backup/restore through
  `project_copies`.
- destination project-hosts claim and apply their own rows, so target hosts can
  be offline when the job is queued and catch up later.

But the public course-facing path does not use this shape:

- `frontend/client/project.ts` exposes only `dest`, not `dests`.
- `server/conat/api/projects.ts` accepts only one `dest` and wraps it as
  `dests: [dest]`.
- `course/assignments/actions.ts` distributes by calling
  `copy_assignment_to_student` once per student via `assignment_action_all_students`.
- `course/handouts/actions.ts` does the same for handouts.

For a 100-student course this means up to 100 copy LROs, repeated source backup
checks, many browser-originated operations, and fragile progress/status behavior
if the instructor closes the browser.

Collection is still the old manual model: the frontend loops over students and
copies each student's target path back to the course project. This is inherently
many-source-to-one-destination, so the single-source fanout optimization does
not apply directly. It still needs to become a server-side course LRO so it is
reliable, resumable, and automatable.

Automated collection is a first-release requirement, not a later enhancement.
Manual server-side collection is still the first validation target because it
proves the worker, copy, status, and notification paths. The release target is
manual collection plus scheduled automated collection built on the same worker.

## Design Principles

1. Browser should initiate course copy/collection, not drive it.
2. Distribution should create one source backup per assignment/handout operation,
   then fan out to all eligible student projects.
3. Collection should be server-side, bounded, resumable, and per-student
   observable.
4. Keep existing per-student course status semantics visible in the UI.
5. Do not regress the single-project file explorer copy flow.
6. Preserve support for offline target hosts: queued destination rows should
   complete when the target host becomes available.
7. Prefer incremental compatibility: support old `dest` callers while adding
   `dests`.
8. Keep the `.course` file eventually consistent with copy/collection LRO state.
9. Send student-facing course notifications as part of server-side copy and
   collection workflows, not as a manual frontend side effect.

## Phase 1: Expose Multi-Destination Copy RPC

### API Shape

Extend existing `copyPathBetweenProjects` instead of adding a parallel RPC.

Input should accept either:

```ts
{
  src: { project_id: string; path: string | string[] };
  src_home?: string;
  dest: { project_id: string; path: string };
  options?: CopyOptions;
}
```

or:

```ts
{
  src: { project_id: string; path: string | string[] };
  src_home?: string;
  dests: { project_id: string; path: string }[];
  options?: CopyOptions;
}
```

Validation:

- exactly one of `dest` or `dests` must be provided
- `dests` must be non-empty
- cap `dests.length` to a sane admission limit, initially 500
- require collaboration on source and every destination
- run storage-admission checks for each destination owner
- deduplicate identical destination `{project_id, path}` pairs before creating
  the LRO, but report dedupe in progress details

LRO input should always persist canonical `dests[]` so worker logic has one
shape.

### Server Changes

Files:

- `src/packages/conat/hub/api/projects.ts`
- `src/packages/server/conat/api/projects.ts`
- `src/packages/frontend/client/project.ts`
- focused tests in `src/packages/server/conat/api/projects.copy-path-between-projects.test.ts`
- focused tests in `src/packages/server/projects/copy.test.ts` if normalization
  behavior changes

Implementation notes:

- keep accepting old `dest`
- store `input.dests` always
- make `scope_id` remain `src.project_id` for distribution; this keeps source
  project copy UI/progress coherent
- include destination count in initial LRO progress summary/result
- do not create 100 parent LROs for 100 student projects

Validation:

- one RPC with 3 destinations produces one LRO with `input.dests.length === 3`
- worker calls `copyProjectFiles` once with all destinations
- one remote source backup is created/reused
- one `project_copies` row is created per remote destination
- same-host destinations still use direct local copy path
- mixed same-host and remote destinations work
- same-host and remote destinations report into the same parent LRO result

## Phase 2: Course Assignment Distribution Uses One LRO

### Current Flow To Replace

`copy_assignment_to_all_students` currently:

1. updates assignment listing
2. creates the due-date file once
3. calls `assignment_action_all_students`
4. `assignment_action_all_students` calls `copy_assignment_to_student` per student
5. `copy_assignment_to_student` starts/finishes per-student status and calls
   `copyPathBetweenProjects` with one destination

### New Flow

Add a new bulk distribution path for `step === "assignment"`:

1. Resolve assignment and eligible students in the frontend.
2. Create missing student projects first.
3. Apply `new_only`/`overwrite` filtering before building `dests`.
4. Mark eligible students as started in course sync state.
5. Submit one `copyPathBetweenProjects({ src, dests, options })`.
6. Track the LRO from the course UI.
7. When LRO finishes, update per-student `last_assignment`:
   - success for destinations whose copy row is `done`
   - error for destinations whose copy row is `failed`, `expired`, or `canceled`
8. Send each student a course-communication notification with a link to the
   assigned directory after their destination copy succeeds.

Initial implementation can update all eligible students success/failure from
the aggregate LRO if per-row result projection is not available yet, but the
target state should be per-student row reporting.

Required backend helper:

- expose copy rows for an LRO to the authorized source-project collaborator, or
  include enough per-destination result in the LRO result/progress summary.

Suggested API:

```ts
listCopyRowsByOpId({ op_id }): ProjectCopyRow[]
```

Authorization:

- account must have access to the LRO scope project, and the LRO must be a copy
  operation created by that account or visible to project collaborators.

### UI Behavior

Keep the current course activity model, but avoid 100 concurrent frontend copy
activities.

Display:

- "Copying assignment to 87 students"
- aggregate progress from LRO
- counts: queued, applying, done, failed
- failed-student list when available
- action to retry failed students only

Do not block the instructor browser. If the tab is closed, the operation should
continue.

The `.course` file should reconcile from LRO state. If the instructor closes and
reopens the course, the course UI should query active/recent course copy LROs,
refresh per-student status, and avoid permanently stale "copying" markers.

### Tests

Frontend/unit tests should verify:

- `new_only` excludes already-copied students
- students without projects are created before submit
- one `copyPathBetweenProjects` call is made with `dests.length === N`
- per-student start state is set for each eligible student
- failed rows map back to student status

Server tests should verify:

- one multi-dest assignment operation creates one source backup and N rows
- offline destination host rows remain queued
- retry failed students produces a new LRO only for failed destinations

## Phase 3: Handout Distribution Uses One LRO

Handout distribution is simpler than assignments.

New flow:

1. Resolve handout and eligible students.
2. Create missing student projects.
3. Filter with `new_only`.
4. Mark per-student handout status as started.
5. Submit one multi-destination copy LRO.
6. Update per-student handout status from row-level results.
7. Send each student a course-communication notification with a link to the
   handout directory after their destination copy succeeds.

Files:

- `src/packages/frontend/course/handouts/actions.ts`
- same project client/server API changes as Phase 1

Tests:

- same shape as assignment distribution, with handout-specific status fields

## Phase 4: Server-Side Course Collection LRO

Collection is many sources to one destination. It should not be represented as
one `copyPathBetweenProjects` fanout operation. It should be its own course
collection LRO that orchestrates bounded per-student copy operations.

### Proposed RPC

Add a course-level server API, preferably under hub projects/course APIs:

```ts
collectAssignment({
  course_project_id: string;
  assignment_id: string;
  student_ids?: string[];
  new_only?: boolean;
  overwrite?: boolean;
  scheduled?: boolean;
})
```

Return an LRO:

```ts
{
  op_id: string;
  scope_type: "project";
  scope_id: course_project_id;
  service: string;
  stream_name: string;
}
```

The LRO worker should:

1. Load course sync data/server-side course records.
2. Resolve assignment target path and collect path.
3. Enumerate eligible students with existing `project_id`.
4. For each student, copy from:
   - `src.project_id = student_project_id`
   - `src.path = assignment.target_path`
   - `dest.project_id = course_project_id`
   - `dest.path = join(assignment.collect_path, student_id)`
5. Run with bounded concurrency, initially 4 or configurable.
6. Write `STUDENT - name.txt` after each successful collection.
7. Update course sync state per student as each copy finishes.
8. Publish progress counts and per-student errors.
9. Send each student a course-communication notification when their assignment
   has been collected, including a link to the directory that was collected.

This can internally call `copyProjectFiles` directly or create child
`copy-path-between-projects` LROs. Prefer direct internal calls if we can keep
progress and cancellation clear; prefer child LROs if we want reuse of existing
LRO recovery semantics. The first version should use child LROs for
correctness/recovery, then optimize only if LRO noise becomes a real problem.

### Automated Collection

Add optional scheduled collection:

- per assignment setting: `auto_collect: boolean`
- schedule trigger: due date plus optional grace period
- worker scans due assignments periodically
- starts `collectAssignment` if not already collected after current due date
- idempotency key: `course_project_id + assignment_id + due_date + mode`
- instructor can cancel a scheduled collection before it starts
- instructor due-date changes cancel or supersede the old scheduled collection
- scheduled collection state is visible in the `.course` file UI

First release requirement: automated collection must ship. The implementation
order should still be manual collection first, because scheduled collection
should be a thin scheduler over the same tested `collectAssignment` LRO.

### Idempotency And Retry

Collection must support:

- retry failed students only
- `new_only`: skip students with successful `last_collect`
- cancellation
- scheduled-job cancellation before start
- safe overwrite behavior for existing collected directories
- partial success without losing errors
- source failure for one student without blocking other students
- clear failure states when the student moved/deleted the assignment folder
- clear retryable failure states when the student's project host is down

Store per-student results either:

- in LRO result/progress detail, and mirrored into course sync state, or
- in a dedicated `course_assignment_collection_jobs` table

Use LRO result plus existing course sync state first. The `.course` file can
query LRO status and update itself accordingly. Do not add a DB table unless
implementation proves that LRO input/result is insufficient for recovery.

## Course Notifications

Course copy and collection workflows should automatically send notifications
using the course communication notification category.

Notification events:

- assignment distributed to student
- handout distributed to student
- assignment collected from student
- graded work returned to student, when that workflow is converted
- collection failed for a student, if useful to the instructor; avoid noisy
  student-facing failure notifications unless the failure requires student
  action

Minimum student notification content:

- course name/title when available
- assignment or handout title/path
- action performed: assigned, handout sent, collected, returned
- link to the relevant directory in the student's project

For collection, the link should point to the student's original assignment
directory, since the collected copy lives in the instructor/course project.

Notifications should be emitted by the server-side LRO worker when each
per-student operation reaches a durable success state. They should not depend on
the instructor browser staying open or the `.course` file being visible.

Notification sends must be idempotent per operation/student/action. Retrying a
failed copy should not send duplicate success notifications for students that
already succeeded.

## Phase 5: Return Graded And Peer Work

After distribution and collection are stable, apply the same server-side
orchestration pattern to:

- return graded assignments to all students
- peer-copy assignments to students
- peer-collect grading from students

These are lower priority than normal distribution/collection because they have
more custom post-processing:

- writing `GRADE.md`
- stripping grader identity files
- peer mapping
- nbgrader integration

Do not combine these with the initial distribution/collection change unless the
first phases are already green.

## Data And Progress Model

We need row-level visibility for course UX.

Minimum useful result shape:

```ts
{
  total: number;
  queued: number;
  applying: number;
  done: number;
  failed: number;
  canceled: number;
  expired: number;
  destinations?: {
    project_id: string;
    dest_path: string;
    status: ProjectCopyState;
    last_error?: string;
  }[];
}
```

For assignment/handout status mapping, include `student_id` in either:

- destination metadata in the LRO input, or
- a deterministic frontend map `{project_id, dest_path} -> student_id`

Preferred: extend destination input with optional metadata:

```ts
{
  project_id: string;
  path: string;
  metadata?: { student_id?: string; course_item_id?: string };
}
```

Do not write metadata into file paths. If adding metadata to `project_copies`
is too much for phase 1, keep it in the parent LRO input and join by
`dest_project_id + dest_path`.

## Admission Control

Distribution to 100 students should count as one parent LRO plus N destination
apply rows, not N parent LROs.

Limits:

- `copy-path-between-projects` parent LRO global cap can stay low.
- per-host `applyPendingCopies` limit controls destination pressure.
- add a max destinations per LRO, initially 500.
- add per-account/course rate limit if abuse audit suggests it.

Storage admission:

- current code checks destination owner storage once per single destination.
- multi-destination API must check each destination owner.
- to avoid O(N) duplicate checks for the same owner, group by owner account id.

## Migration / Compatibility

No data migration required.

Compatibility:

- keep old single `dest` API shape
- file explorer copy continues using single `dest`
- course code moves to `dests`
- existing LRO worker already accepts `input.dest` fallback, so old LROs remain
  valid

## Validation Plan

Focused tests:

1. Server API accepts `dests[]`, authorizes all projects, stores canonical
   `input.dests`.
2. Copy worker processes one LRO with multiple destinations.
3. `copyProjectFiles` creates/reuses one backup for multiple remote dests.
4. Assignment distribute-all makes one RPC for N students.
5. Handout distribute-all makes one RPC for N students.
6. Failed destination row maps to failed student status.
7. Collection LRO collects from N student projects with bounded concurrency.
8. Retry failed collection only retries failed students.
9. Scheduled collection can be created, canceled, superseded by due-date change,
   and executed.
10. Notifications are emitted once per successful student distribution and
   collection.

Live smoke:

1. Create one instructor project and 5 student projects spread across two hosts.
2. Distribute one assignment directory to all students.
3. Verify exactly one parent copy LRO and one source backup.
4. Verify files appear in all student projects.
5. Modify student files.
6. Run server-side collect.
7. Verify collected tree in course project has one folder per student and
   `STUDENT - name.txt`.
8. Stop one target host during distribution; verify rows complete when host is
   restarted.
9. Enable automated collection, change the due date before it fires, and verify
   the old scheduled collection is canceled/superseded.
10. Verify students receive course communication notifications with links.

Scale smoke:

- 100 destinations with tiny assignment
- 25 destinations with a medium Git repo
- measure source backup count, total time, host apply queue, and LRO progress

## Recommended Implementation Order

1. Extend API/client types to support `dests[]`.
2. Add server tests for multi-destination copy API and worker.
3. Convert handout distribute-all first; it is the simplest fanout case.
4. Convert assignment distribute-all.
5. Add row-level result projection for course status accuracy.
6. Implement manual server-side collection LRO.
7. Add `.course` reconciliation from copy/collection LRO state.
8. Add course notifications for distribution and collection success.
9. Add retry-failed collection and distribution.
10. Add scheduled automated collection, including cancellation/superseding on
    due-date changes.
11. Apply the pattern to return-graded and peer workflows.

## Open Questions

1. Should course distribution status be updated only when the whole LRO
   completes, or incrementally as each destination row finishes?
   - Decision: incrementally if cheap, but do not block phase 1 on it. The
     `.course` file must eventually reconcile from LRO state either way.

2. Should collection use child copy LROs or call `copyProjectFiles` directly?
   - Recommendation: child LROs first for correctness/recovery, then optimize if
     the extra LRO noise is painful.

3. Should automated collection be enabled by default?
   - Decision: automated collection must be implemented for first release.
     Default policy can still be conservative, but the feature itself is a hard
     requirement.

4. Should distribution to students require all student projects to exist before
   submitting the copy LRO?
   - Recommendation: yes for phase 1. Project creation has its own failure
     modes and should be handled before file copy.

5. How should unavailable source hosts affect collection?
   - Recommendation: source host unavailable means that student's collection row
     fails/retries independently; other students continue. This also covers
     missing/moved assignment folders in the student project.

6. Does the same-host btrfs/reflink copy path change the course design?
   - Decision: no API change is needed. The multi-destination copy engine should
     continue splitting destinations by host internally: same-host targets use
     the fast local copy path, remote targets use rustic. Course code should not
     need to know which path each student project takes.
