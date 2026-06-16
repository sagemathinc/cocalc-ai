# Site-License Token Authority Plan

Date: 2026-06-15

Status: implementation plan for CUP and future external site-license claim
integrations

## Context

Cambridge University Press needs a way to give paying readers temporary CoCalc
membership access without requiring those readers to have a CUP email address,
SSO affiliation, or pre-created CoCalc account. The migration plan in
`cocalc-com-shutdown-migration-plan-2026-06-11.md` recommends replacing the old
secret-URL CUP flow with signed site-license claim tokens.

This should be a generic CoCalc primitive:

- External authorities can mint signed, scoped, expiring, one-time claim tokens.
- CoCalc verifies those tokens against a site-license claim pool.
- Successful claims assign a normal membership package seat to the signed-in
  account.
- All consumption and rejection is auditable.

### Application -- instructor memberships

- We would like to provide an easy way to sponsor very generous memberships for
  instructors, with minimal friction and an easy UI so we admins can see what is
  going on.
- We could create a site license with a couple of pools for different types of
  instructor needs, then provide a claim token for "6 months" to a particular
  instructor and specific membership from that pool.
  - It's then easy for us to see these all listed.
  - We can see which admin made the grant.
  - It expires at a clear time.
  - It's just sending the instructor a URL to click on.
  - It's flexible.
  - This is better than admin assigned memberships, since there's a central list
    of usage, it expires, and we only have to send a URL, rather than look up
    possibly the wrong account.
- Admin-created instructor claim tokens should record the admin actor, intended
  recipient email or label, pool, membership class, and expiration. The intended
  recipient is audit context by default, not a cryptographic restriction, unless
  a later pool policy explicitly requires matching an email identity.

## Goals

- Support CUP as the first customer without building CUP-specific entitlement
  logic.
- Let an external authority mint tokens offline or from its own backend.
- Use existing site licenses and membership packages as the entitlement
  primitive.
- Enforce one-time use with durable, transactionally checked `jti` consumption.
- Fully support the multibay architecture.
- Provide enough admin and CLI visibility for support to debug claims without
  direct database access.

## Non-Goals

- Do not recreate the legacy cocalc.com license or voucher system.
- Do not require an authenticated CUP-to-CoCalc API just to mint claims.
- Do not make token claims the source of membership truth after consumption.
  The resulting membership package assignment/grant remains the source of
  access.
- Do not make rootfs discovery depend on token claims. Tokens may carry
  `rootfs_id` as context, but rootfs content delivery is a separate subsystem.

## Authority Model

Site-license and rootfs catalog state are seed-global in the current table
ownership model. Token authority state should therefore also be seed-global:

- The seed bay is authoritative for site licenses, external claim pools, public
  keys, consumed `jti` values, and claim audit rows.
- Non-seed bays must route claim verification/consumption to the seed authority
  rather than writing local copies.
- Successful consumption may need account-home side effects because the target
  membership grant belongs to the signed-in account.
- The claim RPC must explicitly route through the same inter-bay membership
  APIs used by normal site-license package assignment flows.

The key invariant is:

- One transaction at the seed authority decides whether a token is valid and
  whether its one-time `jti` is consumed.
- Account-home membership side effects must be idempotent and traceable back to
  that seed-global claim consumption row.
- The seed consumption row is the durable recovery point for any failure between
  token consumption and account-home membership grant creation.

Important ownership constraint:

- `site_licenses` and claim authority tables are seed-global, but
  `membership_packages`, `membership_package_assignments`, and
  `membership_grants` are account-home tables in the current ownership model.
- Therefore, "consume token" and "create account-home grant" cannot be one
  literal cross-bay SQL transaction. The implementation must use a seed-global
  claim consumption state machine plus idempotent account-home side effects.

## Token Format

Use a compact signed JWS/JWT-like token. Prefer an existing JOSE implementation
if already present in the tree; otherwise add a small, well-maintained JOSE
dependency rather than implementing signature parsing by hand.

Required claims:

- `iss`: external issuer id, e.g. `cambridge-university-press`.
- `aud`: exactly `cocalc.ai.site-license-claim`.
- `site_license_id`: target CoCalc site license.
- `pool_id`: external claim pool id.
- `jti`: unique one-time token id within the pool.
- `exp`: expiration timestamp.

Optional claims:

- `iat`: issued-at timestamp. Recommended for debugging publisher clock drift.
- `nbf`: not-before timestamp.
- `membership_class`: override only if allowed by the pool.
- `membership_expires_at`: override only if allowed by the pool.
- `rootfs_id`: landing/content context for the rootfs discovery subsystem.
- `label`: human-readable publisher/publication label.
- `subject`: external customer/order/subscription reference.
- `metadata`: small JSON object for audit/debugging, size-limited and sanitized.

