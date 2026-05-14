# Passkeys as an Alternative Second Factor

Status: implemented for the core second-factor flows, 2026-05-14.

Implementation summary:

- Backend passkey setup, sign-in second-factor assertion, fresh-auth assertion,
  CLI elevation assertion, disable, rename, and list endpoints are implemented.
- Frontend account settings can add, list, rename, and disable passkeys.
- Main sign-in, public sign-in, dangerous-operation fresh auth, and CLI
  elevation approval can use passkeys when available, with TOTP/recovery-code
  fallback preserved.
- Recovery codes work for passkey-only accounts.
- Scope remains second-factor-only; there is no passwordless sign-in or
  discoverable credential account lookup.

Remaining work before release is validation/audit, not new core feature work:

- Run real-browser smoke tests across Chrome/Google Password Manager,
  macOS/iCloud Keychain, phone passkeys, and at least one hardware key if
  available.
- Test launchpad/self-host hostname behavior and final cocalc.ai production
  hostname/RP ID behavior.
- Recheck multibay routing in a multi-bay test cluster once available.
- Add release docs and security-audit notes after smoke testing confirms final
  behavior.

Scope: add passkey/WebAuthn support as an alternative second factor and
fresh-auth method. This is not passwordless sign-in.

## Goals

- Let users satisfy CoCalc second-factor requirements with a passkey instead of
  typing a TOTP or recovery code.
- Make dangerous-operation freshness gates usable with a one-click/passkey
  verification flow.
- Preserve the existing password-first sign-in model for the first
  implementation.
- Preserve the existing `account_auth_sessions` semantics:
  - `factor_level` records how the session most recently satisfied 2FA.
  - `factor_verified_at` records when 2FA was verified.
  - `fresh_auth_until` gates dangerous actions.
- Keep recovery codes as the emergency fallback path.
- Support multibay by making account home bay authoritative for passkey
  credentials and verification.

## Non-Goals

- No passwordless sign-in in this phase.
- No username-less/discoverable credential sign-in in this phase.
- No resident-key-only policy in this phase.
- No passkey sharing between accounts.
- No passkey-based project/runtime authentication.
- No support for passkeys when the browser origin is not HTTPS, except normal
  browser localhost exceptions during development.

## Current Auth Model

Relevant existing files:

- `src/packages/util/db-schema/auth.ts`
- `src/packages/server/auth/two-factor.ts`
- `src/packages/server/auth/auth-sessions.ts`
- `src/packages/server/conat/api/dangerous-session-auth.ts`
- `src/packages/frontend/account/settings/two-factor-auth.tsx`
- `src/packages/frontend/auth/sign-in.tsx`
- `src/packages/frontend/auth/fresh-auth.tsx`
- `src/packages/http-api/pages/api/v2/auth/sign-in.ts`
- `src/packages/http-api/pages/api/v2/auth/verify-second-factor.ts`
- `src/packages/http-api/pages/api/v2/auth/fresh-auth.ts`

Existing second-factor state:

- `account_second_factors` stores active/pending/disabled TOTP factors.
- `account_second_factor_recovery_codes` stores one-time recovery codes tied to
  an active factor.
- `account_auth_challenges` stores sign-in and fresh-auth challenge state.
- `account_auth_sessions` stores session freshness and factor status.
- `AuthSessionFactorLevel` currently supports `"none"`, `"totp"`, and
  `"recovery_code"`.

Existing important behavior:

- Sign-in verifies password first. If 2FA is active, sign-in returns a challenge
  and the browser completes it using TOTP or a recovery code.
- Fresh auth verifies the current password and optionally a second factor, then
  updates `fresh_auth_until`.
- Dangerous Conat RPCs call `requireDangerousSessionAuth`, which only depends on
  active 2FA and recent factor verification. It should not need to know the
  underlying factor mechanism.

## Proposed Model

Add `passkey` as a first-class second-factor method:

```ts
type SecondFactorMethod = "totp" | "recovery_code" | "passkey";
type AuthSessionFactorLevel = "none" | SecondFactorMethod;
```

