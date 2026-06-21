# Google SSO Fresh Auth Plan

Created: 2026-06-21

## Status

Implemented.

Implemented in this branch with:

- `/auth/google/fresh-auth/start` on the hub auth router.
- A Google OIDC return branch that validates state, browser binding, current
  remember-me session, linked Google passport, and recent Google `auth_time`.
- `google_oidc` as a fresh-auth session factor level, without treating it as a
  password/2FA credential result or admin dangerous-operation second factor.
- `FreshAuthModal` support for `Verify with Google`, including the existing
  15-minute default and 8-hour checkbox duration choices.

## Problem

Fresh-auth-protected purchase and account-security actions currently work for
password, TOTP/recovery-code, and passkey users. They fail for Google SSO-only
users because `FreshAuthModal` asks for a CoCalc password when the account has no
password:

> fresh authentication requires a password or second factor

This blocks the normal release flow:

- user creates an account with Google SSO
- user tries to purchase a membership
- purchase requires fresh auth
- user has no CoCalc password or second factor
- user cannot proceed

This is a product bug and a security-model gap. Fresh auth should be satisfied by
the account's actual authentication methods, including linked SSO providers.

## Goals

- Add `Verify with Google` to `FreshAuthModal` for accounts linked to Google.
- Keep the user in the current page/modal when possible.
- Mark the current browser auth session fresh after successful Google
  reauthentication.
- Honor the existing fresh-auth duration UI:
  - default: 15 minutes
  - checked "Keep this verification active for 8 hours": 8 hours
- Ensure the Google return verifies the same CoCalc account and same linked
  Google identity.
- Keep normal Google sign-in/sign-up/linking behavior separate from fresh auth.
- Do not initially mark ordinary Google sign-in as fresh auth. Implement that
  later after the explicit `Verify with Google` path is testable without waiting
  15 minutes between attempts.

## Non-Goals

- Do not make SAML fresh auth a release blocker.
- Do not require SSO-only users to create a CoCalc password.
- Do not require SSO-only users to configure CoCalc 2FA before purchasing.
- Do not weaken existing fresh-auth checks on billing mutations.
- Do not route project-host traffic or project data through this flow.

## Architecture Constraints

Fresh auth is account/control-plane state and must follow the scalable
architecture model:

- The account's home bay is authoritative for `account_auth_sessions`.
- The browser is connected to the account home bay for account-facing
  control-plane work.
- Google OAuth routes may start on the visible web origin, but final fresh-auth
  session mutation must happen against the authoritative account/home-bay state.
- Project hosts are not involved.

Current relevant files:

- Frontend fresh auth:
  `src/packages/frontend/auth/fresh-auth.tsx`
- Frontend auth HTTP helper:
  `src/packages/frontend/auth/api.ts`
- Existing Google OIDC routes:
  `src/packages/server/hub/auth.ts`
- Google OIDC helper:
  `src/packages/server/auth/sso/google-oidc.ts`
- Fresh auth session state:
  `src/packages/server/auth/auth-sessions.ts`
- Password/2FA/passkey fresh-auth logic:
  `src/packages/server/auth/two-factor.ts`
- Fresh auth HTTP endpoints:
  `src/packages/http-api/pages/api/v2/auth/fresh-auth.ts`
  `src/packages/http-api/pages/api/v2/auth/fresh-auth-status.ts`
- Linked SSO identity storage:
  `accounts.passports` using keys from
  `src/packages/database/postgres/account/passport-key.ts`

## Current Behavior

`FreshAuthModal` calls `auth/fresh-auth-status`.

That status currently reports:

- mode: account or impersonation actor
- whether CoCalc second factor is enabled
- second-factor methods: `totp`, `recovery_code`, `passkey`
- account email

It does not report linked SSO methods.

When no second factor exists, the modal asks for a current CoCalc password. For a
Google-only account, `freshAuthSession` rejects because there is no password and
no second factor.

## Target User Flow

1. User clicks a purchase action.
2. Backend returns `fresh_auth_required`.
3. `FreshAuthModal` opens.
4. Modal loads status and sees:
   - account has no CoCalc 2FA/passkey
   - account has linked Google SSO
5. Modal shows:
   - `Verify with Google`
   - optional duration checkbox, default unchecked
   - no unusable CoCalc password prompt unless the account also has a password
6. User clicks `Verify with Google`.
7. Frontend opens a small OAuth popup.
8. Popup runs Google OIDC with a dedicated `fresh-auth` flow state.
9. Google callback verifies:
   - OAuth state/nonce/browser binding
   - Google ID token
   - token audience/client ID
   - hosted-domain restrictions, if configured
   - same linked passport belongs to the current CoCalc account
   - same browser session is being promoted
   - recent Google authentication for fresh auth
