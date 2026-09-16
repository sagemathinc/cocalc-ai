# Course Funding API Handoff

Public namespace: `hub.computeFunding`. Contract imports:
`@cocalc/conat/hub/api/compute-funding`.

All USD values are decimal strings, all timestamps ISO strings. The payer or
beneficiary always comes from authenticated account identity, never request terms.
Course access is checked at the project's owning bay. Account operations route to
the payer/beneficiary home. No approval RPC exists.

## Read And Allocation

- `getCourseSummary({course_project_id,course_instance_id})` returns
  `CourseFundingSummary`: `{as_of,pools}`. Pools and grants have whitelisted
  budgets (`authorized_usd,spent_usd,reserved_usd,released_usd`), states, dates,
  and optimistic `version`. Runtime counts/rates are omitted when unknown.
- `listSources({include_inactive?:boolean})` returns `CourseFundingSources`: `{as_of,sources}` for the
  signed-in beneficiary. Bounded fanout covers configured/registered bays;
  missing bays fail the complete request. Stale payer-home copies are excluded.
  Student history must pass `include_inactive:true`: expired/exhausted/revoked
  grants and closing/closed/suspended pools remain visible. `state` is the grant
  state; `pool_state` is independent. Disable new-resource choices unless
  `available_for_new_resources === true`. This is snapshot eligibility, not a
  guarantee that a particular priced resource will pass fresh admission.
- `previewAllocation({terms:CourseFundingDraft})` returns normalized `terms`,
  actual `available_backing_usd`, verified `recipients`, and `as_of`.
- `proposeAllocation({operation_id,terms})` returns
  `CourseFundingAllocationStatus`: `{id,status,approval_url?,pool_id?,expires_at}`.
- `getAllocationStatus({intent_id})` returns that same status for either kind of
  intent. Status is `pending | approved | rejected | expired`.

## Pool Management

- `previewPoolChange({terms:CourseFundingPoolChangeDraft})` returns
  `{terms,pool,as_of,available_backing_usd?}`. `pool` is the predicted resulting
  public summary; backing is present when extra backing is required.
- `proposePoolChange({operation_id,terms})` returns the same intent status as
  allocation. Retry identical terms with the same operation UUID. New terms or
  a fresh proposal after expiry require a new operation UUID.

`CourseFundingPoolChangeDraft` contains course project/instance IDs, `pool_id`,
`expected_version`, and `action: "revise" | "close"`. Revisions optionally carry
`amount_usd`, `starts_at`, `ends_at`, and `grants`. Each grant change contains
`grant_id`, `expected_version`, `action: "revise" | "revoke"`, plus optional
amount/dates for revisions. Close/revoke must not contain revised amount/dates.

Amounts are absolute lifetime usable ceilings (`authorized - released`), not
deltas and not available-to-spend balances. Reductions preserve release history;
increases add authorization. Spend and reservations cannot be erased. Without
overcommit, all student usable ceilings must fit the pool ceiling. Dates of all
grants must fit pool dates. Changes are reviewed and applied under the funding
transaction, with optimistic versions rechecked at approval.

## Financial Callbacks And Workers

Pauli owns isolated `approval-*` files. Allocation applies
`createCourseFundingPoolInTransaction`, then
`enqueueCourseFundingReceiptInTransaction` on the same client. Pool management
uses `changeCourseFundingPoolInTransaction`, which enqueues receipts itself.
Receipt routing homes must be resolved before entering the financial transaction.
Receipt failure rolls back money changes. Required billing email and home-bay
inbox projection use the durable notification target outbox; student events
contain only their own grant, not classmates' budgets.

Close releases only unused backing and prevents admission. Reserved liabilities
keep a pool `closing`. After trusted resource settlement, the registered compute
worker finalizes eligible closing pools via
`finalizeClosingCourseFundingPoolInTransaction`; it releases unused remainder and
enqueues final receipts atomically. Never infer settlement from a timeout.

## Integration Ownership

- Instructor management UI: `frontend/course/compute-pool-management.tsx`, mounted
  in the existing budget panel, with injectable API and refresh callback.
- CLI: `computeFunding` namespace, reads/previews/proposals/status only.
- Curie recommendations: separate course metadata, never signed funding terms
  and never authority to spend. Existing recommendations UI stays independent.