Header requirements:

- `kid`: public key id for key lookup.
- `alg`: allowed algorithm for the pool/key.

Recommended initial algorithms:

- EdDSA/Ed25519 if supported by the chosen JOSE implementation.
- ES256 as fallback if EdDSA support is awkward.

Avoid symmetric shared-secret tokens. They are easier to leak and harder to
rotate safely across publisher infrastructure.

## Data Model

Add formal schema entries, not ad-hoc hidden tables.

### `site_license_external_claim_pools`

Seed-global table.

Suggested columns:

- `id UUID PRIMARY KEY`
- `slug TEXT`
- `site_license_id UUID NOT NULL`
- `package_id UUID NOT NULL`
- `name TEXT NOT NULL`
- `issuer TEXT NOT NULL`
- `audience TEXT NOT NULL DEFAULT 'cocalc.ai.site-license-claim'`
- `default_membership_class TEXT`
- `allow_membership_class_override BOOLEAN NOT NULL DEFAULT false`
- `default_membership_duration_days INTEGER`
- `default_membership_expires_at TIMESTAMPTZ`
- `allow_membership_expires_at_override BOOLEAN NOT NULL DEFAULT false`
- `min_membership_duration_days INTEGER`
- `max_membership_duration_days INTEGER`
- `max_membership_expires_at TIMESTAMPTZ`
- `default_rootfs_id TEXT`
- `max_claims INTEGER`
- `max_claims_per_account INTEGER`
- `starts_at TIMESTAMPTZ`
- `expires_at TIMESTAMPTZ`
- `disabled_at TIMESTAMPTZ`
- `metadata JSONB`
- `created_by_account_id UUID`
- `created TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Indexes:

- `site_license_id`
- `package_id`
- `issuer`
- Unique `(site_license_id, issuer, slug)` when `slug IS NOT NULL`.
- `disabled_at`
- `expires_at`

Slug rules:

- `id` remains the internal primary key.
- `slug` is optional but should be supported for publisher/admin ergonomics.
- Validate slugs using the same conservative naming style as
  `src/packages/util/db-schema/name-rules.ts`; no UUID-looking slugs, no
  reserved names, no path-like strings.

Expiry override rules:

- Publisher-provided `membership_expires_at` should be allowed when the pool
  enables it, but must still be bounded by pool policy.
- Initial policy can be simple: if `max_membership_duration_days` or
  `max_membership_expires_at` is set, the token override must not exceed it.
- This preserves CUP and instructor-grant flexibility while keeping the pool as
  the operator-defined safety envelope.

### `site_license_external_claim_keys`

Seed-global table.

Suggested columns:

- `id UUID PRIMARY KEY`
- `pool_id UUID NOT NULL`
- `kid TEXT NOT NULL`
- `alg TEXT NOT NULL`
- `public_key_jwk JSONB`
- `public_key_pem TEXT`
- `starts_at TIMESTAMPTZ`
- `expires_at TIMESTAMPTZ`
- `revoked_at TIMESTAMPTZ`
- `created_by_account_id UUID`
- `metadata JSONB`
- `created TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints:

- Unique `(pool_id, kid)`.
- Exactly one public key representation should be present.

### `site_license_external_claim_consumptions`

Seed-global table.

Suggested columns:

