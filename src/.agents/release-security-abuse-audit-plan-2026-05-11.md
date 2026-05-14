# Release Security and Abuse Audit Plan

Status: reviewed and expanded plan, 2026-05-11.

This plan is for the post-feature release phase of `cocalc-ai`, covering both
the hosted SaaS product and installable CoCalc Plus/local deployments. The goal
is not to prove the system secure. The goal is to systematically find and fix
cheap abuse vectors, authority-boundary bugs, and missing operational guardrails
before release.

Related documents:

- [launchpad-security-audit.md](./launchpad-security-audit.md)
- [browser-automation-policy.md](./browser-automation-policy.md)
- [membership2.md](./membership2.md)
- [membership-usage-limits-release-spec-2026-04-25.md](./membership-usage-limits-release-spec-2026-04-25.md)
- [first-public-release-master-plan-2026-04-30.md](./first-public-release-master-plan-2026-04-30.md)
- [first-public-release-scoreboard-2026-05-09.md](./first-public-release-scoreboard-2026-05-09.md)
- [codex-auth.md](./codex-auth.md)
- [project-host-auth.md](./project-host-auth.md)
- [cocalc-cli.md](./cocalc-cli.md)
- [codex-cocalc-launchpad-integration-polish.md](./codex-cocalc-launchpad-integration-polish.md)

## Release Threat Model

Primary adversaries:

1. A normal signed-in user trying to consume unbounded resources.
2. A user with many free/trial/low-tier accounts.
3. A compromised account or browser session.
4. A malicious or confused Codex/ACP agent running inside a project.
5. A user-controlled project process trying to cross from project-local
   authority to account/global authority.
6. A public internet client sending high-volume websocket or HTTP traffic.
7. An operator or automation credential with broader authority than intended.

Primary assets:

1. Hosted infrastructure cost and availability.
2. User files, project state, chat threads, and credentials.
3. Account-level identity, billing, memberships, hosts, and notification state.
4. Project-host and hub control-plane integrity.
5. Browser sessions and automation channels.
6. Operator/admin credentials and audit trails.

Primary release risks:

1. Missing per-account/per-project/per-IP limits on newly added APIs.
2. Missing central admission control for websocket and HTTP message rates.
3. Confused-deputy bugs where project-local code can trigger global effects.
4. Durable agent scheduling without quotas, backpressure, or cancellation caps.
5. Browser automation and `cocalc-cli` capabilities usable with overly broad or
   ambiguous auth.
6. NPM dependency vulnerabilities or supply-chain risk in production bundles.
7. Installable/local defaults that are safe on localhost but unsafe when exposed
   behind a proxy.
8. Account and project API keys whose effective authority is broader than their
   visible scope.
9. Registration-token configuration where "no configured token" accidentally
   means "public signup allowed".
10. Plaintext-on-disk master-key handling for encrypted application secrets.
11. User-created root filesystems with unbounded count or storage size.
12. Unbounded simultaneous running projects attributed to one owner or
    `usage_account_id`, especially course/team workflows where one paid account
    can implicitly sponsor many free collaborators.
13. Dependency-advisory drift between `pnpm audit`, GitHub Dependabot, Python
    lockfile scanners, and production bundle reachability.

## Audit Rules

Every audit item should produce one of:

1. a code fix,
2. a test or smoke check,
3. a documented policy decision with owner and accepted residual risk,
4. an explicit follow-up issue with severity and reproduction steps.

Do not rely on generic scanners alone. Scanners are useful for dependency and
known-CVE coverage, but the highest-risk bugs here are product-specific
authorization and resource-exhaustion bugs.

For every mutating or resource-consuming API, record:

- actor identity,
- target scope,
- auth mechanism,
- rate/usage limit,
- idempotency semantics,
- audit/log trail,
- failure behavior under reconnect/retry,
- whether a project-local principal can reach it.

## Phase 0: Inventory and Scoreboard

Goal: build a release-gating inventory of abuse-sensitive surfaces.

Deliverables:

- `src/.agents/release-security-abuse-scoreboard-2026-05-11.md`
- one row per endpoint/service/scheduler/tooling surface
- each row marked `unknown`, `blocked`, `guarded`, `accepted-risk`, or `done`

Initial inventory buckets:

1. Codex/ACP scheduling and worker lifecycle.
2. Chat message creation, queued turns, notification creation, and git-review
   actions.
3. Browser session APIs: `browser exec`, typed browser actions, filesystem
   helpers, notebook helpers, syncdoc leases, and session heartbeat.
