# Optimize the bay

This change is an availability/performance change, not a production deployment.

## Query work

- Summary/state/host updates no longer search for a collaborator event that
  cannot match the current event.
- Project history has a project/time/id index and a partial collaborator-history
  index. The collaborator query uses a literal predicate so prepared plans can
  use the partial index.
- Usage attribution first unions candidates from usage-account, student-course,
  and users-GIN indexes. Only those candidates expand users JSON. Explicit usage,
  student-course, and lexicographically first owner precedence is unchanged;
  the existing owning-bay filter is retained.
- Collaborator projection recomputes affected pairs from current authoritative
  state, rather than applying fragile increments or rebuilding every pair.
  Replays are idempotent. Unrelated pairs and their timestamps are untouched.
  Transaction-scoped account locks are taken in sorted order over the whole
  batch and retained until commit. The immediate publisher now uses a transaction.
- Host resolution has a sub-budget (at most 32 active calls per account and a
  quarter of the global allowance) inside the existing limits. It cannot consume
  all the capacity needed for invites, payment-source reads, and other requests.
  Existing same-scope single-flight behavior is retained. Overload telemetry is
  aggregated with bounded memory and a single database writer.

## Billing process

Ordinary hubs initialize billing enforcement and transport only. They no longer
acquire authority or execute billing commands. A dedicated `--billing-worker`
initializes the dispatcher, funding handlers, and feed publishing without starting
HTTP/API listeners or general hub maintenance.

`cocalc-bay-billing.service` runs one executor on the seed/standalone bay. Its
launcher holds a kernel `flock` for the worker lifetime. Replacement cannot start
until that process exits; systemd stops the whole service control group. Do not
run this service on two machines or configure automatic cross-machine failover.
Moving it requires stopping the old instance first. Never unlink the lock file
to force a second executor to start.

Database/query/heartbeat errors revoke the current execution context, let all
in-flight work settle, and retry with exponential backoff capped at 30 seconds.
They do not call `process.exit`. A late heartbeat cannot reactivate a revoked
context. Idle client errors are handled. A command exceeding its runtime bound
pauses further execution; if it never settles, only the billing service needs
operator intervention. An HTTP request already received by Stripe is not undone.

The existing durable journal, generation checks, account-freeze ordering, provider
idempotency identities, and uncertain-outcome reconciliation remain. The existing
lease table stores a `supervised_singleton` ownership generation with a year-9999
expiry sentinel for compatibility with journal queries. It does not expire due to
event-loop delay and does not elect another executor. The process-lifetime lock,
not the database clock, excludes replacements. The old per-command execution
advisory lock is not held by singleton commands. Normal transactional ordering of
command claims and account freezes is retained.

The five-second heartbeat reports liveness and reads operator drain state. After
60 seconds without a heartbeat, health reports not-ready, but ownership is not
transferred. A failed database operation has a 10-second bound and pauses work;
there is no periodic lease-deadline watchdog. After restart or settled-error
recovery, a fresh generation marks old running commands uncertain, never blindly
replays them. Legacy lease acquisition remains for migration compatibility and
cannot take over a supervised singleton.

With billing authority disabled, the existing legacy path is unchanged. Enabled
authority requires the separate service; do not disable authority to compensate
for a missing executor. Process-local PGlite is not supported by the separate
executor; use shared PostgreSQL. Non-systemd Launchpad installations must supervise
the same `--billing-worker` command with a lifetime exclusive lock and set
`COCALC_BILLING_SINGLETON_LOCKED=1` only in that locked process.

## Deployment and rollback

1. Build workspace dependencies and the hub package. For a fresh checkout use
   `pnpm -C src build:dev`; the compact release builder is
   `src/packages/rocket/bay/build-hub-bundle.sh`. It includes the new service and
   launcher through the existing scaffold packaging.
2. On an existing busy bay, run `src/scripts/bay-systemd/optimize-bay-indexes.sql`
   with `psql -v ON_ERROR_STOP=1`, without a transaction wrapper, before normal
   schema migration. Index creation is concurrent. Verify validity; after an
   interrupted build, drop only the invalid index concurrently and rerun.
3. Drain billing via the existing operator API and wait for active work to finish.
   Roll hub workers to the new release. The hub-only/full upgrade paths restart
   the singleton after rolling workers; static-only updates do not restart it.
4. Resume billing and verify authority health, a non-mutating billing command,
   queue progress, and ordinary hub calls. Check that the executor PID is separate
   from hub PIDs. Monitor event-loop lag, request rejection counts, and query plans.
5. To roll back, drain and stop the singleton before restoring hub-embedded
   billing. Confirm its ownership row has been released. If it crashed while
   drained, resume/restart this version first to reconcile the previous generation,
   then drain and stop cleanly. Do not simply start legacy contenders against an
   unreleased singleton row. Keep the indexes: they are compatible with older
   code. Do not replay uncertain payment commands without reconciliation.

No production settings, databases, services, or running projects are changed by
creating this PR. The review is advisory; review feedback requires maintainer
discussion before follow-up edits.