10. Backend calls `setCurrentSessionFreshAuth` for the current session with:
    - `factor_level`: new value such as `google_oidc` or existing compatible
      representation
    - `fresh_auth_until`: now + selected duration
11. Popup sends success to opener and closes.
12. Modal calls `onSuccess()`.
13. Original protected action retries and completes.

## Security Requirements

### Same Account

The Google account returned by the fresh-auth OAuth callback must already be
linked to the signed-in CoCalc account.

Implementation detail:

- Compute the passport key using the same strategy/id scheme as normal SSO:
  `google-<google sub>` via `_passport_key({ strategy: "google", id: sub })`.
- Load the current CoCalc account row from the account's home bay.
- Require `accounts.passports[passport_key]` to exist.
- Require that passport is not linked to a different account.

Do not allow this flow to:

- create an account
- link a new Google identity
- switch the current account
- sign in a different user

### Same Browser Session

The flow should promote the current browser session, not just any session for the
account.

Implementation detail:

- At fresh-auth start, capture:
  - `account_id`
  - current `remember_me` session hash
  - `duration`
  - `startedAt`
  - `nonce`
  - browser-binding secret
  - flow: `"fresh-auth"`
- Store this server-side in `passport_store` using `getOauthCache`.
- Set an HTTP-only browser-binding cookie, as the existing Google flow does.
- At callback, require:
  - matching OAuth `state`
  - matching browser-binding cookie
  - current request's remember-me hash matches the stored session hash
  - current auth session belongs to stored `account_id`

### Recent Google Auth

Fresh auth should mean recent authentication, not just silent reuse of an old
Google session.

Implementation detail:

- Extend `googleOidcAuthorizationUrl` to accept `freshAuth?: boolean`.
- For fresh-auth flow, include `max_age=0`.
- Extend `GoogleIdTokenClaims` to include `auth_time?: number`.
- In fresh-auth flow, require `auth_time` to be present and recent enough:
  - `auth_time >= startedAt - CLOCK_SKEW_SECONDS`
  - `auth_time <= now + CLOCK_SKEW_SECONDS`
- If Google does not return `auth_time`, fail with a clear error instead of
  silently treating a stale Google session as fresh auth.

If this is too strict in real testing because Google omits `auth_time` despite
`max_age=0`, revisit explicitly. Do not silently relax this in the first pass.

### Duration

The modal's existing 8-hour checkbox must apply to Google fresh auth.

Implementation detail:

- `FreshAuthModal` should send `duration: "default" | "extended"` when starting
  Google fresh auth.
- Server should use `resolveFreshAuthDurationMs({ duration, factor_level })`.
- The current resolver only permits extended duration for `totp` and `passkey`.
  Decide one of:
  - preferred: add a new `AuthSessionFactorLevel` value such as
    `google_oidc`, and allow extended duration for that level
  - acceptable: represent SSO fresh auth in metadata and use `factor_level:
"none"`, but then explicitly allow extended duration for verified SSO

Preferred is a new factor level because it makes audit/debugging clearer.

### Auditability

Record enough metadata to inspect fresh-auth source later:

- `metadata.sso_fresh_auth_provider = "google"`
- `metadata.sso_fresh_auth_strategy = "google"`
- `metadata.sso_fresh_auth_sub_hash`, not raw Google `sub`
- `metadata.sso_fresh_auth_email_domain`
- `metadata.sso_fresh_auth_auth_time`

Avoid storing raw Google tokens or raw provider subject in session metadata.

## Backend Design

### 1. Extend Auth Session Factor Levels

Current type:

```ts
export type SecondFactorMethod = "totp" | "recovery_code" | "passkey";
export type AuthSessionFactorLevel = "none" | SecondFactorMethod;
```

Plan:

- Add an SSO fresh-auth level:
  - `google_oidc` for Google-specific first pass, or
  - `sso` if we want generic semantics now.
- Prefer `google_oidc` because it is precise and makes tests/audits clearer.
- Update `resolveFreshAuthDurationMs` to allow extended duration for
  `google_oidc`.
- Update relevant type imports/tests.

### 2. Extend Fresh Auth Status

Add linked SSO info to `getFreshAuthStatus`.

Suggested shape:

```ts
type FreshAuthSsoMethod = {
  provider: "google";
  strategy: "google";
  display: "Google";
};

type FreshAuthStatus = {
  mode: "account" | "impersonation_actor";
  enabled: boolean;
  methods: SecondFactorMethod[];
  sso_methods?: FreshAuthSsoMethod[];
  has_password?: boolean;
  email_address?: string | null;
  actor_name?: string | null;
  actor_email_address?: string | null;
};
```

Rules:

- For normal account mode, inspect `accounts.passports` for a linked Google
  passport.
