# Billing Authority

CoCalc routes low-volume financial control operations through one logical
billing authority. The authority is deliberately simpler than a distributed
financial system: one PostgreSQL database owns a durable command journal and
exactly one Hub worker executes commands at a time.

The initial deployment supports a standalone installation or the seed bay of
a one-bay hosted deployment. Attached bays fail closed until CoCalc has a
dedicated, narrowly authenticated authority transport. A generic inter-bay Hub
RPC is intentionally not used because the current shared Hub identity is too
broad for a financial mutation boundary.

## Scope

Commands include:

- Stripe customer, payment-method, setup, invoice, payment, refund, checkout,
  and subscription mutations;
- purchase, credit, membership subscription, package, team-license, site
  license, and commercial-order control operations;
- verified Stripe webhook processing and provider reconciliation;
- automatic payment, auto-balance, statement, subscription, payment-intent,
  and team-license maintenance;
- legacy-migration credit and membership-renewal changes; and
- account deletion and abuse-quarantine cleanup in Stripe.

High-volume project usage metering remains an append-oriented data-plane path.
It does not possess Stripe credentials or perform external collection.

Explicitly reviewed side-effect-free local billing reads execute directly and
do not enter the journal. Stripe-facing HTTP operations remain serialized
because customer lookup can recover a missing PostgreSQL mapping. Unknown Hub
methods and HTTP operations default to commands. `getBalance` uses
`noSave: true`, so a concurrent read cannot overwrite the authoritative cached
balance. A read that unexpectedly attempts a Stripe mutation is rejected by
the Stripe transport guard.

## Durable Command Journal

`billing_authority_commands` records every command before execution. A command
has a UUID, canonical request hash, operation, scheduling lane, optional account
identity, expiry, lifecycle state, execution generation, bounded result or
error, and timestamps. Sensitive command and result payloads are removed after
48 hours; operation, request hash, account identity, status, generation, error,
and timestamps are retained for 400 days.

The lifecycle is:

1. `queued`
2. `running`
3. one of `succeeded`, `failed`, `canceled`, `expired`, or `uncertain`

Submitting the same UUID and command is an idempotent status lookup. Reusing a
UUID with different input is rejected. Provider events, maintenance buckets,
and commands carrying an explicit idempotency key derive stable UUIDs. For all
other commands, the journal conservatively coalesces identical canonical input
within a bounded window onto the existing durable result. Canceled and expired
commands are excluded because they provably did not begin execution. Every
uncertain-outcome error exposes the authoritative command UUID so an operator
or caller can inspect that exact command rather than blindly retry it.

Queued commands have bounded admission by lane: critical, interactive, and
maintenance. Critical work is claimed first, then interactive work, then
maintenance. A caller timeout atomically cancels work that is still queued. If
execution already started, the client reports an explicit uncertain outcome
and command UUID; it never pretends cancellation succeeded and never silently
submits a replacement.

Only one command executes at a time. Fleet maintenance commands process at
most one customer, statement, renewal, notification, license, or payment
intent per journal entry. This prevents an unbounded maintenance scan from
holding the authority while payments wait. Health and command-status reads
query PostgreSQL directly and therefore cannot be blocked by command admission
or consume command slots.

## Lease And Fencing

`billing_authority_lease` is a singleton database-clock lease. It contains a
random process instance UUID, monotonically increasing generation, expiry,
enabled state, and drain state.

The elected worker renews a 12-second PostgreSQL lease every two seconds and
also maintains an earlier monotonic local deadline. If renewal becomes
ambiguous or the local deadline expires, the worker fail-stops. A replacement
cannot acquire the lease until PostgreSQL's clock says the old lease expired.
Each Stripe mutation performs a fresh database assertion of the instance,
generation, and expiry before network I/O. A stale worker therefore cannot
continue mutating Stripe after takeover, even if it retained asynchronous
execution context.

Command completion is also generation-fenced. On takeover, any `running`
command from another instance or generation becomes `uncertain`; it is never
automatically replayed. Detached asynchronous work loses its mutation permit
as soon as the parent command returns.