4. `cocalc-cli` commands exposed to agent auth, project auth, browser auth, and
   operator auth.
5. Hub HTTP routes and Conat websocket services.
6. Project-host Conat services and project-local RPCs.
7. Dedicated-host create/edit/start/stop/deprovision flows.
8. Notifications, outbound email, invites, mentions, and collaborator flows.
9. File upload/import/public URL/blob endpoints.
10. Billing, membership, entitlement override, and package/seat flows.
11. Admin/operator tools and impersonation.
12. Installable/local CoCalc Plus bootstrap defaults and reverse-proxy exposure.
13. Account-scoped and project-scoped API keys, including CLI use and project
    restrictions.
14. Registration-token signup policy and public-signup configuration.
15. Master-key loading, storage, rotation, and bay startup unlock flows.
16. Root filesystem create/edit/publish/storage flows and image distribution
    side effects.
17. Project start/wake/restart admission, including concurrent running project
    caps by `usage_account_id`, owner, project host, and bay.
18. Dependency advisory reconciliation across npm and Python lockfiles, with
    explicit release decisions for open Dependabot alerts.

Inventory commands:

```sh
rg -n "router\\.|app\\.|async_query|rpcService|service\\(|call\\(|request\\(" src/packages -g'*.ts' -g'*.tsx'
rg -n "projectConat|hub\\.|account_client|webapp_client|conat_client" src/packages -g'*.ts' -g'*.tsx'
rg -n "setInterval|queue|schedule|worker|spawn|exec|browser exec|rate|limit|quota|timeout" src/packages -g'*.ts' -g'*.tsx'
rg -n "admin|operator|impersonat|entitlement|billing|purchase|host" src/packages -g'*.ts' -g'*.tsx'
rg -n "rootfs|root filesystem|root filesystem|root_filesystem|root_filesystems|rootfs_images" src/packages -g'*.ts' -g'*.tsx'
```

## Phase 1: Central Admission Control

Goal: make the default behavior safe when traffic arrives too fast.

This is expected to find major release-blocking issues. Historical dogfood
failures were mostly fixed by making browser clients less stormy after reconnect,
not by adding uniform backend protection. The backend must assume clients can be
buggy, stale, malicious, or duplicated across many tabs and devices.

Required decisions:

1. Define traffic classes:
   - unauthenticated HTTP
   - authenticated HTTP
   - unauthenticated Conat websocket
   - authenticated Conat websocket
   - project-host websocket
   - browser-session automation
   - Codex/ACP scheduling
   - outbound email/notification fanout
2. Define identity keys:
   - IP / Cloudflare identity
   - account_id
   - project_id
   - browser_id/session_id
   - thread_id/agent_session_id
   - host_id
3. Define enforcement mode:
   - reject before expensive work
   - queue with bounded depth
   - degrade feature
   - disconnect abusive socket
   - require higher membership/verified payment/2FA/admin override

Implementation targets:

- one shared rate/admission helper for hub HTTP and Conat service methods where
  possible
- per-socket message rate and pending-request limits
- per-socket reconnect and resubscription storm limits
- per-account/project/browser reconnect dampening
- max concurrent expensive operations per account/project
- max simultaneously running projects per billing/usage account, owner, bay, and
  host, enforced before project wake/start work enters project-host placement
- bounded queue depth for work accepted by a websocket service
- structured deny reasons returned to clients
- metrics/logs for allowed, delayed, and denied work

High-priority checks:

- Can one browser tab flood a hub websocket with arbitrary requests?
- Can one project-host socket retain unbounded pending calls?
- Can retries after reconnect multiply work?
- Can a suspended/resumed browser tab cause a reconnect storm that degrades hub
  or project-host availability?
- Can many stale browser tabs for one account simultaneously resubscribe,
  re-fetch, or re-open expensive resources?
- Are rate-limit keys based on trusted address resolution only?
- Do limits apply before project-host wake/start operations?
- Can one paid user or `usage_account_id` sponsor an unbounded number of
  simultaneously running free-user/collaborator projects?
- Are denied/rejected websocket requests cheap enough to process under attack?

Minimum release target:

- backend-side guards exist even if every frontend reconnect mitigation is
  accidentally removed.
- one misbehaving browser account cannot materially degrade a bay or
  project-host.
- denied work is visible in logs/metrics with actor, source, and reason.

## Phase 2: Codex/ACP Scheduling Limits

Goal: durable agents should be useful but not unbounded.