- Only expose Google if current Google SSO settings are configured.
- Only expose Google if the stored passport strategy matches the configured
  Google strategy name.
- Do not expose SSO methods for `impersonation_actor` in the first pass.
  Admin impersonation fresh auth should continue requiring admin 2FA.
- Include `has_password` so the frontend can avoid showing a misleading
  password prompt for passwordless accounts.

### 3. Add Fresh Auth Start Endpoint

Add a browser HTTP endpoint:

`POST /api/v2/auth/sso/fresh-auth/start`

Input:

```ts
{
  provider: "google",
  duration: "default" | "extended"
}
```

Output:

```ts
{
  url: string,
  popup: true
}
```

Responsibilities:

- Require signed-in account.
- Require browser remember-me session.
- Require provider is linked to this account.
- Generate OAuth state, nonce, browser-binding value.
- Save `GoogleOidcState` with `flow: "fresh-auth"` and the fields listed in
  security requirements.
- Set the HTTP-only browser-binding cookie.
- Return Google authorization URL instead of redirecting.

This endpoint is preferable to using `GET /auth/google?...` directly because it
lets the modal start the popup without navigating the current page.

### 4. Extend Google Callback

Extend `GET /auth/google/return` to branch on stored state:

- normal sign-in/sign-up/link flow: existing `PassportLogin` behavior
- `flow === "fresh-auth"`: new fresh-auth behavior

Fresh-auth callback should:

- verify state and browser-binding cookie
- exchange code
- verify ID token and hosted-domain restrictions
- verify `auth_time`
- verify linked passport belongs to stored account
- verify current remember-me session hash matches stored session hash
- call `setSessionFreshAuth` or `setCurrentSessionFreshAuth`
- return a tiny HTML page that posts a message to `window.opener`

Do not call `PassportLogin` in fresh-auth mode.

### 5. Popup Completion HTML

Return a minimal page from the callback:

```html
<script>
  if (window.opener) {
    window.opener.postMessage(
      { type: "cocalc:fresh-auth", provider: "google", ok: true },
      window.location.origin,
    );
  }
  window.close();
</script>
```

For failures, post:

```ts
{ type: "cocalc:fresh-auth", provider: "google", ok: false, error: "..." }
```

Security:

- The opener must check `event.origin === window.location.origin`.
- The opener must check the message shape.
- The actual source of truth is the server-set `fresh_auth_until`; postMessage
  only tells the modal to retry/status-check.

### 6. Full-Page Fallback

If popup creation fails or is blocked:

- Show a link/button: `Open Google verification`.
- It may navigate the current tab as a fallback.
- Store enough local pending state to retry the protected action only when the
  user returns if practical.

This is lower priority than popup because the release-critical flow is purchase
modals with meaningful in-page state.

## Frontend Design

### 1. Extend `FreshAuthModal`

Add to `FreshAuthStatus`:

- `sso_methods?: FreshAuthSsoMethod[]`
- `has_password?: boolean`

Render logic:

- If `sso_methods` includes Google, show `Verify with Google`.
- If account has no password and no second factor, do not show a password field
  as the primary path.
- If account has both password and Google, show both options:
  - Google as a primary button
  - password/2FA as existing form
- The 8-hour checkbox should be enabled for Google fresh auth.

### 2. Popup Helper

Add frontend helper, likely in `src/packages/frontend/auth/api.ts` or a new
`src/packages/frontend/auth/sso-fresh-auth.ts`:

```ts
startSsoFreshAuth({
  provider: "google",
  duration: "default" | "extended",
}): Promise<{ url: string }>
```

Then:

- `window.open(url, "cocalc-google-fresh-auth", "...")`
- listen for `message`
- clear listener on completion/cancel/unmount
- optionally poll `auth/fresh-auth-status` or simply call `onSuccess()` and let
  the original protected action retry

The protected action retry is the authoritative validation.

### 3. User-Facing Copy

Suggested modal copy:

- Button: `Verify with Google`
- Info text for SSO-only accounts:
  `This account signs in with Google. Verify with Google to continue this security-sensitive action.`
- Error for mismatched Google account:
  `That Google account is not linked to this CoCalc account. Use the Google account you used to sign in.`

Avoid telling users to create a password or enable 2FA just to buy a
membership.

## Testing Plan

### Backend Unit Tests

Add tests for:

- `auth/fresh-auth-status` reports Google for an account with linked Google
  passport.
- It does not report Google when Google SSO is not configured.
- Fresh-auth start rejects unsigned users.
- Fresh-auth start rejects accounts without linked Google passport.
- Fresh-auth start stores state with account/session/duration/nonce.
- Google callback in `fresh-auth` flow:
  - accepts matching linked passport and current session
  - rejects Google subject linked to another account
  - rejects unlinked Google subject
  - rejects missing/old `auth_time`
  - rejects wrong browser-binding cookie
  - rejects wrong current remember-me session hash
  - honors `duration: "default"` as 15 minutes
  - honors `duration: "extended"` as 8 hours
