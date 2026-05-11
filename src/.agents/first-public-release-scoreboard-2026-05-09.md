# First Public Release Scoreboard

Status: working scoreboard, updated 2026-05-10.

Purpose:

- make the first-release path easy to see at a glance
- separate true release blockers from active polish work
- keep the team focused on trust, usability, performance, and purchase-path correctness

This scoreboard is derived from:

- [first-public-release-master-plan-2026-04-30.md](/home/user/cocalc-ai/src/.agents/first-public-release-master-plan-2026-04-30.md)
- [membership2.md](/home/user/cocalc-ai/src/.agents/membership2.md)
- [control-plane-launch-readiness-plan.md](/home/user/cocalc-ai/src/.agents/control-plane-launch-readiness-plan.md)
- recent dogfood, canary, dedicated-host, billing-enforcement, and admin-override
  implementation work through 2026-05-10

## Current Read

The first public SaaS release of `cocalc-ai` is no longer blocked by missing
core architecture.

The main remaining risk is not “does the system design make sense”.

The main remaining risk is:

- unfinished revenue and entitlement flows
- dedicated-host commercialization gaps
- multibay/operator trust under churn
- insufficient soak confidence on the real hosted system

The right strategy is:

- do not expand product scope
- do not redesign architecture
- finish the commercial and operational gaps that directly affect user trust

## Scoreboard

| Area                                                         | Status                    | Read                                                                                             | Immediate Next Step                                                                   |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Multibay routing / stable URL / home-bay auth                | Done                      | Real strength                                                                                    | Keep fixing only correctness bugs found in soak                                       |
| Browser 2FA / fresh-auth / CLI auth elevation                | Done                      | Strong enough to dogfood and ship                                                                | Keep as maintenance only                                                              |
| Project move between regions                                 | Done enough               | Release-credible path exists                                                                     | Soak and document semantics                                                           |
| Shared-host protection / eviction / stopping                 | Done enough               | One of the stronger release areas                                                                | Keep policy/docs coherent                                                             |
| Managed spot recovery                                        | Done enough               | Real system on the supported path                                                                | Final provider-matrix smoke                                                           |
| Hosted backup sharding / direct R2 backup indexes            | Done enough               | Major risk reduced materially                                                                    | Soak under ordinary churn                                                             |
| Dedicated-host pricing UX                                    | Done enough, bug-fix only | Pricing breakdown, price sorting, CoreMark/value metadata, and unavailable handling are credible | Fix correctness bugs only                                                             |
| Dedicated-host product definition                            | Done enough               | GCP/Nebius release catalog is intentionally narrow and frozen enough for first release           | Keep SKU/region/support docs aligned                                                  |
| Dedicated-host billing enforcement / failed-payment handling | In progress, close        | Backend drain/backup/stop/deprovision state and notifications exist; needs live recovery smoke   | Smoke exhaustion, recovery, admin limit increase, and deprovision paths               |
| Admin entitlement overrides                                  | In progress, very close   | Backend, multibay routing, audit trail, admin UI, and user-visible summary exist                 | Final live save/clear/expiry smoke and UI wording pass                                |
| Dedicated-host owner access control                          | Blocker                   | Needed for real hosted use                                                                       | Implement narrow owner/grant model                                                    |
| Dedicated-host provider/funding-lane final smoke             | Blocker                   | Needs final trusted matrix                                                                       | Run supported-path matrix on real cluster                                             |
| Student pay                                                  | Blocker                   | Explicit release blocker in the master plan                                                      | Implement purchase, entitlement, expiry                                               |
| Minimal domain/site license                                  | Blocker                   | Explicit release blocker in the master plan                                                      | Implement verified-domain entitlement path                                            |
| Notification delivery controls / outbound email              | Blocker                   | Internal notifications exist, but external email behavior is still too blunt for public SaaS     | Implement per-category no/immediate/digest rules and Cloudflare-backed email delivery |
| Stale/deleted host convergence across bays                   | Blocker                   | Still a trust risk when the UI lies                                                              | Harden convergence and operator inspection                                            |
| VM/provider/db orphan healing                                | Blocker                   | Operators still should not need DB surgery                                                       | Make healing and workflows explicit                                                   |
| Deployment / packaging / rollback reproducibility            | Blocker                   | Needed for boring production operation                                                           | Finish standard deploy/rollback path                                                  |
| Real 3-bay hosted soak                                       | Blocker                   | Needed to convert “promising” into “trustworthy”                                                 | Run soak and fix only correctness/trust issues                                        |
| Self-hosted provider bootstrap UX                            | Post-release for SaaS     | Important for Launchpad, not SaaS launch-critical                                                | Resume after hosted release                                                           |
| Cloudflare bootstrap redesign                                | Post-release for SaaS     | Important but not launch-critical                                                                | Treat as Launchpad workstream                                                         |
| Benchmark metadata / CoreMark selector work                  | Post-release              | Valuable differentiation, not a blocker                                                          | Revisit after trust/commercial blockers                                               |

