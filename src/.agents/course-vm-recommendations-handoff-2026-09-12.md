# Course VM Recommendations: Connected Implementation

Worktree: `/home/user/cocalc-course-funding-v2`, branch
`feature/course-sponsored-compute-v2`. No commit or live operations.

## Build Checkpoint

The refreshed full server `pnpm tsc --build` passes after the concurrent personal
funding exports landed. Frontend `pnpm tsc --build` and full
`pnpm -C src lint:frontend` passed at the recommendation checkpoint.
Compiled server output contains the real recommendation get/set exports and
all three inter-bay bindings. Recommendation code is ready for the coordinated
v2 hub restart with schema update enabled (`--all` enables it, or use
`--update-database-schema`). No original hub was restarted.
Hub/inter-bay contract tests: 31 passed. Template validator tests: 13 passed.
Focused frontend regression run: 40 passed across eight suites.
The real course budget panel tests pass 4/4, including saving recommendations
while funding allocation is unavailable without calling financial APIs.

The real backend exports, project-owned persistence, typed inter-bay service
bindings, and source attachment are implemented. PostgreSQL: 39 tests passed
across four focused suites. PGlite: 37 passed, with the two real PostgreSQL
concurrency tests skipped. No no-op handlers or success stubs.
The 37-test PGlite run was refreshed after source-history integration and still
passes; `include_inactive` and recommendation attachment remain connected.

## Shared Contract

Shared shapes live in `src/packages/util/course-vm-template.ts`.
Conat declarations and principal registrations live in
`src/packages/conat/hub/api/compute-funding.ts`.

- `getCourseVmRecommendations({ course_project_id, course_instance_id })`
  returns `CourseVmRecommendations`: `{ templates: CourseVmTemplate[], version: number }`.
- `setCourseVmRecommendations({ course_project_id, course_instance_id,
templates, expected_version })` returns the updated same shape.
- `CourseFundingSourceSummary.recommended_vm_templates?: CourseVmTemplate[]`
  carries recommendations for the source's associated course to the student.
- Use `normalizeCourseVmTemplates` at the metadata write boundary. It caps the
  list at 10 and permits only bounded labels and hardware config fields.
- Course/project ownership and collaborator authorization govern this metadata.
  Resolve the project authority explicitly, fence concurrent edits with the
  version, and do not treat payer approval or a course-file edit as metadata or
  financial authorization. The signed-in account injected by Conat is the
  actor, not an assertion that this actor owns the payer's money.
- The student source projection must use authorized grant/course associations;
  it must not grant course/project access or disclose unrelated project data.
- Recommendations are not admission policy, a machine allowlist, a quote, or
  financial consent. They contain no payer, SSH, attachment, or deadline fields.

There is no direct agent-messaging tool in this session; coordination was sent
through the shared user conversation. Per the user's ownership correction,
this implementation owns the recommendation backend, not Cicero. Cicero's pool
management, approvals, and source-history behavior remain intact. Shared API
edits are limited to recommendation exports, types, projection, and bindings.

## Backend Authority And Storage

- `projects.course_vm_recommendations` is a server-only JSONB map, keyed by
  course instance UUID. It is not readable or writable through generic project
  `user_query`. It travels with the existing full-row project rehome copy.
- Public reads/writes resolve the course project's owning bay, never payer or
  editor account home. The destination checks local ownership and current
  collaborator access. A payer account or funding pool is not required.
- Writes hold the existing project rehome fence and lock the project row;
  ownership, collaborator access and `expected_version` are checked in that
  transaction. Concurrent saves have one winner. Clearing retains the version.
  Limits are 10 templates per instance and 100 instances per project.
- The payer-home source query supplies course IDs from its authoritative
  beneficiary grant/pool join, after excluding stale rehomed payer copies.
  A separate trusted fabric read resolves project ownership and returns only
  allowlisted published templates. It does not impersonate a payer or grant
  a student access to the course project; the read is absent from public hub API.
- Source attachment deduplicates courses and uses concurrency four within the
  existing 1000-source bound. Recommendation lookup failure omits only optional
  metadata, preserving the funding source and its availability. Course IDs used
  internally are not leaked in the public source projection.
- The schema field is installed by normal database schema initialization/update
  on a coordinated deployment. No live database migration or hub restart was
  performed here.
- Tests cover real persistence/source attachment, remote project routing,
  collaborator denial/revocation, deleted projects, stale bays, rehome fencing,
  version conflicts, metadata limits, invalid financial fields, and a real
  row-lock wait during concurrent collaborator revocation.

## Connected Frontend

- `ComputeBudget` mounts the independent recommendation editor outside the
  financial allocation form. It loads metadata, edits/adds/removes choices, and
  saves only after an explicit command with the loaded version.
