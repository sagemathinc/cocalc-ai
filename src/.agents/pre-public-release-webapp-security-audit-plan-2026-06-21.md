# Pre-Public Release Web App Security Audit Plan

Date: 2026-06-21

Status: In progress. Phases 1, 2, and 3 are done except manual
smoke/adversarial testing.
This follows the completed purchasing/security code audit and focuses on the
remaining highest-risk web-app surfaces before the first public release.

## Context

CoCalc AI is approaching first public release as a paid web application with
free users, free trials, paid memberships, course/student flows, project hosts,
browser-visible project data, and direct project-host data-plane traffic.

The purchasing audit is done except manual Stripe/UI follow-up. SSO and
password auth have had multiple focused passes. The next release-critical
security work should cover the broader surfaces where a public web app is most
likely to fail:

- anonymous or semi-public HTTP endpoints;
- project-host and data-plane authorization;
- secrets, API keys, and one-time tokens;
- free-user, trial, and resource-abuse enforcement.

These four tracks are independent enough to audit separately, but findings
should be fixed immediately in separate commits when they are release-blocking.

## Release Blocker Standard

Treat a finding as release-blocking if it enables any of the following:

- unauthenticated private data disclosure;
- unauthenticated or weakly authenticated mutation of account, project, billing,
  membership, host, or security state;
- cross-account, cross-project, cross-bay, or cross-host access to data or
  actions the user does not own;
- API key, bearer token, browser token, invitation token, reset token, or
  project-host token scope bypass;
- project-host data-plane access without a current scoped authorization;
- free, trial, or unpaid accounts causing unbounded CPU, RAM, disk, egress,
  blob, rootfs, AI, or project-host cost;
- leaked secrets, long-lived credentials, auth tokens, internal topology,
  project-host bootstrap material, or sensitive logs;
- public/debug/status endpoints revealing enough information to materially help
  an attacker.

## Cross-Cutting Rules

- Every audit should ask which bay is authoritative for the data or action.
- Account-owned state routes by `home_bay_id`.
- Project-owned state routes by `owning_bay_id`.
- Host-owned state routes by `bay_id`.
- Global cluster state should be seed-authoritative unless explicitly designed
  as bay-local cache state.
- The hub/control plane should authorize, route, and issue scoped access, but
  steady-state project data should not be proxied through the hub unless there
  is a documented reason.
- Browser-visible code is never an authority boundary. Server and project-host
  handlers must recompute authority from trusted state.

## Phase 1: Anonymous and Public HTTP Attack Surface

Status: Done except manual follow-up, 2026-06-21.

Goal: ensure every route reachable without a logged-in browser session is
explicitly intended to be public and cannot be used to mutate or disclose private
state.

Primary source surfaces:

- `src/packages/http-api/pages/api/v2/`
- `src/packages/next/pages/api/`
- `src/packages/frontend/public/`
- `src/packages/frontend/public/routes.ts`
- `src/packages/server/auth/`
- SSO callbacks, password reset, email verification, invitation/redeem flows,
  public sharing, project viewer routes, preview/app server entry points, status
  pages, support/contact routes, and static metadata endpoints.

Audit questions:

- Is every unauthenticated endpoint classified as public-read, callback,
  token-redeem, static, or bug?
- Does every mutation require a real logged-in session, valid scoped token, or
  deliberately narrow public token?
- Are API-key and bearer-token paths forbidden for browser-only public flows
  where they would bypass freshness, CSRF, origin, or UI constraints?
- Are callback and redirect URLs constrained against open redirect and callback
  confusion?
- Are one-time tokens high entropy, expiring, scoped, and replay-safe where
  replay would matter?
- Do public routes avoid leaking account emails, internal account IDs, private
  project IDs, bay IDs, hostnames, logs, stack traces, internal status, or
  configuration?
- Are rate limits, throttles, or abuse checks present for unauthenticated flows
  that can send email, create accounts, create work, or consume CPU/network?

Execution:

