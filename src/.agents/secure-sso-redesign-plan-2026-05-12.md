# Secure SSO Redesign Plan

Status: draft plan, 2026-05-12.

This plan is for a new secure and maintainable SSO implementation for
`cocalc-ai`. The legacy CoCalc.com SSO system used Passport.js and supported
many providers, but the product need for `cocalc-ai` is much smaller:

- one easy public SSO provider: Google,
- enterprise/org SSO through explicit admin configuration,
- no database-only setup requirement for normal site admins,
- no users without verified email addresses,
- no long-tail public OAuth providers,
- CoCalc-native 2FA remains valuable even when external SSO also has 2FA.

The target is not just "replace Passport." The target is a clear identity policy
layer where every account-creation and sign-in path has the same release-safe
rules.

## Goals

1. Provide Google sign-in as the only public SSO provider.
2. Provide admin-configurable organization SSO using SAML and, where useful,
   Google Workspace domain policy.
3. Delete unsupported public providers rather than hiding them behind feature
   flags.
4. Require verified email for all SSO-created and password-created accounts.
5. Keep CoCalc's built-in 2FA as an independent local second layer, even for
   users who sign in through Google or SAML.
6. Allow admins to require SSO for selected email domains, such as
   `cornell.edu`.
7. Allow admins to require 2FA for selected email domains, such as
   `sagemath.com`.
8. Make all normal configuration available from admin UI/settings, not by
   manually editing Postgres rows.
9. Keep signup policy integrated with registration-token and public-signup
   settings.

## Non-Goals

1. Do not preserve Facebook, Twitter, GitHub, or other legacy public OAuth
   providers for `cocalc-ai`.
2. Do not support SSO account creation when the provider does not return a
   verified email address.
3. Do not make Passport.js compatibility a requirement.
4. Do not build complex SCIM/user-provisioning workflows for the first release.
5. Do not treat external-provider MFA as a complete replacement for CoCalc 2FA.

## Security Model

Authentication produces an identity assertion. CoCalc still owns the account,
session, authorization, local 2FA, freshness, billing, projects, API keys, and
dangerous-action policy.

Required session facts:

- `account_id`
- `auth_method`: `password`, `google_oidc`, `saml`
- `provider_id`, when applicable
- `email_address`
- `email_verified`
- `sso_domain`, when applicable
- CoCalc auth session hash/freshness metadata
- CoCalc 2FA level, independent from external SSO

Important rule: external SSO can establish "this external identity controls this
verified email." It must not bypass CoCalc's local 2FA or dangerous-action
freshness rules.

## CoCalc 2FA With SSO

CoCalc-native 2FA should remain fully supported and encouraged for SSO users.
This gives a useful defense-in-depth model:

1. The external provider authenticates the user and may enforce its own MFA.
2. CoCalc establishes a local session from the verified external identity.
3. CoCalc can still require its own TOTP/recovery-code factor for:
   - account security settings,
   - API-key creation,
   - billing and membership mutations,
   - admin/operator actions,
   - browser raw exec policy changes,
   - other dangerous actions.

This is especially useful for hosted `cocalc.ai`, since a compromised Google or
enterprise SSO session should not automatically have maximum CoCalc authority.

## Provider Policy

### Public Google OIDC

Google is the only built-in public SSO provider for the first release.

Admin settings should include:

- `google_sso_enabled`
- `google_sso_client_id`
- `google_sso_client_secret`, encrypted at rest
- `google_sso_allowed_domains`, optional comma-separated domain allowlist
- `google_sso_signup_mode`: `disabled`, `registration_token_required`,
  `public_allowed`

Admin UI should include setup guidance:

- where to create a Google OAuth/OIDC client,
- required redirect URI for the current site origin,
- required scopes: `openid email profile`,
- warning that only verified emails are accepted,
- warning that domain restrictions should use the domain policy table for
  organization enforcement.

Google sign-in must reject any response without:

- stable provider subject,
- email address,
- `email_verified=true`.

### Organization SAML

SAML is the enterprise provider path.

Admin settings/UI should support creating provider records with:

- display name,
- enabled flag,
- entity ID,
- SSO URL,
- certificate or metadata XML,
- requested name ID / email attribute mapping,
- optional allowed email domains,
- optional default membership/organization assignment if later needed.

SAML sign-in must reject assertions without a verified or explicitly trusted
email claim. For SAML, "verified" is usually a trust decision attached to the
configured IdP and allowed domain, not a provider-supplied boolean.

### Deleted Providers

Delete cocalc-ai UI and signup/sign-in support for:

- Facebook,
- Twitter/X,
- GitHub,
- any other generic public OAuth provider.

Rationale:

- they are not required for `cocalc-ai`,
- they increase account-creation and provider-maintenance surface,
- some providers do not reliably return verified email,
- GitHub accounts without email are explicitly undesirable for abuse/security.

## Domain Authentication Policy

Add a first-class domain policy model managed from admin UI.

Suggested model:

```ts
type DomainAuthMode = "password_allowed" | "sso_required" | "sso_signup_only";

type DomainAuthPolicy = {
  domain: string;
  mode: DomainAuthMode;
  provider_id?: string;
  provider_kind?: "google_oidc" | "saml";
  require_cocalc_2fa?: boolean;
  enabled: boolean;
};
```

Behavior:

- If `foo@cornell.edu` matches `cornell.edu` with `sso_required`, password
  sign-in must not verify a password or reveal account state. It should return a
  clear "Use Cornell SSO" response with the correct provider link.
- Password signup for an SSO-required domain should be blocked before account
  creation.
- SSO signup for a domain must still obey registration-token/public-signup
  policy unless the admin explicitly configures that provider/domain as allowed
  to create accounts.
- Domain policy may additionally require CoCalc-native 2FA for matching
  accounts. This is independent of whether the external SSO provider also
  enforces MFA.
- Domain matching must normalize case and reject ambiguous malformed emails.

## Signup Policy Integration

Every account-creation path must go through one policy function.

Inputs:

- requested email,
- auth method,
- provider ID,
- provider subject,
- email verified/trusted status,
- registration token redemption result, if any,
- public signup setting,
- domain auth policy,
- existing account lookup result.

Required outcomes:

- `allow_create`
- `deny_generic`
- `deny_use_sso`
- `deny_registration_token_required`
- `deny_email_unverified`
- `deny_existing_account`
- `deny_domain_policy`

Rules:

- Signup never signs in an existing account.
- Token-gated signup validates the registration token before returning
  account-specific errors.
- SSO account creation requires verified/trusted email.
- Password account creation requires email verification or a redeemed
  registration token before meaningful app use.
- Public signup without a token remains explicit opt-in.
- SSO public signup is not automatically enabled just because Google SSO is
  configured.

## Password Accounts, Registration Tokens, And Email Verification

For password-created accounts, email verification should become a product-level
gate.

Recommended first release behavior:

- allow account creation if registration/public-signup policy allows it,
- create account in `email_unverified` state,
- allow only minimal account settings and verification resend,
- block project creation, Codex/ACP, API keys, billing mutations, invitations,
  and public sharing until email is verified or the account was created using a
  valid registration token.

This prevents throwaway unverified email accounts from using expensive resources
while avoiding a hard dependency on email delivery for simply creating the
account row.

Registration-token exception: small private sites may not have outbound email
configured, and a valid registration token is already an explicit trust grant.
For product-access gates, "verified email" and "account created through a valid
registration token" should both satisfy the trusted-account requirement. This
does not mean registration tokens should bypass domain SSO requirements or
CoCalc 2FA requirements.

## Data Model Direction

Prefer new explicit identity tables over overloading the legacy `passports`
field.

Suggested tables:

### `identity_providers`

- `provider_id`
- `kind`: `google_oidc` or `saml`
- `name`
- `enabled`
- encrypted provider config
- created/updated audit fields

### `account_identities`

- `account_id`
- `provider_id`
- `provider_subject`
- `email_address`
- `email_verified`
- `last_used`
- unique `(provider_id, provider_subject)`

### `domain_auth_policies`

- domain policy fields described above.

Secrets such as OAuth client secrets and SAML private material must use the
site secret encryption mechanism, not plaintext config rows.