TOTP remains supported. Recovery codes remain supported. A user may have:

- zero passkeys and one active TOTP factor,
- one or more passkeys and no TOTP factor,
- both TOTP and passkeys,
- recovery codes as fallback if any active second-factor method exists.

For release simplicity, keep the existing settings area labeled
“Two-Factor Authentication”, but show separate sections:

- Authenticator app
- Passkeys
- Recovery codes

An account is considered to have active 2FA when it has at least one active TOTP
factor or at least one active passkey.

## Data Model

Use the existing `account_second_factors` table for passkey rows:

- `type = "passkey"`
- `status = "pending" | "active" | "disabled"`
- `label`: user-facing passkey label, defaulting to a browser/platform-derived
  label when available.
- `secret_encrypted`: empty string or a small encrypted placeholder for
  compatibility; WebAuthn public keys are not secret.
- `metadata`: WebAuthn credential metadata.

Proposed passkey metadata fields:

```ts
type PasskeyFactorMetadata = {
  credential_id: string; // base64url
  credential_public_key: string; // base64url-encoded COSE key bytes
  counter: number;
  transports?: string[];
  backed_up?: boolean;
  backup_eligible?: boolean;
  device_type?: "singleDevice" | "multiDevice";
  aaguid?: string;
  rp_id: string;
  origin: string;
  user_agent?: string;
  created_by_session_hash?: string;
};
```

Indexes:

- Existing indexes are enough for MVP.
- Add a unique partial index on active/pending passkey `credential_id` if the
  schema/migration layer makes this practical:
  `UNIQUE ((metadata->>'credential_id')) WHERE type='passkey' AND status IN
('pending','active')`.
- If expression indexes are awkward in the current schema machinery, enforce
  credential-id uniqueness in the server transaction first and add the DB index
  as a follow-up hardening item.

Challenge state:

- Continue using `account_auth_challenges`.
- Store WebAuthn registration/authentication options in `metadata`, including:
  - challenge
  - rp_id
  - origin
  - expected account id
  - purpose: setup, sign-in second factor, fresh auth
  - target session hash for fresh-auth flows

## RP ID and Origin

This is the main correctness risk.

WebAuthn verification must use the user-visible origin and RP ID, not internal
bay hostnames.

Rules:

- `rp_id` is derived from configured public site origin.
- For `https://cocalc.ai`, use `cocalc.ai`.
- For a bay URL under a shared parent domain, still use the parent RP ID only if
  the browser origin is a subdomain of that RP ID and product policy wants
  passkeys shared across bays.
- For launchpad/self-host, default RP ID to the configured public hostname.
- For development, support `localhost`/loopback origins where browsers allow
  WebAuthn.
- Never verify a passkey assertion against an internal service URL.

Implementation recommendation:

- Add a helper, e.g. `src/packages/server/auth/webauthn-origin.ts`, that returns:
  - `origin`
  - `rp_id`
  - `rp_name`
- Use the request’s public origin helpers and configured server settings.
- Fail closed if the public origin cannot be determined.
- In multibay, the account home bay verifies passkeys. If a browser starts on
  the wrong bay, use the existing wrong-home-bay retry pattern before creating
  or verifying passkey challenges.

## Library Choice

Use SimpleWebAuthn:

- `@simplewebauthn/server` in backend/auth code.
- `@simplewebauthn/browser` in frontend auth/settings code.

Reasons:

- It handles CBOR/COSE/WebAuthn edge cases.
- It is commonly used and actively maintained.
- It avoids hand-rolled WebAuthn parsing.

Package additions:

- Add server dependency to the package that owns auth backend code.
- Add browser dependency to the package that owns frontend auth UI.
- Keep versions pinned consistently across pnpm workspace constraints.

## Backend API Design

Add APIs under `/api/v2/auth/2fa/passkeys/*`:

- `setup/start`
- `setup/finish`
- `authentication/start`
- `authentication/finish`
- `list`
- `rename`
- `disable`

