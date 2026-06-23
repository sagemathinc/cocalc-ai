# Course Assignment Selected Updates Plan

## Problem

Instructors often send an assignment, then later discover they need to add or
change one file. The current course UI mostly frames this as re-copying the
assignment. That is dangerous and hard to reason about because a full re-copy
can overwrite student work that already exists in the assignment folder.

The desired workflow is not a three-way merge. It is an explicit, narrow patch:

- choose one or more files/folders inside the instructor assignment directory
- send only those paths to selected or all student projects
- default to not overwriting existing student files
- require an explicit destructive opt-in for overwrites
- make the initial assignment send feel normal, not scary
- make later updates clear, auditable, and instructor-trustworthy

## Goals

- Preserve the current low-friction initial assignment distribution.
- Make subsequent assignment updates path-scoped and explicit.
- Default update behavior must protect student work.
- Make overwrite behavior unambiguous before the instructor starts the copy.
- Reuse durable `copyPathBetweenProjects` / `project_copies` machinery where
  possible.
- Support cross-host and future multi-bay project placement. The course layer
  should authorize and route; project data should still move through the
  project-host copy path, not through the hub as a data proxy.
- Provide useful update history for support and instructor confidence.

## Non-Goals

- No three-way merge.
- No automatic conflict resolution.
- No attempt to patch notebooks cell-by-cell.
- No hidden overwrite mode.
- No special same-host-only path.
- No major redesign of collection, grading, peer grading, or nbgrader.

## Current Relevant Surfaces

- Frontend assignment UI:
  - `src/packages/frontend/course/assignments/assignment.tsx`
  - `src/packages/frontend/course/assignments/actions.ts`
- Course copy LRO helper:
  - `src/packages/frontend/course/copy-lro.ts`
- Current course copy state:
  - `last_assignment` in assignment records tracks whether a student has
    received the assignment.
  - `copy_assignment_to_all_students(assignment_id, new_only, overwrite)`
    currently sends the whole assignment path.
- Backend copy API:
  - `copyPathBetweenProjects` in
    `src/packages/server/conat/api/projects.ts`
  - `copyProjectFiles` in `src/packages/server/projects/copy.ts`
  - durable rows in `project_copies`
- Copy options already support the core safety knobs:
  - `force: false`
  - `errorOnExist: false`
  - `recursive: true`

Important caveat: current remote multi-source copy flattens each source path by
basename when queueing rows. That is acceptable for ordinary "copy these files
into this directory" but not sufficient for assignment patching, because
selected nested paths must preserve their path relative to the assignment
directory.

## UX Model

### Initial Assignment Send

When `status.assignment === 0`, keep the primary action simple:

- Button label: `Send Assignment...` or current `Assign...`.
- Confirmation copy should be non-scary:
  - "Send this assignment folder to N students?"
  - Include the existing note if only `student/` is sent.
  - No overwrite warning unless the instructor chooses an overwrite mode.
- Default options:
  - copy full assignment source
  - create missing student projects if needed
  - `force: true` is acceptable for the first send because there should be no
    existing assignment work yet, but the UI should not promise it will never
    overwrite if files already exist.

### After First Assignment Send

Once at least one student has `last_assignment` success, the assignment card
should separate two concepts:

- Primary/safe action: `Send Selected Files...`
- Secondary/destructive action: `Replace Entire Assignment Folder...`

The current re-copy-all flow can remain, but it should be visually secondary
and clearly destructive. It should still require the existing explicit
`OVERWRITE` confirmation if it will replace existing student files.

### Send Selected Files Modal

Open a modal from the assignment card. The modal should show:

- Assignment source directory path.
- A searchable tree/list rooted at that assignment directory.
- Checkboxes for files and folders.
- Selected path summary with paths relative to the assignment directory.
- Student target scope:
  - default: students who already received this assignment
  - option: all active students
  - option: manually selected students, if cheap enough with existing student
    list components
- Conflict policy:
  - default: `Skip existing student files`
  - option: `Overwrite existing student files`
  - later optional: `Only create missing files`
- A short preview summary before starting:
  - selected paths
  - number of target students
  - conflict policy
  - expected destination root

Recommended default text:

> Send only the selected files/folders into each student's existing assignment
> folder. Existing student files are skipped by default.

Overwrite option text:

> Overwrite matching student files. This can replace student work at the same
> paths. TimeTravel may be able to recover overwritten files.

Do not label the safe patch flow as "Update Assignment" without detail. The
word "update" is exactly what is ambiguous today. Prefer "Send Selected Files".

## Data Model

Add assignment update history to the course sync data. Keep it compact.

