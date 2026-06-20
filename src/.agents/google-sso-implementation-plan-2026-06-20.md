# Google SSO Implementation Plan

Created: 2026-06-20

## Goal

Make Google single sign-on fully usable on CoCalc Launchpad/Lite:

- `/auth/sign-in` shows a Google SSO option when Google is configured.
- `/auth/sign-up` shows a Google SSO option without making users think
  email/password signup is mandatory.
- Google signup respects Terms of Service and marketing consent.
- `/settings/profile` shows whether Google is linked, and lets a signed-in user
  link Google when it is not.
- Google SSO requires a verified Google email address.
- Linking Google to an existing account requires the Google email to match the
  account email.
- A successfully linked Google account verifies the matching CoCalc email
  address.
- SAML remains structurally supported, but Google is the only public non-SAML
  SSO provider for the release.

## Non-Goals

- Do not add Facebook, GitHub, Twitter, generic public OIDC, or other consumer
  identity providers.
- Do not make SAML a release blocker.
- Do not route auth through project hosts; this is account/control-plane state.
- Do not store Google client secrets outside the existing encrypted site
  settings mechanism.

## Architecture Constraints

Auth and account identity are global/home-bay control-plane state. The
implementation must follow the scalable architecture model:

- Account identity is authoritative in the account's home bay or global auth
  layer.
- Public auth routes may start on the local bay, but sign-in/sign-up must
  converge on the account's home bay using the existing wrong-bay retry/session
  mechanisms.
- Project hosts are not involved.
- Public UI should only receive non-secret provider metadata.

Google SSO is currently configured through encrypted site settings:

- `google_sso_enabled`
- `google_sso_client_id`
- `google_sso_client_secret`
- `google_sso_allowed_domains`
- `google_sso_signup_mode`

SAML providers are configured through `sso_providers` and domain policies. Keep
that separation for now.

## Current State Findings

Observed against `https://lite1b.cocalc.ai` on 2026-06-20:

- `GET /api/v2/auth/sso-strategies` returns Google.
- `GET /auth/strategies?v=2` returns only email.
- `GET /auth/google` returns `404 Cannot GET /auth/google`.
- `GET /customize` exposes only `strategies: [{ name: "email" }]`.
- `POST /api/v2/auth/sign-in-method` only reports domain-required SSO. It does
  not advertise general public Google SSO.

Relevant current code:

- Google settings and strategy construction:
  `src/packages/database/settings/google-sso.ts`
- Public strategy API:
  `src/packages/http-api/pages/api/v2/auth/sso-strategies.ts`
- Sign-in domain policy API:
  `src/packages/http-api/pages/api/v2/auth/sign-in-method.ts`
- Passport/OAuth/SAML route manager:
  `src/packages/server/hub/auth.ts`
- Google OIDC implementation:
  `src/packages/server/auth/sso/google-oidc.ts`
- SSO account creation/linking logic:
  `src/packages/server/auth/sso/passport-login.ts`
- Public sign-in/sign-up UI:
  `src/packages/frontend/public/auth/forms.tsx`
- In-app legacy sign-in/sign-up UI:
  `src/packages/frontend/auth/sign-in.tsx`
  `src/packages/frontend/auth/sign-up-base.tsx`
- Account/profile SSO UI:
  `src/packages/frontend/account/settings/account-settings.tsx`
- Existing reusable SSO/passport icons:
  `src/packages/frontend/passports.tsx`

Important discrepancies:

- The http API strategy list sees Google because it calls
  `getStrategies()`.
- The PassportManager route state does not see Google because it caches
  `passports` at init and registers `/auth/google` only during init.
- The public auth forms do not consume `auth/sso-strategies`; they only show
  SSO when `auth/sign-in-method` says the typed email domain requires SSO.
- The profile SSO UI exists but is hidden in Lite by checks of `lite`.
- Existing SSO account creation marks trusted SSO-created emails verified, but
  linking Google to an existing email/password account does not obviously mark
  the matching email verified.

## Root Cause

