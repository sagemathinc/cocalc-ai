# Admin Impersonation Redesign Plan

## Purpose

This plan replaces the current impersonation model with one that preserves
actor/subject identity, supports recent admin 2FA for operational debugging,
and remains correct in the multi-bay architecture.

The main goal is:

1. let admins safely inspect and operate as a user when needed
2. preserve the fact that an admin is acting as that user
3. allow selected dangerous actions to rely on admin 2FA/fresh-auth instead of
   user 2FA
4. keep security-ownership actions blocked or separately handled
5. make the entire flow auditable

This is not a UI-only cleanup. The main problem is architectural.

## Current Model And Why It Is Wrong

Current flow:

1. admin UI requests a short-lived auth token for a target user
2. browser opens `/auth/impersonate?auth_token=...`
3. server resolves the target account and eventually calls
   `setSignInCookies(...)`
4. the browser becomes the target user

Relevant current files:

- admin UI: `src/packages/frontend/admin/users/impersonate.tsx`
- token creation: `src/packages/server/conat/api/org.ts`
- impersonation sign-in: `src/packages/server/auth/impersonate.ts`
- cookie/session issuance: `src/packages/server/auth/set-sign-in-cookies.ts`
- auth session state: `src/packages/server/auth/auth-sessions.ts`

The core defect is that once cookies are issued, the system mostly sees:

- "signed in as the user"

It does **not** reliably preserve:

- which admin started the impersonation
- whether that admin recently passed 2FA
- which dangerous actions should be allowed because of admin 2FA
- which actions must still be treated as user-owned security actions

That makes the model too lossy for dedicated hosts, money, and security work.

## Design Principles

### 1. Preserve actor and subject separately

Every impersonation session must retain:

- `actor_account_id`: the admin
- `subject_account_id`: the user being impersonated

These are not interchangeable.

### 2. Keep account-home-bay authority

The subject account's home bay should remain authoritative for the final
browser session that acts as that subject.

### 3. Treat impersonation as a special session mode

Impersonation is not "normal sign-in with a different account".

It is a different authenticated mode with different policy semantics.

### 4. Use admin fresh-auth for operational actions only

For selected actions, an impersonation session may satisfy dangerous-action
policy using the admin actor's recent 2FA.

This must **not** apply to everything.

### 5. Audit all impersonated actions

Every sensitive write performed during impersonation must record both:

- actor admin
- subject user

## Product Rules

### Actions that should accept admin 2FA during impersonation

Examples:

- dedicated host create/start/resize
- payment method debugging
- membership and billing debugging
- project/host operational debugging

These are operational actions where the admin is intentionally acting on behalf
of the user.

### Actions that should not accept impersonation as equivalent to the user

Examples:

- changing the user's password
- changing the user's email
- enabling/disabling the user's 2FA
- regenerating the user's recovery codes
- creating privileged long-lived credentials as the user without an explicit
  separate admin flow

These are security-ownership actions, not operational debugging actions.

For those, either:

1. block them during impersonation, or
2. provide separate explicit admin-only tools with their own audit trail

## Proposed Data Model

### `account_impersonation_grants`

One-time short-lived grant used to begin an impersonation session.

Suggested fields:

- `id`
- `actor_account_id`
- `subject_account_id`
- `created`
- `expire`
- `consumed_at`
- `revoked_at`
- `created_on_bay_id`
- `subject_home_bay_id`
- `actor_session_hash`
- `actor_password_verified_at`
- `actor_factor_verified_at`
- `actor_fresh_auth_until`
- `actor_factor_level`
- `reason`
- `metadata`

Rules:

- one-time use
- short TTL, e.g. 5 to 15 minutes
- creation requires fresh admin auth
- intended for redirect/exchange into a browser session

### `account_impersonation_sessions`

Active impersonation context keyed by the issued subject session hash.

Suggested fields:

- `session_hash`
- `actor_account_id`
- `subject_account_id`
- `grant_id`
- `created`
- `updated`
- `expire`
- `actor_authenticated_at`
- `actor_password_verified_at`
- `actor_factor_verified_at`
- `actor_fresh_auth_until`
- `actor_factor_level`
- `status`
  - `active`
  - `ended`
  - `revoked`
- `reason`
- `metadata`

Rules:

- `session_hash` points at the existing browser auth session
- subject account remains the effective signed-in account for the browser
- actor admin context is loaded alongside the subject session

### `account_auth_sessions`

Keep using this for the browser session itself.

Do **not** overload it so heavily that normal sessions and impersonation become
hard to reason about.

Practical approach:

- keep `account_auth_sessions.account_id = subject_account_id`
- keep the ordinary browser session there
- store impersonation-specific context in `account_impersonation_sessions`

This is cleaner than hiding actor state inside generic JSON metadata only.

## Backend Flow

### Phase A: creating an impersonation grant

New flow:

1. admin clicks impersonate
2. backend requires:
   - admin privileges
   - recent fresh auth
   - active admin 2FA
3. backend resolves the subject account home bay
4. backend creates a one-time impersonation grant on the subject home bay
5. backend returns a URL that already targets the subject home bay

This replaces the current "admin creates a generic auth token" approach.

### Phase B: redeeming the grant

New `/auth/impersonate` flow:

1. browser visits impersonation URL
2. if not on subject home bay, redirect there with a retry token as needed
3. subject home bay redeems the one-time grant
4. server issues the normal subject cookies
5. server also creates `account_impersonation_sessions` for the issued session
6. browser lands in the app as the subject, but with actor context attached