Suggested assignment field:

```ts
assignment_updates?: {
  [update_id: string]: {
    update_id: string;
    created_at: number;
    created_by?: string;
    mode: "selected-paths";
    paths: string[];
    target: "already-assigned" | "all-active" | "selected-students";
    overwrite: boolean;
    student_count: number;
    op_id?: string;
    status: "running" | "done" | "failed" | "canceled";
    counts?: {
      done: number;
      skipped?: number;
      failed: number;
      total: number;
    };
    errors?: { student_id: string; error: string }[];
  };
}
```

Notes:

- Store aggregate counts and per-student errors, not a full success row for
  every student forever.
- Cap retained history, e.g. last 25 updates per assignment, to keep course
  sync data small.
- Do not update `last_assignment` for a selected-file patch unless this is the
  first full assignment send. Path-scoped updates are separate from the main
  assignment distribution state.

## Copy Semantics

Let:

- `assignment.path` be the instructor source root, e.g. `hw1`
- `assignment.target_path` be the student destination root, e.g. `hw1`
- selected relative path be `rel`, e.g. `data/new.csv`

The copy must map:

- source: `join(assignment.path, rel)`
- destination: `join(assignment.target_path, rel)`

For a selected folder, copy the folder subtree to the same relative destination
folder. For a selected file, copy exactly that file to the matching relative
path.

The selected-path copy must never flatten nested files to their basenames.

### Safe Default

Use:

```ts
options: {
  recursive: true,
  force: false,
  errorOnExist: false,
}
```

With current project-host pending-copy behavior this means:

- if destination exists and force is false, skip
- if destination does not exist, create/copy it
- if a parent directory is missing, create it

This is the right default because it cannot clobber student work.

### Destructive Overwrite

Use:

```ts
options: {
  recursive: true,
  force: true,
}
```

The UI must require an explicit confirmation. For selected-path overwrite, do
not require typing `OVERWRITE` for every tiny patch unless usability demands it,
but do require an obvious checkbox or danger confirmation with the selected path
list visible.

For replacing the entire assignment folder, keep the stronger `OVERWRITE`
typing gate.

## Backend Strategy

### Minimum Safe Implementation

Implement selected-path sends by issuing copy operations per selected relative
path, not as one multi-source copy into the assignment root. This preserves
nested relative paths with existing single-source semantics.

For each selected `rel`:

- `src.path = join(assignment.path, rel)`
- each destination path is `join(assignment.target_path, rel)`
- call `copyPathBetweenProjects` with all student destination projects
- wait for each LRO and aggregate results

This may create one source backup per selected path in the worst case. That is
acceptable for a first safe implementation if the UI recommends selecting a
small number of patch files. It is much safer than relying on the current
multi-source basename behavior.

### Better Backend Extension

Add a new backend mode for base-relative copy:

```ts
copyPathBetweenProjects({
  src: {
    project_id,
    path: selectedAbsolutePaths,
    base_path: assignment.path,
  },
  dests,
  options,
});
```

or a new course-specific API:

```ts
sendCourseAssignmentPatch({
  course_project_id,
  assignment_id,
  src_base_path,
  dest_base_path,
  relative_paths,
  student_dests,
  options,
});
```

The backend would create one backup, then queue rows with:

- `src_path = join(backup_base_path, rel)`
- `dest_path = join(dest_base_path, rel)`

This is more efficient and less error-prone for large patch sets. It also gives
one LRO with better progress and history. This is the preferred medium-term
shape.

### Preview / Dry Run

Add a preview endpoint after the basic send flow or as part of the better
backend extension:

```ts
previewCourseAssignmentPatch({
  course_project_id,
  assignment_id,
  relative_paths,
  student_project_ids,
  overwrite,
});
```

Return aggregate counts:

- `will_create`
- `will_skip_existing`
- `will_overwrite`
- `missing_source`
- `invalid_path`
- `target_project_missing`

The preview can be implemented by checking source existence once in the
instructor project and destination existence through routed project-host file
services. For very large courses, allow preview to be approximate or LRO-backed.

Do not block v1 on a perfect preview if it delays the safety fix. The critical
first behavior is "safe by default, selected paths only".

## Frontend Implementation Steps

1. Add a path selector modal rooted at `assignment.path`.
   - Reuse file listing/search components where practical.
   - Exclude hidden system paths by default.
   - Show paths relative to the assignment directory.
   - Allow folders and files.

