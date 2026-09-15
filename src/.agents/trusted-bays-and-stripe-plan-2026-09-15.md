# Trusted Bays And Stripe: Bounded Implementation Plan

Status: proposal for review, not authorization to implement or deploy.

This replaces the implementation approach in
`multibay-identity-and-billing-plan-2026-09-14.md` if approved. Preserve that
document and `/home/user/cocalc-bay-identities` as historical/reference work,
including its uncommitted changes. Do not continue implementing its threat model.
Do not claim that its acceptance criteria have been met.

## 1. Decision And Business Purpose

CoCalc hubs are trusted components of one application, distributed for capacity.
A compromised hub is a site-level incident. We do not attempt to contain an
actively malicious hub through independently authorized application RPCs.

Separate three objectives:

1. Identify individual bays and rotate/revoke their credentials reliably.
2. Preserve the existing billing authority's ordering, idempotency, recovery,
   and financial invariants.
3. Keep Stripe secrets and provider operations on the billing hub to reduce
   accidental exposure and prevent unintended duplicate executors.

The first and third are primarily operational hardening/least privilege. The
second is correctness: duplicate charges, competing reservations, and ambiguous
provider results matter even when every server is honest.

None of this should become an indefinite prerequisite for Manchester. Production
is currently single-bay according to the maintainer. Existing single-bay billing
and course-sponsored compute can be tested/reviewed independently. This plan
does not assert that sponsorship is already release-ready.

## 2. Explicit Security Model

Trusted: enrolled hubs, the seed, fabric/router infrastructure, operators, and
their private databases. Trusted hubs may attest authenticated actors and perform
internal application operations. Attribution identifies the credential used,
not an incorruptible human actor after hub compromise.

Untrusted: browsers, unauthenticated clients, students, notebook contents,
project processes, and project-host principals. They must not receive hub
credentials or access hub-only RPC merely by supplying a bay ID or actor ID.
Project hosts retain their existing scoped permissions; they are not promoted
to trusted hubs by this plan.

Required protections:

- Authenticate the connection; derive bay identity from its credential, never
  from a client-supplied label alone. Encrypt traffic outside trusted loopback.
- Preserve public API authorization, account/project access checks, fresh-auth
  requirements, input validation, rate limits, and safe error handling.
- Keep hub credentials out of user projects, browser assets, logs, and ordinary
  configuration responses. Audit the secret-setting replication path explicitly.
- Use server-selected billing handlers and existing classified operations,
  never user-selected modules, executable code, SQL, or arbitrary Stripe calls.
- Revocation rejects new connections and disconnects existing ones. Suspected
  compromise additionally requires network isolation and a site-wide incident
  response; credential revocation is not proof the incident is contained.

Explicitly not promised: protection of other hubs or money from a malicious
enrolled hub; independent financial approval in a browser controlled by that
hub; trustworthy resource metering from a compromised component; automatic
recovery from malicious database rollback. Do not add signed per-method actor
delegations, independent authorization proofs, or a new certificate authority.

## 3. Recommended Scope Reduction: Seed-Homed Accounts

Proposed first supported topology:

- All accounts, account sessions, membership, and financial records stay on the
  seed. Account creation always chooses the seed.
- Projects and project hosts may belong to attached bays; existing ownership
  routing remains in use. Project data stays on project hosts.
- Account rehome to an attached bay is rejected server-side, including operator
  and background callers. Do not merely hide the UI option.
- Stripe API work, payment webhooks, billing workers, and the financial journal
  run on the seed. Resource bays send existing application requests/metering to
  it over authenticated trusted-hub transport.

Why: this aligns the existing account-local billing tables with the financial
executor without extracting mixed account fields or migrating account-home
financial state. It avoids the largest unfinished part of the previous plan.

Tradeoff: account/control-plane traffic is not horizontally sharded yet. This is
not the final large-scale account architecture. Measure seed load before choosing
when to implement account sharding; low financial volume alone does not prove
the seed can support all account traffic.

