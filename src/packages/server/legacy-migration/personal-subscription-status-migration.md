# Personal Subscription Status Migration

This migration retires the legacy `NULL`, `unpaid`, and `past_due` states from
the local `subscriptions` table. It does not modify Stripe subscriptions or
payment intents.

## Predeployment Audit

Run `audit-personal-subscription-statuses.sql` against every production
database that contains `subscriptions`, and record the grouped output in the
PR deployment note. The query is read-only and does not select account
identifiers or other PII.

The expected result is zero rows. If it finds any rows, retain a secure export
of the affected rows before deployment and review every group before allowing
schema sync to run.

## Mapping

| Existing status | New status | Reason |
| --- | --- | --- |
| `NULL` | `canceled` | The row is neither renewable nor a source of personal-membership entitlement. |
| `unpaid` | `canceled` | Personal membership is prepaid; an unpaid row grants no entitlement. |
| `past_due` | `canceled` | There is no grace-period membership; failed renewal leaves no paid entitlement. |

Existing nonblank cancellation reasons are preserved. Otherwise the migration
records a status-specific retirement reason and sets `canceled_at` when it is
missing. Other subscription history, metadata, period dates, and purchase
references remain unchanged.

For a migrated row only, an embedded `payment.status='active'` is changed to
`canceled`. This JSON field is CoCalc's local pending-renewal marker. Leaving it
active on a terminal subscription would falsely indicate that fulfillment is
still in progress. The migration does not cancel or mutate any Stripe object;
the existing payment-intent processor continues to credit a successful but
unapplied payment to the account.

## Deployment Safety

The application change that rejects creation of legacy states precedes this
migration. A search of the previous production code found no normal runtime
writer that creates `unpaid` or `past_due`: personal membership creation uses
`active` or `canceled`, and the retired renew/resume paths only write `active`.
During a rolling deployment, an older generic/admin write could still attempt
an arbitrary legacy status; PostgreSQL will reject that write after the
constraint is installed.

The migration acquires its own per-database transaction advisory lock before
rechecking the constraint. This also protects direct `syncSchema()` callers
that do not enter through the pool bootstrap's broader schema lock. In a
multibay deployment, each database migrates independently. The row
normalization, `CHECK ... NOT VALID`, and constraint validation run in the
locked transaction with a five-second lock timeout. A lock timeout, process
failure, or validation error rolls back the update and constraint together;
another startup retries schema sync for that database. `NOT VALID` minimizes
the initial lock, then PostgreSQL validates all rows before commit. The
production audit is required because schema sync is not an appropriate place
for an unexpectedly large unreviewed data rewrite.

## Recovery

Before commit, any migration failure rolls back automatically. After a
successful migration, reverting application code does not reconstruct the
three historical status values. If the audit found affected rows and one was
classified incorrectly, use the retained secure export or database backup to
identify it, drop the named
`subscriptions_status_active_or_canceled_check` constraint, restore only the
reviewed rows, deploy a corrected forward migration, and rerun schema sync.