- Inventory unauthenticated routes and classify each route in audit notes.
- Trace each public mutation to the exact server-side authority check.
- Manually test logged-out access to representative public and non-public
  endpoints.
- Add focused regression tests for any blocker that is fixed.

Completed audit notes:

- No `src/packages/next/pages/api/` tree is present in this checkout. The live
  API surface for this phase is `src/packages/http-api/pages/api/v2/`, public
  frontend routes under `src/packages/frontend/public/`, and auth helpers under
  `src/packages/server/auth/`.
- Public/no-session HTTP API routes were classified as public metadata/static
  reads (`customize`, public news, SSO strategy metadata, service-cost
  estimates, software status, API index, no-op bookmarks), narrow auth/token
  flows (sign-in, sign-up, password reset, email verification, 2FA/passkey,
  CLI auth, project invite links), or optional-session support/user-query flows.
- Anonymous `user-query` reads are constrained by database schema
  `anonymous: true`, and the scan found only the public `news` table using that
  flag. Anonymous set queries are rejected.
- Public SSO/customize metadata does not expose provider client secrets or
  private OAuth/SAML material. Strategy metadata exposes intended button/domain
  policy information only.
- Public auth redirect targets are normalized to app-relative paths and reject
  external URLs, protocol-relative URLs, root/default loops, and nested auth
  loops.
- Fixed release blocker: production `apiRoute` wrappers previously skipped
  method enforcement when validation was disabled, while the router dispatches
  every API route with `router.all(...)`. Commit `276fb8522a` now enforces the
  declared operation method in production and returns `405` with `Allow`.
- Fixed release blocker: hand-written auth, 2FA, passkey, CLI auth, invite,
  support, and admin news handlers did not have a uniform method guard. Commit
  `54dd75369a` now rejects non-POST requests before any token, cookie, account,
  session, or mutation work for those handlers.

Validation:

- `cd src/packages/http-api && pnpm tsc --build`
- `cd src/packages/http-api && pnpm exec jest ./pages/api/v2/auth/sign-in.test.ts ./pages/api/v2/auth/password-reset-api.test.ts ./pages/api/v2/projects/email-invite.test.ts ./pages/api/v2/support-api-key-scope.test.ts ./pages/api/v2/news-fresh-auth.test.ts`
- `cd src/packages/http-api && pnpm test-api`

Manual follow-up:

- Logged-out browser/API smoke test representative public routes:
  `customize`, `news/list`, `auth/sso-strategies`, `auth/requires-token`,
  password reset request, password reset redeem with bogus token, project invite
  preview/redeem with bogus token, support ticket creation, and a private route
  expected to reject anonymous access.
- Decide separately whether password reset/sign-up copy should hide account
  existence even when registration-token mode is off. This is a privacy/abuse
  hardening decision, not an authority bypass found in this phase.

## Phase 2: Project-Host and Data-Plane Authorization

Status: Done except manual follow-up, 2026-06-21.

Goal: ensure files, terminals, Jupyter, Codex, app previews, sync, and other
project-host services are only reachable with current project-scoped authority.

Primary source surfaces:

- `src/packages/project-host/`
- `src/packages/conat/project-host/`
- `src/packages/conat/project/`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/conat/api/projects.ts`
- `src/packages/server/project-host/`
- `src/packages/frontend/project/`
- file services, terminals, Jupyter, Codex/agent services, browser sessions,
  app/server proxying, previews, syncdoc, project secrets, and project viewer
  code.

Audit questions:

- Can a client select an arbitrary `project_id`, `host_id`, subject, websocket,
  or project-host URL to access another user's project?
- Is project access resolved through the authoritative project owner and current
  collaborator/viewer role rather than stale frontend state?
- Are viewer, collaborator, owner, and admin capabilities separated on the
  project-host services themselves?
- Are scoped project-host tokens bound to project, account/session, purpose,
  role, expiration, and host where appropriate?
- Does revoking a collaborator or changing a role invalidate or bound the
  lifetime of existing project-host access?
- Are project moves, host replacement, and stale browser tabs safe?
- Are hub-issued host/bootstrap/control tokens impossible to reuse from user
  code inside a project?
- Are app server and preview routes constrained to the intended project and
  permissions, including public-viewer cases?
- Are Conat subjects named in a way that prevents cross-project collisions or
  confused deputy routing?

Execution:

- Map every externally reachable project-host service to its auth input and
  authority check.
- Test adversarial cases with two accounts and two projects:
  unauthorized file open, terminal start, Jupyter access, app preview, public
  share, collaborator removal, role downgrade, project restart, and stale token.
- Verify cross-bay/project-host routing uses the routing layer rather than local
  database shortcuts.
- Add regression tests for any auth bypass that is fixed.

Completed audit notes:

- Hub-to-project-host routing issues signed project-host JWTs that are bound to
  the target host audience (`project-host:<host_id>`) with short expirations.
  Remote host cases route through the inter-bay host API; local cases sign with
  the local host key. The helper never trusts a frontend-selected project-host
  URL as the authority.
- Account-issued project-host tokens are gated by current project access before
  issuance. Project-host Conat authorization then rechecks local synced project
  membership per subject, so a token alone does not grant access to another
  project on the same host.
- The apparent `host_id` override path in
  `hosts.issueProjectHostAgentAuthToken` is safe: the Conat API transform
  `authFirstRequireHost` overwrites caller-supplied `host_id` with the
  authenticated project-host id before the method runs.
- Project-host Conat auth accepts bearer tokens, project-host browser-session
  cookies, and a restricted project-secret path. Project-secret auth is only
  accepted from trusted local project peers and rejects forwarded external
  connections; browser-session and bearer auth take precedence over
  project-secret cookies.
- Viewer access is separated from collaborator/owner access at the project-host
  subject-policy layer. Viewers are allowed only on their
  `fs-viewer.project-<project_id>.account-<account_id>` subject and are denied
  normal fs, file-server, persist, acp, codex, terminal/storage, and
  `hub.project` subjects. The viewer filesystem is read-only and applies the
  per-viewer read policy after canonicalizing symlinks through the project
  sandbox.
- API keys cannot use project-host file-server management subjects. They are
  limited to ordinary project/fs subjects and still require both declared API
  key capability and current collaborator access.
- HTTP/app/file proxy authorization is enforced on the project host before
  proxying. Browser-session cookies and HTTP session cookies still require
  current local collaborator access for the requested project, and positive
  collaborator decisions are cached only briefly. Query bearer tokens are
  stripped or redirected after successful auth so they are not forwarded to app
  backends.
- Project-host HTTP session cookies are project-path scoped. Existing tests
  cover path scoping, stale broad cookie handling, shared browser-session to
  project HTTP session minting, websocket upgrade auth, and query token
  stripping.
- Project file-server paths are served through `createProjectSandboxFilesystem`
  and `SandboxedFilesystem.safeAbsPath` / canonical path checks. Direct
  container file I/O uses `O_NOFOLLOW` and revalidates opened file descriptors
  against the project root to mitigate symlink and TOCTOU escapes.
- Server-side file-server clients intentionally do not authorize by themselves;
  caller-side APIs must authorize before requesting a routed file-server client.
  The reviewed user-triggered callers for imports, copy, scratch volume,
  snapshots, backups, restore, and backup file reads perform collaborator,
  viewer-read-policy, dangerous-operation, or storage-destructive checks before
  calling into the project-host file service.
- Background workers and host control flows that call file-server clients
  without an account are hub/host-authoritative maintenance paths, not
  browser-user authority paths.
- Public app/preview access is gated by the project-host public-exposure feature
  flag, per-app live exposure state, path matching under the requested project
  id, and optional app token. Static app roots are constrained to project
  writable areas and then served through a read-only sandbox rooted at the
  resolved static root.
- No release-blocking Phase 2 authorization bypass was found in this code
  review pass.

Validation:

- Code review of project-host token issuance, host routing, project-host Conat
  auth, HTTP proxy auth, file-server sandboxing, viewer read-only filesystem,
  public app access, file-server client callers, and relevant existing tests.
- Existing focused coverage includes:
  `src/packages/project-host/conat-auth.test.ts`,
  `src/packages/project-host/http-proxy-auth.test.ts`,
  `src/packages/conat/auth/subject-policy.test.ts`, and
  `src/packages/server/conat/socketio/auth.test.ts`.

Manual follow-up:

- Exercise two-account/two-project browser tests for unauthorized file open,
  terminal start, Jupyter access, Codex/project service access, app preview,
  public app exposure, viewer-only file access, collaborator removal, role
  downgrade, project restart, stale browser tab, and stale project-host HTTP
  session behavior.
- Product decision follow-up: public app exposure is project-owned and can make
  app paths public when collaborators configure exposure. Confirm this is
  acceptable for launch UX and documentation.

## Phase 3: Secrets, API Keys, and Tokens

Status: Done except manual follow-up, 2026-06-21.

Goal: ensure credentials and one-time tokens are scoped, revocable, non-leaking,
and never accepted for operations that require stronger browser or fresh-auth
semantics.

Primary source surfaces:

- `src/packages/server/auth/`
- `src/packages/server/auth/sso/`
- `src/packages/server/accounts/`
- `src/packages/http-api/pages/api/v2/account-security*`
- `src/packages/http-api/pages/api/v2/`
- `src/packages/cli/`
- project secrets, self-host/connector tokens, project-host bootstrap tokens,
  browser auth, API keys, password reset, email verification, invitations, SSO,
  2FA, fresh auth, and CLI elevation.

Audit questions:

- Are reusable secrets hashed at rest where practical?
- Are one-time tokens single-use when replay would grant access, membership,
  account control, or project access?
- Are tokens scoped to account, project, host, session, purpose, and expiration
  as narrowly as practical?
- Are API keys explicitly rejected for browser-only, billing, fresh-auth,
  password, 2FA, SSO linking, admin, and other dangerous mutations?
- Are fresh-auth and 2FA requirements enforced on the server, not only in the
  frontend?
- Are tokens and secrets omitted from logs, errors, telemetry, Redux state,
  local storage, URLs, and project environments unless explicitly intended?
- Does revocation work for API keys, sessions, SSO links, CLI elevation,
  project-host tokens, and invite/reset/verification tokens?
- Are token validation and account lookup routed to the authoritative bay?

Execution:

- Inventory token creation and verification helpers.
- Grep for logging or serialization of `token`, `secret`, `bearer`, `api_key`,
  `authorization`, `password`, `session`, and `cookie` values.
- Negative-test API keys against account-security, billing, admin, and
  project-host mutating endpoints.
- Verify token expiry, replay, revocation, and stale-session behavior for the
  highest-impact tokens.

Completed audit notes:

- API keys are explicit-capability credentials. Creation normalizes and requires
  at least one capability, stores only a hash/truncated display value, and
  audits creation/use/denial by key id rather than secret. HTTP hub RPC access
  is deny-by-default with a short allowlist; project RPC access is
  project-capability scoped.
- API keys are explicitly rejected for reviewed browser-only account-security,
  Stripe billing, project invite, admin, and dangerous mutation flows. Existing
  tests cover account security, admin RPC, Stripe read/write denial, and
  project capability negative cases.
- Server-side fresh-auth gates protect reviewed password, 2FA, passkey, SSO
  unlink, account deletion, billing, purchase, CLI login approval, host, and
  dangerous admin flows. Fresh-auth state is checked on the server via current
  browser session or explicitly passed browser-session hash for Conat/RPC
  actions.
- Fixed release blocker: password-reset redemption used a select-then-expire
  pattern, so concurrent requests with the same reset code could both redeem
  before the token was expired. Commit `9013a7987e` now consumes the token with
  one conditional `UPDATE ... WHERE expire > NOW() RETURNING email_address`.
- Fixed release blocker: CLI login redemption created a remember-me cookie and
  auth-session row before marking the approved login challenge redeemed. Commit
  `5a6c92062c` now performs a conditional approved-to-redeemed update first and
  records the session only after winning that transition.
- Fixed release blocker: provider setup direct-upload tokens for cloud
  credentials could overwrite an already-uploaded payload until challenge
  expiry. Commit `a5318881f9` now makes the upload token single-use by
  atomically transitioning `pending` to `uploaded`.
- Fixed hardening issue: low-level auth-session write helpers accepted both
  `account_id` and `session_hash` but updated by `session_hash` alone. Commit
  `e1e20a5a6e` now scopes fresh-auth promotion and single-session revocation by
  both account and session, and rejects fresh-auth promotion if the session row
  is not owned by that account.
- Registration tokens are protected at rest: normal tokens are encrypted,
  bootstrap-admin tokens are hidden/hash-only in admin listing after creation,
  legacy plaintext rows are opportunistically encrypted on validation, and
  redeem counters are updated under row lock. No release-blocking issue was
  found in the code review pass.
- Project-host bootstrap/master tokens are high-entropy secret tokens stored as
  password hashes, scoped by host/purpose, TTL-bound, and replaced by revoking
  previous active tokens for the same host/purpose.
- Logging/telemetry scan of high-risk auth, API key, project-host token, and
  provider setup paths did not find raw token/secret logging in the reviewed
  paths. API key and token audit records use ids, key ids, or aggregate byte
  counts rather than raw secret material.

Validation:

- `cd src/packages/server && pnpm exec jest ./auth/auth-sessions.test.ts ./auth/cli-auth.test.ts ./auth/password-reset.test.ts ./provider-setup/challenges.test.ts`
- `cd src/packages/server && pnpm exec jest ./api/http-api-key-policy.test.ts ./api/manage.test.ts ./auth/auth-sessions.test.ts ./auth/cli-auth.test.ts ./auth/password-reset.test.ts ./provider-setup/challenges.test.ts`
- `cd src/packages/server && pnpm tsc --build`
- `cd src/packages/http-api && pnpm exec jest ./pages/api/v2/account-security-browser-session.test.ts ./pages/api/v2/admin-api-key-scope.test.ts ./pages/api/v2/purchases-stripe-api-key-scope.test.ts ./pages/api/v2/purchases-stripe-fresh-auth.test.ts ./pages/api/v2/auth-cli-login-approve-fresh-auth.test.ts ./pages/api/v2/api-keys.test.ts`

Validation not completed:

- `cd src/packages/server && pnpm exec jest ./auth/tokens/registration-token-storage.test.ts`
  could not run in this shell because the local Postgres socket was unavailable
  at `/home/user/.cache/cocalc/project/postgres/socket/.s.PGSQL.5432`. The
  storage code and test coverage were reviewed, but this DB-backed suite should
  be run once local Postgres is available.

Manual follow-up:

- Exercise password reset, email verification, registration token redemption,
  CLI login approval/redeem, CLI fresh-auth elevation, provider setup direct
  upload, API key creation/revocation/use/denial, account-security fresh-auth,
  and Stripe fresh-auth flows end-to-end in a browser/dev environment.
- Confirm that provider setup challenge payloads are cleared after successful
  settings application and that re-running a cloud setup command requires a new
  challenge.

## Phase 4: Resource Abuse and Free-User Enforcement

Goal: ensure free, trial, unpaid, or downgraded users cannot create unbounded
infrastructure cost or bypass membership usage limits through direct APIs,
stale state, or alternate entry points.

Primary source surfaces:

- `src/packages/server/membership/`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/conat/api/purchases.ts`
- `src/packages/server/launch/kill-switches.ts`
- `src/packages/server/purchases/`
- project creation/start/stop paths, host assignment, managed CPU/RAM, disk,
  egress, blob/rootfs upload, app/server proxying, AI/Codex use, site-license
  grants, course/student memberships, and package seats.