These limits should be membership-entitlement backed, not hardcoded release
constants. Each membership tier already has admin-configurable 5-hour and 7-day
rate limits for several resources; Codex/ACP scheduling must use the same
framework. Admin overrides should work only after each new limit is explicitly
wired into the entitlement/override machinery.

Minimum release policy:

- per-account max queued turns
- per-account max running turns
- per-project max running turns
- per-thread max queued turns
- per-account 5-hour created-turn limit
- per-account 7-day created-turn limit
- per-account 5-hour model/token/cost budget if measurable
- per-account 7-day model/token/cost budget if measurable
- per-project 5-hour worker-start or project-host wake budget
- per-project 7-day worker-start or project-host wake budget
- per-worker max sessions
- per-session max lifetime
- per-turn max wall clock and idle timeout
- bounded retry count after worker/project-host restart
- explicit cancellation path that releases quota

Recommended first limits:

- free/trial: very small concurrent and daily caps
- paid individual: modest caps with burst protection
- team/org/admin: higher caps, still bounded
- operator override: explicit, expiring, audited

Membership-tier work:

- add explicit Codex/ACP limit fields to the admin-editable membership tier
  model.
- display current effective Codex/ACP limits in account/admin membership views.
- add expiring admin overrides for each newly wired limit.
- record limit-denial events with tier, effective limit, current usage, and
  actor.
- expose top users and near-limit users for each 5-hour and 7-day limit.

Audit questions:

- Can a user queue thousands of Codex turns without a running worker?
  - Expected current answer may be yes, with "thousands" effectively meaning
    "unbounded enough to be millions"; verify and treat as release-blocking if
    true.
- Can a queued turn survive forever after account membership changes?
- Can several tabs schedule duplicate turns for the same message?
- Can a project-local worker create a global notification or start another
  worker without account-level admission?
- Are agent sessions cleaned up if the browser disappears, project host restarts,
  or hub restarts?
- Are token/cost-heavy model calls bounded independently from local worker time?

## Phase 2b: Root Filesystem Storage Limits

Goal: user-created root filesystems must be useful for paid users but bounded as
a storage and image-distribution abuse surface.

Current status: guarded. Membership-tier rootfs limits and server-side
admission checks now cover catalog save, project rootfs publish, project rootfs
image selection, and project creation with a selected/cloned rootfs image.
Remaining work is focused on top-user/near-limit reporting, current-usage UI,
and continued edge-path review.

Current concern:

- A user may be able to create an unlimited number of root filesystems.
- Each root filesystem may be able to grow without a per-rootfs cap.
- Total rootfs storage owned by one account may be unbounded.
- A user may be able to request remote OCI images that are arbitrarily large or
  expensive to pull, unpack, store, and distribute.
- This creates direct storage-cost exposure and can indirectly amplify project
  start, image build, image pull, snapshot, backup, and distribution load.

Required release policy:

- Rootfs creation is controlled by admin-editable membership-tier usage limits,
  with explicit admin overrides where the membership framework supports them.
- Limits are enforced server-side before create/clone/import/grow operations, not
  just hidden in the frontend.
- Every rootfs ownership transfer, delete, clone, import, and resize path must
  preserve or re-check limits.
- Denials must include the effective limit, current usage, account/tier, and
  requested operation.
- Users and admins can see current rootfs usage and effective limits before a
  create/grow attempt fails.
- OCI-image-backed rootfs creation/import must either be disabled by membership
  tier or pass the same quota checks with bounded pull/unpack behavior.

Required membership-tier limit fields:

- `rootfs_count`: maximum number of root filesystems owned by the account.
- `rootfs_total_storage_gb`: maximum sum of storage across all root filesystems
  owned by the account.
- `rootfs_max_storage_gb`: maximum storage size of any one root filesystem.
- `rootfs_oci_images`: whether the account may create root filesystems from
  remote OCI images.

Initial default policy:

| Tier     | `rootfs_count` | `rootfs_total_storage_gb` | `rootfs_max_storage_gb` | `rootfs_oci_images` |
| -------- | -------------- | ------------------------- | ----------------------- | ------------------- |
| free     | 0              | 0                         | 0                       | false               |
| student  | 0              | 0                         | 0                       | false               |
| standard | 20             | 25                        | 10                      | false               |
| pro      | 250            | 250                       | 30                      | true                |

Audit targets:

- rootfs create/clone/import/edit/delete APIs.
- rootfs storage accounting model and owner lookup.
- membership-tier schema/defaults/admin UI for the three new limits.
- project/rootfs selection UI so free/student users do not see broken create
  affordances.