- `id UUID PRIMARY KEY`
- `pool_id UUID NOT NULL`
- `site_license_id UUID NOT NULL`
- `package_id UUID NOT NULL`
- `jti TEXT NOT NULL`
- `token_hash TEXT NOT NULL`
- `issuer TEXT NOT NULL`
- `kid TEXT`
- `account_id UUID NOT NULL`
- `status TEXT NOT NULL`
- `side_effect_key TEXT NOT NULL`
- `assignment_id UUID`
- `membership_grant_id UUID`
- `membership_class TEXT NOT NULL`
- `membership_expires_at TIMESTAMPTZ`
- `rootfs_id TEXT`
- `external_subject TEXT`
- `token_expires_at TIMESTAMPTZ`
- `error_code TEXT`
- `error_message TEXT`
- `retry_count INTEGER NOT NULL DEFAULT 0`
- `last_retry_at TIMESTAMPTZ`
- `metadata JSONB`
- `consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints:

- Unique `(pool_id, jti)`.
- Unique `token_hash` as a defense-in-depth duplicate detector.
- Unique `side_effect_key`.

Consumption status values:

- `pending-side-effect`: token and `jti` are valid and consumed, but the
  account-home membership side effect has not been confirmed.
- `granted`: account-home membership grant or package assignment was created or
  found idempotently.
- `failed-retryable`: token is consumed, but grant side effects failed in a way
  a worker or retry can safely reattempt.
- `failed-terminal`: token is consumed and cannot be completed automatically.
  This should be rare and must be visible to support/admin tooling.

Idempotency requirements:

- `side_effect_key` should be deterministic from the consumption row, e.g.
  `site-license-external-claim:<consumption_id>`.
- Account-home grant or assignment creation must store this key in metadata or
  another queryable field so retries can find the existing side effect instead
  of creating duplicates.
- A browser retry after a timeout must return the existing `granted` result if
  the same token was already consumed for the same account.

### Claim Failure Visibility

Use `site_license_audit_log` for failures if its metadata is sufficient. If the
failure volume becomes noisy, add `site_license_external_claim_attempts` later.

Failure audit metadata should include:

- failure code
- pool id if parsed
- site license id if parsed
- `kid` if parsed
- token hash, never raw token
- signed-in account id if available
- user-visible message category

Token hash rules:

- Never store the raw token.
- Prefer HMAC-SHA-256 with a server-side secret over plain SHA-256. The token is
  already signed and high entropy in normal use, but HMAC avoids offline
  correlation if logs or audit rows leak.

## Consumption Flow

1. User opens a CoCalc claim URL with a token.
2. If not signed in, CoCalc stores the token in a short-lived browser/session
   location and sends the user through sign-in/sign-up.
3. After sign-in, the browser calls a seed-routed claim RPC.
4. Server parses the token without trusting it enough to identify
   `pool_id`, `kid`, and `site_license_id`.
5. Server loads the active pool and key from seed-global state.
6. Server verifies signature, audience, issuer, `nbf`, and `exp`.
7. Server starts a seed-global transaction.
8. Transaction locks the pool/package rows needed for seat/limit enforcement.
9. Transaction inserts `(pool_id, jti)` into
   `site_license_external_claim_consumptions`; unique violation means already
   consumed.
10. Transaction records status `pending-side-effect`, deterministic
    `side_effect_key`, requested membership class/expiration, and sanitized
    token metadata.
11. Transaction writes a `site_license_audit_log` success event for token
    consumption.
12. Server performs or enqueues the account-home membership side effect using
    the existing membership package/grant APIs.
13. Side-effect code idempotently creates or finds the package assignment and
    membership grant, then updates the seed consumption row to `granted`.
14. Server returns a structured result with the granted membership and optional
    `rootfs_id` context.

Any failure after `jti` consumption but before account-home side effects must be
recoverable from the consumption row. A retry must not consume a second seat or
create a second grant.

If the account-home side effect cannot complete during the claim request:

- Mark the consumption `failed-retryable` when the error is transient.
- Return a structured "claim accepted, grant pending" response only if the UI can
  represent that state clearly.
- Otherwise retry synchronously a small bounded number of times, then surface a
  supportable error that includes a claim reference, never the raw token.
- Background repair tooling should retry `pending-side-effect` and
  `failed-retryable` rows.

## User Experience

Claim page states:

- Loading/validating token.
- Sign in or create account to claim.
- Token expired.
- Token already used.
- Token not valid for this site.
- Site license or pool disabled.
- Seat limit reached.
- Claim successful.

After success:

- Show the organization/publisher name.
- Show membership class and expiration.
- If the token or pool includes `rootfs_id`, offer to continue to the related
  rootfs landing page or create-project flow.

Do not show cryptographic details to ordinary users.

## Admin and CLI Surface

Admin UI should allow:

- Create/edit/disable external claim pools.
- Attach a pool to a site license membership package.
- Add/revoke public keys.
- View consumed claims.
- View failed claim audit events.
- Export a pool summary for the external publisher.
- Generate a sample token locally for testing when CoCalc owns the private key
  during setup.

CLI should support machine-readable operations:

- `cocalc site-license claim-pool list --site-license <id> --json`
- `cocalc site-license claim-pool create ... --json`
- `cocalc site-license claim-pool disable <pool-id>`
- `cocalc site-license claim-key add <pool-id> --jwk <file>`
- `cocalc site-license claim-key revoke <pool-id> <kid>`
- `cocalc site-license claim consumed <pool-id> --json`
- `cocalc site-license claim sample-token <pool-id> ...`

The exact command names can evolve, but operator access must not require direct
SQL.

## Security Requirements

- Never log raw tokens.
- Store only token hashes and parsed, sanitized fields.
- Hard-limit token size and metadata size.
- Require exact audience match.
- Require active pool and active key.
- Enforce token expiration and optional not-before.
- Enforce pool/site-license/package active windows.
- Enforce seed-global claim limits inside the same transaction that consumes
  `jti`.
- Enforce account-home package/grant idempotency with `side_effect_key` because
  package/grant rows may live on the account home bay.
- Support key revocation and pool disablement.
- Rate-limit failed claim attempts by IP, session, signed-in account, and token
  hash where practical.
- Use structured user-facing errors; do not expose stack traces or raw JOSE
  parse errors.

## Multibay Requirements

- All claim-pool, key, consumption, and site-license audit writes route to the
  seed authority.
- Account membership grants/projections must be delivered to the account home
  bay through existing membership side-effect mechanisms.
- The claim RPC must be safe when the browser is connected to a non-seed home
  bay.
- Claim success must be idempotent if the browser retries after a timeout.
- Claim repair must be possible from seed-global consumption rows even if the
  original non-seed caller disconnects or the account-home side effect times
  out.
- Tests should include seed-bay and non-seed caller paths, even if the test
  harness initially simulates routing.

## Relationship To Rootfs Discovery

Token authority may expose `rootfs_id` as optional context. It should not:

- Load rootfs content manifests.
- Decide what files are in the rootfs.
- Create projects directly.
- Depend on the Rootfs flyout implementation.

The rootfs landing page may call token redemption as part of a combined CUP
flow, but it should treat token redemption as an external entitlement step.

## Implementation Phases

### Phase 1: Schema and Server Primitive

- Add seed-global schema entries and table ownership metadata.
- Add server helpers for pool/key lookup and token verification.
- Add transactional consumption with unique `jti` enforcement and the
  consumption status state machine.
- Reuse existing membership package assignment/grant logic where possible, but
  make the account-home side effect idempotent using `side_effect_key`.
- Add audit event actions for consumed/rejected external claims.
- Add focused server tests for token validation, replay prevention, expiration,
  disabled pools, revoked keys, seat limits, side-effect retry, and browser
  retry after timeout.

### Phase 2: Claim Page and RPC

- Add browser-to-hub RPC for claiming a token.
- Add public claim page that survives sign-in/sign-up redirects.
- Add user-facing success/failure states.
- Add structured error codes.
- Add tests for anonymous-to-signed-in flow at the component/API boundary.

### Phase 3: Admin and CLI

- Add admin UI for pools, keys, consumption, and failures.
- Add CLI commands for operators and publisher setup.
- Add sample token generator for CUP onboarding.
- Add docs for publishers explaining token fields and key rotation.

### Phase 4: CUP Pilot

- Create a CUP site license and external claim pool.
- Configure one test rootfs/content landing context.
- Generate sample CUP tokens.
- Exercise sign-up, sign-in, replay, expiry, disabled-pool, and seat-exhaustion
  paths.
- Produce a support runbook before real customer tokens are issued.

## Acceptance Criteria

- A signed CUP-style token grants exactly one site-license membership seat to a
  signed-in account.
- Reusing the same token fails without assigning another seat.
- Expired, future, wrong-audience, wrong-issuer, disabled-pool, revoked-key,
  and seat-exhausted tokens produce clear user-facing errors and audit rows.
- Claiming from a non-seed home bay routes correctly to seed authority and
  updates account-home membership state.
- Retrying a claim after seed consumption but before/after account-home side
  effects does not consume another token, assign another seat, or create a
  duplicate grant.
- Admin/support can identify when, why, and by whom a token was consumed.
- Admin/support can identify and retry `pending-side-effect` or
  `failed-retryable` consumptions without direct SQL.
- No raw token values are stored or logged.

## Open Decisions

- Exact JOSE library and allowed initial algorithms.
- Whether CUP or CoCalc generates the production keypair.
  - ANS: CUP generates it using cocalc-cli, then submits ONLY the public key.
    That can also be done via cocalc-cli and `cocalc auth login`.
- Whether pool ids should be UUIDs only or allow stable publisher-friendly
  slugs.
  - ANS: support UUID primary keys plus optional publisher-friendly slugs.
    `/home/user/cocalc-ai/src/packages/util/db-schema/name-rules.ts` is
    relevant.
- Whether `membership_expires_at` override should be allowed for CUP or fixed
  by pool policy.
  - ANS: allow publisher-provided `membership_expires_at`, bounded by pool
    policy. It needs to be flexible.
- Initial rate limits for failed claims.
  - Proposed initial answer: per-IP, per-session, per-account, and per-token-hash
    buckets with conservative limits; tune after CUP pilot data.