This topology needs explicit maintainer approval. If accounts must be distributed
now, stop and estimate central financial storage separately. Do not smuggle that
migration into a credential PR, proxy arbitrary database access, or copy entire
account rows into a second database.

## 4. PR 1: Distinct Credentials, Same Trusted Application

### Mechanism

Prefer an opaque random per-bay credential over a new signing/enrollment protocol.
Generate 32 random bytes; store a digest in the seed registry and the raw secret
only in the destination bay's restricted local configuration (0600 file or the
existing secret mechanism). Record cluster ID, bay ID, credential ID, creation
time, expiration if used, and revocation time. Seed credentials are also distinct.

Reuse the existing authenticated Conat connection/principal and routing layers.
Choose the exact credential header/cookie after checking existing handshake code;
it must not reuse a browser session or make a bay token a general HTTP admin key.
Trust the fabric to carry authenticated source identity between routers. No new
end-to-end signature envelope is required under this model.

### Implementation Steps

1. Inventory actual hub/fabric/router authentication consumers and project-host
   subjects before editing. Identify which connections need a hub credential.
2. Add registry lookup and a bay principal to the existing handshake. Unknown,
   revoked, wrong-cluster, and malformed credentials fail closed. User and host
   principals cannot subscribe/publish on internal hub-only subjects.
3. Bind service registration to the addressed bay (and global services to seed).
   Keep reply subscriptions scoped using existing transport facilities. Ordinary
   authenticated hubs remain trusted callers; no hundreds-of-method policy audit.
4. Update local and systemd launch scripts to provision distinct credentials.
   Operators provision through local trusted tooling, not a public enrollment API.
   Validate IDs, restrict file permissions, redact output, and avoid copying the
   seed's shared password into attached configuration.
5. Provide issue, list-metadata, rotate, and revoke operator commands. Rotation:
   issue replacement, install/reconnect the chosen bay, verify identity, then
   revoke old credential. Interrupted rotation is retryable; operator chooses
   when to revoke, with no hidden grace period.
6. Make live revocation effective by disconnecting matching authenticated
   connections and invalidating authentication caches. Test the actual fabric
   path, not just the registry helper. If remote routers cache trust, use bounded
   revalidation and document/test the maximum revocation delay.
7. Include authenticated source bay/credential ID in operational logs without
   logging credential values. One-bay startup remains supported.

### Done Means

Three real dev hubs start with distinct credentials; cross-bay project access and
host control work; forged identity labels do not change attribution; project/user
credentials cannot access hub services; rotating one bay leaves the others up;
revoking a connected bay stops its access within the documented bound; restart
does not restore revoked access. Test both deployed transport modes if both remain
supported. No global per-method permission rewrite is part of this PR.

## 5. PR 2: Seed-Only Billing For The Restricted Topology

This is not a generic Stripe HTTP proxy. Routing Stripe calls alone would leave
ledger updates, retries, and fulfillment distributed and would not establish the
intended correctness boundary.

### Inventory Before Edits

Produce a compact caller checklist with destination and test for:

- Public purchase/payment-method/setup/checkout/customer-session paths.
- Subscriptions, automatic collection, refunds, commercial/admin operations.
- Stripe webhooks, fulfillment, scheduled billing and reconciliation workers.
- Resource spending admission, usage delivery, sponsorship settlement/cleanup.
- Stripe secret settings, environment/config generation, legacy SDK clients.

Inspect actual runtime consumers, not just imports. Browser publishable keys are
not secret; account-scoped customer-session secrets are not global API keys but
still require normal account authorization and must not be logged.

### Implementation Steps

1. Enforce seed-homed account creation and disable account rehome away from seed.
   Refuse billing activation when the directory contains an attached-home account
   or attached databases contain financial source records requiring migration.
2. Use existing account/project ownership routing for resource callers. Add only
   the missing trusted-hub billing transport, keeping the existing command
   classifier, journal, executor lease, locks, retry IDs, and uncertain outcomes.
   Select handler/lane at the receiver. No direct-execution fallback on timeout.