## What Is Already Good Enough To Build On

- multibay split-ingress architecture
- stable browser URL with hidden home-bay routing
- account-home-bay auth authority
- browser 2FA and fresh-auth
- CLI login/elevation model
- project move between regions
- backup-region cutover
- shared-host pressure/stopping model
- hosted backup sharding
- spot interruption recovery foundation
- dedicated-host funding-lane safety foundation
- dedicated-host selector/pricing/value metadata foundation
- admin entitlement override foundation

These areas should now be treated as:

- real product foundations
- ongoing bug-fix and soak targets
- not active redesign zones

## True Release Blockers

These are the items that still clearly block a trustworthy first public SaaS release.

### 1. Dedicated-host commercialization

Required:

- keep the exact supported GCP and Nebius SKUs frozen
- keep the exact supported regions explicit if the catalog is region-sensitive
- finish live smoke for billing enforcement, recovery, and failed-charge behavior
- implement host-owner access control
- finish the final create/start/stop/delete/status smoke on the real supported matrix
- write narrow support-boundary docs

Why this is a blocker:

- the host flow is now visible and attractive enough that users will try to buy it
- that means pricing, access, and failed-charge behavior must be explicit and boring

### 2. Admin entitlement overrides

Required:

- final live smoke for set, clear, expiry, and multibay target-account routing
- confirm effective limits update everywhere they are displayed
- confirm project defaults take effect on project restart with an understood lag
- keep the UI explicit that there is at most one active override set per account
- keep audit events sufficient for support/accounting review

Why this is a blocker:

- support needs a reliable way to save the day for instructors, special customers,
  abuse cases, and billing-limit recovery without editing the database
- this is also the recovery valve for dedicated-host billing enforcement

### 3. Notification delivery controls and outbound email

Required:

- keep internal app notifications as the durable in-product notification surface
- define first-release notification categories, at minimum:
  - billing and dedicated-host enforcement
  - mentions / direct collaboration
  - support/admin account actions
  - LLM/chat/codex turn completion
  - product/news announcements
- add per-account, per-category delivery preferences:
  - no email
  - immediate email
  - digest email
- choose safe first-release defaults, with billing and mentions more prominent than
  noisy activity such as LLM turn completion
- implement immediate-email and digest-email delivery through a durable outbox
- use a Cloudflare-backed email delivery path for hosted `cocalc-ai` if it meets
  the operational requirements, with the provider hidden behind a small adapter
- expose basic delivery metrics, retry state, and admin inspection for failed sends

Why this is a blocker:

- users already complain about coarse digest-only email behavior
- billing and account-risk notifications must reach users outside the app
- noisy categories must not train users to ignore all CoCalc email
- hosted operations should not depend on another avoidable third-party email
  provider if Cloudflare can cover the release needs

