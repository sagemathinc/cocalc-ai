# Course-Sponsored Compute: Fresh Implementation

Date: 2026-09-12. Status: implementation and local validation in progress;
not release-ready.

## Implementation Checkpoint

The course budget tab, allocation preview and approval-intent APIs, student
funding selection, VM admission/billing integration, and separate financial
approval service are implemented on this branch. Focused tests exercise these
boundaries. This is not yet verification of the full acceptance path below.

An isolated development hub is running with its own database, instructor and
student test accounts, fictitious credit, and a real course project. Browser
testing has exercised enrollment, the actual course allocation preview, and
separate-origin approval of a USD 2 allowance. Both accounts see that allowance.
The same student, with zero personal balance and no payment method, launched a
disposable GCP CPU VM through the normal authenticated compute API using that
allowance. SSH and Python execution succeeded. The actual worker stopped the VM
at its five-minute scheduled deadline and deleted it at its ten-minute deletion
deadline. At 22:00 UTC, independent provider inspection confirmed no remaining
instance, boot disk, or public address. The existing purchase ledger charged the
instructor USD 0.01; the student's personal balance remained zero. A payer-home
read-only audit found no ledger discrepancies. Test account credit is fictitious;
the GCP VM was real and has been cleaned up.

Final egress settlement is a separate check: the live run exposed a timestamp
precision mismatch in the first owning-bay watermark update. Its focused
real-PostgreSQL regression failed before the fix and passes afterward, including
successive meter readings, retries, and final reservation release. After loading
the fix, the live worker finalized egress and released the unused reservation.
At 22:16 UTC the student had USD 1.99 available from this USD 2 allowance, zero
personal charges, and no remaining resource commitments. The payer audit was
clean. Physical deletion and financial settlement were checked separately.

The instructor/student budget surfaces have been checked in Chromium at 320,
720, and 1440 CSS pixels, in light and dark modes, with keyboard scrolling of
the instructor table and expandable student budget details. Student available
credit is visible without horizontal scrolling. Focused accessibility scans
passed. This is not yet a complete browser
VM-create, personal-handoff, or home-volume workflow. First-party email
verification succeeded for both controlled accounts; financial receipt delivery
after a repaired SMTP configuration succeeded for both recipients through the
normal retry worker. It retried the original two receipt records without a new
allocation, receipt event, or direct database reset.
The existing live checkout and previous implementation worktree remain preserved.

Classroom-size PostgreSQL checks cover simultaneous retries for both 20 and 50
students: one pool, one grant per recipient, and one backing hold. Browser VM
creation now retains both VM and optional-volume request identities on an
unchanged retry after a lost response. Shared region/machine selectors preserve
their form labels and ARIA attributes; that independently validated change is
committed as `e8624b52bf`.

The browser VM-create workflow now uses the instructor's CPU recommendation.
Its scheduled stop/deletion and fresh-browser notebook preservation checks
passed. The test student's original zero-balance result above is preserved; a
subsequent USD 2 fictitious credit was added solely for personal-payment testing.
It is not a captured payment or transferable cash.

A live separate-origin personal approval stopped a running GCP VM, waited for
network accounting, switched its payer, and restarted the retained instance.
That test found two defects: old-source release incorrectly required a network
watermark through the later storage handoff, and retained-instance restart did
not create the new billing-generation timing row. Both have fixes and focused
PostgreSQL regressions; the latter test now verifies a persisted personal runtime
start. The live attempt is not proof of correct personal runtime billing: a new
live run must validate the corrected path. The first attempt was stopped on its
timer and deletion was requested through the student's normal authenticated API.
Automatic fallback and personal home-volume takeover remain incomplete live paths.

The current checkpoint also includes a checksum/expiry-validated offline Ed25519
rollout-manifest CLI and operations runbook. No operator key is loaded into hubs;
the tool does not deploy or enable sponsorship. Personal admission now shares
the same aggregate exposure guard as course admission. Full static build and
package typechecks passed. Broader purchase/admission/rehome checks passed 376
tests (13 skipped), funding PostgreSQL checks passed 167 before the newest
regressions, and the updated VM/personal suites pass 42 tests. Three-bay tests
use real PostgreSQL and Conat with controlled directory/rollout fixtures, not
actual cloud instances in multiple bays.

Remaining implementation/validation includes cross-bay personal handoff,
personal home-volume takeover, live sponsored-volume lifecycle, transfer/payment
provenance validation, bounded postpaid workflows, and currency display. A
phone-width screenshot caught wrapped amounts/dates missed by the automated
accessibility scan; funding details now use vertical label/value layout and
await a fresh rendered check. Nothing in this checkpoint enables production.

Other work in progress includes pool changes, nonbinding recommendations,
historical student balances, personal funding handoff, transfers, sponsored
storage, and multibay/rehome behavior. Do not infer completion from the presence
of a UI component, table, or passing unit test. The independent review and pilot
gates remain outstanding.

Implementation decisions:

