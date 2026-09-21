# Credit Transfer Integration

Working tree: `/home/user/cocalc-course-funding-v2`. No commits.

## Current Connected Status

Pauli's `approval-transfer.ts` adapter is installed by the shared isolated
approval startup. The generic executor hook replaces, rather than nests, its
single-payer transaction. A PostgreSQL/Chromium test now exercises real password
verification, stored fresh-auth sessions, typed proposal/status APIs, uncleared
payment rejection after proposal, successful retry, and both account receipts.

Account billing now resumes durable pending approvals after reopening, preserving
the operation ID. `CreditTransferList.pending_approvals` supplies their original
validated terms and trusted approval URLs; status and receipts remain payer-scoped.

Independent PostgreSQL databases over real Conat exercise colliding purchase IDs,
lost acknowledgments, rejection compensation, third-bay retransfer, and the
transfer participant's sender/receiver rehome behavior. See
`funding-rehome-integration-2026-09-12.md` for the exact participant interfaces and
remaining coordinator requirements. Full financial rehome is still gated.

## Approval Worker Contract

Shared isolated approval integration is REQUIRED before enabling new transfers.
Do not expose `applyCreditTransferInTransaction` as a hub or inter-bay RPC.

Imports from `@cocalc/server/purchases/credit-transfers/core`:

```ts
prepareCreditTransferApproval(
  { payer_account_id, terms: CreditTransferTerms },
  creditTransferTransport,
): Promise<PreparedCreditTransferApproval>

withCreditTransferApprovalTransaction<T>(
  prepared: PreparedCreditTransferApproval,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T>

applyCreditTransferInTransaction(
  { db, payer_account_id, operation_id, intent_id, terms: CreditTransferTerms },
  prepared: PreparedCreditTransferApproval,
): Promise<CreditTransferReceipt>
```

Sequence: authenticate isolated approval session; load immutable stored terms;
run preflight OUTSIDE the transaction; invoke the transaction wrapper; lock and
recheck approval intent/session/expiry/hash; apply using that same db; consume
approval and save its result in that transaction. No nested payer transaction.
Preflight expires after 60 seconds and must be repeated after expiry, not cached
for the 15-minute approval lifetime. Financial locks precede approval-row locks.

From `@cocalc/server/purchases/credit-transfers/api`:

```ts
creditTransferTransport: CreditTransferTransport
registerCreditTransferApprovalService({
  propose({ payer_account_id, operation_id, terms }): Promise<CreditTransferApprovalStatus>,
  status({ payer_account_id, operation_id }): Promise<CreditTransferApprovalStatus>,
}): () => void
```

Register only after the shared isolated listener and transfer handler are ready;
unregister on listener shutdown. The independent feature flag is
`COCALC_ENABLE_CREDIT_TRANSFERS=yes`, default disabled. Both flag and registered
approval handler are necessary. `propose` only persists approval intent, never
calls the financial callback. The shared registry must bind operation kind to
stored terms so course and transfer intents cannot be confused. Approval review
must show sender, verified recipient name/email/account ID, exact USD amount and
remaining transferable balance. Nothing is installed by this transfer module.

The course approval factory now supports the required executor/preflight hook.

## API Worker Contract

Typed methods are already registered under `hub.purchases` and forwarded to the
sender's resolved account home:

- `previewCreditTransfer({ recipient_account_id, amount_usd })`
- `proposeCreditTransfer({ operation_id, terms })`
- `getCreditTransferStatus({ operation_id })`
- `listCreditTransfers()`

Types/normalization: `@cocalc/util/credit-transfers`. Server adapter:
`server/purchases/credit-transfers/api.ts`. Transport is the existing authenticated
account-local inter-bay service, method subject `credit-transfers`. Four additional
internal-only methods resolve verified recipients, verify original payment roots,
read committed sender manifests, and pull/deliver committed transfers. Do not add
those four methods to the public purchases API.

## Delivered Transfer Core

- Only verified cleared USD add-credit/auto-credit PaymentIntent purchase roots.
  Provider verification checks site/account/customer, exact pre-tax purchase
  amount, successful captured charge, no refunds/disputes/review/fraud indication,
  and available USD balance transaction. Pending/uncertain provider results fail
  closed. Other payments, promotions, restricted product funding and postpaid
  capacity do not become roots.
- Reconstructs ordered ledger debits against paid lots before restricted credit;
  later promotional credits and service refunds do not restore paid provenance.
  Received and retransferred credit preserves original payment roots. Changed
  historical ledger rows that invalidate an export require reconciliation.
- Existing backing, renewal splits, captured fulfillment and refund holds reduce
  available credit under the same spending lock as purchases and pool allocation.
- Same-bay sender/recipient locks in sorted account order. Debit/credit, source
  fragments and two notifications commit atomically. Idempotency is durable
  sender account + operation ID; changed terms are rejected.
- Cross-bay sender debit/outbox commits first. Receiver pulls committed sender
  terms, records one durable received/rejected fence and credit atomically.
  A lost acknowledgment remains pending. Only a durable rejection permits a
  compensating sender credit. Already received credit cannot be generically
  refunded; a new approved reverse transfer is required.
- Exported original payment roots block voluntary provider refunds until the
  transfer chain is reconciled. No transfer receipt is treated as a new payment.
