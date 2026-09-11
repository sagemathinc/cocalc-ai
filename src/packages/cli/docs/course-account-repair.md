# Replacing a course student's account

Use `cocalc admin support replace-course-student-account` for an approved repair
when a roster refers internally to the wrong account. This is an admin support
operation, not an account merge. Personal memberships, files, grades, student IDs,
and project IDs are preserved. The course email/display name remain unchanged;
the preview shows both actual account identities for the operator to confirm.

```sh
cocalc --profile prod admin support replace-course-student-account \
  --ticket-id 12345 --instructor INSTRUCTOR_ACCOUNT_UUID \
  --project INSTRUCTOR_PROJECT_UUID --path 'My class.course' \
  --student-id STUDENT_RECORD_UUID \
  --old-account OLD_ACCOUNT_UUID --new-account NEW_ACCOUNT_UUID \
  --reason 'Instructor confirmed institutional account; operator approved repair' \
  --consent-reference 'Ticket comment ID and operator approval'
```

Review the identities, projects, and returned state hash. Repeat with
`--commit --expected-hash sha256:... --recovery-dir /private/new-repair-directory`.
The directory must not already exist. It contains private course records and
must not be committed or attached to public issues.

Both preview and apply require fresh admin authentication and create a temporary,
audited instructor impersonation session. They read the live course SyncDB without
opening the course UI (which can automatically reconfigure student projects).
The temporary session is signed out on completion or failure. Consent references
are operator attestations, not automatic proof of customer consent.

Apply creates snapshots of the instructor, student, and shared projects, saves
the original course records and project metadata, and writes a durable progress
journal before each phase. It grants new access through the existing admin direct
invitation API, changes only the roster account ID and student-project account
metadata, verifies the result, then removes obsolete access. Shared-project access
is updated too. Other collaborators are preserved. Membership entitlement is not
changed; verify the intended account's entitlement separately after the repair.

## Failure recovery and limits

Do not blindly retry a partially applied repair. Read `before.json` and
`progress.jsonl`, inspect current live state, and reconcile the recorded phase.
The journal deliberately records phase intent before the operation: a network
timeout may mean an operation succeeded. New access may already exist, the roster
or metadata may already have changed, or old access may have been removed from
only some projects. No automatic rollback overwrites concurrent instructor edits.
Snapshot names include the operation UUID. Recovery should preserve subsequent
coursework; restoring a whole project is a last resort.

This first supported command rejects duplicate roster accounts/project IDs,
deleted students, instructor/student overlap, owner/viewer role changes, and
unexpected course associations. Busy course edits invalidate the preview or stop
the operation before removing old access. The client checks cannot provide a
distributed transaction or lock other course editors; arrange a quiet editing
window for the repair.

The legacy course-metadata HTTP API is local-bay-only, so every affected project
must belong to the impersonated instructor's home bay. Project-host connections
still route directly to their respective hosts. Cross-bay repair is rejected
before access changes; supporting it requires a routed metadata RPC.

The reusable sequencing code is `core/course-account-replacement.ts`. A future
instructor-facing UI should share its validation and sequencing, but needs an
explicit invitation/consent design: ordinary instructors cannot directly add a
different account using the existing collaborator API. Do not bypass that
restriction or replace this workflow with raw `.course` JSON or database writes.

The command does not send customer messages or modify ticket status. Record the
verified outcome in a private support note and follow the normal reply approval
workflow.
