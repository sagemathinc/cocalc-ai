# Trusted Bays And Stripe: Minimal Implementation Plan

Status: maintainer-approved scope and trust model; this document describes work
to implement, not completed work or authorization to deploy to production.

This supersedes the implementation approach and malicious-hub containment goals
in `multibay-identity-and-billing-plan-2026-09-14.md`. Preserve that document and
`/home/user/cocalc-bay-identities`, including uncommitted work, as references.
Do not import that project's unfinished requirements into this plan.

## 1. Purpose And Assumptions

Multibay exists for one reason: **horizontal scaling to more simultaneous active
users and projects**. Hubs may all run in one zone on operator-controlled VMs.
This is not federation, tenant isolation, geographic distribution, high
availability, or a new security architecture.

Required outcome:

1. Distinct bay credentials for reliable attribution and rotation one bay at a
   time, without rotating the whole cluster.
2. Accounts remain sharded across home bays. Financial operations and their
   authoritative data go to the seed; other account/project behavior stays put.
3. Only the seed receives global Stripe secrets and runs Stripe operations.

**There are no non-development multibay deployments. Exactly three dev-only
sites exist, with no real data that needs preserving.** Offline reset/recreation
is acceptable. Do not build a production multibay migration, legacy-secret
cleanup framework, or online compatibility rollout. Existing single-bay
production data is different and must remain intact.

Credential separation and fewer Stripe secret copies are operational hygiene.
Billing ordering, transactions, idempotency, and recovery are correctness
requirements even when every hub is honest. Both can be implemented without
defending against a malicious enrolled hub.

## 2. Trust Boundary

- Hubs, seed, fabric/router infrastructure, operators, and private databases are
  trusted parts of one application. A hub may attest authenticated actor/session
  context to another hub. Derive source bay identity from its credential.
- Browsers, project processes, notebook content, and project-host principals do
  not acquire hub authority. Preserve their existing authentication, resource
  scopes, API authorization, input validation, and fresh-auth requirements.
- Never promote browser-provided actor/admin flags into trusted internal context.
  Once a hub has authenticated/authorized the request, other hubs trust that
  context; they do not demand independently signed proof of every user action.
- Keep hub secrets out of projects, browser assets, ordinary responses, and logs.
  Use the existing protected transport, with TLS outside trusted loopback.
- An operator distrusting a bay removes/disconnects it, revokes its credential,
  and performs a full audit/reinstall. Hub compromise is a site-level incident;
  per-bay revocation or seed-only Stripe keys do not promise containment.

No custom PKI, per-method delegation signatures, independent approval origin, or
general-purpose authorization framework is needed.

## 3. Ownership: Keep Account Sharding

| Owner            | State and work                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account home bay | Sessions, passwords/MFA, ordinary account profile, user-facing control connections and projections.                                                                                                                |
| Project/host bay | Project access and lifecycle, host/VM management, raw resource usage and its delivery.                                                                                                                             |
| Seed             | Financial account fields, Stripe customer mappings/settings, purchases/balances/holds, subscription and purchased-entitlement source records, sponsorship accounting, transfers, billing journal/workers/webhooks. |

Only financial calls and required financial data move. Files, terminals,
notebooks, and other project traffic keep their existing paths. Ordinary account
traffic must not start passing through the seed. Do not force account creation
onto the seed or disable account sharding/rehome to simplify billing.

The request path is: user -> home hub's existing API authorization -> trusted
internal billing call -> seed's existing executor/database -> result. Financial
queries also go to seed; display caches and entitlement projections may stay at
the account home, but are not authoritative balances or permission to spend.

## 4. PR 1: Simple Per-Bay Credentials

Reuse existing Conat authentication, principal handling, and routing. Use opaque
random credentials, not a new signing/enrollment protocol.

1. Store a per-bay credential registry at the seed: cluster ID, bay ID, credential
   ID, secret digest, creation/revocation times. Generate 32 random bytes per
   secret; install raw credentials only in the owning hub's restricted local
   configuration. The seed has its own credential too.
2. Authenticate hub connections with these credentials and attach the verified
   bay/credential identity to requests and logs. A claimed bay ID cannot override
   the authenticated one. Keep the existing hub-only service boundary; user and
   project-host credentials must not gain access. No shared hub-password fallback
   for multibay fabric connections.
3. Preserve destination routing and existing service/reply scoping. Trusted hubs
   may invoke existing internal application APIs; do not add hundreds of method
   policies. A bay token is not a browser session or generic public admin token.
4. Add small operator tooling to issue/list metadata/rotate/revoke. Rotation is
   issue replacement -> install/reconnect that bay -> verify -> revoke old key.
   An interrupted rotation can be resumed. Provision via trusted local tooling,
   not a new public enrollment service.
5. Revocation rejects reconnects and closes existing matching connections;
   invalidate credential caches. Check this through the actual fabric/router
   path and document any bounded propagation delay. No cluster-wide restart is
   required for routine rotation.
6. Update existing local-dev and systemd launch scripts to provision distinct
   credentials securely. Keep single-bay behavior working. Do not redesign
   deployment orchestration, account creation, or account rehome.