- host/project image distribution paths that can be triggered by creating or
  modifying root filesystems.
- OCI image pull/import path, including owner attribution for the resulting
  rootfs, maximum accepted image size, download timeout, unpack timeout, and
  temporary-disk cleanup.
- CLI/API paths that mutate rootfs state.

Audit questions:

- What is the authoritative byte/GB value for a rootfs size?
  - Working answer: use the existing rootfs database size value that is already
    displayed in project-host storage UI, or the underlying Rustic-reported size
    if that is more authoritative. Pick one source and use it consistently for
    quota checks and display.
- Is deleted rootfs storage reclaimed promptly, eventually, or retained in
  snapshots/backups?
  - Working answer: rootfs deletion is blocked while projects still use it; once
    deleted, cleanup appears to be eventual across Rustic and project hosts.
    Quota semantics should count active/non-deleted rootfs rows, not historical
    backups, unless retained data remains user-addressable.
- Can one account create rootfs objects owned by another account or organization?
  - Current understanding: no. Verify and add regression coverage around owner
    attribution for create/clone/import paths.
- Can project-local code create, clone, or resize root filesystems?
  - Current understanding: probably no. Verify project-local permissions anyway
    because this is an important privilege boundary.
- Can rootfs images be uploaded/imported from arbitrary remote URLs, and are
  downloads bounded?
  - Current understanding: users can specify OCI images that result in rootfs
    creation. This is a major abuse risk because remote OCI images can be huge.
    Mitigate with a membership-tier `rootfs_oci_images` flag, size/time bounds,
    and clear owner attribution.
- Are concurrent create/clone/grow operations serialized enough to prevent two
  operations from passing quota checks simultaneously?
  - Current understanding: no. Exact accounting is less important than blocking
    egregious abuse, so small race slack is acceptable initially; free/student
    defaults of zero provide the most important protection.
- Does membership downgrade or admin override expiry prevent future growth while
  handling existing over-limit root filesystems predictably?
  - Desired behavior: existing over-limit rootfs objects may remain available,
    but the user cannot create, clone, import, or grow root filesystems until
    usage is back under the effective limit.

Release gate:

- No account can create unbounded rootfs count or storage.
- Free and student tiers cannot create root filesystems by default.
- Standard and pro tiers have the initial bounded defaults listed above.
- Remote OCI image rootfs creation is disabled unless the effective membership
  tier explicitly allows it.
- Rootfs quota denials are visible in user/admin UI and abuse telemetry.

## Phase 3: Browser Automation and Browser Exec

Goal: raw browser power must not be a production default.

The codebase now has a QuickJS/WASM JavaScript sandbox for browser automation.
That gives a plausible path to safe production automation, but it does not by
itself solve authorization, action classification, or auditability. Non-sandbox
raw browser exec remains highly dangerous.

Minimum release policy:

- prod posture blocks raw `browser exec` by default
- sandboxed QuickJS/WASM exec is the default programmable path in production
- typed browser actions have action-level policy checks
- project_id, browser_id, origin, and actor must be explicit under agent auth
- no automatic session discovery for agent auth in production
- privileged action attempts are denied or require short-lived approval
- all allowed/denied browser automation actions are auditable

Audit targets:

- `src/packages/frontend/conat/browser-session`
- `src/packages/frontend/conat/browser-session/fs-api.ts`
- `src/packages/frontend/conat/browser-session/syncdoc-leases.ts`
- `src/packages/frontend/conat/browser-session/session-heartbeat.ts`
- `src/packages/frontend/conat/browser-session/exec-api-declaration.ts`
- QuickJS/WASM host-function bridge and exposed capabilities
- CLI browser command implementation

Abuse scenarios:

- agent auth tries to discover or control another browser session
- raw JS submits billing/admin/destructive UI actions
- raw JS exfiltrates page state or tokens
- sandboxed JS escapes through an overly broad host function
- sandboxed JS consumes unbounded CPU, memory, time, or queued browser actions
- browser filesystem helpers read/write outside intended project scope
- stale browser_id/project_id environment targets the wrong session after
  reconnect

## Phase 4: `cocalc-cli` Authority Audit

Goal: CLI behavior should be predictable under user, project, agent, and
operator auth.

CoCalc now has 2FA, auth freshness, and dangerous-action controls. These should
be used to make high-risk CLI and browser-automation actions explicit without
making Codex useless for operations. Codex is often valuable for cluster
debugging with enough access to read logs and run safe commands, so the target
is scoped, temporary, auditable elevation rather than blanket denial.

