# Two-Factor Auth / Fresh-Auth Implementation Plan

## Purpose

This plan covers the first real 2FA / MFA implementation for `cocalc-ai`,
anchored to the current auth and multi-bay architecture.

The immediate goals are:

1. require a second factor for accounts that enable 2FA
2. support TOTP plus one-time recovery codes in V1
3. add a reusable fresh-auth checkpoint for dangerous actions
4. keep account-home-bay auth authority and rehome correctness intact
5. make dedicated hosts and billing actions safe enough to ship

This is not a generic MFA plan. It is the concrete implementation sequence for
this repo.

## Current Auth Architecture

The current sign-in/session flow is:

1. browser posts email/password to `src/packages/http-api/pages/api/v2/auth/sign-in.ts`
2. sign-in checks whether the account lives on the current bay
3. if not, it returns `wrong_bay + retry_token + home_bay_url`
4. the browser retries the request on the account home bay
5. successful sign-in issues:
   - `remember_me` cookie
   - `account_id` cookie
   - `home_bay_id` cookie
6. authenticated requests resolve the account via:
   - `remember_me` cookie, or
   - account/project API key

Relevant current files:

- sign-in: `src/packages/http-api/pages/api/v2/auth/sign-in.ts`
- sign-up: `src/packages/http-api/pages/api/v2/auth/sign-up.ts`
- auth bootstrap: `src/packages/http-api/pages/api/v2/auth/bootstrap.ts`
- cookie issuance: `src/packages/server/auth/set-sign-in-cookies.ts`
- remember-me storage: `src/packages/server/auth/remember-me.ts`
- authenticated account lookup: `src/packages/server/auth/get-account.ts`
- sign-out + revoke-all-sessions: `src/packages/http-api/pages/api/v2/accounts/sign-out.ts`
- account revocation checkpoint: `src/packages/server/accounts/revocation.ts`
- app sign-in UI: `src/packages/frontend/auth/sign-in.tsx`
- public sign-in UI: `src/packages/frontend/public/auth/forms.tsx`
- account security settings area:
  - `src/packages/frontend/account/account-preferences-security.tsx`
  - `src/packages/frontend/account/settings/account-settings.tsx`

Important current fact:

- there is no second-factor state
- there is no session freshness state
- there is no “step-up” challenge flow

## Product Decisions

### V1 factor types

V1 should support:

1. TOTP authenticator apps
2. one-time recovery codes

V1 should not support yet:

- SMS
- email as second factor
- passkeys / WebAuthn as the primary 2FA path

Reason:

- TOTP is straightforward, local to the account home bay, and does not create
  telco dependency or SMS abuse exposure
- recovery codes are required for survivability
- WebAuthn can be added later once the rest of the auth/session model is in
  place

### Security posture

V1 policy should be:

- paid compute and dedicated hosts should not be considered release-ready
  without 2FA support
- dangerous actions require fresh auth, not only an existing signed-in session
- long-lived API keys do not by themselves satisfy fresh-auth requirements

### Scope of V1 “fresh auth”

Fresh auth means:

- recent password verification
- plus recent second-factor verification if the account has 2FA enabled

It is separate from:

- just being signed in
- having a valid remember-me cookie
- possessing a long-lived API key

## Non-Goals

This plan does not try to solve:

- federated MFA policy sync with SSO providers in V1
- adaptive risk scoring beyond explicit fresh-auth gates
- full passkey / WebAuthn rollout
- perfect CLI UX for MFA on day one

Those can follow after the core account-local 2FA model exists.

## Multi-Bay Invariants

The auth plan must respect the actual cluster architecture.

### 1. Account home bay owns auth state

2FA state and session-freshness state are account-home-bay authoritative.

This includes:

- enrolled second factors
- recovery codes
- sign-in / fresh-auth challenges
- session-freshness metadata

### 2. Wrong-bay sign-in still redirects before MFA completion

Email/password sign-in should keep the current wrong-bay behavior:

1. initial sign-in may land on a non-home bay
2. server returns `wrong_bay + retry_token`
3. browser retries on the home bay
4. home bay then returns either:
   - sign-in success, or
   - `mfa_required`

Do not try to verify TOTP on the wrong bay.

### 3. Account rehome must move all auth-local 2FA state

Rehome portability must include any new auth tables introduced here.

At minimum:

- second-factor rows
- recovery-code rows
- auth-challenge rows
- auth-session metadata rows

