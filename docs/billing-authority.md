# Billing Authority

CoCalc routes low-volume financial control operations through one logical
billing authority. This replaces concurrent execution by arbitrary Hub and
HTTP workers with a single reviewed command boundary.

This design is intentionally conservative. The first deployment supports one
bay. Multibay billing fails closed until financial data and authority routing
have an explicit global owner.

## Scope

The authority serializes operations that can change externally funded or
commercial state, including:

- Stripe payment, customer, payment-method, checkout, invoice, quote, refund,
  and subscription mutations;
- purchase, credit, membership subscription, package, team-license, and site
  license control operations exposed by the Hub billing API;
- automatic payment, auto-balance, statement, subscription, payment-intent,
  and team-license maintenance;
- verified Stripe webhook processing;
- commercial-order mutations and reconciliation;
- legacy-migration credit grants and membership-renewal changes;
- account deletion and abuse-quarantine cleanup in Stripe.

HTTP operations that need the Stripe secret also execute in the authority,
including customer, payment-method, invoice, and billing-readiness retrieval.
Explicitly reviewed pure reads use a concurrent authority endpoint; payment
listing remains serialized because it can reconcile succeeded intents and
change local billing state.

High-volume project usage metering remains an append-oriented data-plane path.
It does not possess Stripe credentials or perform external collection. Moving
that stream through the low-volume authority would create a needless billing
availability bottleneck.

Read-only billing APIs may execute concurrently only when their method or HTTP
operation is on the explicit allowlist in
`packages/server/purchases/billing-authority/classification.ts`. Unknown and
new methods default to serialized commands. A read accidentally attempting a
Stripe mutation is rejected by the Stripe transport guard.

## Invariants

1. At most one process in a bay holds the billing-authority PostgreSQL advisory
   lock.
2. Every authority command runs to completion before the next command starts.
3. A Stripe mutation is permitted only while an active serialized authority
   command is executing.
4. Detached asynchronous work cannot retain the mutation permit after its
   parent command returns.
5. Authority requests use Conat request transport. A caller may wait for a
   subscriber before sending, but a request is sent only once; transport
   fallback never replays a possibly completed money operation.
6. The authority service accepts only the internal Hub Conat identity. Browser,
   account, project, project-host, and agent principals cannot publish or
   subscribe to its subject.
7. Unsupported multibay topologies reject billing commands with a service
   unavailable error instead of executing against a possibly non-authoritative
   database.

Application authorization is still enforced by the existing HTTP and Hub API
layers. The authority receives the authenticated principal attributes and
invokes the same local domain API after transport. It is not an authorization
bypass.

## Election And Health

Every Hub worker may attempt election, but PostgreSQL grants the session
advisory lock to only one connection. The winner starts the typed internal
Conat service. Losing workers remain clients and retry election periodically.

The winner continuously checks both parts of its lease:

- the PostgreSQL session still answers, proving that it still owns the
  session-scoped election lock;
- the Conat authority subject answers with the winner's own process ID,
  detecting a dead handler or competing responder.

Failure before election retries normally. Failure of the database or service
lease after election closes the service and fail-stops that Hub worker. This
ensures its other database connections and in-flight work cannot overlap a new
authority after PostgreSQL releases the advisory lock; normal process
supervision then starts a clean worker. Command queue health reports the
process ID, start time, active state, queue depth, and completed/failed command
counts. Command logs include a request ID, operation name, serialization
status, and duration, but no payment secrets.

## Failure Semantics

Serial execution removes cross-worker races; it does not make Stripe and
PostgreSQL one atomic transaction. Existing domain-specific idempotency keys,
unique identifiers, fulfillment checks, and reconciliation remain necessary.

If a caller loses the reply after sending a command, the result is unknown. It
must not blindly retry a non-idempotent operation. Inspect local operation
state and Stripe state, or use the operation's durable idempotency mechanism,
before retrying. The authority client intentionally has no after-send retry.

If the authority dies during a command, PostgreSQL rolls back open database
transactions and releases the advisory lock. Stripe operations already
accepted by Stripe remain accepted and are recovered through webhook or
maintenance reconciliation. This is why command serialization complements,
rather than replaces, durable provider identifiers.

Legacy webhook-backup reconciliation is scheduled as new authority commands.
It never continues to mutate the financial ledger as detached work after a
queue slot has been released.

## Initial Rollout

The first activation requires a coordinated all-worker cutover. Old workers do
not know about the authority and can still execute financial operations
directly, so old and new versions must not serve billing concurrently.

1. Deploy the containment change first or as part of the same coordinated
   release.
2. Pause externally initiated billing and automatic billing maintenance.
3. Stop all old Hub and HTTP workers.
4. Start all workers from the authority-enabled release.
5. Verify exactly one `billing authority elected` event and a successful
   authority health response from the elected PID.
6. Smoke-test billing reads, setup intent creation, a test-mode payment, its
   webhook fulfillment, cancellation, and commercial-order diagnostics.
7. Re-enable automatic maintenance and user billing.

There is no data migration for the initial one-bay deployment. The authority
uses the existing authoritative PostgreSQL database and Stripe account.

Rollback is also coordinated: stop all authority-enabled workers before
starting the prior version. Do not run a mixed old/new fleet.

After this initial cutover, versions that implement the same authority
protocol may use ordinary rolling deployment. Protocol changes must preserve
backward compatibility or use another coordinated cutover.

## Self-Hosted Deployments

A single-process or multi-worker standalone deployment gets the same logical
authority automatically. PostgreSQL performs election, so no additional cloud
service is required. If the authority or PostgreSQL is unavailable, billing
fails closed while non-billing functionality can continue.

Operators must configure Stripe webhooks. The delayed reconciliation fallback
is defense in depth, not a substitute for working webhooks and alerting.

Legacy standalone scripts that call Stripe directly are intentionally blocked
from mutating Stripe after this change. Operators must use an authority-backed
API or add a reviewed authority command instead of disabling the transport
guard.

## Deliberate Limitations And Next Step

This first version is a logical authority inside the trusted Hub deployment.
All Hub workers can currently read the Stripe secret, although the transport
guard prevents normal code paths from using it to mutate Stripe outside the
winner. A full process compromise is therefore still inside the trust boundary.

The next hardening step is physical isolation:

- run the authority as a separately supervised service;
- give only that service the Stripe secret;
- authenticate callers with a narrower workload identity than the general Hub
  identity;
- move financial tables behind a database role writable only by the authority;
- retain immutable external command and provider-event audit records;
- designate one global authority and financial database before enabling
  multibay billing.

Until that global authority exists, deployments must not expose legacy
inter-bay financial mutation handlers as an alternate path. Public
authority-routed billing entry points already reject multibay operation.

Those changes reduce the trusted computing base. They do not require changing
the command protocol or domain APIs introduced here.