Alternative naming:

- Use `/api/v2/auth/passkeys/*` if we want passkeys to be conceptually broader
  later. For this phase, `/2fa/passkeys` is clearer and intentionally scoped.

### Setup Flow

`POST auth/2fa/passkeys/setup/start`

Requirements:

- User is signed in.
- User is not impersonating.
- Current browser session is fresh, or the endpoint requires fresh auth first.
- Account is on this home bay.

Behavior:

- Resolve RP ID and origin.
- Generate registration options with:
  - `userID = account_id`
  - `userName = email_address`
  - `userDisplayName = account name/email`
  - `rpName = site name`
  - `rpID = resolved rp_id`
  - exclude existing active passkey credential IDs
  - authenticator selection: platform preferred, resident key discouraged or
    preferred but not required; do not require discoverable credentials for this
    phase
  - user verification: preferred or required
- Store challenge/options in `account_auth_challenges` with purpose
  `passkey_setup`.
- Return browser registration options.

`POST auth/2fa/passkeys/setup/finish`

Requirements:

- User is signed in.
- User is not impersonating.
- Challenge exists, not expired, not completed.
- Account is on this home bay.

Behavior:

- Verify registration response using SimpleWebAuthn.
- Insert `account_second_factors` row:
  - `type="passkey"`
  - `status="active"`
  - `activated_at=NOW()`
  - metadata contains credential public key/counter/etc.
- If this is the account’s first active 2FA method, issue recovery codes.
- Mark challenge complete.
- Set current session fresh auth with `factor_level="passkey"` and default
  freshness window.
- Return passkey metadata and recovery codes if newly generated.

### Sign-In Second Factor Flow

Password sign-in behavior changes:

- If account has active TOTP/passkey, return:

```ts
{
  mfa_required: true,
  challenge_id,
  methods: ["passkey", "totp", "recovery_code"]
}
```

Only include methods that are actually available:

- include `passkey` if active passkeys exist
- include `totp` if active TOTP exists
- include `recovery_code` if recovery codes exist

`POST auth/2fa/passkeys/authentication/start`

Requirements:

- Sign-in challenge exists for the account, or current signed-in session exists
  for fresh-auth mode.
- Challenge/session is on this home bay.

Behavior:

- Generate authentication options with allowed credential IDs for active
  passkeys.
- Store the WebAuthn challenge in `account_auth_challenges.metadata` or create a
  child challenge row keyed by purpose.
- Return browser authentication options.

`POST auth/2fa/passkeys/authentication/finish`

Behavior:

- Verify assertion.
- Check credential belongs to the challenge account.
- Verify and update signature counter.
- Mark passkey `last_used_at=NOW()`.
- Mark sign-in challenge completed with `verified_factor_type="passkey"`.
- Return:

```ts
{
  account_id,
  factor_level: "passkey",
  password_verified_at,
  factor_verified_at,
  fresh_auth_until
}
```

Then `verify-second-factor.ts` can either call a unified backend helper or the
passkey finish endpoint can sign the user in directly. Prefer a unified helper
so cookie/session behavior stays centralized.

### Fresh Auth Flow

Fresh auth currently posts:

```ts
{
  (current_password, method, code, duration);
}
```

For passkey:

- Keep current password verification for this phase.
- Then use WebAuthn assertion instead of `code`.
- The frontend flow becomes two-step:
  1. `fresh-auth` start with password + `method="passkey"` creates WebAuthn
     options.
  2. Browser calls `navigator.credentials.get`.
  3. Finish endpoint verifies passkey and updates `fresh_auth_until`.

Implementation options:

- Option A: add dedicated passkey fresh-auth endpoints:
  - `auth/2fa/passkeys/fresh-auth/start`
  - `auth/2fa/passkeys/fresh-auth/finish`
- Option B: extend existing `auth/fresh-auth`.

Recommendation: use dedicated passkey endpoints to avoid overloading the simple
TOTP/recovery-code form body. Keep `freshAuthSession` as the common final state
setter.

