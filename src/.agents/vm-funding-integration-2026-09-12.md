# Sponsored VM Integration Checkpoint

No live provider operations or commits were performed for this change-set.

## Interfaces

- `CreateComputeVmRequest.funding_source`: `CourseVmFundingSource` from
  `@cocalc/util/compute-vm-funding`. Payer ID is a routing hint, not authority.
- `ComputeVm.funding_status`: `ComputeVmFundingStatus` from the same module.
  Amounts here describe the resource authorization, not the student's entire
  grant. Internal authority/binding metadata is omitted from public VM metadata.
- Internal account-local funding methods: `reserveComputeVmFunding`,
  `checkComputeVmFunding` (including bounded renewal), `settleComputeVmFunding`.
  The existing `compute-funding` inter-bay subject carries these methods.
- Local implementations are exported by
  `server/compute/funding/vm-funding.ts`; requests are trusted bay-service
  requests, never browser-supplied rates, owner identity or observations.

## Connected Callers

- VM create persists the selected source and reserves before provider work.
  Student personal payment/2FA funding eligibility is not the payer policy.
  Existing account, project, agent, fresh-auth and VM canary checks remain.
- Catalog remains readable when personal funding lanes are unavailable.
- Worker provision/start recheck reservation dispatch before provider mutation.
- Sponsored billing never opens an unbounded owner purchase. Actual closed
  purchases debit the payer, reconcile backing in the same transaction and
  retain cumulative sub-cent remainder across polling ticks.
- GCP egress has a separate reservation, provider watermark and customer cap.
  Late egress keeps obligations reserved until finalization. Overrun estimates
  are recorded separately and are not passed to the student or instructor.
- Independent deadline sweeps enqueue epoch-fenced stop/delete work without
  requiring a successful payer call. Protected storage is reserved initially.
- Bounded renewals reserve incremental service/storage before extending the
  local deadline; lost renewal replies can be retried against the canonical
  payer reservation. Failed renewals preserve only existing authority.

## Rollout

- `compute_vm_course_funding_enabled` is a disabled-by-default site setting.
- Controlled non-production tests may alternatively set
  `COCALC_COURSE_FUNDING_DEV_VM_ENABLED=yes`.
- GCP egress reserve defaults to USD 1, configurable via
  `COCALC_COURSE_VM_EGRESS_RESERVE_USD`.
- The one-bay outstanding exposure ceiling defaults to USD 100, configurable via
  `COCALC_COURSE_VM_SITE_EXPOSURE_USD`.
- Additive schema is in `util/db-schema/compute-vm-funding.ts`: reservations,
  events, purchase attributions. It must be deployed with the core hold schema.

## Explicit Remaining Gates

- New multi-bay reservations remain denied until a global exposure allocator
  is deployed. Transport routing itself is implemented; this is not a claim
  of full multi-bay product readiness.
- Restart/replacement needs a durable new-epoch reservation and transfer of
  the stopped-storage obligation. Existing restart, resize, pricing switch,
  automatic fallback and funding-mode mutations remain denied for sponsored VMs.
- Personal continuation requires transaction-bound consent and a durable
  payer handoff, not the existing funding-mode selector.
- Sponsored separate home volumes are not implemented. The create API rejects
  a sponsored volume request instead of silently charging personal funding.
- Continuous service across payer usage-window boundaries, source moves,
  independent-process watchdogs and provider-outage recovery need further work.
- Real PostgreSQL concurrency, full multi-bay failure injection and approved
  disposable-provider lifecycle tests remain release gates.

## Checks

- First connected checkpoint: emitting server build passed; 37 focused tests
  passed across funding integration and existing worker/public metadata suites.
- Follow-up renewal and worker admission coverage: 14 tests passed.
- Later aggregate builds may encounter concurrent approval/API interface edits;
  re-run checks after those interfaces stabilize.