3. Preserve authenticated actor/session context at public ingress. Internal hub
   assertions are trusted under this model; browser-provided privilege flags are
   not. Status/cancel APIs still enforce access for the requesting user.
4. Run provider-facing workers and webhook verification on seed only. Attached
   startup must not schedule duplicate financial jobs. Route webhooks to seed;
   do not accept a browser's or project's assertion of provider verification.
5. Stop distributing global Stripe secrets, including webhook secrets, to
   attached bays. Remove legacy stored copies during dev cutover. Ensure generic
   settings retrieval/replication does not send them back. Make Stripe connection
   creation reject attached-bay execution before consulting a cached client.
6. Enable billing authority only after every required caller in the checklist is
   routed. Test actual course sponsorship against this topology; retain student
   VM ownership and resource-bay lifecycle while the seed owns payer accounting.

### Done Means

An instructor on seed funds a student allowance; the student uses a project and
small disposable VM assigned to an attached resource bay; the seed records the
correct payer; both users see spending; exhaustion and storage cleanup work.
Existing test-mode card purchase, payment-method flow, refund, webhook retry, and
one scheduled billing path also pass. Direct attached Stripe access fails; current
attached config/database/settings responses contain no global Stripe secrets.

Lost replies and executor restart do not duplicate effects. Concurrent spending
cannot use the same funds twice. Seed unavailability prevents new financial
admission without losing already-running resource measurements or cleanup work.
Use existing real-PostgreSQL concurrency suites plus targeted integration tests.

Do not claim Stripe secret confinement prevents a malicious trusted hub from
abusing allowed billing operations. Its value is fewer secret copies and a single
controlled implementation path.

## 6. Development Cutover And Rollback

Exactly three multibay sites exist, all disposable development deployments per
the maintainer. No valuable financial data requires a multibay migration.

1. Preserve code/worktrees and optionally export fixtures. Inventory and clean
   up real provider resources before resetting their database records.
2. Stop all dev hubs/workers. Reset multibay fixtures or explicitly rebuild them
   with every account homed on seed; keep project/host directory ownership valid.
3. Provision distinct bay credentials and seed-only Stripe test secrets. Remove
   attached legacy secret copies. Start seed/fabric, then attached bays.
4. Verify three-bay readiness and credential attribution before enabling billing.
   Run the acceptance workflows and save redacted evidence.
5. On failure, stop the cluster and restore the matching code/config/database
   snapshot together. Do not rerun ambiguous provider charges or enable legacy
   financial fallbacks to get a green demo.

Single-bay production financial history is never reset by this procedure. Its
existing auth and billing regression tests must pass. No production deployment or
real-customer sponsorship activation is authorized by this plan.

## 7. Scope And Execution Controls

- Start a clean branch from current reviewed code, not the large identity branch.
  Reuse small proven pieces only after checking they fit this trust model.
- First milestone is three hubs booting with attributable credentials. Finish
  PR 1 before beginning broad billing edits; PR 2 depends on it.
- Do not add account/financial field extraction, general account rehome, a new
  financial ledger, a custom PKI, signed per-call delegation, independent browser
  approval, or compromised-hub containment.
- If a step requires touching hundreds of methods or moving financial tables
  between databases, return for a scope decision. That violates this proposal.
- Commit connected increments and report actual workflows. Do not count helper
  tests as substitutes for a booting cluster. Review both PRs before release.
- Do not promise an implementation duration until the consumer inventory confirms
  the topology restriction removes the existing cross-home dependencies.

## 8. What Can Be Deferred?

For the immediate single-bay Manchester release, neither distinct multibay
credentials nor multibay billing transport is inherently required. Prioritize
the existing billing correctness work and sponsorship end-to-end review there.
Use this project when multibay development/rollout is worth its opportunity cost.

Approval requested: trusted-hub model (already agreed); seed-homed accounts for
this release (new); two bounded PRs above rather than global financial extraction;
and whether to do them now or after the single-bay sponsorship pilot.