Extended freshness:

- Current code only allows extended freshness for TOTP.
- Allow extended freshness for `passkey` as well, because passkeys provide a
  strong phishing-resistant factor.
- Keep recovery codes ineligible for extended freshness.

## Frontend UX

### Account Settings

Update `TwoFactorAuthSetting`:

- Rename visible copy from “Set up authenticator app” to a broader 2FA panel.
- Add “Add passkey” button.
- List active passkeys with:
  - label
  - created date
  - last used date
  - browser/platform hint if available
  - rename button
  - disable button
- Disable passkey management while impersonating, same as TOTP.
- Require fresh auth before disabling the last active second factor.
- Require fresh auth before adding a passkey unless the current session was just
  elevated.

### Sign-In

When `methods` includes `passkey`:

- Show “Use passkey” as the primary second-factor action.
- Keep “Authenticator code” and “Recovery code” as fallback options.
- If passkey verification fails or browser lacks WebAuthn support, show a clear
  fallback message and leave TOTP/recovery code available.

### Fresh Auth Modal

When active passkeys exist:

- Default to passkey verification.
- Show current password field first.
- Show “Verify with passkey” button.
- Keep “Use authenticator code or recovery code instead” fallback.
- Permit “Keep this verification active for 8 hours” for TOTP or passkey, but
  not recovery code.

### CLI Elevation

`cocalc auth elevate` already opens a browser approval flow.

Update the browser approval UI:

- If passkeys are available, default to passkey.
- Keep TOTP/recovery fallback.
- The CLI itself does not need WebAuthn support; browser handles it.

## Multibay Behavior

Passkeys are account-owned security state. The account home bay is
authoritative.

Rules:

- Passkey setup and verification must execute on the account home bay.
- Sign-in flow must route to home bay before passkey challenge creation.
- Fresh-auth flow must use the browser’s home-bay control session.
- Inter-bay dangerous-operation forwarding must continue to use session
  freshness state, not passkey material.
- Account rehome must move passkey rows with the rest of account auth state.
  Existing account rehome logic should include `account_second_factors`,
  `account_second_factor_recovery_codes`, `account_auth_challenges`, and
  `account_auth_sessions`; verify this explicitly.

Open design decision:

- Whether `rp_id` is global across all bays or per bay. For `cocalc.ai`, a
  global RP ID is likely best if all bay public origins are under `cocalc.ai` or
  the browser-facing origin is always `https://cocalc.ai`. For launchpad/self
  host, RP ID should be the configured hostname.

## Security Requirements

- Require HTTPS except localhost development.
- Never store private key material. Store credential public key and counter.
- Verify:
  - expected challenge
  - expected origin
  - expected RP ID
  - expected user/account
  - credential id belongs to account
  - signature counter behavior
  - user verification when required by policy
- Increment challenge attempts on failed assertions where possible.
- Expire challenges quickly.
- Disable, do not delete, passkeys by default.
- Do not allow disabling the last active second factor unless policy allows
  accounts without 2FA.
- Keep recovery codes available and rotatable.
- Log/audit:
  - passkey added
  - passkey renamed
  - passkey disabled
  - passkey used for sign-in second factor
  - passkey used for fresh auth
  - passkey verification failure above threshold

## Implementation Phases

### Phase 1: Backend Types and Storage

- Add `"passkey"` to `SecondFactorMethod` and `AuthSessionFactorLevel`.
- Add helper functions:
  - list active second-factor methods
  - list active passkeys
  - get passkey by credential id
  - mark passkey used
  - disable passkey
- Add WebAuthn origin/RP helper.
- Add SimpleWebAuthn dependencies.
- Add unit tests for method availability and RP helper.

### Phase 2: Passkey Setup

- Add setup start/finish HTTP endpoints.
- Generate and verify registration options.
- Store active passkey factor metadata.
- Generate recovery codes if this is first active 2FA method.
- Add settings UI button and passkey list.
- Add tests for:
  - setup requires signed-in home-bay account
  - setup rejects impersonation
  - setup stores only public credential metadata
  - setup returns recovery codes only when first 2FA method is enabled