Audit questions:

- Does every high-cost operation map to current membership, payment, trial,
  course, or site-license authority?
- Are CPU, RAM, disk, egress, blob, rootfs, AI, project-count, project-host, and
  app/proxy limits checked server-side?
- Are usage windows shared per account for all 5-hour and 7-day meters where
  the product expects one user-visible window?
- Are project start, restart, host assignment, and project creation blocked when
  the account is over limit, unpaid, quarantined, canceled, or otherwise not
  allowed to create new cost?
- Do kill switches block new cost even when the frontend is bypassed?
- Does downgrade, cancellation, failed payment, refund, chargeback, package seat
  removal, site-license removal, or course status change immediately affect
  enforcement?
- Can free users create cost by alternate entry points such as CLI, API key,
  stale browser tabs, direct project-host URLs, public app routes, file uploads,
  rootfs pulls, or background jobs?
- Are resource usage events attributed to the correct account and bay?

Execution:

- Build a high-cost-operation map from entry point to limit check.
- Exercise direct API attempts as a free/trial account, not only through the UI.
- Test over-limit transitions for CPU and disk because they are user-visible and
  high-risk.
- Test membership upgrade, downgrade, cancellation, failed payment, package seat
  assignment/removal, and site-license assignment/removal.
- Add regression tests for any bypass that is fixed.