The implementation is split between two strategy sources:

- Dynamic public strategy metadata via `getStrategies()`.
- PassportManager's initialized route/passport state.

When Google is enabled after the hub starts, public metadata can show Google
while the actual `/auth/google` route is absent. The UI currently avoids this
bug only because it does not show the general Google button.

The correct fix is to make route handling and public strategy metadata resolve
from the same live source, then wire the UI to that source.

## Proposed Design

### 1. Make Google Auth Routes Dynamic

Avoid dynamic Express route removal/re-registration. Register stable Google
routes unconditionally:

- `GET /auth/google`
- `GET /auth/google/return`

Each request should resolve the current Google settings via
`getGoogleSsoSettingsState()` and fail gracefully if not configured.

This avoids the stale PassportManager route problem and means changing Google
SSO site settings does not require a hub restart just to install routes.

Implementation outline:

- Move `initGoogleOidc()` from "conditionally register routes if strategy
  exists" to "always register handlers once."
- In `GET /auth/google`, call `getGoogleSsoSettingsState()` and require
  `configured === true`.
- In `GET /auth/google/return`, resolve current settings again, verify the
  returned ID token against the current client ID, then call `PassportLogin`.
- Build the PassportLogin `passports` map from a live strategy loader, not from
  stale `this.passports`.
- Keep SAML route registration as-is for now, since SAML is not the release
  blocker.

### 2. Define a Canonical Public Strategy Loader

Use `getStrategies()` as the canonical browser-facing strategy metadata source.
It already combines:

- Google public OIDC settings.
- Enabled SAML providers.
- Domain policies.

Add or standardize fields that the auth UI needs:

- `name`
- `display`
- `icon`
- `backgroundColor`
- `public`
- `exclusiveDomains`
- `doNotHide`
- `accountCreation` or equivalent public-safe signup mode

`accountCreation` is useful so the sign-up page can say whether Google can
create a new account directly or whether the user should first create an
email/password account and link Google later.

Then align the legacy hub endpoint:

- Either make `/auth/strategies?v=2` call the same canonical loader, or stop
  using it for SSO-capable UI.
- Clear `WebappConfiguration` strategy cache after site-setting changes if
  `/customize` remains a source for account settings.

### 3. Preserve OAuth State

The current Google state only stores `nonce`. Extend the server-side state
stored in the OAuth cache to include:

- `nonce`
- `target`
- `flow`: `"sign-in" | "sign-up" | "link"`
- `termsAccepted`
- `marketingConsent`
- `registrationToken`
- `createdAt`

Rules:

- Store the full state server-side using the opaque OAuth `state` token.
- Do not put marketing/terms/registration token values directly in Google URLs.
- Validate `target` as same-origin or relative before redirecting.
- Remove OAuth state after callback, as now.
- Use a short TTL, consistent with existing OAuth/passport state caches.

### 4. Sign-In UI

In `src/packages/frontend/public/auth/forms.tsx`:

- Fetch `api("auth/sso-strategies")` once for public auth forms.
- Render a Google button when the returned public strategies include Google.
- Put Google above the email/password form with a divider:
  - `Continue with Google`
  - `or sign in with email`
- Keep existing domain-required SSO behavior:
  - If `auth/sign-in-method` says a typed email requires SSO, show the required
    provider message and hide/disable password submission.
- Do not require Terms acceptance on plain sign-in. Only require it for account
  creation flows or domain-required SSO where policies are visible and the
  current code already asks for it.
- Preserve `target` by adding it to the OAuth state.

The sign-in page should not wait for the user to type an email before showing a
general Google button.

### 5. Sign-Up UI

In `src/packages/frontend/public/auth/forms.tsx`:

- Render a Google sign-up section above the email/password fields when Google is
  configured.
- Use copy that avoids implying email/password is mandatory:
  - `Create or access your account with Google`
  - divider: `or create an account with email`
- Disable the Google button until Terms are accepted when policy pages are
  visible.