### Phase 3: Sign-In Second Factor

- Make sign-in challenge return available methods dynamically.
- Add passkey authentication start/finish for sign-in challenges.
- Update sign-in UI to prefer passkey when available.
- Add tests for:
  - password sign-in returns `passkey` method when passkey exists
  - passkey assertion completes sign-in challenge
  - wrong credential/account/origin fails
  - TOTP and recovery fallback still work

### Phase 4: Fresh Auth

- Add passkey fresh-auth start/finish endpoints.
- Update `FreshAuthModal` to default to passkey when available.
- Allow extended freshness for passkey.
- Update `assertFreshAuthDurationMethodCompatible`.
- Add tests for:
  - passkey fresh auth sets `factor_level="passkey"`
  - dangerous-session helper accepts recent passkey verification
  - recovery code still cannot request extended freshness
  - impersonation actor fresh auth supports passkey for actor account

### Phase 5: CLI Browser Approval

- Update CLI login/elevation browser views to use passkeys where available.
- No CLI-native WebAuthn support in this phase.
- Add tests around browser approval payload and factor level propagation.

### Phase 6: Audit, Docs, and Operations

- Add admin/user docs:
  - passkeys require HTTPS
  - recovery codes remain important
  - passkeys are second factors, not passwordless sign-in
- Add security audit notes to the release scoreboard if implemented before
  release.
- Add smoke checklist:
  - macOS Touch ID / iCloud passkey
  - Windows Hello
  - Android/iOS passkey
  - hardware security key if available
  - launchpad/self-host hostname behavior
  - cocalc.ai production hostname behavior

## Test Strategy

Use real SimpleWebAuthn test vectors or library-generated test helpers where
possible. Do not hand-wave WebAuthn verification in unit tests only.

Minimum automated tests:

- Backend unit tests for challenge creation, method availability, and metadata
  validation.
- Backend integration-style tests for registration and assertion finish helpers
  using mocked SimpleWebAuthn verification outputs.
- Frontend tests for method selection and fallback UI.
- Regression tests that existing TOTP/recovery flows still pass.
- Multibay tests or mock-routing tests showing passkey operations route to
  account home bay.

Manual smoke tests:

- Add passkey to an account with existing TOTP.
- Add passkey as first 2FA method and save recovery codes.
- Sign in with password + passkey.
- Use passkey to satisfy dangerous-operation fresh auth.
- Use TOTP fallback after passkey cancellation.
- Use recovery-code fallback.
- Disable one passkey while another factor remains.
- Attempt to disable the last factor and verify policy.
- Verify CLI `auth elevate` browser flow with passkey.

## Risks and Mitigations

Risk: RP ID/origin mismatch across bays or launchpad.

- Mitigation: central helper, explicit tests, fail closed, production config
  smoke test.

Risk: Accidentally implementing passwordless sign-in surface.

- Mitigation: require password before all sign-in passkey assertions in this
  phase; challenge must be account-bound from prior password verification.

Risk: Lockout from disabling TOTP after adding a passkey.

- Mitigation: recovery codes remain required; warn before disabling last factor;
  keep recovery-code fallback.

Risk: Browser/platform WebAuthn incompatibility.

- Mitigation: TOTP/recovery fallback remains visible; passkey support is
  progressive enhancement.

Risk: Future dangerous RPCs bypass fresh-auth gates.

- Mitigation: passkeys improve usability but do not solve coverage. Continue the
  planned dangerous-RPC registry/regression test.

## Release Recommendation

Passkeys as a second factor are a strong usability/security improvement, but
they are not strictly required for the first public release if TOTP/recovery
fresh-auth is acceptable.

If implemented before release, keep the scope tight:

- second-factor only,
- no passwordless sign-in,
- no discoverable credential account lookup,
- no CLI-native WebAuthn,
- strong tests around RP ID/origin and fallback behavior.
