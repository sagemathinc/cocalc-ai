# Isolated Multibay Acceptance

Run from `src/packages/server`, after the coordinated workspace build:

```sh
COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath collaborators/multibay.acceptance.test.ts collaborators/historical.acceptance.test.ts
```

The suite is opt-in, requires PostgreSQL binaries (`pg_config --bindir`, or
`COCALC_ACCEPTANCE_PG_BIN`) and the Node version supported by the host's SQLite
and persist implementation. It does not install dependencies or build packages.
The CommonJS worker deliberately loads the normal compiled workspace outputs;
the TypeScript Jest driver does not mock production modules.

## Isolation And Cleanup

Each run creates a fresh, mode-0700 temporary directory and a private PostgreSQL
cluster listening only on its Unix socket. It ignores inherited database and
site configuration. Owner, home A and home B have separate Node processes,
databases and non-superuser roles. Public database connection permission is
revoked. The host has separate local SQLite, persist and sandbox volume storage;
its configured PostgreSQL role/database do not exist.

Conat sockets bind only to loopback on allocated ports. The owner/seed hosts one
fabric broker; the host has a separate broker. Bay traffic uses real generated
bay credentials and the production hub subject policy. Human/host authentication
on the fabric uses per-run opaque fixture credentials mapped to fixed principals;
the handshake cannot supply its own identity. Human connections to the host use
real signed project-host tokens and the production host auth adapter. No allow-all
authorization callback is installed.

Only the parent/child IPC channel can seed/query fixtures and drive maintenance.
It is not exposed as a network API. The runner shuts down the host first, then
homes, then the fabric; unresponsive owned children are terminated. PostgreSQL is
stopped before removing the temporary directory. Startup failures use the same
cleanup path. No inherited PostgreSQL process or database is touched.

## Coverage And Boundaries

The scenario uses the production hub dispatcher, owner/home collaborators
handlers, SQL projection/notification workers, host human-room service, SyncDB,
filesystem journal and ingestion pipeline. It checks two authenticated humans,
idempotent concurrent sends, private personal state, transport principal
separation, owner revocation despite stale home/host caches, rejoin cutover,
notifications and revision invalidation. It asserts stopped project state and
rejects/counts hub compute-start attempts. No runner is installed.

The recovery scenario suppresses exactly one successful Conat service reply
after the unmodified human-room send handler has returned from persistence. The
real client times out; retrying the same request ID must yield one message and
one notification. It then SIGKILLs the owned host process, reopens its existing
SQLite/persist/chat volume without reseeding the project, reconnects the humans,
and checks another same-ID retry and a fresh advancing send.

Account transfer enters the production private account-local RPC using a real
bay credential. It interrupts the source after the destination durably receives
a snapshot page, checks both homes reject writes while fenced, then reconciles
the same operation over Conat. Private names, collection/follow/mute/read state,
notification cursors and notification identities must survive. Old-home writes
remain rejected, while access leases and discovery rows are rebuilt rather than
copied. Human use of the private rehome subject is explicitly rejected.

Project transfer enters the production project-control RPC and sends the bounded
collaboration prepare/page/activate protocol to a separate owner database. The
test checks the canonical initialized pointer, catalog identity/activity,
personal overlays, stale-owner fencing, notification deduplication and new sends
after cutover. This is an owning-bay metadata rehome: the host and its volume stay
in place, and compute is never started. It is not a host/volume move test.

The historical scenario seeds 1,000 timestamp-only messages in the owned fixture
volume and archives 999 of them using the real chat store. It explicitly requests
that known source, then runs the production legacy identity migration and full
relation producer. Another account's home must discover its participation outside
the summary preview, page all participants and resolve an archived typed reference.
The raw message digest must remain unchanged; assigned identities and relations
must survive host restart. Backfill must not generate notifications or start
compute. This is not a path-free census test; streaming traversal and durable
census recovery have separate backend and host/Lite adapter tests.

The human client fixture pins the first registered room identity before sending.
All retries carry that expected identity, including after host restart. It never
silently refreshes the room target after a failed operation; replacement scenarios
must explicitly supply a successor identity.

This is not a full deployment boot. It registers only required API subscriptions
and directory handlers instead of starting the entire hub and host main programs.
Membership changes are made directly in the authoritative fixture database, so
membership mutation RPCs and host metadata replication are not covered. The
fabric uses one broker, not geographically separated broker clusters. Account
favorites revision inventory uses that broker's persist service; SQL personal
and attention state is independently stored on the account homes. The account
and project rehome scenarios exercise the trusted private bay protocol, not the
operator browser API's interactive fresh-auth entry point. Account persist
portability has independent home-local directories, but the shared broker's
Favorites data is not relocated by this fixture; SQL handoff coverage does not
establish persist routing/relocation coverage.

Login/cookie issuance, automatic service startup/reconnect, production TLS/proxy
configuration, real volume/container isolation, and browser rendering still need
their separate acceptance validations. This fixture does not complete those
broader plan requirements. The adjacent SQL-only `end-to-end.integration.test.ts`
uses an explicit empty Favorites adapter; these transport tests do not.
