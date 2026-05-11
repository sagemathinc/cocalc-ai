# Release Security and Abuse Audit Plan

Status: initial plan, 2026-05-11.

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

Inventory commands:

```sh
rg -n "router\\.|app\\.|async_query|rpcService|service\\(|call\\(|request\\(" src/packages -g'*.ts' -g'*.tsx'
rg -n "projectConat|hub\\.|account_client|webapp_client|conat_client" src/packages -g'*.ts' -g'*.tsx'
rg -n "setInterval|queue|schedule|worker|spawn|exec|browser exec|rate|limit|quota|timeout" src/packages -g'*.ts' -g'*.tsx'
rg -n "admin|operator|impersonat|entitlement|billing|purchase|host" src/packages -g'*.ts' -g'*.tsx'
```

## Phase 1: Central Admission Control

Goal: make the default behavior safe when traffic arrives too fast.

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
- max concurrent expensive operations per account/project
- structured deny reasons returned to clients
- metrics/logs for allowed, delayed, and denied work

High-priority checks:

- Can one browser tab flood a hub websocket with arbitrary requests?
- Can one project-host socket retain unbounded pending calls?
- Can retries after reconnect multiply work?
- Are rate-limit keys based on trusted address resolution only?
- Do limits apply before project-host wake/start operations?

## Phase 2: Codex/ACP Scheduling Limits

Goal: durable agents should be useful but not unbounded.

Minimum release policy:

- per-account max queued turns
- per-account max running turns
- per-project max running turns
- per-thread max queued turns
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

Audit questions:

- Can a user queue thousands of Codex turns without a running worker?
- Can a queued turn survive forever after account membership changes?
- Can several tabs schedule duplicate turns for the same message?
- Can a project-local worker create a global notification or start another
  worker without account-level admission?
- Are agent sessions cleaned up if the browser disappears, project host restarts,
  or hub restarts?
- Are token/cost-heavy model calls bounded independently from local worker time?

## Phase 3: Browser Automation and Browser Exec

Goal: raw browser power must not be a production default.

Minimum release policy:

- prod posture blocks raw `browser exec` by default
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
- CLI browser command implementation

Abuse scenarios:

- agent auth tries to discover or control another browser session
- raw JS submits billing/admin/destructive UI actions
- raw JS exfiltrates page state or tokens
- browser filesystem helpers read/write outside intended project scope
- stale browser_id/project_id environment targets the wrong session after
  reconnect

## Phase 4: `cocalc-cli` Authority Audit

Goal: CLI behavior should be predictable under user, project, agent, and
operator auth.

For each command family, classify:

- allowed under project auth
- allowed under agent auth
- allowed under browser/session auth
- requires account auth
- requires operator/admin auth
- requires explicit approval or recent auth
- should be disabled in production

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
- Can local CoCalc Plus expose CLI-backed APIs over a public network by mistake?

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

High-risk surfaces:

- markdown/slate rendering in chat
- Codex output and git-review diff rendering
- Jupyter output and HTML display
- public file viewer
- app-server/proxy error pages
- notifications and outbound email rendering
- imported public URLs and file previews

Audit questions:

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
```

If exact commands differ, record the actual supported commands in the scoreboard.

Review categories:

- direct production dependencies with known CVEs
- transitive dependencies bundled into frontend assets
- packages that execute untrusted content
- packages that parse archives, images, markdown, HTML, PDFs, notebooks, or
  terminal output
- packages used by CLI and browser automation

Policy:

- fix high/critical production vulnerabilities before release
- document false positives with package path and exploitability reason
- avoid risky major upgrades without focused smoke tests

## Phase 8: Installable CoCalc Plus Defaults

Goal: local install should not become insecure when exposed to a LAN or reverse
proxy.

Audit questions:

- What binds to `0.0.0.0` by default?
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
- membership/billing mutation attempts

Minimum admin/CLI readouts:

- account abuse summary
- project abuse summary
- top accounts by Codex scheduling
- top accounts by websocket/request rate
- top accounts by outbound notifications/email
- top accounts by host/project wake cost
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
- Hub/Conat websocket admission has a baseline per-socket/account/project limit.
- Browser automation prod posture is deny-by-default for raw exec.
- Agent/project/operator CLI auth classification exists for dangerous commands.
- Outbound email/notification abuse controls exist for user-triggered sends.
- High/critical production dependency CVEs are fixed or explicitly documented as
  non-exploitable.
- Installable defaults are safe for accidental LAN exposure or loudly warn.
- Operators have at least basic abuse visibility for Codex, websockets, browser
  automation, notifications, hosts, and project starts.

Do not release installable CoCalc Plus until:

- default secrets are unique,
- dev-only browser automation is not exposed remotely by default,
- reverse-proxy trust is explicit,
- production-mode checklist exists,
- local admin/bootstrap credentials are visible and rotatable.

## Open Questions

1. Should Codex scheduling limits be membership-entitlement backed from day one,
   or start as a simpler hardcoded release policy?
2. Should websocket admission be implemented inside Conat core, hub wrappers, or
   both?
3. Which browser automation actions count as privileged for the first release?
4. Should agent-auth `cocalc-cli` commands be deny-by-default except for an
   allow-list?
5. What minimum operator abuse dashboard is required before public launch?
6. For CoCalc Plus, should production mode be an explicit opt-in command rather
   than inferred from bind address/origin?