**Acceptance on lite2b:** three real hubs boot; accounts on both attached bays
sign in and access projects across bays; source attribution is correct; invalid
or revoked tokens and non-hub principals cannot access hub services. Rotate one
bay while the others stay connected; revoke its old live connection and verify
the old key cannot reconnect after restart. Exercise supported RPC transports.

## 5. PR 2: Seed Billing And Stripe, Not Seed Accounts

### Route Existing Operations

Use `server/purchases/billing-authority/client.ts` and its existing typed
protocol/dispatcher. Replace the attached-bay transport rejection with a hub-only
Conat call to seed; seed and standalone execution remain local. Do not build a
second executor or a generic Stripe/SQL proxy.

Keep command IDs stable across routing retries and status/cancel calls. Reuse the
existing classifier, journal, lease, transaction locks, fresh-auth checks, and
uncertain-provider-result handling. Forward authenticated hub context, not raw
user privilege claims. Status/results still require the requesting user's access.
No attached execution fallback when seed is unavailable.

### Centralize Only Financial Dependencies

Make one compact checklist of existing billing callers, their table/field
dependencies, and the corresponding integration test. Include purchases and
balances, customer/payment/setup/checkout flows, subscriptions/entitlements,
refunds, collections, admin/commercial operations, webhooks/workers, and the
existing sponsorship admission/settlement/transfer/cleanup paths.

- Store financial source records at seed, keyed by the existing account UUID.
  Extract only billing fields currently embedded in `accounts` into a small
  billing-account record, such as Stripe customer IDs and collection settings.
  Do not copy entire accounts, passwords, or MFA data to satisfy billing joins.
- Fix local database assumptions in those callers, including balance writes,
  foreign keys, account-status reads, and transaction scopes. Fetch ordinary
  profile/security facts through existing home-bay APIs where needed. Keep ledger
  transactions local to seed; do not introduce distributed database transactions.
- Keep account-home balance/entitlement displays updated using existing response
  or projection mechanisms. Admission uses seed financial state, never a stale
  display. Seed failure must not turn an unavailable balance into zero/free data.
- Financial workers and provider fulfillment run only at seed. Resource bays
  retain lifecycle control and deliver usage/cleanup results with stable retry
  IDs using existing mechanisms. Preserve reservation, spending-limit, and cleanup
  behavior; this is integration of sponsorship, not a rewrite of that product.
- Financial records no longer move during account rehome. Update only affected
  ownership metadata, export/import lists, and backup coverage. Home-bay deletion
  or suspension must still reach existing financial fences; do not redesign the
  account lifecycle.

Single-bay uses the same database and local call path. Any new billing-field
extraction there needs a lossless, idempotent backfill preserving customer IDs,
balances, and pending operation identities. Multibay development fixtures can be
reset instead of migrated.

### Keep Stripe Secrets On Seed

Exclude global Stripe API and webhook secrets from admin-settings replication
and attached-hub settings responses; keep the publishable key available. Do not
copy these secrets through launch scripts or environment generation. This is a
small settings filter with focused tests, not a general secret-service project.

Route existing provider callers before removing their key access. Reject direct
Stripe SDK use on attached bays, including cached clients. Route Stripe webhooks
to seed and keep provider verification there. No custom cryptographic approval
scheme is required. Seed-only secrets reduce copies, not malicious-hub authority.

### Acceptance On lite2b

- Instructor and student have different attached home bays; project/VM ownership
  can be on another bay. Sign-in and ordinary account traffic remain home-routed.
- Stripe test purchase, customer/payment-method flow, refund, webhook retry, and
  a scheduled billing job work via seed. Attached settings/config have no global
  Stripe secrets; direct attached Stripe calls fail. Single-bay regression tests
  preserve the same financial results without remote routing.
- Existing course allocation -> student funding selection -> small real managed
  VM -> correct payer -> spend display -> exhaustion/shutdown/storage cleanup
  works. Account rehome does not move or duplicate money/provider history.
- Real-PostgreSQL concurrent spending/transfer tests conserve funds. Lost replies
  and executor restart do not double-charge. Seed outage denies new financial
  admission while retryable metering and cleanup are retained, not discarded.

## 6. Cutover And Limits

Implement as two reviewable PRs from current working code; select small useful
pieces from the experimental branch, do not wholesale import it. First get PR 1
booting three hubs, then connect PR 2 through actual callers. No runtime changes
are made by updating this plan.

For each of the three disposable dev sites: stop hubs/workers, reset/recreate
affected local fixtures/config, issue distinct credentials, configure Stripe
test secrets only on seed, and restart. Recreate accounts on multiple home bays.
No valuable multibay data exists to migrate or preserve; optional fixture export
is a convenience. Clean up real cloud resources before discarding their records.
On failure, restore matching dev code/config/data together or recreate fixtures;
do not replay uncertain Stripe operations. Never reset single-bay production.

Out of scope: federation, geographic routing, high availability, malicious-hub
containment, a new ledger, a new authorization system, production multibay
migration, or centralizing ordinary account state. Central financial dependencies
are in scope; unrelated RPC/lifecycle rewrites are not. If such a rewrite appears
necessary, report the specific dependency before expanding this plan.

Completion requires the connected workflows above, focused regressions, and
review of both PRs, not an isolated helper-test count. Do not promise that all
billing integration fits in the settings filter's size. No production deployment
or real-customer sponsorship activation is authorized here.