- Five consumed schema tables (including monotonic ledger observations), existing notification outbox, existing maintenance
  runner. No quote/launch/dispatch/rehome framework copied.
- Ledger observations retain debit high-water marks; reducing a historical cost
  cannot restore spent payment eligibility. Cleared roots are consumed before
  disputed roots, so disputed credit cannot shelter transferable paid credit.

## Explicit Transfer Restrictions And Remaining Work

- Shared isolated approval handler wiring is now implemented by Pauli. New
  mutations require that listener registration plus the feature flag. Production approval deployment
  and independent security review are separate gates, not inferred from builds.
- New transfers reject accounts with open `cost IS NULL` purchases until personal
  compute has bounded reservations. Already delivered liabilities cannot safely
  be treated as free transferable credit.
- Recipient UI currently takes an account UUID, not an email search/creation
  flow. Authoritative recipient verification is mandatory. No implicit accounts.
- Conservative history scan caps: 100,000 ledger rows and 250 candidate roots or
  incoming roots. Larger histories fail closed pending durable checkpoints.
- Imported/legacy non-PaymentIntent invoice credits are not automatically made
  transferable. They need an explicit independently verified provenance importer.
- Payment-provider disputes/refunds outside CoCalc can occur after preflight.
  Every retransfer re-verifies roots, but webhook-driven freezes, forced recovery
  and support tooling for already-exported chains remain rollout requirements.
- Delivery follows the recipient's current home. An imported received fence
  always wins. An old-home manifest with no prior receipt can only be rejected,
  not newly credited at the successor. Frozen/moving authority remains pending.
  An unreachable authoritative receiving bay remains pending; no timeout refund.
- Independent database and Conat transfer tests now pass. Production-like isolated
  bay processes, deployment configuration and independent review remain separate.

## Omitted Core Plan Requirements (Separate From Transfers)

- Personal running compute was missing bounded reservations at the initial
  checkpoint. The lifecycle worker has since added personal consent/reservation
  paths; their complete integration is outside this transfer validation claim.
- Account financial handoff/rehome is not connected to the coordinator; transfer
  copy participants are implemented and tested, but funding/renewal/refund holds,
  complete ledger/subscription copying, activation and stale-worker acceptance
  still require the shared coordinator work. Existing funding records remain
  fenced against unimplemented movement.
- Lifecycle worker owns course reservation/settlement, egress caps, storage grace,
  watchdog/provider reconciliation and grant exhaustion. This transfer change
  does not claim those paths or their multi-bay tests complete.
- Pool expiry/revocation/close/unused-fund release and beneficiary permission
  changes need connected lifecycle enforcement and independently tested races.
- Postpaid 5-hour/7-day boundary segmentation, epoch reset/tier downgrade and
  outstanding personal liability tests still need end-to-end lifecycle evidence.
- Production trusted-approval deployment, participant-specific audit visibility,
  support reconciliation/alerts and phased independent rollout remain required.

## Recurring And Postpaid Audit

`renew-subscription`, `resume-subscription`, membership changes and recurring
payment application take `lockMembershipSubscriptionAccount`, which now takes
the common account-spending lock before subscription locks. Admission uses
`getSpendableBalance`; scheduled balance splits are holds. Provider-captured
product payments remain held until fulfillment/debit commits. Refunds use the
same account lock and provider-attempt holds. Postpaid admission/enforcement
subtracts committed capacity from the 7-day headroom, including existing pools.

`createPurchase` remains a low-level ledger writer, not authorization. Settlement
must not be rejected after delivery; authorization belongs before delivery.
`createCredit` adds positive balance and does not itself obtain the spending
lock; it must not be used as evidence of transferable payment provenance. The
transfer verifier independently binds a ledger credit to its actual provider
payment and local refund/fulfillment state. Audit new raw ledger writers against
these contracts rather than treating the low-level writer as a generic spend API.

## Validation At Handoff

Current resumed increment: 68 PostgreSQL transfer/provenance/refund/maintenance
tests passed, including the connected browser approval and five independent
multi-database transfer/portability cases. Util 9, Conat 9, frontend 8 passed;
frontend lint, frontend package build, and diff whitespace checks passed. Server
build passed earlier in this increment; the latest attempt reports only shared
`getOwnedPools` registration and volume funding/attribution contracts, not transfer
files. No live QA credits were represented as Stripe payments.
The earlier figures below describe the previous checkpoint, not current gaps.

- Util transfer validation: 9 passed.
- Conat principal binding/private-method exclusion: 9 passed.
- PostgreSQL transfer/provenance/maintenance/refund regression set: 61 passed.
  Final transfer/provenance rerun after authority checks: 31 passed.
- PGlite transfer/provenance/maintenance set: 33 passed, 1 concurrency test skipped.
- Frontend keyboard, stale-preview, idempotent retry and refund UI: 7 passed.
- Frontend lint and `git diff --check`: passed.
- Server build passed during implementation. Last full server attempt is blocked
  only by the other worker's pending `proposeCourseFundingPoolChange` export.
- Last frontend build reports only other workers' course recommendation API,
  `HostCatalog.provider` fixture, and `recommended_vm_templates` contract errors.
- No live approval/transfer execution or independent two-database bay test was
  performed. The private PostgreSQL test instance was stopped. Main worktree
  remains untouched except its original user-edited plan. No commits.