- Include marketing consent in the OAuth state.
- Include registration token in OAuth state if the token field is visible and
  non-empty.
- If Google account creation is not currently allowed by policy, show a precise
  note:
  - `Google can be linked after creating an account with a registration token.`
  - If the site supports registration-token-backed Google creation, allow the
    button once a token is entered.

Preferred behavior for token-gated deployments:

- Support registration-token-backed Google account creation if the user enters a
  valid token before clicking Google.
- If that is too large for the first implementation, explicitly disable Google
  account creation under `registration_token_required` and explain the fallback.

Backend support needed for full token-gated Google signup:

- Store `registrationToken` in OAuth state.
- Pass it to the SSO account creation path.
- Validate it with the same token logic used by `auth/sign-up`.
- Record failed token attempts through the same throttling path.

### 6. In-App Auth UI

The public auth pages are the primary release blocker because
`/auth/sign-in` and `/auth/sign-up` route there. The legacy in-app auth forms
still exist:

- `src/packages/frontend/auth/sign-in.tsx`
- `src/packages/frontend/auth/sign-up-base.tsx`

After public auth works, either:

- Wire these to the same `SsoButtons` component, or
- Confirm they are no longer reachable in the release flow and leave them for a
  cleanup task.

Do not implement two visually different Google SSO flows unless necessary.

### 7. Profile / Account Linking UI

In `src/packages/frontend/account/settings/account-settings.tsx`:

- Remove the `lite` condition that suppresses SSO link/status UI.
- Continue hiding account ID/email mutation pieces in Lite if needed, but not
  SSO visibility.
- Show linked providers based on `accounts.passports`.
- Show an available `Google` link button when Google is configured and not
  linked.
- Make the link button open `/auth/google?flow=link`.
- Keep unlink guarded by fresh auth.
- For an account that is already governed by an exclusive SSO domain, keep
  unlink blocked as the backend currently enforces.

The profile page should answer:

- `Your account is linked with Google`
- or `Link your Google account`

### 8. Backend Linking Rules

For Google specifically:

- Require Google to return an email.
- Require `email_verified === true`.
- When linking to an already signed-in CoCalc account, require normalized Google
  email to equal normalized account email.
- If the account has no email address, either reject with a clear message or
  require setting an email address first. For this release, rejecting is safer.
- If another account already owns the Google passport id, reject with the
  existing "already attached" error.
- If another account already has the Google email and the user is not signed in
  as that account, reject and tell them to sign in with email/password first.

Backend changes likely belong in or near:

- `src/packages/server/auth/sso/passport-login.ts`
- `src/packages/server/auth/sso/google-oidc.ts`

Do not weaken SAML domain-management behavior while adding Google-specific
email matching.

### 9. Email Verification Semantics

Current SSO account creation marks trusted SSO-created emails verified. Extend
that to linking:

- If a signed-in user links Google and the verified Google email matches the
  account email, call `set_email_address_verified`.
- If the account email is already verified, leave it verified.
- If the Google email does not match, reject before linking.

This implements the release rule:

> Once Google SSO is configured for an email, that email is verified because we
> trust Google SSO.

### 10. Redirect And Error Handling

Improve OAuth callback errors:

- Avoid raw backend error pages where possible.
- Redirect back to `/auth/sign-in` or `/auth/sign-up` with a short user-safe
  error token/message, or render a branded auth error page.
- Keep detailed diagnostics in server logs and SSO audit events.

Preserve targets:

- Start `/auth/google` with target from current auth page query.
- Store validated target in OAuth state.
- After successful sign-in/link, redirect to that target or `/projects`.

### 11. Caches And Settings Propagation

Current caches:

- `getStrategies()` caches for 3 seconds in dev and 15 seconds otherwise.
- `WebappConfiguration` caches `/customize` pieces for 30 seconds.
- PassportManager currently holds `this.passports` indefinitely.

Target behavior:

- `/api/v2/auth/sso-strategies` can lag by at most the existing TTL.
- `/auth/google` must reflect current settings without requiring route
  re-registration.