### Phase C: loading auth context on requests

Authenticated request resolution should provide:

- `account_id`: subject account
- `impersonation`:
  - `active`
  - `actor_account_id`
  - `subject_account_id`
  - `actor_fresh_auth_until`
  - `actor_factor_level`

This should be available through a single auth-context helper rather than
scattered ad hoc queries.

## Fresh-Auth Behavior

### Admin pages

Admin UI should itself be treated as sensitive:

- require active 2FA for site admins
- require recent fresh auth for especially dangerous admin actions

Examples:

- starting impersonation
- creating admin payment adjustments
- forcing host or billing changes

### Impersonation step-up

During impersonation, the "fresh auth" prompt for eligible operational actions
should authenticate the **actor admin**, not the subject user.

That means:

1. impersonated session hits a protected action
2. backend says fresh auth required
3. fresh-auth UI shows that this is verifying the admin actor
4. admin enters their password + TOTP
5. server updates `account_impersonation_sessions.actor_fresh_auth_until`
6. the action proceeds

This should not mutate the subject user's 2FA state or freshness state.

## Policy API

Introduce a clear policy helper for dangerous actions:

- `requireFreshAuth({ allow_actor_impersonation: true | false, ... })`

And a companion helper for 2FA-dependent policy:

- `requireSecondFactorForDangerousAction(...)`

Behavior:

- normal session:
  - use subject session fresh-auth and 2FA state
- impersonation session with `allow_actor_impersonation: true`:
  - use actor admin fresh-auth and 2FA state
- impersonation session with `allow_actor_impersonation: false`:
  - reject or require a separate admin flow

## Frontend UX

### Admin user search / user page

Replace the current raw-link model with a real flow:

1. admin clicks `Impersonate`
2. if fresh auth is stale, show the fresh-auth prompt
3. backend creates impersonation grant
4. open a new incognito window or new profile window

The current "copy this raw URL" fallback can remain as a backup, but it should
not be the primary UX forever.

### Visible impersonation banner

When impersonating, show a strong persistent banner:

- `Acting as <subject>`
- `Signed in as admin <actor>`
- `End impersonation`

This must be globally visible, not hidden in a settings page.

### Avatar and settings affordances

The account menu should clearly indicate impersonation mode.

It should be difficult to forget that the session is impersonated.

## Auditing

Every sensitive write path should be able to record:

- `account_id`: subject
- `actor_account_id`: admin, when impersonating
- `session_mode`: normal or impersonation

This should propagate into:

- host operations
- membership changes
- billing adjustments
- payment method changes
- support/admin overrides

Where a table already has a `metadata` or audit field, include actor identity
there immediately. Longer term, standardize this through a shared audit helper.

## Multi-Bay Requirements

### 1. Grant creation routes to the subject home bay

The subject home bay should own impersonation grants and redemption.

### 2. Impersonation session stays account-home-bay-correct

The final browser session should still belong to the subject account's home
bay, exactly like ordinary sign-in.

### 3. Rehome portability

Account rehome must move:

- active impersonation grants for that subject account
- active impersonation session rows for that subject account

### 4. Retry-token support remains

If the browser lands on the wrong bay, the system should still redirect to the
correct subject home bay without losing the impersonation intent.

## Migration Strategy

### Step 1

Add the new tables and read path, but keep the old `/auth/impersonate?auth_token`
flow working.

### Step 2

Add new admin endpoint:

- `createImpersonationGrant(subject_account_id, reason?)`

Require:

- admin
- active 2FA
- recent fresh auth

### Step 3

Switch the admin UI to the new grant-based flow.

### Step 4

Teach auth context and fresh-auth helpers about impersonation sessions.

### Step 5

Apply impersonation-aware policy to:

- dedicated host actions
- billing actions
- membership/package admin debugging flows

### Step 6

Deprecate raw generic auth-token impersonation.

Eventually:

- disable creation of generic impersonation auth tokens entirely

## Testing Plan

### Unit / integration

1. impersonation grant creation requires admin + fresh auth + 2FA
2. grant creation routes to subject home bay
3. grant redemption creates subject session plus actor context
4. one-time grants cannot be reused
5. impersonation session can satisfy host/billing fresh-auth with actor 2FA
6. impersonation session cannot change subject security settings
7. actor/subject audit fields are recorded on sensitive writes
8. rehome moves active impersonation rows correctly

### Live smoke

1. admin without 2FA cannot start impersonation
2. admin with 2FA but stale freshness is prompted before impersonation
3. impersonated session shows banner and actor identity
4. impersonated host start succeeds using admin fresh auth
5. impersonated password/2FA settings edit is blocked
6. ending impersonation returns to the admin cleanly

## Recommended Implementation Order

1. backend grant + impersonation-session tables
2. new impersonation auth flow on the subject home bay
3. auth-context helper that exposes actor/subject
4. fresh-auth support for impersonation actor sessions
5. admin UI migration to the new flow
6. policy integration for hosts/billing
7. audit propagation

## Bottom Line

The correct redesign is:

- not "better raw auth tokens"
- not "just gate the old flow behind 2FA"

It is:

- actor-aware impersonation grants
- actor-aware impersonation sessions
- explicit policy that distinguishes operational admin actions from
  subject-owned security actions

That is what makes impersonation compatible with 2FA, dedicated hosts, and
money-sensitive workflows without destroying admin usability or auditability.