### 4. Student pay

Required:

- one-time purchase flow
- four-month duration
- entitlement grant
- automatic expiry/revocation
- clear course association rules

Why this is a blocker:

- the master plan explicitly names it as required for real course adoption and renewals

### 5. Minimal domain/site license

Required:

- verified-domain model
- baseline membership grant
- site-admin configuration path
- entitlement precedence with direct memberships and student pay

Why this is a blocker:

- the master plan explicitly names it as required for several likely low-friction customers

### 6. Multibay trust under churn

Required:

- stale/deleted host convergence
- “VM gone but row still live” healing
- trustworthy host inspection and search/filter
- explicit orphan workflows

Why this is a blocker:

- if the control plane lies about host state, operators and users lose trust quickly

### 7. Deployment / operator boringness

Required:

- reproducible deploy
- reproducible rollback
- standard packaging/runtime path
- less env-sensitive operator flows

Why this is a blocker:

- a public hosted release cannot depend on expert tribal knowledge for routine operations

### 8. Real hosted soak

Required:

- one real 3-bay dogfood cluster
- repeated restarts, host churn, browser reconnects, dedicated-host actions, purchases, and admin workflows
- fix every correctness/trust issue found during the soak

Why this is a blocker:

- this is where the remaining scary bugs will actually show up

## Active Work That Should Not Expand Further Right Now

These areas are useful, but the right move now is bounded cleanup only.

### Dedicated-host pricing UI

The pricing/configuration work is now past the foundation stage.

Do:

- fix correctness bugs
- fix missing/lying prices
- keep the breakdown and unsupported-combination behavior coherent

Do not:

- keep broadening the selector indefinitely
- turn the host picker into a new product in itself

### Notification system

The release need is precise email delivery control for existing notification
categories, not a broad notification-system rewrite.

Do:

- add category-level email preferences
- make immediate vs digest behavior predictable
- wire billing/host enforcement notifications into reliable outbound delivery
- keep provider-specific Cloudflare details behind an adapter

Do not:

- redesign every notification source before release
- attempt push/mobile/webhook delivery before the email path is boring

### Self-hosted Launchpad operator UX

This matters a lot long term, especially:

- GCP one-line bootstrap
- Nebius one-line bootstrap
- Cloudflare bootstrap-token automation

But for the first hosted `cocalc-ai.com` release, this is not a blocker.

## Recommended Next Sequence

This is the shortest sensible path to a trustworthy first release.

1. Freeze dedicated-host scope.
2. Finish dedicated-host billing enforcement live smoke and recovery paths.
3. Finish admin entitlement override live smoke.
4. Implement host-owner access control.
5. Implement notification email preferences and Cloudflare-backed delivery.
6. Implement student pay.
7. Implement minimal domain/site licensing.
8. Run a real hosted multibay soak and fix only correctness/trust issues.
9. Freeze support boundaries and launch conservatively.

## What To Say “No” To Right Now

Until the blocker list above is closed, say no to:

- self-hosted Launchpad scope expansion
- Cloudflare bootstrap/email work for self-hosted beyond the hosted release email
  provider path
- broad notification redesign beyond first-release category email controls
- benchmark metadata UI work
- broader provider/backend expansion
- deep architectural redesign
- broad new product features unrelated to purchase, trust, or hosted robustness

## Conservative Release Standard

The first public SaaS release should be considered ready only when all of the following are true:

- dedicated-host pricing and billing semantics are trustworthy
- admin entitlement overrides work end to end
- notification email preferences and Cloudflare-backed outbound delivery work
- student pay works
- minimal domain/site licensing works
- host-state convergence is boring enough in normal churn
- deployment and rollback are reproducible
- the real hosted cluster survives a meaningful soak without unresolved trust-breaking bugs

If those are true, the release can be narrow and still strong.

If those are not true, shipping earlier would mainly create avoidable trust damage.