- Account profile available-link UI can tolerate a short cache TTL.

If site settings change, it is acceptable for the button to appear/disappear
within 15 to 30 seconds. It is not acceptable for `/auth/google` to 404 until
hub restart.

## Test Plan

### Unit Tests

Database/settings:

- `getStrategies()` includes Google when enabled and configured.
- `getStrategies()` excludes Google when disabled, missing client ID, or missing
  client secret.
- Google public strategy includes safe fields only.
- Google allowed domains become `exclusiveDomains` and/or policy fields as
  intended.

HTTP API:

- `/api/v2/auth/sso-strategies` returns Google when configured.
- `/api/v2/auth/sign-in-method` continues to require SSO only for configured
  domains.
- General gmail.com style emails remain `password_allowed: true`.

Hub auth:

- `/auth/google` does not 404 when Google is enabled after startup.
- `/auth/google` returns a clear configured-disabled error when not configured.
- OAuth state includes nonce, target, flow, terms, marketing, and optional
  registration token.
- Callback rejects missing email.
- Callback rejects unverified email.
- Callback rejects invalid nonce/state.

Passport login:

- Google creates a new account only when account creation policy allows it.
- Google account creation marks email verified.
- Google linking rejects email mismatch.
- Google linking marks matching account email verified.
- Google linking rejects if the Google passport is attached to another account.
- Existing SAML tests still pass.

Frontend public auth:

- Sign-in renders `Continue with Google` when strategy API returns Google.
- Sign-in still renders email/password.
- Domain-required SSO still shows the required-provider warning.
- Sign-up renders Google above email/password.
- Sign-up Google button is disabled until Terms are accepted when policies are
  visible.
- Sign-up passes marketing consent and target into Google start URL/state
  initiation.
- Sign-up copy does not imply email/password is required.

Frontend profile:

- Lite profile shows linked Google state.
- Lite profile shows link Google button when configured and not linked.
- Unlink warning still appears when unlinking would remove the last login
  method.

### Focused Commands

Use focused tests first:

```sh
pnpm -C src/packages/database test settings/get-sso-strategies.test.ts
pnpm -C src/packages/server test auth/sso/google-oidc.test.ts auth/sso/passport-login.test.ts
pnpm -C src/packages/http-api test pages/api/v2/auth/sign-in-method.test.ts
pnpm -C src/packages/frontend test public/auth/__tests__/app.test.tsx
```

Then run broader checks for touched packages:

```sh
pnpm -C src prettier --write <changed-files>
pnpm -C src lint:frontend
cd src/packages/frontend && pnpm tsc --build
cd src/packages/server && pnpm tsc --build
cd src/packages/http-api && pnpm tsc --build
```

### Live Smoke

Against local/lite1b after build/restart:

```sh
curl -fsSL https://lite1b.cocalc.ai/api/v2/auth/sso-strategies | jq .
curl -i -sS https://lite1b.cocalc.ai/auth/google | sed -n '1,30p'
curl -fsSL 'https://lite1b.cocalc.ai/auth/strategies?v=2' | jq .
```

Expected:

- `auth/sso-strategies` includes Google.
- `/auth/google` redirects to `https://accounts.google.com/...`, not 404.
- `/auth/strategies?v=2` is either aligned with Google or no longer used by the
  relevant UI.

Browser smoke:

- `/auth/sign-in` shows Google.
- `/auth/sign-up` shows Google and Terms gating works.
- Google callback signs in or creates account according to policy.
- Existing account can link Google from `/settings/profile`.
- Email verification UI no longer asks for verification after successful
  matching Google link.

## Implementation Order

### Commit 1: Backend Route Liveness

- Make `/auth/google` and `/auth/google/return` stable dynamic routes.
- Make them resolve current Google SSO settings at request time.
- Add tests that enabling Google after PassportManager init does not leave
  `/auth/google` missing.

This is the highest-priority commit because a visible button is harmful if the
route 404s.

### Commit 2: Canonical Strategy Metadata

