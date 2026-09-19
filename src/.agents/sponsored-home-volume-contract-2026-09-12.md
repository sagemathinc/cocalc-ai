# Sponsored Home Volume UI/CLI Contract

Coordination for main/Nietzsche: UI/CLI owns this caller integration; Nietzsche
owns backend volume reservations, settlement, dispatch, attachment and personal
handoff. No direct agent messaging is available in this session.

## Resumed Caller Contract

Backend checkpoint: source/status intentionally redact the actual payer UUID for
student views. A course source with pool_id/grant_id is the public identity;
requireVolumeFundingVersion must not require payer_account_id. The routing hint
used on create is not financial authority. Backend now accepts
accept_course_retention, publishes sponsored_home_volumes only under successful
rollout admission, and enforces attachment/growth funding-version checks.

Main resumed UI/CLI and Nietzsche backend work after the namespace review. Home
volume UI/CLI owns callers and focused tests only; no cloud/hub/worker operations.

Additive capability: `ComputeCatalog.sponsored_home_volumes?: boolean`. Backend
must publish `true` only once sponsored create, attachment, resize, retention
acknowledgment and funding-status projection are all enforced. Absent/false fails
closed in callers before creating a volume or attaching sponsored storage. This
also prevents older servers from silently ignoring course fields. This is a
capability check, not a substitute for owning-bay/payer authorization.

Usable funding status requires state `running`, `active` or `ready`, a course
source with pool/grant IDs, current funding version, future `authorized_until`,
future service `stop_at` when supplied, and `as_of` at most 45 seconds old
(5-second forward clock tolerance). The public payer UUID may be redacted;
display the authorized funding label, with no private account lookup. Requests
still require the explicit payer/pool/grant triple. Unavailable status stays
unavailable. CLI now
implements the flags below, including `funding --version-only` for the generated
combined shell command. No payer/lane mutation bypass is added.

## Proposed Additive Contract

- Existing `createVolume(CreateComputeVolumeRequest)` already declares
  `funding_source?: CourseVmFundingSource`. Both standalone creation and combined
  VM + new home-volume creation will send the explicitly selected course source.
  Backend must reject unsupported sponsored creation before any personal charge.
  Add `accept_course_retention?: boolean`; sponsored callers require true and
  backend should persist the independent retention agreement/policy. CLI exposes
  `--accept-course-retention`, not an implied acceptance from the VM's source.
- `ComputeVolume.funding_source?: CourseVmFundingSource` identifies a sponsored
  volume even when its status lookup is unavailable. Absence denotes existing
  legacy personal/site funding; do not omit it for a sponsored volume.
- `ComputeVolume.funding_status?: ComputeVolumeFundingStatus`, imported from
  `@cocalc/util/compute-volume-funding`, has:
  `source`, `label`, `state`, `funding_version`, `as_of`, optional `payer_account_id`,
  optional `lane`, `spent_usd`, `committed_usd`, `remaining_usd`,
  `protected_storage_usd`, `authorized_until`, `stop_at`, `storage_delete_at`.
  Missing status/amount/date is unavailable, never zero or personal funding.
- Existing `resizeVolume` gains `expected_funding_version?: string`. Sponsored
  growth requires the current version and a fresh reservation against the
  volume's existing source/payer. Never reinterpret funding_mode as a payer
  switch. Personal/site legacy requests remain compatible.
- Existing `createVm` gains `expected_home_volume_funding_version?: string`
  alongside `home_volume`. Sponsored attachments bind the reviewed volume
  funding version; personally funded attachments remain compatible without it.
  The volume owner/source/payer/retention remain independent of the VM's source.
- Existing `deleteVolume` stays unchanged: exact name confirmation, owning-bay
  authorization, detached-state/generation fencing and independent settlement.
  Neither deleting a VM nor changing its funding may delete/rebill its volume.
- Sponsored `setVolumeFundingMode` must reject legacy payer/lane changes; any
  personal takeover belongs to the separate browser-approved handoff contract.

## UI/CLI Work

Real volume creation form: source selector, unavailable-source blocking,
independent storage-policy disclosure; generated CLI includes the same source.
Combined creation: pass the source to both resources with separate idempotency
keys; retain and identify a created volume when VM creation fails. No personal
fallback and no automatic rollback deletion of data.

Existing volume table/details and VM attachment selection: display volume payer,
funding state/cost/retention independently. Growth passes the reviewed funding
version and never changes payer. Deletion warns about permanent data loss and
the volume's own deadline; attached/ambiguous volumes stay nondeletable.

