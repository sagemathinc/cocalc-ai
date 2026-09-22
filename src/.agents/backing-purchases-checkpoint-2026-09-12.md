# Backing/Purchases Commit Checkpoint

Worktree: `/home/user/cocalc-course-funding-v2`.
This is the selected backing/purchases portion of the connected course increment,
NOT a claim that a standalone backing-only commit implements the course workflow.
No staging, source edits, commits, hub restart or new live financial operation
were performed for this checkpoint. Main owns the isolated hub on port 19200 and
the final workflow validation/commit.

Ordinary QA credit added with `createCredit` is valid ledger backing for prepaid
course funding. It is NOT verified payment provenance for direct transfers.

## Whole-File Selection

These files contain the selected core/purchase changes and no transfer-feature
integration hunks. Paths are relative to the worktree root. Do not replace this
list with a broad directory add: other workers and incomplete transfers share
these directories.

```text
src/packages/util/compute-funding.ts
src/packages/util/compute-funding.test.ts
src/packages/util/db-schema/compute-funding.ts
src/packages/util/db-schema/payment-fulfillments.ts
src/packages/util/db-schema/provider-refund-attempts.ts
src/packages/util/db-schema/admin-membership-orders.ts
src/packages/util/db-schema/subscription-renewal-attempts.ts
src/packages/server/compute/funding/backing.ts
src/packages/server/compute/funding/pools.ts
src/packages/server/compute/funding/policy.ts
src/packages/server/compute/funding/__tests__/policy-source.ts
src/packages/server/compute/funding/backing.integration.test.ts
src/packages/server/compute/funding/pools.integration.test.ts
src/packages/server/compute/funding/policy.test.ts
src/packages/server/compute/funding/authority.test.ts
src/packages/server/compute/funding/spending.integration.test.ts
src/packages/server/compute/funding/refunds.integration.test.ts
src/packages/server/accounts/admin-audit.ts
src/packages/server/accounts/is-valid-account.ts
src/packages/server/accounts/rehome.ts
src/packages/server/membership/packages.ts
src/packages/server/membership/resolve.ts
src/packages/server/membership/tiers.ts
src/packages/server/membership/usage-windows.ts
src/packages/server/membership/seed-tier-routing.test.ts
src/packages/server/project-host/admission.ts
src/packages/server/project-host/admission.test.ts
src/packages/server/project-host/spend.ts
src/packages/server/project-host/spend.test.ts
src/packages/server/project-host/spend-enforcement.ts
src/packages/server/project-host/spend-enforcement.test.ts
src/packages/server/purchases/lock-account-spending.ts
src/packages/server/purchases/get-spendable-balance.ts
src/packages/server/purchases/assert-debit-preserves-prepaid-holds.ts
src/packages/server/purchases/captured-payment.ts
src/packages/server/purchases/captured-payment.test.ts
src/packages/server/purchases/provider-refund-reader.ts
src/packages/server/purchases/provider-refund-worker.ts
src/packages/server/purchases/admin-membership-orders.ts
src/packages/server/purchases/admin-membership-package.ts
src/packages/server/purchases/admin-membership-package.test.ts
src/packages/server/purchases/admin-purchase.ts
src/packages/server/purchases/admin-purchase.test.ts
src/packages/server/purchases/create-credit.ts
src/packages/server/purchases/create-refund.test.ts
src/packages/server/purchases/create-membership-refund.test.ts
src/packages/server/purchases/cancel-subscription.test.ts
src/packages/server/purchases/is-purchase-allowed.ts
src/packages/server/purchases/membership-subscription-guard.ts
src/packages/server/purchases/membership-change.ts
src/packages/server/purchases/membership-change.test.ts
src/packages/server/purchases/membership-package.ts
src/packages/server/purchases/team-license.ts
src/packages/server/purchases/subscription-renewal-attempts.ts
src/packages/server/purchases/stripe-usage-based-subscription.ts
src/packages/server/purchases/stripe/billing-readiness.ts
src/packages/server/purchases/stripe/create-payment-intent.ts
src/packages/server/purchases/stripe/create-payment-intent.test.ts
src/packages/server/purchases/stripe/create-subscription-payment.ts
src/packages/server/purchases/stripe/create-subscription-payment.test.ts
src/packages/server/purchases/stripe/process-payment-intents.ts
src/packages/server/purchases/stripe/process-payment-intents-invoice-link.test.ts
```

`renew-subscription.ts`, `resume-subscription.ts` and ordinary subscription callers
need no direct diff: they consume the changed shared subscription-account guard.
`create-purchase.ts` and `get-balance.ts` are unchanged low-level ledger functions.

## Seven Mixed Core Files

Include the following files only after excluding these transfer-only hunks from
the candidate commit. Preserve their remaining backing/purchase changes.

1. `src/packages/server/compute/funding/authority.ts`: exclude the five entries for
   `credit_payment_roots`, `credit_transfers`, `credit_transfer_deliveries`,
   `credit_transfer_entries`, `credit_transfer_ledger_observations` in the rehome
   table list. Keep authority initialization and backing/pool/pending-payment
   rehome fences. The table-presence checks are defensive, but the transfer guards
   do not belong in this selected increment.