This does not make Stripe and PostgreSQL one atomic transaction. Durable
provider identifiers, Stripe idempotency keys, webhook handling, and
domain-specific reconciliation remain necessary for failures between the two
systems.

## Account Fences

`billing_authority_account_fences` provides a monotonic per-account freeze.
Deletion, abuse quarantine, and equivalent containment freeze billing before
cleanup is queued. Freezing cancels all queued ordinary commands for that
account and rejects new ones. Cleanup commands are the narrow exception.

An already-running command completes before the serialized cleanup command can
run. This ordering lets cleanup remove resources created by that in-flight
command. Fleet maintenance rechecks frozen, banned, and deleted accounts when
it selects each bounded unit of work. Ordinary commands cannot be inserted
between freeze and cleanup. Unfreezing is an explicit lifecycle operation.

## Readiness And Lifecycle

The admin system API exposes authority status from PostgreSQL:

- lease instance, generation, and expiry;
- ready, enabled, and draining state;
- active command UUID;
- queue depth by lane; and
- 24-hour success and failure counts.

Global lifecycle mutations require administrator authorization, fresh
authentication, and a second factor when enabled:

- `drainBillingAuthority` disables admission, prevents new claims, waits for
  the active command, and releases the lease;
- `resumeBillingAuthority` re-enables election and waits for readiness; and
- `handoffBillingAuthority` drains, resumes, and verifies a newer generation.

If a holder dies after drain starts, the drain path atomically clears the
expired holder and records its running command as `uncertain`. Drain therefore
cannot wait forever on a dead process. These APIs provide an enforceable
cutover and rollback gate rather than relying on timing or log inspection.

## Initial Rollout

Old workers can still execute financial code directly, so the first authority
activation is a coordinated cutover, not a rolling deployment.

1. Deploy the containment change that removes generic synchronized-table
   financial writes.
2. Disable externally initiated billing and automatic billing maintenance.
3. Stop every old Hub and HTTP worker.
4. Start the authority-enabled release on the authoritative standalone or seed
   bay.
5. Confirm status is `ready`, exactly one valid lease exists, and queue depth is
   bounded.
6. Smoke-test read-only billing, setup-intent creation, a test-mode payment,
   webhook fulfillment, cancellation, refund authorization, and commercial
   diagnostics.
7. Re-enable automatic maintenance and user billing.

Rollback uses the same gate: drain the authority, stop all authority-enabled
workers, start the prior release, then deliberately restore billing. Never run
old and authority-enabled workers concurrently.

There is no financial-data migration for the current one-bay production
deployment. It continues using the existing authoritative PostgreSQL database
and Stripe account.

## Self-Hosted Deployments

A standalone installation gets the same durable authority automatically. It
requires PostgreSQL but no cloud-specific queue, lock service, or extra daemon.
If PostgreSQL or the authority is unavailable, billing fails closed while
unrelated product functionality can continue.

Operators must configure Stripe webhooks and alerting. Reconciliation is
defense in depth, not a substitute for delivery. Scripts that mutate Stripe
directly are intentionally blocked once enforcement starts; they must use a
reviewed authority command instead of disabling the guard.

## Multibay And Physical Isolation

Public billing entry points and known inter-bay financial writers enter this
authority boundary, but attached bays currently receive `503` for all billing
calls, including reads.
Do not enable multibay billing until all of the following exist:

- one designated global financial database and authority;
- a dedicated authenticated transport whose credential cannot invoke general
  Hub operations;
- account and project ownership attestations appropriate to each command; and
- tests proving no attached-bay legacy writer bypasses the authority.

This version is a logical authority inside the trusted Hub deployment. Hub
workers can still read the Stripe secret, although normal Stripe mutation paths
are guarded. The next trust-boundary improvement is to run the executor as a
separately supervised service, give only it the Stripe secret and financial
database write role, authenticate callers with a narrow workload identity, and
export the retained journal and provider events to immutable external storage.
