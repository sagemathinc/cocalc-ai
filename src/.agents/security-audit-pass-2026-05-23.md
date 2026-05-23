# Security Audit Pass - 2026-05-23

Scope: fresh audit pass after site-license seed-bay architecture, admin editing, notification, and account-rehome work. Focused on high-risk launch surfaces rather than broad code style:

- Dangerous public hub RPCs and fresh-auth coverage.
- Site-license and membership-package entitlement mutation paths.
- Multibay authority boundaries for seed-global site licenses and account rehome.
- Verified-email trust boundaries for site-license claims.

## Findings Fixed

### Software-license admin mutations lacked fresh auth

The admin software-license RPCs could create, revoke, restore, and edit tier
templates with ordinary admin authorization only. These actions mint or change
signed commercial entitlements, so a stolen admin browser session without recent
verification was enough.

Fix:

- `software.createLicense`, `software.revokeLicense`,
  `software.restoreLicense`, and `software.upsertLicenseTier` now require recent
  second-factor-backed fresh auth.
- The frontend software-license admin panel now attaches browser session context
  and retries through the standard fresh-auth modal.
- The dangerous RPC registry now classifies these RPCs as requiring fresh auth.

Validation:

- `packages/server`: `conat/api/software.dangerous-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Admin license listings exposed bearer software-license tokens

The broad admin software-license listing used `SELECT *`, which returned the
signed bearer license token for every license. The UI only needs tokens at
creation time; broad listings should not put all tokens on the wire.

Fix:

- `software.listLicenses` now selects explicit non-token columns.
- License creation still returns the newly created token once, and owner-facing
  license views can still show the owner's own token.

Validation:

- `packages/server`: `conat/api/software.dangerous-auth.test.ts`

### Global site-settings edits lacked fresh auth

`system.setSiteSettings` can change global configuration and propagate it to all
bays, including sensitive operational settings, but previously only required
ordinary admin authorization.

Fix:

- `system.setSiteSettings` now requires recent second-factor-backed fresh auth.
- The admin site-settings UI now passes browser context and uses the standard
  fresh-auth modal for single-setting and save-all flows.
- The dangerous RPC registry now classifies site-settings mutation as requiring
  fresh auth.

Validation:

- `packages/server`: `conat/api/system.site-settings-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Destructive Cloudflare R2 backup cleanup lacked fresh auth

`system.startCloudflareR2BayBackupCleanup` can enqueue deletion of Cloudflare R2
bay-backup objects, but it only required ordinary admin authorization.

Fix:

- `startCloudflareR2BayBackupCleanup` now requires recent second-factor-backed
  fresh auth before creating the cleanup LRO.
- The hub API type accepts `browser_id` and `session_hash` for browser and CLI
  callers.
- The dangerous RPC registry now classifies the cleanup start RPC as requiring
  fresh auth.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Hand-rolled admin fresh-auth checks diverged from the central helper

`createImpersonationGrant` and `startCloudflareTeardownApply` each implemented
their own fresh-auth/2FA checks. The custom code checked only that some factor
was present on the auth session, instead of using the centralized
`requireDangerousSessionAuth` helper that also handles second-factor recency,
dev CLI fresh-auth, and impersonation semantics consistently.

Fix:

- Both RPCs now use `requireDangerousSessionAuth` with
  `require_second_factor: true`.
- The dangerous RPC registry now explicitly marks Cloudflare teardown apply as
  fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### OpenAI/Codex external credential mutations lacked fresh auth

Users could store or revoke encrypted OpenAI API keys and other external
credentials with ordinary account auth. The credential payloads were not exposed
by listing/status APIs, but mutation of a credential that can spend money or
affect project execution should require a recent verification.

Fix:

- `system.setOpenAiApiKey`, `system.deleteOpenAiApiKey`, and
  `system.revokeExternalCredential` now require fresh auth before mutating an
  existing credential.
- The Codex credentials UI now passes browser session context and retries these
  actions through the standard fresh-auth modal.