## Implementation Strategy

### Phase 1: Policy Boundary First

1. Inventory current signup/sign-in account-creation paths.
2. Add a shared account-creation policy function.
3. Ensure password signup, Google signup, SAML signup, and future SSO all call
   the same policy.
4. Add tests for:
   - public signup disabled,
   - registration token required,
   - registration-token-created account can pass product-access gates without
     email delivery,
   - existing account cannot be signed in through signup,
   - SSO without verified email denied,
   - SSO-required domain blocks password signup/sign-in.

### Phase 2: Delete Legacy Public Providers

1. Remove Facebook/Twitter/GitHub provider types from cocalc-ai signup/sign-in
   UI.
2. Remove provider-specific server routes/config if no longer referenced.
3. Keep a temporary internal compatibility shim only if required to avoid
   breaking unrelated code during the transition.
4. Add tests that provider discovery only returns Google and configured org
   providers.

### Phase 3: Admin-Configured Google OIDC

1. Add admin settings/UI for Google OIDC client configuration. Status:
   implemented through admin site settings. Client secret storage is encrypted;
   legacy DB-only Google rows are ignored.
2. Implement direct OIDC flow or a minimal OIDC library integration. Status:
   implemented with direct code flow and ID-token validation against Google's
   JWKS.
3. Require `openid email profile` and `email_verified=true`. Status:
   implemented for Google.
4. Link identity to existing account only after safe policy checks.
5. Keep CoCalc 2FA/fresh-auth requirements unchanged after SSO login.

### Phase 4: Domain Policy UI

1. Add admin UI for domain auth policies. Status: first-class
   `sso_providers` and `sso_domain_policies` tables plus an Administration
   panel exist.
2. Add sign-in UI support for "Use SSO for this email/domain." Status:
   implemented for enabled `sso_required` domain policies that point at a
   configured provider.
3. Add optional domain policy for requiring CoCalc-native 2FA. Status:
   enforced for password sign-in and SSO sign-in. Password sign-in is denied if
   the matching domain requires CoCalc 2FA and the account has no active second
   factor; SSO sign-in creates a public second-factor challenge before setting
   sign-in cookies. New account creation is denied for matching domains because
   a newly created account cannot already have an active CoCalc second factor.
4. Add clear error/redirect responses for password attempts on SSO-required
   domains.
5. Add tests for domain normalization, SSO precedence, and domain-level CoCalc
   2FA requirements. Status: focused policy, auth API, and public auth route
   tests cover the implemented paths.

### Phase 5: Organization SAML

1. Add admin UI for SAML provider config. Status: implemented with structured
   provider fields for IdP metadata XML, IdP entity ID, SSO URL, signing
   certificate, allowed domains, account-creation mode, and copyable SP
   metadata/ACS URLs.
2. Implement direct SAML flow using a focused maintained library. Status:
   implemented using `@node-saml/passport-saml`'s direct `SAML` API, not
   Passport strategy routing.
3. Require trusted email mapping and allowed-domain checks. Status: SAML
   profiles are normalized into the existing `PassportLogin` path, which
   applies allowed-domain checks, domain policy, registration-token signup
   policy, and CoCalc 2FA requirements.
4. Add provider-specific sign-in links and error diagnostics for admins. Status:
   provider links and metadata URLs exist; richer test-configuration diagnostics
   remain open.
5. Add a minimal local SAML dev IdP launcher. Status: `pnpm dev:saml:idp`
   prints a matching CoCalc provider config, creates a disposable test IdP
   certificate under `src/.saml-dev`, and starts `saml-idp` via `pnpm dlx`.

### Phase 6: Passport Removal

Once Google OIDC and SAML are implemented directly:

1. remove Passport.js dependency from cocalc-ai auth paths,
2. delete legacy passport provider config types,
3. migrate or remove legacy `passports` account-field usage,
4. update API/docs/admin UI.

Passport removal is valuable, but it is lower priority than enforcing policy
correctly around account creation and verified email.

## Admin UX Requirements

Admin SSO page should show:

- configured providers,
- current public Google SSO status,
- current domain policies,
- whether public signup without token is enabled,
- whether SSO-created accounts may be created without registration tokens,
- setup instructions and redirect URLs,
- test-configuration button if practical.

Sign-in UX should:

- show Google only if configured and enabled,
- ask for email first when domain policy might affect the available auth
  methods,
- show organization SSO only when an email/domain maps to a provider or the
  provider is intentionally public,
- avoid listing internal SAML providers publicly by default,
- stop showing long-tail legacy provider buttons,
- clearly explain "this domain requires SSO" instead of generic password
  failure.

## Audit And Logging

Record audit events for:

- provider create/edit/delete. Status: implemented via sanitized
  `sso_provider_config_changed` central-log events; secret values, cert bodies,
  and metadata XML are not logged,
- domain policy create/edit/delete. Status: implemented via sanitized
  `sso_domain_policy_changed` central-log events,
- SSO signup allowed/denied. Status: covered by the shared SSO sign-in audit
  path with `new_account_created`,
- SSO sign-in allowed/denied. Status: implemented via
  `sso_sign_in_allowed` / `sso_sign_in_denied`, including direct Google/SAML
  callback failures before `PassportLogin`,
- account identity linked/unlinked. Status: implemented for passport
  link/unlink and unlink-blocked events,
- password attempt blocked because domain requires SSO. Status: implemented
  via `sso_required_password_sign_in_blocked`,
- SSO result rejected because email was missing or unverified. Status: covered
  by shared SSO denial logging.

Do not log raw tokens, authorization codes, SAML assertions, OAuth client
secrets, or full provider responses.

## Release Gates

Do not ship the new SSO implementation until:

- unsupported public providers are deleted from cocalc-ai auth UI and server
  discovery,
- every SSO account creation requires verified/trusted email,
- public signup and registration-token policy applies consistently to SSO
  account creation,
- product-access gates accept either verified email or valid registration-token
  signup, so private sites without outbound email can still operate,
- password signup/sign-in cannot bypass domain SSO-required policy,
- CoCalc 2FA remains enforceable for SSO users,
- domain policy can require CoCalc-native 2FA independent of provider MFA,
- admin UI can configure Google without database edits,
- provider secrets are encrypted at rest,
- focused tests cover the main account-creation and sign-in policy decisions.

Focused verification on 2026-05-12:

- Product-access gating for unverified password accounts is not complete.
  Signup policy computes whether an account-creation path is trusted, but that
  trust result is not persisted as an account fact and is not centrally enforced
  by project creation, API-key creation, Codex/ACP, billing, invitations, or
  public-sharing paths.
- Follow-up implementation started on 2026-05-12: registration-token-created
  accounts persist a server-owned `trusted_product_access` marker; project
  creation, API-key creation, central Codex auth entry points, and project-owner
  ACP admission limits now enforce verified email or trusted creation when
  email verification is configured. Membership purchase/seat/package mutation
  flows and collaboration invitation/acceptance flows now enforce the same
  gate. Public sharing still needs a separate pass.
- Sites without an email backend need an explicit exception model. If
  `verify_emails` is disabled or email sending is unavailable, email
  verification cannot be the release gate; registration-token-created accounts
  and admin-created accounts should satisfy the trusted-account requirement.
- SSO provider secrets are release-safe only if provider rows stay non-secret.
  Public Google OIDC client secrets belong in encrypted site settings; SAML
  provider rows should store public IdP metadata/certificates only and reject
  private keys, OAuth client secrets, passwords, and tokens.

## Relationship To Current Security Audit

This is a follow-up to `SEC-REG-001`, but it should run after
`SEC-ROOTFS-001`. Rootfs is currently the clearer unbounded-cost release blocker.

Recommended order:

1. Finish `SEC-ROOTFS-001`.
2. Return to SSO as `SEC-SSO-001`.
3. Implement Phase 1 policy boundary and provider deletion first.
4. Replace remaining non-Google organization Passport paths with direct
   SAML/OIDC next; Google no longer depends on Passport.js and the
   provider/domain policy skeleton is in place. Status: direct SAML is
   implemented; generic non-Google OIDC remains deferred until there is a
   concrete customer requirement.