## Recommended Execution Order

1. Phase 1 and Phase 2 first. These cover the broadest unauthenticated and
   cross-user compromise risks.
2. Phase 3 next. Token mistakes often create broad bypasses and are easier to
   regress accidentally.
3. Phase 4 in parallel with manual purchasing and usage testing. Focus first on
   free/trial scenarios that can create real cost.
4. Stop auditing and fix release-blocking findings immediately. Use one commit
   per fix or tightly coupled fix set.
5. After each fix, add a test when practical and update this file with the
   finding, severity, fix commit, and residual risk.

## Finding Format

Use this format for findings added to this file or a follow-up scoreboard:

- Severity: blocker, high, medium, low, or note.
- Surface: route, RPC, package, or project-host service.
- Attack scenario: what an attacker can do and with what starting privileges.
- Root cause: the missing or incorrect authority, scope, freshness,
  idempotency, validation, or routing check.
- Fix: code change and commit hash.
- Validation: focused test, typecheck, manual reproduction, or explicit reason
  test coverage was not practical.
- Residual risk: anything still needing manual release testing.

## Manual Release Follow-Up

Before launch, manually smoke-test these flows after the code audits:

- logged-out public routes, SSO callback errors, password reset, email
  verification, and invitations;
- two-account project access, collaborator removal, viewer-only access, stale
  project tab, public share, and app preview;