- Financial approvals use a separately hosted page and independent sign-in;
  an ordinary application RPC can propose but cannot approve spending.
- Test cloud resources must have an isolated ownership namespace before cloud
  credentials are enabled, so orphan cleanup cannot touch another dev hub.
- A new course can establish its identity from the budget workflow without
  requiring a prior visit to an unrelated Configuration panel.
- Stale or failed funding lookups disable sponsored creation and retain the
  selected payer; they never silently switch the student to personal payment.
- The first user guide remains a draft until the implemented workflow and
  release gates have been verified.
- Operations have a read-only payer-home audit API and CLI command. Its bounded
  repeatable-read report explicitly excludes provider inventory and remote worker
  verification; it cannot repair balances or declare the pilot reconciled.

## Baseline

- Branch: `feature/course-sponsored-compute-v2`.
- Base: `origin/main` at `b024f77b31`.
- Worktree: `/home/user/cocalc-course-funding-v2`.
- Previous implementation remains on `feature/course-sponsored-compute` at
  `545c8e413e`, in `/home/user/cocalc-course-funding-impl`.
- The annotated [implementation plan](course-sponsored-compute-plan-2026-09-11.md)
  remains the requirements contract, including the user's section 17 decisions.

Do not wholesale cherry-pick the previous implementation. Consult its code and
tests for lessons, then reuse individual pieces only when needed by the connected
workflow. Do not treat its passing tests as verification of this branch.

## First Acceptance Path

Build and exercise one connected instructor/student workflow before broadening
the implementation. Initially use controlled development accounts and a bounded,
disposable CPU VM. Keep sponsorship disabled for ordinary customers until the
full release gates are met.

1. An instructor selects a verified student in the course UI, enters a budget and
   dates, and approves the exact allocation through the trusted financial flow.
2. The server locks the backing, records the allowance, and exposes it to that
   student's account. A retry does not create another allocation. Course-file
   edits and course collaboration do not grant financial authority.
3. The student, with no personal balance or payment method, chooses that allowance
   in the existing VM form and starts an affordable VM. The student is its owner;
   the instructor is its payer. Personal VM behavior remains unchanged.
4. The existing compute worker and purchase metering charge the selected payer
   and update both dashboards, including reserved funds and data timestamps.
5. Expiry or exhaustion prevents further unfunded work, stops compute, preserves
   the funded storage obligation, and ultimately deletes only the disclosed VM
   resources. The project notebook survives. No implicit personal charge occurs.
6. A duplicate request, worker restart, or lost provider reply does not duplicate
   charges, launch an extra VM, or prematurely release backing.

This is an ordering decision, not a waiver of security or accounting. The path
must include atomic backing, authorization, payer-home routing, durable resource
commitments, and cleanup before it spends actual funds. Mocked provider tests can
exercise it earlier, but must be labeled as such.

## Existing Product Integration Points

- `server/conat/api/compute.ts`: existing create/start/mutation authorization and
  affordability admission. Connect here rather than add an unused launch API.
- `server/compute/worker.ts`: actual metering, funding checks, stop and deletion.
  It currently uses `owner_account_id` as payer. Preserve ownership permissions
  while giving sponsored billing an explicit, authorized payer.
- `server/project-host/spend.ts`: reuse purchase metering and account-home routing;
  do not create a second charge ledger.
- `server/purchases/is-purchase-allowed.ts` and other balance consumers: allocation
  backing must reduce genuinely spendable funds, not just the displayed balance.
- `frontend/course` and `frontend/project/compute-vms.tsx`: connect instructor
  allocation and student selection to the same real APIs used by CLI and agents.

Each completed increment needs its real caller and a test crossing that boundary.
Do not accumulate unregistered RPCs, unused worker adapters, or schema-only
milestones and describe them as a working product.

## Subsequent Acceptance Paths

After the first connected path, extend it to 20/50 students, concurrent resources,
postpaid limits, GCP/Nebius failure recovery, bounded personal handoff, credit
transfers, notifications, recommendations, and CLI/agent context. All requirements
and release gates in the original plan still apply. Multi-bay authorization and
accounting are design constraints from the start, not a later retrofit.

Before pilot: real-PostgreSQL concurrency checks, multi-bay exercises, live VM
cleanup, independent security/accounting review, accessible light/dark UI checks,
reconciliation, and operational rollback verification. USD-only display is fine
for the pilot; GBP is explicitly not a pilot prerequisite.

## Provider Identity Clarification

`server/compute/resource-names.ts` already derives provider names from the VM ID
and environment, independently of the user-facing name. The previous explanation
incorrectly implied that this separation was missing.

The narrower lifecycle question concerns replacing a physical cloud instance for
the same logical VM. Normal stop/start of the same instance is not replacement.
If a replacement path reuses a provider name, prefer a fresh, durably recorded
creation name: retries of that creation reuse it; a new physical creation does
not. Keep the old identity available for cleanup and fence stale operations.
Verify the actual replacement paths before changing naming or migration behavior.
Do not block the entire product on hypothetical numeric-ID API support.