- Hub API types and the dangerous RPC registry now classify these credential
  mutations as fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.external-credentials-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Site-license pool edits bypassed fresh auth through `updateMembershipPackage`

The public `purchases.updateMembershipPackage` RPC could update site-license pool domains, seat counts, and expiration via the generic membership package path without passing `browser_id` or `session_hash`. This was inconsistent with `adminProvisionSiteLicense`, `updateSiteLicense`, and `addSiteLicensePool`.

Fix:

- Site-license pool edits now require fresh auth in both the explicit `site_license_id` path and the local `pkg.kind === "site"` fallback path.
- The frontend wrapper now attaches `webapp_client.browser_id` for site-license pool edits.
- The dangerous RPC registry now classifies `purchases.updateMembershipPackage` as requiring fresh auth for the site-license pool case.

Validation:

- `packages/server`: `conat/api/purchases.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`
- `packages/frontend`: `account/__tests__/membership-package-manager.test.tsx`

### Site-license managers could administer owner/manager roles

The role-admin path used write-manager authorization, which meant a site-license manager could promote themselves or others to owner, demote owners, or remove managers. That is too broad for an administrative control plane.

Fix:

- `setSiteLicenseManager` and `removeSiteLicenseManager` now require site-license owner or platform admin.
- Ordinary managers still retain write access for operational site-license actions such as request review and pool/license management.

Validation:

- `packages/server`: `membership/site-licenses.test.ts`

### Site-license structural edits were available to customer managers/owners

`updateSiteLicense`, `updateSiteLicensePool`, and `addSiteLicensePool` used the same write-manager authorization as operational request workflows. That meant a customer site-license owner or manager could change structural/commercial license terms such as allowed domains, pool seat counts, expiration, and newly available pools.

Fix:

- Site-license creation, site-license settings edits, pool edits, and pool creation now require platform admin authorization.
- Customer owners/managers still retain the intended operational paths such as request review and owner-only manager administration.

Validation:

- `packages/server`: `membership/site-licenses.test.ts`

### Generic seat assignment could bypass site-license claim policy

The public `purchases.assignMembershipPackageSeat` RPC treated site-license pools like ordinary owner-owned team packages. Since site-license pool packages are owned by the customer license owner, that owner could directly assign arbitrary accounts or reserved email seats into a site-license pool. That bypassed verified-domain matching, custom terms acceptance, manager-approval requests, and exclusive-group institutional claim tracking.

Fix:

- The public generic seat-assignment RPC now rejects `kind='site'` membership packages.
- Site-license seats must be created through the site-license workflows: verified self-claim or manager-approved request. Those internal workflows still use the lower-level package assignment primitive after policy checks pass.

Validation:

- `packages/server`: `conat/api/purchases.test.ts`

### Admin account creation lacked fresh auth

`system.adminCreateUser` can create an account with an explicit or generated
password, but it only required ordinary admin authorization. A stolen admin
session without recent verification could mint a new durable account and retain
access after the original session was revoked.

Fix:

- `system.adminCreateUser` now requires recent second-factor-backed fresh auth
  before password generation or account creation.
- Hub API types accept `browser_id` and `session_hash`; CLI callers continue to
  work through the existing Conat `auth_session_hash` injection after
  `cocalc auth elevate` or `cocalc auth elevate --dev`.
- The dangerous RPC registry now classifies admin account creation as
  fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### SSO/passport unlink lacked fresh auth

`system.deletePassport` removes a linked SSO/passport login method from the
signed-in account, but it only required ordinary account authorization. A stolen
browser session could weaken the account's future sign-in posture by unlinking a
federated login method without any recent verification.

Fix:

- `system.deletePassport` now requires recent second-factor-backed fresh auth.
- The account settings UI passes browser context and retries unlinking through
  the standard fresh-auth modal.
- The dangerous RPC registry now classifies passport unlinking as
  fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Parallel worker limit mutations lacked fresh auth