- Standardize public strategy fields from `getStrategies()`.
- Add `accountCreation` or equivalent public-safe signup information.
- Align `/auth/strategies?v=2` with the canonical source or document/remove its
  use from SSO UI.
- Add http-api tests for `auth/sso-strategies`.

### Commit 3: Public Sign-In UI

- Add a small shared public auth SSO button/list component.
- Render Google on sign-in independent of email entry.
- Preserve domain-required SSO behavior.
- Preserve target in Google start URL/state.

### Commit 4: Public Sign-Up UI

- Render Google on sign-up with Terms gating and marketing consent.
- Add registration-token behavior or clear fallback copy.
- Add tests for Terms gating and button/copy behavior.

### Commit 5: Profile Linking UI

- Show SSO linked/linkable state in Lite.
- Link to Google when not linked.
- Keep unlink/fresh-auth behavior.
- Add profile/account settings tests.

### Commit 6: Google Link Safety And Email Verification

- Enforce matching verified Google email on link.
- Mark matching account email verified after link.
- Add PassportLogin tests for mismatch, match, and verification.

### Commit 7: Polish And Live Validation

- Improve callback error display.
- Run focused package checks.
- Build/restart lite1b as needed.
- Perform live browser smoke.

## Open Decisions

### Registration-token-backed Google signup

Question:

- Should a token-gated site allow users to enter a registration token and then
  create the account with Google directly?

Recommendation:

- Yes, if implementation is not too invasive. It matches user expectations on
  `/auth/sign-up`.
  - USER:  it's currently a setting in the admin settings dropdown, but I do NOT like the current setup:  <img src="/blobs/paste-i2q7go5kh7.png?uuid=76cfdda8-bbb0-4031-8a40-0e3694782fa3"   width="1126px"  height="165px"  style="object-fit:cover"/>It should be impossible to set this to public_allowed if a registration token is required.  Also if no reg token is required, it should NOT be possible to set it to registration_token_required.  The only reasonable settings should be enabled/disabled for SSO.   
- If deferred, explicitly communicate that Google can be linked after creating
  an email/password account with the token.

### Existing account with no email address

Question:

- Can Google link to an account with no CoCalc email address?

Recommendation:

- No for this release. Require setting an email first, then link matching
  Google. This keeps the matching-email invariant simple and reviewable.   
- USER: it should be easy to create an account without setting a password, i.e., SSO only. But a key invariant should be that SSO email = cocalc email.    
  - do not allow removing SSO if no password is set
  - do allow adding a password even if SSO is set.
  - if google doesn't provide an email for some reason, do NOT allow account creation.

### SAML UI

Question:

- Should public auth pages show SAML now?

Recommendation:

- Only show SAML through the existing `/sso` index/detail flow or
  domain-required flow. Do not expand SAML UX as part of the Google release
  blocker unless it falls out naturally from the shared strategy component.
- USER: agreed; we won't configure SAML for a while.

## Risks

- A visible Google button that routes to 404 is worse than no button. Fix route
  liveness first.
- OAuth target redirects can become open redirects if not validated. Store only
  validated relative/same-origin targets.
- Linking by Google subject alone is not enough for this product policy. Enforce
  matching verified email.
- The profile page currently hides SSO in Lite. Removing that condition should
  be narrow so unrelated Lite account settings stay hidden if intentional.
- Strategy caches can make manual testing confusing. Document expected TTLs and
  prefer dynamic route settings for `/auth/google`.

## Definition Of Done

- Google appears on `/auth/sign-in`.
- Google appears on `/auth/sign-up`.
- Sign-up Google button respects Terms gating and captures marketing consent.
- `/auth/google` redirects to Google when configured and never 404s because of
  stale PassportManager state.
- Google callback can sign in an existing linked account.
- A user can create an account with Google when policy allows it.
- A signed-in user can link Google from `/settings/profile`.
- Linking requires the verified Google email to match the account email.
- Linking marks the matching account email verified.
- Focused unit tests pass.
- Lite1b browser smoke passes.