2. `src/packages/server/purchases/provider-refund-attempts.ts`: exclude the import
   of `assertPaymentRootNotExported` from `./credit-transfers/ledger` and its call
   in `prepareProviderRefund`. Keep the durable refund attempt/hold protocol.
3. `src/packages/server/purchases/create-refund.ts`: exclude only the early
   `service === "credit-transfer"` rejection block. Keep provider attempts,
   ordinary reversal hold protection, account locks and atomic product reversals.
4. `src/packages/server/purchases/maintenance.ts`: exclude `maintainCreditTransfers`
   import and its runner entry. KEEP `maintainProviderRefunds` import/runner.
5. `src/packages/server/purchases/maintenance.test.ts`: exclude the four
   `"reconcile pending account credit transfers"` expected entries. KEEP the
   `"reconcile pending provider refunds"` expectation.
6. `src/packages/util/db-schema/purchases.ts`: keep
   `ADMIN_MEMBERSHIP_PACKAGE_PURCHASE`; exclude the `"credit-transfer"` service
   union member and the transfer `Description` variant.
7. `src/packages/util/db-schema/index.ts`: keep imports for `compute-funding`,
   `payment-fulfillments`, `admin-membership-orders`, `provider-refund-attempts`.
   Exclude `./credit-transfers`. `./compute-vm-funding` belongs to the lifecycle
   worker's connected increment; keep it when including that worker's schema.

## Inter-Bay And Connected Worker Files

`src/packages/conat/inter-bay/api.ts` is also mixed across workers. My backing
dependency is ONLY the two `AccountLocalDedicatedHostPolicySnapshot` fields:
`prepaid_spendable_balance?: MoneyValue`, `postpaid_committed_usd?: MoneyValue`.
Those fields must accompany admission/spend changes even in a narrow backing
selection.

For the full connected course increment retain Cicero/Nietzsche's compute-funding
types, subject, client forwarding and handlers. Exclude all of the following
transfer additions from that file:

- `"credit-transfers"` in `AccountLocalMethod`.
- `InterBayCreditTransferApi` import and interface extension.
- `creditTransfersClient` construction.
- The four public transfer forwarding methods and four internal transfer methods.
- The `createServiceHandler<InterBayCreditTransferApi>` block.

Likewise in `src/packages/server/inter-bay/service.ts`, retain the other workers'
course/VM registrations but exclude the import from
`server/purchases/credit-transfers/api` and its eight implementation properties.

Approval, course API, lifecycle reservations/settlement/schema, stop/expiry,
receipts/notifications and frontend course files belong to the other workers'
explicit handoffs. They ARE needed for the full connected workflow. Do not omit
them because they are outside this backing/purchases list. In particular service
reservation policy uses the lifecycle reservation tables; the four-table backing
schema alone only supplies allocation/backing state.

## Entirely Excluded Transfer Files

```text
src/packages/util/credit-transfers.ts
src/packages/util/credit-transfers.test.ts
src/packages/util/db-schema/credit-transfers.ts
src/packages/conat/inter-bay/credit-transfers.ts
src/packages/conat/hub/api/credit-transfers.test.ts
src/packages/server/purchases/credit-transfers/
src/packages/frontend/purchases/credit-transfers.tsx
src/packages/frontend/purchases/credit-transfers.test.tsx
```

Also exclude the current diffs in the following tracked files: they are entirely
transfer integration, not required backing changes:

```text
src/packages/conat/hub/api/purchases.ts
src/packages/server/conat/api/purchases.ts
src/packages/server/purchases/get-service-cost.ts
src/packages/util/db-schema/purchase-quotas.ts
src/packages/frontend/purchases/balance-page.tsx
src/packages/frontend/purchases/purchases.tsx
src/packages/frontend/purchases/admin-refund.tsx
src/packages/frontend/purchases/admin-refund.test.tsx
```

The separate transfer handoff document is
`src/.agents/credit-transfer-integration-2026-09-12.md`; do not describe that feature
as enabled or part of the approved course workflow. Its shared isolated approval
adapter is still absent and mutation remains gated off.

## Validation And Boundaries

Before the transfer feature, this selected backing/purchases implementation had
31 util tests, 94 real PostgreSQL tests, and 205 PGlite tests (4 skipped) passing,
plus a further focused 40-test pass (1 skipped). These are prior run results,
not a fresh claim that the exact selectively staged snapshot has been validated.
Recent worktree validation also included the existing refund regression suite.

Main must build/test the exact candidate without the excluded transfer hunks:
leaving `provider-refund-attempts` or schema registration importing excluded files
would make a whole-file-only selection incoherent. Re-run package typechecks and
focused backing/purchase tests, then validate the approved instructor/student VM
workflow against the isolated hub before committing the connected increment.

Independent review, independent multibay validation and pilot rollout have NOT
been done. A successful project operation and seeded QA balance do not establish
those gates. Financial account rehome remains blocked, not portable. Personal
unbounded running liabilities are not replaced by this backing core. The other
workers own lifecycle/postpaid boundary, protected storage, watchdog and provider
reconciliation validation; do not infer completion from this file list.