### 4. Seed is not 2FA authority

Seed/global state should not own per-account MFA state.

Seed is allowed only to help route to the home bay through existing account
directory plumbing.

## Data Model

V1 should use explicit tables instead of overloading `accounts`.

### `account_second_factors`

Home-bay-authoritative table.

Suggested fields:

- `id`
- `account_id`
- `type`
  - `totp`
- `label`
  - e.g. “Authenticator app”
- `secret_encrypted`
- `status`
  - `pending`
  - `active`
  - `disabled`
- `created`
- `activated_at`
- `disabled_at`
- `last_used_at`
- `metadata`

Rules:

- V1 allows at most one active TOTP factor per account
- keep schema general enough for later WebAuthn/passkey factors

### `account_second_factor_recovery_codes`

Home-bay-authoritative table.

Suggested fields:

- `id`
- `account_id`
- `factor_id`
- `code_hash`
- `used_at`
- `created`
- `metadata`

Rules:

- store only hashed recovery codes
- recovery codes are shown exactly once at generation time
- code use is one-time and irreversible
- regenerating codes invalidates all older unused codes

### `account_auth_challenges`

Home-bay-authoritative table used for sign-in step-up and fresh-auth.

Suggested fields:

- `id`
- `account_id`
- `purpose`
  - `sign_in`
  - `fresh_auth`
  - `disable_2fa`
  - `rotate_recovery_codes`
- `password_verified_at`
- `factor_verified_at`
- `verified_factor_type`
  - `totp`
  - `recovery_code`
- `target_session_hash` nullable
- `expire`
- `attempt_count`
- `max_attempts`
- `completed_at`
- `created`
- `metadata`

Rules:

- short TTL, e.g. 10 minutes
- strict attempt limit with lockout/backoff
- old or completed challenges cannot be replayed

### `account_auth_sessions`

Home-bay-authoritative session metadata table.

This is the missing piece for fresh-auth.

The `remember_me` table currently answers only:

- which account is this cookie for?
- when does it expire?

That is not enough for:

- second-factor satisfaction
- session freshness
- session listing / revocation by device

Suggested fields:

- `session_hash`
  - hash derived from the `remember_me` cookie, or a stable linked session id
- `account_id`
- `created`
- `updated`
- `expires_at`
- `authenticated_at`
- `password_verified_at`
- `factor_verified_at` nullable
- `fresh_auth_until` nullable
- `factor_level`
  - `none`
  - `totp`
  - `recovery_code`
- `ip_address`
- `user_agent`
- `revoked_at`
- `metadata`

Design choice:

- keep `remember_me` as the cookie/token authority
- add `account_auth_sessions` as the richer per-session metadata layer

This is cleaner than trying to overload the existing `remember_me` row with all
future session semantics.

## Secret Handling

TOTP secrets must not be stored in plaintext.

V1 requirement:

- encrypt TOTP secrets at rest using a server-side application secret
- decryption should happen only on the account home bay during verification

Implementation note:

- use an authenticated encryption scheme such as AES-GCM or XChaCha20-Poly1305
- keep crypto wrapper local to `src/packages/server/auth`

Recovery codes:

- never store plaintext codes
- store only salted hashes

## API and RPC Surface

### Sign-in changes

Current endpoint:

- `POST /api/v2/auth/sign-in`

New behavior:

1. verify email/password as today
2. if 2FA is not enabled:
   - issue cookies and session metadata normally
3. if 2FA is enabled:
   - create `account_auth_challenges` row with purpose `sign_in`
   - return:
     - `mfa_required: true`
     - `challenge_id`
     - `methods: ["totp", "recovery_code"]`
     - `home_bay_id`
     - `home_bay_url`

Do not issue the long-lived session cookie before MFA completion.

### New auth endpoints

Suggested HTTP endpoints:

- `POST /api/v2/auth/verify-second-factor`
  - completes sign-in challenge
- `POST /api/v2/auth/fresh-auth`
  - verifies password + MFA for an existing session and extends
    `fresh_auth_until`
- `POST /api/v2/auth/2fa/setup/start`
  - starts TOTP enrollment and returns secret/otpauth payload
- `POST /api/v2/auth/2fa/setup/confirm`
  - verifies first TOTP code, activates factor, returns recovery codes
- `POST /api/v2/auth/2fa/disable`
  - requires fresh auth
- `POST /api/v2/auth/2fa/recovery-codes/rotate`
  - requires fresh auth