- `ComputeFundingSelect.onSourceLoaded` supplies the selected source summary.
- `VmCreateModal` mounts the student selector for that source. Selection fetches
  a fresh catalog and current estimate, then populates only hardware fields.
  The modal uses that fresh catalog for its existing price/confirmation flow.
- Creation is blocked during the quote request. Source changes, template
  updates and manual form edits invalidate pending selection work. Custom
  configuration remains available and never changes the funding source.
- Missing hardware offers alternatives from existing provider catalog helpers;
  missing prices have a separate state. Neither condition means zero course
  credit, silently switches payer, or creates a VM.
- The real VM-form submission test preserves the selected course payer, SSH
  key, 90-minute stop choice and deletion deadline through template selection.
- Main's `VmFundingStatus` details and cost-popover integration is preserved.

## Exact Owned Files

New:

- `src/packages/util/course-vm-template.ts`
- `src/packages/util/course-vm-template.test.ts`
- `src/packages/frontend/course/course-vm-template-model.ts`
- `src/packages/frontend/course/course-vm-template-model.test.ts`
- `src/packages/frontend/course/course-vm-recommendations.tsx`
- `src/packages/frontend/course/course-vm-recommendations.test.tsx`
- `src/packages/frontend/course/test/course-vm-template-fixture.ts`
- `src/packages/frontend/project/course-vm-template-select.tsx`
- `src/packages/frontend/project/course-vm-template-select.test.tsx`
- `src/packages/frontend/project/compute-vms-recommendations.test.tsx`
- `src/packages/server/compute/funding/course-vm-recommendations.ts`
- `src/packages/server/compute/funding/course-vm-recommendations.integration.test.ts`
- `src/packages/server/compute/funding/source-vm-recommendations.ts`
- `src/packages/server/compute/funding/source-vm-recommendations.test.ts`
- `src/.agents/course-vm-recommendations-handoff-2026-09-12.md`

Additive shared edits; preserve other agents' hunks:

- `src/packages/conat/hub/api/compute-funding.ts`
- `src/packages/conat/hub/api/compute-funding.test.ts`
- `src/packages/conat/inter-bay/api.ts`
- `src/packages/conat/inter-bay/compute-funding.test.ts`
- `src/packages/server/conat/api/compute-funding.ts`
- `src/packages/server/inter-bay/service.ts`
- `src/packages/server/compute/funding/sources.ts`
- `src/packages/server/compute/funding/sources.integration.test.ts`
- `src/packages/util/db-schema/projects.ts`
- `src/packages/frontend/course/compute-budget-panel.tsx`
- `src/packages/frontend/course/compute-budget-panel.test.tsx`
- `src/packages/frontend/project/compute-funding-select.tsx`
- `src/packages/frontend/project/compute-vms.tsx`

## Browser Evidence

The standalone fixture runs real components and catalog helpers with mocked
metadata/RPC services, not the original hub. Instructor add/edit/save and
student keyboard selection passed in light and dark themes at 1280, 640 and
320 CSS pixels. All six runs had zero settled-state axe violations, horizontal
overflow or runtime errors, with editor focus restoration checked.

Local artifacts: `src/.local/course-vm-template-audit.cjs` and
`src/.local/course-vm-template-audit/` (results JSON and screenshots).
This is focused UI evidence using mocked RPC services. Backend persistence and
concurrency are separately tested against an isolated PostgreSQL 18 instance;
typed remote routing is tested with an RPC transport fixture. No live multi-bay
deployment or original-hub browser acceptance is claimed. The disposable
PostgreSQL instance was stopped after verification.

## Focused Commands

From `src/packages/server` (PostgreSQL uses the disposable test cluster only):

```sh
env PGHOST=127.0.0.2 PGPORT=5432 PGUSER=user PGPASSWORD='' COCALC_DB=postgres COCALC_TEST_USE_PGLITE='' pnpm run test:psql compute/funding/course-vm-recommendations.integration.test.ts compute/funding/source-vm-recommendations.test.ts compute/funding/sources.integration.test.ts conat/api/compute-funding.test.ts
pnpm run test:pglite --runInBand compute/funding/course-vm-recommendations.integration.test.ts compute/funding/source-vm-recommendations.test.ts compute/funding/sources.integration.test.ts conat/api/compute-funding.test.ts
pnpm tsc --build
```

From `src/packages/frontend`:

```sh
pnpm exec jest --runInBand --silent course/compute-budget-panel.test.tsx course/course-vm-template-model.test.ts course/course-vm-recommendations.test.tsx project/course-vm-template-select.test.tsx project/compute-vms-recommendations.test.tsx project/compute-funding-select.test.tsx project/compute-vms-cli.test.ts project/compute-vm-stop-after.test.tsx
pnpm tsc --build
```

From the worktree root: `pnpm -C src lint:frontend` and
`node src/.local/course-vm-template-audit.cjs`.
