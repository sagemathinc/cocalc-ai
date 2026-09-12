# Course-Sponsored Compute: Fresh Implementation

Date: 2026-09-12. Status: fresh branch prepared; no product implementation yet.

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