- Live development hub: `http://127.0.0.1:19200`; isolated approval port `19212`.
  Instructor `a3a6b9fb-11f4-4989-a70d-ef4da78c119a`, student
  `7a48c3ab-2f73-4531-8beb-efa5aaa94b90`, course project
  `8867ce1b-b246-4510-acba-0a39cd96e9c9`. No credentials are included here.

No commits until coordinated. Live allocation and management approval validation
must use the isolated first-party approval UI, never a direct approval fixture.

## Runtime Projections

Both student sources and instructor grant summaries include `usage_as_of` and
`active_reservations` from the payer-authoritative reservation ledger. Recent
trusted meter observations additionally yield `running_vms`, `hourly_usd`, and
`forecast_exhausts_at` when observed spend would exhaust the remaining ceiling
before expiry. Any unknown/stale observation omits counts/rates/forecast; a
verified empty reservation set may truthfully report zero. Forecasts exclude
future VMs, pricing changes, unmetered egress, and competing pool users' future
spending. They are not spending authorization or a guaranteed runtime.

## CLI

`cocalc computeFunding` (alias `compute-funding`) exposes `summary`, `sources
--include-inactive`, `preview-allocation`, `propose-allocation`, `preview-change`,
`propose-change`, and `status <intent_id>`. Summary takes `--course-project` and
`--course-instance`; previews/proposals take `--terms <JSON-file-or-dash>`.
Proposals require `--operation <uuid>` so retries cannot silently allocate twice.
Commands return the registered server result including the isolated approval URL;
there is no CLI approve operation.

## Connected Checkpoint

- Instructor pool management is mounted in `compute-budget-panel.tsx`, including
  exact bulk ceilings, date changes, grant revocation, pool closure, server
  previews, stable proposal retries, isolated approval links and status polling.
- `project/course-credit-summary.tsx` requests inactive history and displays
  independent pool/grant states, metered counts/rates, observation timestamps,
  and forecasts. `project/compute-funding-select.tsx` requires the authoritative
  eligibility flag and never silently changes course funding to personal funds.
- `compute/worker.ts` registers a non-overlapping closure timer with shutdown
  cleanup; `pool-lifecycle-worker.ts` resolves payer/recipient homes before
  entering the transaction. Real-table tests verify backing return and replay.
- Server and frontend typechecks, CLI build, frontend lint and diff checks pass.
  Focused evidence includes 60 server tests across seven suites, 24 frontend
  tests, 31 Conat tests, and six CLI tests. These counts exclude other workers'
  independent suites.
- Injectable browser audit: six light/dark viewport cases (320/640/1280), zero
  axe violations, keyboard activation/focus restoration and no page overflow.
  Artifacts: `src/.local/funding-pool-management-audit/`.
- Live approval path is prepared in
  `src/.local/funding-pool-management-live.cjs`. Main must reload the isolated
  hub/approval services first; the last live read was still serving the old
  recommendation-less handlers. No new QA allocation was made by this worker.
  Actual course instance: `d6832efa-e7f4-445a-9f89-7d9a2db12ee7`.
- Main owns the additive admin-only `audit` API/CLI reconciliation report. This
  worker does not implement audit or automatic repairs.

## Rollout And Payer Recovery Checkpoint

- Public `getOwnedPools(): CourseFundingOwnedPools` routes to the authenticated
  payer's current home. Its pools include stored `course_project_id` and
  `course_instance_id`, but no raw mutable funding rows or unrelated grants.
  Account Balance mounts `purchases/sponsored-budgets.tsx`, reusing the course
  management component without requiring access to the former course project.
- Course summaries and owned-pool summaries survive lost collaboration/deleted
  projects. Locked pool-change previews compute `requires_course_access` from
  increases in pool/grant ceilings or expanded dates. Reductions/revoke/close do
  not require course permission; expansion still resolves the owning project
  bay. First-time intent review performs the same check, after replay lookup.
- Sources expose authoritative `available_usd`, the nonnegative minimum of pool
  and grant remainders. Student selectors and summaries use that amount, not
  the potentially overcommitted individual ceiling. Eligibility remains the
  independent `available_for_new_resources` gate.
- `compute_sponsorship_enabled` is default off. Public allocation APIs, review,
  and approval-time preflight enforce it and all-bay writer readiness. Summary
  `sponsorship` status controls new-allocation UI; cleanup is never gated.