`system.setParallelOpsLimit` and `system.clearParallelOpsLimit` can change
global, provider, or project-host worker concurrency caps. These limits affect
availability, operational throughput, and potentially spend, but previously only
required ordinary admin authorization.

Fix:

- Parallel worker limit set/clear RPCs now require recent
  second-factor-backed fresh auth.
- The Hosts admin UI passes browser context and retries limit changes through
  the standard fresh-auth modal.
- The dangerous RPC registry now classifies both RPCs as fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Materialized bay restore operations lacked fresh auth

`system.runBayRestore` can materialize a database restore when `dry_run=false`,
and `system.runBayRestoreTest` materializes a fenced restore workspace for
backup verification. Both operations can write substantial restored database
state to disk, but previously only required ordinary admin authorization.

Fix:

- `runBayRestore` now requires recent second-factor-backed fresh auth when the
  call is not a dry-run.
- `runBayRestoreTest` now requires recent second-factor-backed fresh auth.
- Dry-run restore planning and normal backup execution remain ordinary
  admin-authorized operational reads/runs.
- The dangerous RPC registry now classifies materialized bay restore RPCs as
  fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/system.bay-load.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`

### Cloudflare bootstrap lacked fresh auth

`system.bootstrapCloudflareConfiguration` accepts a high-privilege Cloudflare
bootstrap token and can write Cloudflare tunnel and R2 settings. It previously
required only ordinary admin authorization, so a stolen admin session without
recent verification could reconfigure cloud infrastructure secrets.

Fix:

- Cloudflare bootstrap now requires recent second-factor-backed fresh auth.
- The Cloudflare site-settings wizard passes browser context and retries the
  bootstrap through the standard fresh-auth modal.
- The dangerous RPC registry now classifies Cloudflare bootstrap as
  fresh-auth-required.

Validation:

- `packages/server`: `conat/api/system.admin-maintenance-auth.test.ts`
- `packages/server`: `conat/api/dangerous-rpc-registry.test.ts`
- `packages/frontend`: `admin/site-settings/cloudflare-config-wizard.test.tsx`

### False email verification markers could be treated as verified

`getVerifiedEmailAddressesForAccount` normalized keys but then looked up values using the normalized key. It also had a fallback that could treat a non-null false marker as verified. This mattered because site-license claims rely on verified institutional email addresses.

Fix:

- Verified email extraction now iterates entries directly, normalizes email keys, and only accepts non-null, non-false verification values.

Validation:

- `packages/server`: `membership/site-licenses.test.ts`

### Account rehome destination could delete seed site-license packages

The source-side account rehome cleanup already excluded `membership_packages.kind='site'`, but the destination-side replacement path deleted all owned `membership_packages`, `membership_package_assignments`, and `membership_side_effects_outbox` rows before restoring portable state. If an account was rehomed onto the seed bay, this could delete seed-global site-license pools for that owner.

Fix:

- Destination replacement now deletes only non-site membership packages.
- Assignment and side-effect replacement deletes only rows belonging to non-site owned packages.

Validation:

- `packages/server`: `accounts/rehome.test.ts`

## Reviewed Surfaces

- Public hub dangerous RPC registry and name-based coverage.
- Purchase/site-license RPC wrappers and seed-bay routing.
- Site-license membership package creation, update, request, review, and manager mutation logic.
- Inter-bay account-local site-license routing to the configured seed bay.
- Account membership portability filters for rehome and repair.
- Site-license verified-email extraction and request trust boundary.

## Residual Follow-Up

- Do another focused pass on non-site purchase flows. `purchaseMembershipPackage` still only requires fresh auth when browser/session context is provided; this may be intentional for CLI/server flows, but it is worth explicitly documenting or tightening before launch.
- Re-run live multibay smoke after rebuild/restart, especially account rehome onto seed and away from seed with active site-license grants.
- Add a periodic security audit checklist item for new `membership_packages` owners: any new account-owned table must decide whether site-license rows are portable or seed-global.