- API-key negative tests for billing, account security, project-host, and admin
  mutations;
- free/trial user project start, CPU over-limit, disk over-limit, usage page,
  red pills/banners, downgrade, cancellation, and failed payment;
- Stripe test-mode checkout, subscription renewal, cancellation, failed
  payment, refund, and entitlement removal.

## Related Existing Audit Files

- `src/.agents/purchasing-security-abuse-audit-plan-2026-06-20.md`
- `src/.agents/security-audit-pass-2026-05-23.md`
- `src/.agents/api-key-scope-audit-2026-05-12.md`
- `src/.agents/cli-api-key-dangerous-operation-audit-2026-05-14.md`
- `src/.agents/project-secrets-audit-2026-05-13.md`
- `src/.agents/project-viewer-endpoint-audit-2026-05-28.md`
- `src/.agents/kill-switch-enforcement-audit-2026-06-10.md`
- `src/.agents/launchpad-security-audit.md`
- `src/.agents/google-sso-implementation-plan-2026-06-20.md`
- `src/.agents/multibay-data-ownership-correctness-plan-2026-06-03.md`
- `src/.agents/user-visible-usage-limits-plan-2026-06-01.md`

## Completion Criteria

This plan is done when:

- all four phases have route/service/token/operation inventories;
- all blocker and high findings are fixed or explicitly accepted for launch by
  the release owner;
- fixed findings include focused regression tests where practical;
- manual release follow-up is either completed or delegated with exact test
  cases;
- residual medium/low findings are documented with release impact and owner.