- Normal Google sign-in/sign-up/linking still works.

### Frontend Tests

Extend `src/packages/frontend/auth/fresh-auth.test.tsx`:

- SSO-only status shows `Verify with Google`, not a password-only dead end.
- Clicking `Verify with Google` calls the start endpoint with selected duration.
- Checked 8-hour box sends `duration: "extended"`.
- Successful popup message calls `onSuccess`.
- Failed popup message displays error.
- Password/2FA/passkey flows still work.

### Integration / Manual Testing

Manual test matrix:

- Google-only account:
  - purchase membership
  - fresh-auth modal shows Google
  - verify with same Google account
  - purchase continues
- Google-only account with checkbox unchecked:
  - verify
  - wait less than 15 minutes
  - second protected action does not prompt
- Google-only account with checkbox checked:
  - verify
  - protected action works after more than 15 minutes
- Google-only account, choose different Google account:
  - callback fails clearly
  - original modal remains usable
- Email/password account with no Google:
  - existing password prompt still works
- Account with Google plus password:
  - both paths available
- Account with passkey/TOTP:
  - existing 2FA/passkey paths unchanged
- Popup blocked:
  - fallback is understandable
- Multibay/home-bay deployment:
  - fresh auth promotes the session on the account home bay

## Rollout Order

### Phase 1: Backend State and Status

- Add `google_oidc` factor level.
- Extend fresh-auth status with linked Google method and `has_password`.
- Add tests for status behavior.

### Phase 2: Google Fresh Auth Start

- Add `auth/sso/fresh-auth/start`.
- Generate dedicated `fresh-auth` OAuth state.
- Return auth URL instead of redirecting.
- Add tests for start behavior.

### Phase 3: Google Callback Branch

- Extend Google callback for `flow: "fresh-auth"`.
- Verify same account/passport/session and recent `auth_time`.
- Set current session fresh auth with requested duration.
- Return popup postMessage HTML.
- Add backend tests.

### Phase 4: FreshAuthModal UI

- Render `Verify with Google`.
- Wire popup flow and duration checkbox.
- Keep existing password/2FA/passkey behavior.
- Add frontend tests.

### Phase 5: Manual Release Testing

- Test the membership purchase flow on a Stripe-enabled site.
- Test Google-only accounts before adding the later short-term login-as-fresh
  optimization.

### Phase 6: Later Optimization

After Phase 1-5 are fully tested, mark normal successful Google sign-in as
fresh auth for the default 15-minute window.

Reason to defer:

- We want to test explicit Google fresh auth repeatedly without waiting for the
  15-minute login freshness window to expire.

Implementation later:

- In `PassportLogin.login`, when setting sign-in cookies for Google SSO, set:
  - `fresh_auth_until = now + FRESH_AUTH_DEFAULT_MS`
  - `factor_level = "google_oidc"`
  - metadata noting normal sign-in fresh-auth promotion

## Later SAML Support

SAML should use the same general model later:

- Add `saml` or provider-specific factor level.
- Report linked SAML strategies in `fresh-auth-status`.
- Add `auth/sso/fresh-auth/start` support for SAML providers.
- Store `flow: "fresh-auth"` in SAML relay state/cache.
- On SAML return, verify:
  - same account
  - same linked SAML NameID/strategy
  - same current browser session
  - provider assertion freshness if available

Open issue:

- SAML freshness semantics are provider-dependent. Some IdPs can force
  reauthentication; some only return existing SSO sessions. We should not claim
  SAML satisfies fresh auth unless we can force or verify recent authentication.

## Open Questions

- Does Google always include `auth_time` when `max_age=0` is requested in our
  exact OIDC flow? If not, decide whether to add another prompt mode or reject
  and require password/passkey/2FA.
- Should the factor level be `google_oidc` or generic `sso` with provider
  metadata? Preferred for first pass: `google_oidc`.
- Should Google fresh auth be allowed during impersonation? Preferred for first
  pass: no. Admin impersonation fresh auth should continue requiring admin 2FA.
- Should we expose linked SSO provider names in `fresh-auth-status` for all
  configured providers or only Google? Preferred for release: only Google.

## Success Criteria

- A Google-only user can purchase a membership on a Stripe-enabled deployment.
- The user does not need to set a CoCalc password or 2FA.
- The membership purchase modal does not lose state during Google verification.
- The 8-hour checkbox is honored for Google fresh auth.
- A different Google account cannot satisfy fresh auth.
- Existing password, TOTP, recovery-code, and passkey fresh-auth tests still
  pass.
