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
- `disabled_at`
- `expires_at`

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
- `assignment_id UUID`
- `membership_grant_id UUID`
- `membership_class TEXT NOT NULL`
- `membership_expires_at TIMESTAMPTZ`
- `rootfs_id TEXT`
- `external_subject TEXT`
- `token_expires_at TIMESTAMPTZ`
- `metadata JSONB`
- `consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints:

- Unique `(pool_id, jti)`.
- Unique `token_hash` as a defense-in-depth duplicate detector.

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
10. Transaction assigns a membership package seat or records the desired
    assignment through the existing membership package APIs.
11. Transaction writes a `site_license_audit_log` success event.
12. Account-home side effects sync the membership grant/projection.
13. Server returns a structured result with the granted membership and optional
    `rootfs_id` context.

Any failure after `jti` consumption but before account-home side effects must be
recoverable from the consumption row. A retry must not consume a second seat or
create a second grant.

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
- Enforce seat limits inside the same transaction that consumes `jti`.
- Support key revocation and pool disablement.
- Rate-limit failed claim attempts by IP/session/account where practical.
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
- Add transactional consumption with unique `jti` enforcement.
- Reuse existing membership package assignment/grant logic where possible.
- Add audit event actions for consumed/rejected external claims.
- Add focused server tests for token validation, replay prevention, expiration,
  disabled pools, revoked keys, and seat limits.

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
- Admin/support can identify when, why, and by whom a token was consumed.
- No raw token values are stored or logged.

## Open Decisions

- Exact JOSE library and allowed initial algorithms.
- Whether CUP or CoCalc generates the production keypair.
- Whether pool ids should be UUIDs only or allow stable publisher-friendly
  slugs.
- Whether `membership_expires_at` override should be allowed for CUP or fixed
  by pool policy.
- Initial rate limits for failed claims.