CLI: `vm volume create` uses the existing three all-required UUID flags;
`vm volume funding` returns full public funding status; resize exposes
`--expected-funding-version`; `vm create` attachment exposes
`--home-volume-funding-version`. Existing commands remain the only mutation path.

Nietzsche's current backend connects sponsored lifecycle, retention acknowledgment,
review-version fencing, and rollout-gated capability publication. The resumed
caller patch accepts its redacted public source without relaxing pool/grant or
version fences; returned explicit payer mismatches still reject VM creation.
Personal takeover of an attached home volume remains unsupported, separately
from sponsored volume lifecycle. No live backend acceptance was performed here.
Nietzsche owns project-owning-bay/payer-home authorization and enforcement.

Freshness boundary: the current public projection uses billing_updated_at (or
created_at) for as_of. If that observation is older than 45 seconds, callers
remain blocked even after reloading. This patch does not invent a fresh funding
observation or relax that existing gate; backend observation cadence needs live
validation with main/Nietzsche.

## Owned Files

Paths below are relative to `src/packages`:

- `conat/hub/api/compute.ts`: additive volume contract and catalog capability.
- `util/compute-volume-funding.ts`: public status and shared caller validation.
- `cli/src/bin/commands/vm.ts`: connected volume/attachment flags and callers.
- `cli/src/bin/commands/vm-volume-funding.test.ts`: focused CLI contract tests.
- `frontend/project/compute-vms.tsx`: additive actual VM/volume form, status,
  resize, deletion integration; existing main VM funding components preserved.
- `frontend/project/compute-vms-cli.ts` and `compute-vms-cli.test.ts`: generated
  shell sequence and regressions.
- `frontend/project/compute-vm-create-workflow.ts` and
  `compute-vm-create-workflow.test.ts`: real creation sequence, bounded wait,
  retained-volume reporting and no personal fallback.
- `frontend/project/compute-volume-funding.ts`: independent source/status helpers.
- `frontend/project/compute-volume-funding-status.tsx`: status, policy and
  keyboard-accessible details dialog.
- `frontend/project/compute-volume-funding.test.tsx`: real forms, keyboard/focus,
  unknown status and supported/unsupported creation/attachment checks.

No backend, worker, metering or settlement implementation edits in this resumed
caller checkpoint. No commits or hub/cloud operations.

## Validation

Latest redacted-payer caller checkpoint:

- Changed only util/compute-volume-funding.ts, the one returned-payer comparison
  in frontend/project/compute-vm-create-workflow.ts, funding-status payer display,
  focused frontend/CLI volume tests, and this contract. Main's workflow retry
  implementation/test and compute-vms.tsx/host-selector edits were preserved.
- New frontend/project/compute-volume-redaction.test.ts covers actual new and
  existing volume attachment, explicit request payer, source mismatch rejection,
  stale/missing version/status, protected service and expired stop deadline.
- Util build, CLI test compilation and frontend no-emit typecheck passed.
  Focused CLI audit/regression run: 99 tests passed across seven files.
- Four frontend suites passed 52 tests: compute-volume-funding,
  compute-volume-redaction, compute-vm-create-workflow, compute-vms-cli. Frontend
  lint passed with zero warnings/errors; retry-key regressions remained green.
- Updated src/.local/volume-funding-audit.cjs uses the real redacted public source.
  Twelve browser cases (light/dark, 320/720/1440, ready/unknown) passed with zero
  axe violations/overflow and keyboard open/Escape/focus restoration. No network
  traffic or hub/cloud operations. Screenshots/results use the paths below.

Earlier caller implementation checkpoint (historical):

- CLI build and test TypeScript compile passed. 72 tests passed across
  `vm`, `vm-personal-funding`, and `vm-volume-funding`; built binary help confirms
  the new flags are registered.
- Frontend typecheck and lint passed (zero lint warnings/errors). Final focused
  Jest run: six suites, 48 tests passed (`compute-volume-funding`,
  `compute-vm-create-workflow`, `compute-vms-cli`, `compute-vms-recommendations`,
  `compute-vm-funding-status`, `compute-vm-personal-funding`). This includes the
  fresh-draft payer/retention reset regression and main's existing VM funding UI.
- Standalone browser audit (no hub or network access): real funding details UI
  in light/dark at 320/720/1440, known/unknown status (12 cases), zero axe
  violations, zero horizontal overflow, keyboard open/Escape/focus restoration
  passed. Screenshots inspected; narrow label columns and semantic contrast fixed.
- Audit runner: `src/.local/volume-funding-audit.cjs`; results and screenshots:
  `src/.local/volume-funding-audit/`. This is not live backend acceptance or a
  browser audit of every full VM form; those caller flows have component tests.