For each command family, classify:

- allowed under project auth
- allowed under agent auth
- allowed under browser/session auth
- requires account auth
- requires operator/admin auth
- requires explicit approval or recent auth
- should be disabled in production
- may run under temporary 2FA-backed elevation
- read-only safe for Codex-assisted operations

High-priority command families:

- `browser`
- `project`
- `host`
- `notifications`
- `jupyter`
- `exec`
- `admin`
- `abuse` or future abuse-review commands

Audit questions:

- Does a command silently fall back to a broader credential from the environment?
- Does agent auth require explicit project/browser targets?
- Can project auth mutate account/global state?
- Are dangerous commands logged with actor and target?
- Can Launchpad expose CLI-backed APIs over a public network without the
  expected Cloudflare/proxy/auth posture?

CoCalc Plus constraint:

- CoCalc Plus should only bind to localhost.
- Audit this as an invariant: no supported CoCalc Plus mode should listen on
  `0.0.0.0` or a public interface.
- The public-exposure concern is primarily Launchpad, especially when exposed by
  Cloudflare Tunnel or another reverse proxy.

Operational Codex policy:

- support read-only cluster diagnostics for Codex with scoped operator
  credentials.
- require recent admin auth/2FA or an explicit short-lived approval for
  destructive host, billing, membership, security, and secret-management
  commands.
- log every elevated command with actor, subject, credential type, command
  family, target IDs, and approval source.

## Phase 4b: API Key Scope Audit

Goal: reduce API-key authority to the minimum visible scope.

Current concern:

- account-scoped API keys are effectively broad account credentials.
- project-scoped API keys increase surface area and were intended to be removed.
- the preferred model is account-scoped API keys with explicit restrictions,
  including no-project access, one-project access, or a bounded project set.

Audit targets:

- account API-key creation, storage, display, revocation, and authentication.
- project-scoped API-key creation and all remaining consumers.
- CLI behavior when both account and project credentials are present.
- Conat/API service authorization decisions that accept API-key auth.

Required release direction:

- eliminate project-scoped API keys if practical before release.
- add explicit project restrictions to account-scoped API keys.
- make unrestricted account API keys visually high-risk in the UI.
- support least-privilege keys for Codex/automation use.
- add audit events for API-key creation, use on dangerous endpoints, and
  revocation.
- make API-key auth incompatible with high-risk security/billing mutations
  unless explicitly allowed by a future scoped policy.

## Phase 5: Project-Local to Global Boundary

Goal: project-local services must not become global account authorities.

Audit targets:

- project-host Conat services
- hub APIs callable by project-host code
- notification creation from project workers
- host lifecycle APIs reachable from project contexts
- backup/rootfs/image distribution APIs
- browser-session helpers running near project state

Abuse scenarios:

- malicious project process creates account notifications/emails in a loop
- project-local token invokes host/billing/membership mutations
- project-local RPC can enumerate account/project metadata outside its scope
- project-host service trusts caller-provided `account_id`, `project_id`, or
  `host_id`
- stale project-host connection keeps authority after project move or revocation

Required controls:

- derive target scope from authenticated principal, not request body
- reject cross-scope IDs unless explicitly delegated
- enforce rate limits before global side effects
- write audit records for global effects caused by project-local work

## Phase 6: Web Input and Rendering Surfaces

Goal: avoid XSS, token exfiltration, and unbounded rendering work.

CoCalc has a relatively small HTTP API surface and a much larger websocket/Conat
RPC surface. HTTP endpoints are usually easier to probe with commodity tooling,
but websocket-only RPC is not automatically safe: browsers can open websockets,
cookies can be ambient, and origin/auth/CSRF-style assumptions still matter.
Reducing unnecessary HTTP API surface is useful, but it is not a substitute for
auditing websocket RPC authorization and admission.

High-risk surfaces:

- markdown/slate rendering in chat
- Codex output and git-review diff rendering
- Jupyter output and HTML display
- public file viewer
- app-server/proxy error pages
- notifications and outbound email rendering
- imported public URLs and file previews
- remaining HTTP API routes used for auth, purchasing, billing, and account
  flows
- websocket/Conat RPC methods reachable from browser credentials

Audit questions:

- Which HTTP endpoints can be removed, moved behind Conat RPC, or made
  internal-only before release?
