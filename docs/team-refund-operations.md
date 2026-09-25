# Reversing an initial Team purchase

Use the authenticated, fresh-auth-protected administrator refund API. Do not
edit purchase rows or call Stripe directly to work around an error.

1. Identify the internal membership purchase and its separate payment/credit
   transaction. They represent the purchase and its funding, not two charges.
2. Refund the internal `team-license-change` purchase first. This operation
   supports only `first_paid` purchases that remain the license's latest purchase
   and have no active renewal payment. Expansions and renewals require separate
   reconciliation and are deliberately rejected.
3. Verify that the Team license is canceled, its backing packages expired,
   assignments revoked, and its purchase refund recorded. Grant propagation uses
   the existing durable membership side-effect mechanism; inspect failures before
   reporting completion.
4. Refund the associated external credit through the existing provider-refund
   API. This returns the money to the payment method and removes the corresponding
   account balance. An internal purchase reversal alone is not a cash refund.
5. Verify provider success, ledger balance, renewal status and effective membership
   before notifying the customer that refunds are complete.

The internal reversal and external payment refund are separate idempotent
operations. A provider timeout is not proof of failure: inspect the durable
provider-refund attempt before retrying.

Personal upgrades remain separate from Team licenses. Reversing a personal
membership purchase expires that subscription; it does not automatically restore
the previous plan or undo a prior prorated upgrade credit. Reconcile the original
term and credit before restoring access. Do not refund the same credit twice.

No production account changes are part of this code change.

## Deployment and renewal reconciliation

Run the normal declarative schema convergence before enabling repurchase: the
existing owner unique index is replaced with a partial unique index that excludes
canceled licenses. Canceled license rows and their packages remain historical;
a subsequent purchase creates a new license rather than reviving refunded seats.

Deploy the renewal reservation code to every billing worker and drain old workers
before performing refunds. An old in-flight worker does not know about this fence.
New external renewal attempts reserve an active payment record after checkout
preflight and immediately before creating a provider invoice. Refunds and
duplicate renewals reject while this reservation exists. A preflight rejection
(for example, checkout maintenance) leaves no reservation to reconcile.

Provider timeouts, process crashes and notification failures do not prove that
the external invoice was never created. Such reservations remain active; entries
with a caught error include `reconciliation_required`. Inspect provider and
fulfillment state, and settle or cancel any external invoice before clearing a
reservation through a reviewed operator procedure. Do not expire these
reservations automatically by age or treat a retry as harmless.