- `rollout-startup.ts` registers concrete development verifiers before approval
  service initialization. The isolated-QA verifier validates the operator-owned
  worktree, running compiled writer protocols/mtimes, explicit deployment ID,
  and exact PostgreSQL data directory, Unix socket, and database. `smc` on a
  dedicated cluster is supported. There is no global process/environment census
  and no TCP or database-migration requirement. This deliberately trusts the
  local operator's sole-writer configuration, not a claim of production proof.
- Exact restart environment and owner integration contract:
  `src/.agents/funding-rollout-integration-2026-09-12.md`.
- Latest validation: server build; 28 focused rollout/startup/payer-handler
  tests; 38 Conat registration/routing tests; 22 CLI command plus actual context
  factory tests; account cleanup keyboard and source availability UI tests;
  frontend lint. Main owns the next live restart/approval/CPU workflow.
- Rollout API frozen for that live checkpoint. Production/multibay deployment
  and credential-rollout attestation remains required before release, not
  enabled by the isolated-QA exception. No commits.

## Production And Forecast Source Checkpoint

- Production startup now consumes an Ed25519-signed bounded deployment manifest
  through concrete account/resource verifier callbacks. The account callback
  checks actual PG cluster/database identity, named build/role, write-capable
  credentials (including role membership), and retired login/session fencing.
  The resource callback checks the compiled protocol, actual namespace and
  configured cloud/DNS credential identities. Signed operator evidence attests
  fleet retirement and provider IAM revocation; the hub does not claim independent
  provider IAM inspection. Missing or mismatched evidence denies new commitments.
- Full environment/ownership contract is in
  `src/.agents/funding-production-rollout-contract-2026-09-12.md`.
  `getProductionFundingExposureAllocation()` returns signed static per-bay quotas,
  validates their sum against the site ceiling and a separately pinned allocation
  digest. Nietzsche owns actual locked reservation/renewal consumption; the API
  owner has not edited vm-reservations.ts. Quota redistribution requires a drained,
  fenced deployment, not independently rolling manifest edits.
- Runtime projection excludes all protected storage and the complete egress
  envelope from compute backing. It combines only unreserved pool/grant money
  with this grant's remaining runtime reservation and caps by current payer
  5h/7d windows and source end dates. Policy failure omits the forecast, retaining
  financial history and known runtime counts. The unchanged optional
  `forecast_exhausts_at` field now labels as "Estimated compute limit" in both UIs.
- Provider-confirmed deletion events and verified funding handoff meters yield
  zero ongoing rate, even if a stale reservation remains settling for egress.
  Active reservation count still includes that financial settlement obligation.
- Projection PG fixture now supplies trusted running_started_at, matching current
  settlement semantics; GCP/Nebius tests include reduced payer windows and terminal
  deletion with egress pending. PG execution is paused for Main's restart/readiness
  window. No hub restart or compiled JavaScript updates performed by this worker.
- Source checkpoint validation: server no-emit typecheck; 90 server tests across
  projection/production/dev rollout/public API/sources; 10 student/course UI tests;
  frontend lint; 22 existing compiled CLI command/real-context-factory tests.
  No commit. PG fixture execution still awaits Main's restart-window clearance.

## Connected Exposure Checkpoint

- Production `sponsored-resources` capability now invokes Nietzsche's
  `verifyFundingExposureAllocation`. Every bay checks its durable quota policy
  and outstanding obligations before issuing ready evidence. Reservation/renewal
  admission consumes `loadFundingExposureBudget` in vm-reservations.ts.
- The shared signed manifest loader enforces
  `COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256`, including direct consumers in
  exposure.ts, not only the convenience quota reader.
- Exposure manifest/proof expiry is checked after acquiring the bay advisory
  lock, so waiting cannot reuse expired admission evidence. This was the only
  API-owner edit to Nietzsche's exposure.ts; reservation logic is preserved.
- Fresh validation: server no-emit typecheck and 98 focused server tests pass
  (production/dev rollout, exposure integration with mocked DB/fabric, projection,
  public API, sources). No PG test overlap with Main and no compiled JS writes.
- Main owns fresh-PG projection/provider suites and live workflow validation;
  Lagrange owns the actual three-DB Conat VM sponsorship test. The signed three-bay
  tests here use mocked DB/fabric observations and are not claimed as that evidence.
  Sources are stable for Main's coordinated build/restart/implementation commit.