- `GET /api/v2/auth/2fa/status`
  - current account status for UI

Suggested Conat/system methods for in-app account settings:

- `getTwoFactorStatus`
- `startTwoFactorSetup`
- `confirmTwoFactorSetup`
- `disableTwoFactor`
- `rotateTwoFactorRecoveryCodes`
- `freshAuth`
- later:
  - `listAuthSessions`
  - `revokeAuthSession`

### Fresh-auth gate helper

Add a server-side helper, e.g. in `src/packages/server/auth`, with semantics:

- `requireFreshAuth({ req, account_id, purpose, maxAgeMs })`

It should:

1. resolve the current session metadata row
2. verify the session belongs to `account_id`
3. verify `fresh_auth_until >= now`
4. otherwise throw a structured error such as:
   - `fresh_auth_required`
   - `mfa_required`
   - `session_not_step_up_capable`

This helper should be the common primitive used by dangerous actions.

## UI Plan

### Sign-in flow

Update:

- `src/packages/frontend/auth/sign-in.tsx`
- `src/packages/frontend/public/auth/forms.tsx`

New UX:

1. email/password form unchanged initially
2. if response says `mfa_required`, replace or advance to:
   - TOTP code input
   - “use recovery code instead” path
3. successful verification redirects exactly as today

Important:

- preserve wrong-bay retry behavior before rendering MFA step
- do not treat MFA as a totally separate login route; it is step 2 of sign-in

### Account settings

Add a dedicated 2FA section in:

- `src/packages/frontend/account/account-preferences-security.tsx`

Suggested panel content:

- current 2FA status
- “Set up authenticator app”
- QR code / manual secret
- confirm setup with first TOTP code
- download / copy recovery codes
- disable 2FA
- regenerate recovery codes

This belongs in the existing security area, not under billing.

### Fresh-auth modal

Introduce one reusable modal/component for step-up auth.

Used by:

- payment method changes
- prepaid funding / top-up
- dedicated host create/start/resize
- high-risk membership purchases
- 2FA disable / recovery-code rotation

The modal should collect:

- current password
- TOTP or recovery code when applicable

This should not be reimplemented separately in each page.

## Dangerous Actions That Must Gate on Fresh Auth

Initial V1 list:

### Billing / payment

- create payment method
- delete payment method
- set default payment method
- setup automatic billing / auto-balance
- prepaid top-up / funding

### Membership / entitlement

- buy memberships above a configurable threshold
- buy seat packages above a configurable threshold
- reclaim / transfer institutional entitlements
- disable or materially change billing-critical account settings

### Dedicated hosts

- create host
- start host
- resize / machine change
- enable a higher-risk pricing mode

Stopping a host is not financially dangerous in the same way; it does not need
to be blocked by fresh-auth in V1.

### Account security

- disable 2FA
- rotate recovery codes
- create long-lived high-privilege automation credentials, if those are later
  introduced

## API Key and Automation Policy

This needs to be explicit.

Long-lived API keys are not equivalent to a fresh interactive user auth event.

### V1 rule

- ordinary API-key-authenticated requests do not satisfy fresh-auth

Therefore:

- read-only monitoring, abuse review, analytics, and ordinary automation can
  continue using scoped API keys
- dangerous billing/security actions should reject plain API-key auth unless we
  explicitly support a short-lived step-up token

### Recommended V1 compromise

1. enforce fresh-auth on browser-driven dangerous actions first
2. for CLI/admin operations later, add a short-lived step-up token mechanism
   minted from a fresh browser session

Do not weaken browser security just because CLI ergonomics are not solved yet.

## Password Reset and Recovery Rules

These rules need to be fixed upfront.

### Password reset

Password reset should:

- reset the password
- revoke existing sessions
- not automatically disable 2FA

After password reset, the user should still need:

- TOTP, or
- recovery code

to sign in if 2FA was enabled.

### Recovery codes

Recovery code usage should:

- complete sign-in or fresh-auth
- mark the code used permanently
- be auditable

Optional safety improvement:

- after recovery-code sign-in, prompt the user to rotate recovery codes soon

### Support/admin recovery

There must be an explicit audited admin path to clear MFA for an account.

Requirements:

- admin-only
- logged reason
- recorded in account/security audit trail
- ideally visible to the user afterward via email or account notice

## Session and Revocation Behavior

### Session issuance

On successful MFA sign-in:

- create/refresh remember-me row
- create/refresh `account_auth_sessions` row
- set:
  - `password_verified_at = now`
  - `factor_verified_at = now`
  - `fresh_auth_until = now + default_window`

### Fresh-auth renewal

On successful fresh-auth:

- do not create a whole new login session
- update the existing `account_auth_sessions` row
- extend `fresh_auth_until`

### Global revocation triggers

Reuse `recordAccountRevocation(account_id, now)` for:

- sign out all sessions
- password reset completion
- disabling 2FA
- suspicious-account emergency response

This already exists and should stay the coarse invalidation primitive.

## Rehome and Portability

The rehome workflow must move new auth-local state.

Add these to portable account auth state:

- `account_second_factors`
- `account_second_factor_recovery_codes`
- `account_auth_challenges`
- `account_auth_sessions`

Questions to settle during implementation:

- whether incomplete `sign_in` challenges should move or be expired during
  rehome
- whether active sessions should survive rehome seamlessly or be forced to
  reconnect and possibly reauthenticate

Recommended V1 answer:

- copy active session metadata
- keep the current browser reconnect model
- expire incomplete short-lived auth challenges on rehome for simplicity

## Suggested Implementation Order

### Phase 1: backend factor and session primitives

1. add schema for:
   - second factors
   - recovery codes
   - auth challenges
   - auth sessions
2. add crypto wrapper for TOTP secret encryption
3. add TOTP verification helpers
4. add recovery-code generation and verification helpers

### Phase 2: sign-in second-step flow

1. update `auth/sign-in` to return `mfa_required`
2. add `auth/verify-second-factor`
3. create account-auth-session rows on successful MFA completion
4. keep wrong-bay retry logic intact

### Phase 3: settings UI and enrollment

1. add 2FA status API/RPC
2. add setup-start/setup-confirm flow
3. add security settings panel
4. add recovery-code display/download UX

### Phase 4: fresh-auth primitive

1. add server helper `requireFreshAuth`
2. add `auth/fresh-auth`
3. add reusable frontend fresh-auth modal

### Phase 5: gate dangerous actions

1. payment methods
2. automatic billing / prepaid funding
3. dedicated host create/start/resize
4. 2FA disable / recovery-code rotation
5. high-risk membership/institutional actions

### Phase 6: admin and session management

1. audited admin MFA reset
2. optional session list/revoke UI
3. optional step-up token support for CLI/automation

## Testing Plan

### Unit tests

- TOTP verification
- recovery-code one-time use
- challenge expiry and attempt limits
- auth-session freshness checks
- encryption/decryption round-trip

### Integration tests

- sign-in without MFA still works
- sign-in with MFA returns `mfa_required`
- wrong-bay sign-in + MFA completes on home bay
- password reset does not disable MFA
- disabling MFA requires fresh auth
- payment method mutation requires fresh auth
- dedicated host create/start/resize requires fresh auth

### Multi-bay tests

1. account on bay B signs in through bay A and completes MFA on bay B
2. account rehome moves enrolled factor state
3. account rehome moves session metadata
4. stale session after revocation is rejected on any bay

### Live smoke tests

Required live checks after implementation:

1. enroll TOTP through the browser
2. sign out, sign back in, complete second factor
3. use a recovery code once
4. verify the same recovery code fails on second use
5. verify payment-method mutation prompts for fresh auth
6. verify dedicated host action prompts for fresh auth
7. verify sign-out-all revokes existing sessions

## Open Questions

These should be decided during review before coding starts:

1. How long should `fresh_auth_until` last?
   - recommended V1 default: 15 minutes
2. Should enabling 2FA force sign-out-all immediately?
   - recommended V1 answer: yes
3. Should recovery-code sign-in grant a shorter fresh-auth window than TOTP?
   - recommended V1 answer: yes
4. Do we want dedicated host `start` to require fresh auth, or only
   create/resize?
   - recommended V1 answer: require it for `start` too
5. Do we want any dangerous action over ordinary API key auth in V1?
   - recommended V1 answer: no, not without an explicit short-lived step-up
     token

## Recommended Immediate Next Step

Before writing code, review and confirm these implementation choices:

1. session metadata lives in a new `account_auth_sessions` table
2. V1 factor types are exactly `totp + recovery codes`
3. fresh-auth is required for dedicated-host and payment-method actions
4. ordinary long-lived API keys do not satisfy fresh-auth

Once those are confirmed, implementation should start with Phase 1 schema and
server primitives.