2. Add an action method in `AssignmentsActions`, e.g.
   `send_selected_assignment_paths_to_students`.
   - Inputs:
     - `assignment_id`
     - `relative_paths`
     - `student_scope`
     - `overwrite`
   - Resolve target students.
   - Ensure missing student projects only when target scope includes students
     without projects and the instructor explicitly chose all active students.
   - Start and finish update history records.
   - Call backend copy API using the minimum safe implementation or the new
     backend extension.

3. Update assignment card actions.
   - Before first full send: show normal `Assign...` / `Send Assignment...`.
   - After first successful send:
     - show `Send Selected Files...` prominently
     - demote full resend to `Replace Entire Assignment Folder...`
   - Keep existing progress counts for full assignment sends.
   - Add compact update-history display in expanded assignment details.

4. Make wording precise.
   - Avoid "update assignment" alone.
   - Use "send selected files" for patch flow.
   - Use "replace entire assignment folder" for destructive full resend.
   - In help text, explicitly state that selected-file sends skip existing
     student files unless overwrite is selected.

## Backend Implementation Steps

1. Add tests documenting current multi-source flattening risk or replace it
   with base-relative behavior if choosing the backend extension first.

2. If implementing the minimum frontend-driven path first:
   - Add frontend tests for source/destination path mapping.
   - Add integration tests for selected nested paths:
     - source `hw1/data/new.csv`
     - destination `hw1/data/new.csv`
     - not `hw1/new.csv`
     - not `hw1/data` overwritten as a file

3. If implementing backend extension:
   - Extend `ProjectCopyDestination` or add a course-specific API type.
   - Validate relative paths:
     - no empty path
     - no absolute path
     - no `..`
     - no path outside assignment root
   - Queue `project_copies` rows with exact relative destination paths.
   - Keep existing durable LRO summary behavior.
   - Keep recent snapshot reuse and snapshot-not-visible retry behavior.

4. Add focused tests:
   - selected file creates missing file without overwriting existing file
   - selected file overwrite replaces only that file
   - selected folder copies nested contents
   - skipped existing file records success/skipped, not failure
   - nested relative paths are preserved across different project hosts
   - initial full assignment send still behaves as before

## Student Subdirectory / nbgrader Details

Assignments with `has_student_subdir` currently send only the `student/`
subdirectory for full assignment distribution. The selected-file UI must make
this clear.

Recommended rule:

- For full initial send, keep existing `assignment_src_path` behavior.
- For selected-file sends, root the selector at the effective student source:
  - if `has_student_subdir`, root at `assignment.path/student`
  - otherwise root at `assignment.path`
- Display destination paths relative to `assignment.target_path`.

This prevents instructors from accidentally sending instructor-only nbgrader
files or hidden solutions when the assignment was configured for generated
student versions.

Add an advanced escape hatch later only if instructors need it. Do not include
it in v1.

## Operational / Trust Details

- Every selected-path update should produce one visible history item.
- History should include the selected paths and overwrite mode.
- Errors should be actionable:
  - source missing
  - student project missing
  - destination exists and was skipped
  - copy failed
- Do not say "done" if all files were skipped due to existing destinations.
  Say "completed: 0 created, N skipped".
- Link each failed student row to the student project when possible.
- Keep LRO ids visible in developer/admin detail for support.

## Rollout Plan

1. Implement the selected-file modal and minimum safe copy path.
2. Test on staging with two project hosts and nested selected paths.
3. Test UCLA-like workflow:
   - create assignment
   - send initial full assignment
   - students edit existing files
   - instructor adds a new file
   - send selected new file with default skip-existing behavior
   - verify existing student work is unchanged
   - verify new file appears
4. Deploy to production behind normal release process.
5. Watch support/admin alerts for `copy-path-between-projects` failures.
6. Only after v1 is stable, consider the backend base-relative batch API for
   efficiency.

## Acceptance Criteria

- Initial assignment send remains straightforward and non-scary.
- After an assignment has been sent, the UI offers an obvious safe way to send
  selected files.
- Safe selected-file send never overwrites an existing student file.
- Destructive overwrite requires explicit instructor action.
- Nested selected paths preserve their assignment-relative path.
- Instructor can see what was sent, when, by whom, with aggregate results.
- Existing full assignment send/collect/grade/return flows continue to work.
- Cross-host student projects work.

## Open Questions

- Should selected-file sends target only students who previously received the
  assignment by default? Recommendation: yes.
- Should skipped existing files count as success or warning? Recommendation:
  success with a visible skipped count.
- Should the initial full send use `force: true` or safer `force: false`?
  Recommendation: keep existing behavior initially, but clarify copy text. A
  separate follow-up could make first-send safer if historical course workflows
  allow it.
- Should selected-file patch history be visible to students? Recommendation:
  no for v1; it is instructor/support metadata.