- Which HTTP endpoints are intentionally public or unauthenticated?
- Do HTTP endpoints have CSRF/origin/session expectations documented and tested?
- Do websocket/Conat RPC services validate origin, auth, actor, and target scope?
- Where is raw HTML allowed?
- Are links sanitized and target-safe?
- Can an output render unbounded DOM or CPU work?
- Can a malicious notebook/chat/output trigger privileged UI actions?
- Are CSP and frame boundaries appropriate for hosted vs local deployments?

## Phase 7: Dependency and Supply-Chain Cleanup

Goal: reduce known package risk before release.

Required checks:

```sh
pnpm -C src audit
pnpm -C src outdated
pnpm -C src version-check
pnpm -C src license-check
gh api repos/sagemathinc/cocalc-ai/dependabot/alerts --paginate
```

If exact commands differ, record the actual supported commands in the scoreboard.

Review categories:

- direct production dependencies with known CVEs
- transitive dependencies bundled into frontend assets
- Python package lockfiles surfaced by Dependabot even when `pnpm audit` is
  clean
- packages that execute untrusted content
- packages that parse archives, images, markdown, HTML, PDFs, notebooks, or
  terminal output
- packages used by CLI and browser automation

Policy:

- fix high/critical production vulnerabilities before release
- fix or explicitly defer medium/low Dependabot alerts with manifest path and
  production reachability
- document false positives with package path and exploitability reason
- avoid risky major upgrades without focused smoke tests
- if an advisory has no upstream patched version, mitigate locally, remove the
  reachable use, or write a specific non-exploitability decision; do not hide it
  behind a generic scanner exception

