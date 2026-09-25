# Connected Funding Rehome

Working tree: `/home/user/cocalc-course-funding-v2`. No commits.
No live hub restart, UI changes, cloud changes, or real provider mutations.

## Coordination And Interfaces

Backing/transfer worker owns `server/accounts/rehome.ts`,
`server/accounts/financial-rehome.ts`, and rehome-only inter-bay contracts and
registration. Cicero: the actual coordinator is now connected, not just handed
off. No worker-messaging tool is available; this is the shared coordination file.

Implemented interfaces in `server/accounts/financial-rehome.ts`:

```ts
freezeAccountFinancialState(client, op): Promise<AccountFinancialHandoff>
getAccountFinancialHandoff(op_id): Promise<AccountFinancialHandoff | undefined>
acceptAccountFinancialState(client, handoff): Promise<boolean>
importAccountFinancialState(client, handoff, copyPortable?): Promise<IdMaps>
retireAccountFinancialState(op_id): Promise<void>
activateAccountFinancialState({
  op_id, target_account_id, source_bay_id, dest_bay_id,
}): Promise<void>
```

`AccountFinancialHandoff` and `AccountFinancialActivation` are defined in
`util/account-financial-rehome.ts`. The typed `activateFinancialRehome` RPC is
registered in Conat and the real server inter-bay service. No user RPC accepts
snapshots or ID maps.

## Connected Protocol

- Freeze and immutable snapshot share the source operation transaction, under
  the rehome fence, common spending lock, and authority row lock.
- Destination acceptance installs frozen authority and the account atomically.
  Acceptance checks the committed source operation over the internal bay RPC.
- Financial import and existing membership/projection rows share one destination
  transaction, including durable numeric purchase/subscription/statement maps.
- Source retires before directory cutover. Destination activation verifies the
  source's directory-updated stage and current authoritative account ownership.
- Failed/retrying operations remain frozen. Completed copy replays never erase
  subsequent ledger or projection changes. Return moves can replace only proven
  retired shadows; prior immutable snapshots remain as audit history.

The single new runtime-schema table is `account_financial_handoffs`, using the
existing rehome schema-initialization pattern. It stores snapshots/digests,
source/successor epochs, ID maps, and phase receipts. No unused foundation schema.

Copied financial state: purchases, subscriptions, statements, renewal attempts,
egress meter intervals, postpaid usage windows, holds, pools/grants, personal
consents, reservations/events/attributions, payment fulfillments, provider refund
attempts, admin orders, approval intents/results, transfer provenance/outboxes/
receiver fences, and notification event/target/email records. Known local
membership purchase references are remapped in the same transaction. Pending
approval sessions do not move; pending approvals/consents expire.

## Authority And Workers

Successor authority rotates its epoch. Existing VM/volume pricing and bindings
remain immutable. `assertFundingReservationAuthority` is used by the course and
personal reservation lockers: an old epoch is accepted only for the exact
reservation identity present in the activated handoff snapshot. Bounded renewal
can change its terms without losing that lineage. New authorization still uses
current authority. No resource-table or quote-lifecycle framework was copied.

Cicero's `sources.ts` already resolves current payer homes. Resource routing must
continue to resolve current payer home, not infer it from historical records.

Standalone credit/purchase creation now uses the common spending transaction.
Purchase creation does not impose a new balance-admission check on authorized
settlement. Database triggers provide the final freeze/retirement fence for
legacy SQL. Normal callers must still acquire account locks before row locks;
a legacy lock inversion may abort, never bypass freeze.

Renewal, notification projection, and email selectors skip frozen/retired
financial owners. Destination refund/renewal leases reset without releasing
holds. Provider request/idempotency identities and uncertain outcomes survive.
Financial preflight resolves authoritative ownership before transaction locks,
including rejecting restored stale source workers.

Stripe subscription callbacks resolve stable payment/renewal-attempt identities
to current local IDs; statement callbacks use stable automatic payment identity.
Already processed payments return current local ledger IDs. Immutable provider
request metadata remains unchanged.

## Transfer Participant

`server/purchases/credit-transfers/portability.ts` exports:

```ts
exportCreditTransferStateInTransaction(client, account_id)
  : Promise<CreditTransferPortableState>
importCreditTransferStateInTransaction(client, {
  account_id, state, purchase_ids,
}): Promise<void>
```

Both require frozen local authority. Numeric amounts/high-water marks serialize
as decimal strings. Import maps only local ledger references, never transfer
manifests, root identities, or fence hashes. Replays must match existing rows.

`credit_payment_roots.original_purchase_id` preserves immutable original root
identity while `purchase_id` follows the local ledger map. Verified evidence
retains original Stripe site binding. Root verification routes the original
payer's current home and resolves its local purchase by root UUID. Old prototype
roots lacking site evidence need source re-verification, not relaxed eligibility.

Delivery resolves the current sender home and pulls the committed original
manifest. Reconciliation delivers to the recipient's current home. Imported
receiver fences win; frozen receivers remain pending, never compensatable
rejections. Retired sender outboxes are not selected by source maintenance.

## Validation And Remaining Acceptance

- Actual account coordinator, typed Conat clients, and three independent
  PostgreSQL databases cover sender/recipient/return moves, lost copy and
  activation acknowledgments, frozen raw SQL, predecessor binding settlement,
  prepaid/postpaid liabilities, moved renewal holds/claims, uncertain refund
  settlement, exact provenance/retransfer, restored stale workers, and replay
  after later ledger changes.
- 160 distinct focused PostgreSQL tests passed across transfer/backing/refund,
  renewal/credit, payment callback, notification, and VM/personal lifecycle
  suites. Two runs contained 99 and 67 tests, sharing the six multibay tests.
  All 22 focused rehome/fence/remapping tests passed. Main confirmed the shared
  server build is clean on September 12 after resolving the concurrent build
  errors. No additional PostgreSQL tests were started during main's isolated
  hub 19200/PostgreSQL restart; the separate rehome test database remains stopped.
  Owned-file Prettier checks and git diff --check passed. No frontend files changed
  during this rehome increment; main owns live UI validation.
- The rollout switch is `COCALC_ENABLE_FINANCIAL_REHOME=yes`; it remains unset on
  the live hub. The legacy path rejects ordinary financial ledger history as
  well as funding and transfer records. Do not remove the guard to enable moves.
- Independent security review, live multi-process/multibay rollout, actual
  payment-provider mutations, cloud-provider exercises, and a named-payer pilot
  remain outstanding. Main owns live UI and cloud checks.
- Snapshots exceeding 100,000 rows per participant or 32 MiB require pagination
  and are rejected atomically. Different global postpaid reset epochs are
  rejected; rehome cannot overwrite other accounts' reset policy.
- Connected tests mock filesystem persistence and directory storage, while
  exercising the real financial coordinator and actual bay RPC transport.
  Existing general account-file portability semantics were not redesigned.