News Item to be aware of -- [**Postmortem: TanStack NPM supply-chain compromise**](https://news.ycombinator.com/item?id=48083938)

## Phase 8: Installable CoCalc Plus Defaults

Goal: local install should not become insecure when exposed to a LAN or reverse
proxy.

Audit questions:

- What binds to `0.0.0.0` by default?
- Does CoCalc Plus enforce localhost-only binding as an invariant?
- Are default secrets generated uniquely?
- Are admin/bootstrap tokens short-lived or visibly persistent?
- Is Cloudflare/proxy trust disabled unless explicitly configured?
- Are browser automation and raw exec disabled or dev-only by default?
- Are sample configs safe to copy into production?
- Is the upgrade path safe if users expose a previously-local install?

Required release artifacts:

- hardened default config
- explicit production checklist
- `cocalc doctor security` or equivalent preflight if practical
- visible warning when running with dev/insecure settings on non-loopback origins

## Phase 8b: Master-Key and Secret Unlock Model

Goal: avoid treating an unmanaged plaintext master-key file on disk as the final
production answer.

Current model:

- application secrets are stored in Postgres encrypted under purpose-specific
  keys derived from one local `site-master-key`.
- the site master key is stored once at `$SECRETS/site-master-key` by default;
  `COCALC_SITE_MASTER_KEY_PATH` can override it.
- the raw site master key is not used directly for AES-GCM payload encryption.
- `cocalc admin master-key status|init|export|import` provides the first
  operator lifecycle for checking, creating, passphrase-exporting, and restoring
  the key.
- `cocalc admin master-key doctor` checks key presence, validity, permissions,
  legacy key residue, and encrypted-data migration state without printing key
  material.
- `cocalc admin master-key migrate` is an offline-only migration command. It is
  dry-run by default; writes require `--execute --yes-i-stopped-cocalc`.
- legacy `server-settings-key` and `backup-master-key` files are read only as
  migration fallbacks, not as new root keys.
- production bay systemd units load `/etc/cocalc/site-master-key` via
  `LoadCredential=site-master-key:...`; `COCALC_REQUIRE_SITE_MASTER_KEY=1`
  makes missing keys fatal instead of auto-creating a local key.

Audit questions:

- Where is the master key read, cached, logged, backed up, or copied?
- What file permissions and ownership are enforced?
- Can the master key be rotated?
- What happens if the master key file is missing at startup?
- Are backups/snapshots likely to include plaintext master keys?
- How does this differ for SaaS bays, Launchpad, CoCalc Plus on macOS, and Linux
  servers?

Potential directions:

1. OS keystore integration:
   - macOS Keychain for local Launchpad/CoCalc Plus.
   - Linux Secret Service/libsecret where a user session exists.
   - systemd credentials, TPM, cloud KMS, or sealed secrets for server contexts.
2. Manual startup unlock:
   - bay startup pauses before decrypting the master key.
   - a site admin authenticates with password plus 2FA.
   - the process receives the decrypted master key only in memory.
   - restart/automation semantics are explicit and documented.
3. Hybrid:
   - development and localhost-only CoCalc Plus can use plaintext with warnings.
   - hosted production requires keystore/KMS/manual unlock mode.
   - Launchpad supports both, with clear production-mode checks.

Release target:

- document the current residual risk if local plaintext-at-rest remains for first
  release.
- ensure file permissions are strict and checked.
- ensure operators have a documented backup/restore path; R2/database backups
  are not sufficient without the `site-master-key`.
- ensure an existing dev/early install can migrate from legacy two-key storage
  to one `site-master-key` without creating a new server.
- keep the door open for KMS/keystore/manual-unlock implementation without
  changing every secret consumer.
- add the master-key state to `cocalc doctor security` or equivalent.

## Phase 8c: Registration Token Signup Security

Goal: make account signup fail closed, avoid account-enumeration shortcuts, and
avoid treating database access as sufficient to mint registration-token
signups.

Current concern:

- registration tokens are intended to prevent random people from creating
  accounts on a Launchpad instance.
- fail-open public signup when no tokens are active has been fixed by the
  explicit `public_signup_without_registration_token` setting.
- normal registration-token rows are now encrypted at rest so admins can
  redisplay token values without storing cleartext in database backups.
- bootstrap-admin registration-token rows are hash-only, hidden from admin token
  listing, and deleted after successful bootstrap signup.
- sign-up no longer doubles as sign-in and cannot bypass sign-in 2FA.
- token-gated signup validates the token before returning account-specific
  errors, so invalid-token attempts cannot enumerate existing accounts.
- registration tokens are not consumed until cheap pre-create checks have
  passed.
- unauthenticated signup no longer accepts arbitrary metadata such as tags or
  signup reason; any future policy should come from validated token metadata or
  later authenticated account setup.

Required behavior:

- signup without a registration token is disabled by default.
- public signup without a token requires an explicit setting.
- that setting is visible and editable on the registration-token admin page.
- disabling/deleting all tokens must not implicitly enable public signup.
- normal token values are encrypted at rest for admin redisplay, while
  bootstrap-admin token values are hash-only.
- invalid token attempts are throttled whether the submitted token is wrong,
  disabled, expired, exhausted, or missing.
- signup creation failures are logged server-side but returned to users as
  generic signup failures.
- the UI should clearly show the current signup policy:
  - token required,
  - public signup explicitly enabled,
  - signup disabled.

Audit targets:

- registration-token database/config model.
- account creation HTTP/API path.
- admin registration-token page.
- Launchpad bootstrap defaults.
- tests for "no tokens configured" and "all tokens disabled".
- direct regression coverage for encrypted normal tokens, hash-only bootstrap
  tokens, and legacy plaintext opportunistic protection.

Release gate:

- public signup without a token must be explicit opt-in, never an implicit
  fallback.
- database access alone must not reveal active registration-token cleartext or
  bootstrap-admin signup URLs.
- sign-up cannot authenticate an existing account or bypass sign-in 2FA.

## Phase 9: Abuse Observability

Goal: operators should see abuse before the system is on fire.

Minimum metrics/logs:

- HTTP and websocket request rates by account/project/IP
- Conat auth failures and disconnect reasons
- pending Conat requests per socket/client
- Codex queued/running/completed/failed/cancelled counts
- browser automation allowed/denied actions
- outbound notification/email attempts and denials
- host create/start/stop/deprovision attempts
- project wake/start attempts
- project wake/start denials by owner, `usage_account_id`, host, bay, and
  effective membership tier
- membership/billing mutation attempts
- rootfs create/clone/import/grow/delete attempts and quota denials
- simultaneously running project counts by owner/`usage_account_id`, host, and
  bay
- API-key creations, revocations, and dangerous-use attempts
- registration-token signup attempts and public-signup denials
- master-key unlock/startup mode and failures

Minimum admin/CLI readouts:

- account abuse summary
- project abuse summary
- top accounts by Codex scheduling
- top accounts by websocket/request rate
- top accounts by outbound notifications/email
- top accounts by host/project wake cost
- top accounts by simultaneously running sponsored projects
- top users in absolute terms for every 5-hour and 7-day limit
- users closest to their effective 5-hour and 7-day limits, accounting for
  membership tier and admin overrides
- recent denied actions with reason

Near-term design principle:

- alert humans on suspicious patterns
- do not add autonomous punitive action by default
- support read-only Codex-assisted abuse review using explicitly scoped operator
  credentials

## Execution Cadence

Each audit pass should be small and commit-oriented.

Suggested loop:

1. Pick one inventory bucket.
2. Build a call graph from entrypoint to side effect.
3. Write down current actor, scope, and limits.
4. Try one abuse scenario.
5. If real and localized, add guardrail and test.
6. If broad, add a scoreboard finding with severity and owner.
7. Commit code/doc changes immediately after validation.

Suggested first five passes:

1. Codex scheduling quota/admission audit.
2. Conat websocket per-socket pending request and message-rate audit.
3. Browser automation production posture audit.
4. `cocalc-cli` agent/project/operator auth command classification.
5. Notification/outbound email abuse-limit audit.

Suggested next five passes:

1. API-key scope and project-scoped key elimination audit.
2. Registration-token public-signup default audit.
3. Master-key storage/unlock risk audit.
4. HTTP API surface reduction and websocket RPC origin/auth audit.
5. CoCalc Plus localhost-only binding audit.

## Severity Model

High:

- cross-account data access
- project-local to global unauthorized mutation
- unbounded infrastructure cost path
- unauthenticated remote resource exhaustion
- token/credential exfiltration

Medium:

- authenticated but unbounded expensive operation
- missing audit trail for sensitive mutation
- confusing auth fallback that can use broader credentials than intended
- denial-of-service limited to one account/project/host

Low:

- missing operator visibility with no direct abuse path
- local-only unsafe default with clear warning
- dependency issue not reachable in production

## Release Gates

Do not release hosted SaaS until:

- Codex scheduling has explicit quotas and cancellation cleanup.
- Codex scheduling quotas are backed by admin-editable membership tier limits
  and explicit admin overrides.
- Hub/Conat websocket admission has a baseline per-socket/account/project limit.
- Browser automation prod posture is deny-by-default for raw exec.
- Browser automation sandbox host functions are audited and bounded.
- Agent/project/operator CLI auth classification exists for dangerous commands.
- Outbound email/notification abuse controls exist for user-triggered sends.
- Project start/wake has an explicit simultaneous-running-project admission
  policy, including `usage_account_id` attribution and course/team sponsorship
  semantics.
- API keys have a least-privilege scope story, and project-scoped keys are
  removed or explicitly risk-accepted.
- Public signup without registration tokens is explicit opt-in, never automatic.
- Master-key plaintext-on-disk risk is either mitigated or explicitly accepted
  with documented file-permission checks and upgrade path.
- High/critical production dependency CVEs are fixed or explicitly documented as
  non-exploitable.
- GitHub Dependabot open alerts are reconciled against package-manager audit
  output, including Python lockfile alerts not seen by `pnpm audit`.
- Installable defaults are safe for accidental LAN exposure or loudly warn.
- Operators have at least basic abuse visibility for Codex, websockets, browser
  automation, notifications, hosts, rootfs usage, and project starts.

Do not release installable CoCalc Plus until:

- default secrets are unique,
- localhost-only binding is enforced,
- dev-only browser automation is not exposed remotely by default,
- reverse-proxy trust is explicit,
- production-mode checklist exists,
- local admin/bootstrap credentials are visible and rotatable.

## Resolved Directions

1. Codex scheduling limits should be membership-entitlement backed from day one,
   not hardcoded release constants.
2. CoCalc Plus must only bind to localhost. Public exposure concerns mainly
   apply to Launchpad, especially when made internet-visible through Cloudflare
   Tunnel or another reverse proxy.
3. Non-sandbox browser exec is dangerous. The QuickJS/WASM sandbox is the
   preferred production programmable path, but its host capabilities still need
   an explicit privilege and resource audit.
4. The minimum abuse dashboard should cover every 5-hour and 7-day limit:
   - top users in absolute usage,
   - users closest to their effective limit,
   - effective limits after membership tier and admin overrides.
5. Every user-consumable durable resource must have a clear bound. Rootfs count,
   total storage, and per-rootfs storage are release-gating membership-tier
   limits.

## Remaining Questions

1. Should websocket admission live primarily inside Conat core, hub/service
   wrappers, or both?
2. Which browser automation actions count as privileged for the first release,
   given the QuickJS/WASM sandbox and typed action API?
3. Should agent-auth `cocalc-cli` commands be deny-by-default except for an
   allow-list, or is the right boundary entirely at the underlying Conat RPC
   authorization layer?
4. What OS/KMS/manual-unlock master-key path is practical for hosted SaaS bays
   before first public release?
