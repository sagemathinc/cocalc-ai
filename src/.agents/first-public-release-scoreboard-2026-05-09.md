# First Public Release Scoreboard

Status: working scoreboard, updated 2026-05-11.

Purpose:

- make the first-release path easy to see at a glance
- separate true release blockers from active polish work
- keep the team focused on trust, usability, performance, and purchase-path correctness

This scoreboard is derived from:

- [first-public-release-master-plan-2026-04-30.md](/home/user/cocalc-ai/src/.agents/first-public-release-master-plan-2026-04-30.md)
- [membership2.md](/home/user/cocalc-ai/src/.agents/membership2.md)
- [control-plane-launch-readiness-plan.md](/home/user/cocalc-ai/src/.agents/control-plane-launch-readiness-plan.md)
- [notification-delivery-controls-plan-2026-05-10.md](/home/user/cocalc-ai/src/.agents/notification-delivery-controls-plan-2026-05-10.md)
- [student-pay-membership-plan-2026-05-10.md](/home/user/cocalc-ai/src/.agents/student-pay-membership-plan-2026-05-10.md)
- recent admin override, site-license, notification, email-verification, and
  student-pay implementation work through 2026-05-11

## Current Read

The first public SaaS release of `cocalc-ai` is no longer blocked by missing
membership architecture or missing commercial primitives.

The system now has credible implementations for:

- admin entitlement overrides
- notification email preferences, outbox, and daily digest delivery
- simplified site licenses
- course-visible student membership tiers
- instructor-paid course seats
- direct student course membership purchase
- course access resolution using membership priority, course seats, direct
  student purchases, and claimable site licenses
- dedicated-host owner/manager/user access control
- owner-configurable dedicated-host RAM and spend safety limits

The remaining release risk has shifted from "build the model" to:

- finish live end-to-end smoke on real hosted paths
- finish dedicated-host billing recovery, provider/funding-lane, and churn smoke
- prove multibay/operator trust under churn
- make deployment and rollback boring

The right strategy is still:

- do not expand product scope
- do not redesign architecture
- finish the commercial and operational gaps that directly affect user trust

## Scoreboard

| Area                                                         | Status                      | Read                                                                                                                  | Immediate Next Step                                                             |
| ------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Multibay routing / stable URL / home-bay auth                | Done                        | Real strength                                                                                                         | Keep fixing only correctness bugs found in soak                                 |
| Browser 2FA / fresh-auth / CLI auth elevation                | Done                        | Strong enough to dogfood and ship                                                                                     | Maintenance only                                                                |
| Email verification                                           | Done                        | Verify link encoding, completion UX, address-change verification reset, and feed updates work                         | Maintenance only                                                                |
| Project move between regions                                 | Done enough                 | Release-credible path exists                                                                                          | Soak and document semantics                                                     |
| Shared-host protection / eviction / stopping                 | Done enough                 | One of the stronger release areas                                                                                     | Keep policy/docs coherent                                                       |
| Managed spot recovery                                        | Done enough                 | Real system on the supported path                                                                                     | Final provider-matrix smoke                                                     |
| Hosted backup sharding / direct R2 backup indexes            | Done enough                 | Major risk reduced materially                                                                                         | Soak under ordinary churn                                                       |
| Dedicated-host pricing UX                                    | Done enough, bug-fix only   | Pricing breakdown, price sorting, CoreMark/value metadata, and unavailable handling are credible                      | Fix correctness bugs only                                                       |
| Dedicated-host product definition                            | Done enough                 | GCP/Nebius release catalog is intentionally narrow and frozen enough for first release                                | Keep SKU/region/support docs aligned                                            |
| Dedicated-host billing enforcement / failed-payment handling | In progress, close          | Backend drain/backup/stop/deprovision state and notifications exist                                                   | Live smoke exhaustion, recovery, admin limit increase, and deprovision paths    |
| Dedicated-host owner access control                          | Done enough, smoke-followup | Owner/manager/user grants, placement enforcement, RAM caps, spend caps, manager controls, and fresh-auth gating exist | Rebuild/re-smoke stale-session fresh-auth, soft-delete cleanup, and role matrix |
| Dedicated-host provider/funding-lane final smoke             | Blocker                     | Needs final trusted matrix                                                                                            | Run supported-path matrix on real cluster                                       |
| Admin entitlement overrides                                  | Done enough, bug-fix only   | Backend, multibay routing, audit trail, CLI, admin UI, user summary, and live save path work                          | Keep wording/UX precise; only fix correctness bugs                              |
| Notification delivery controls / outbound email              | In progress, close          | Preferences, outbox, SendGrid/SMTP-style delivery, and daily digest exist                                             | Cloudflare adapter decision, live E2E smoke, abuse/rate-limit review            |
| Minimal site license                                         | In progress, close          | Site licenses are simplified, domain claim path exists, admin provisioning/edit UI exists                             | Live verified-domain claim smoke, usage display polish, edge-case cleanup       |
| Student pay                                                  | In progress, close          | Membership-based model implemented; API smoke and browser/Stripe direct-student smoke passed                          | Instructor workflow smoke, site-license defaulting smoke, wording polish        |
| Stale/deleted host convergence across bays                   | Blocker                     | Still a trust risk when the UI lies; several concrete bugs have been fixed during smoke                               | Harden convergence and operator inspection                                      |
| VM/provider/db orphan healing                                | Blocker                     | Operators still should not need DB surgery                                                                            | Make healing workflows explicit and smoke them                                  |
| Deployment / packaging / rollback reproducibility            | Blocker                     | Needed for boring production operation                                                                                | Finish standard deploy/rollback path                                            |
| Real 3-bay hosted soak                                       | Blocker                     | Needed to convert "promising" into "trustworthy"                                                                      | Run soak and fix only correctness/trust issues                                  |
| Self-hosted provider bootstrap UX                            | Post-release for SaaS       | Important for Launchpad, not SaaS launch-critical                                                                     | Resume after hosted release                                                     |
| Cloudflare bootstrap redesign                                | Post-release for SaaS       | Important but not launch-critical                                                                                     | Treat as Launchpad workstream                                                   |
| Benchmark metadata / CoreMark selector work                  | Post-release                | Valuable differentiation, not a blocker                                                                               | Revisit after trust/commercial blockers                                         |

## What Is Now Good Enough To Build On

- multibay split-ingress architecture
- stable browser URL with hidden home-bay routing
- account-home-bay auth authority
- browser 2FA and fresh-auth
- CLI login/elevation model
- email verification flow
- project move between regions
- backup-region cutover
- shared-host pressure/stopping model
- hosted backup sharding
- spot interruption recovery foundation
- dedicated-host funding-lane safety foundation
- dedicated-host selector/pricing/value metadata foundation
- dedicated-host owner/manager/user access-control foundation
- dedicated-host per-host 5-hour/7-day spend caps and per-host project RAM caps
- admin entitlement override foundation and UI
- notification preference/outbox/digest foundation
- membership package foundation for team, site, and course seats
- simplified site-license foundation
- membership-based student-pay foundation

These areas should now be treated as:

- real product foundations
- ongoing bug-fix and soak targets
- not active redesign zones

## True Release Blockers

These are the items that still clearly block a trustworthy first public SaaS release.

### 1. Dedicated-host commercialization, access, and safety

Implemented:

- keep the exact supported GCP and Nebius SKUs frozen
- keep supported regions explicit if the catalog is region-sensitive
- owner/manager/user host access grants
- grant-by-email UI/API flow
- manager power controls and access-management controls
- user placement enforcement for creating/moving projects onto a host
- owner/manager configurable project RAM cap
- owner-configurable per-host 5-hour and 7-day spend caps
- spend-cap enforcement that stops a host when owner opt-in caps are exceeded
- fresh-auth gating for sensitive host mutations

Remaining:

- rebuild and re-smoke the fresh-auth modal path for stale browser sessions
- re-smoke soft-delete cleanup after moving backup assignment release/restore out
  of the delete transaction
- finish live smoke for billing enforcement, recovery, and failed-charge behavior
- finish final create/start/stop/delete/status smoke on the real supported matrix
- smoke owner, manager, user, unrelated-user, and site-admin role matrix on `lite4b`
- write narrow support-boundary docs

Why this is a blocker:

- the host flow is visible and attractive enough that users will try to buy it
- pricing, access, ownership, spend safety, and failed-charge behavior must be
  explicit and boring

### 2. Student pay end-to-end validation

Implemented:

- course-visible membership tier fields
- configurable course duration and grace period
- student template with course membership pricing
- membership-based course configuration
- course access resolver exposed through hub API
- student-facing project banner and purchase modal
- direct student course package purchase and self-assignment
- distinct `student-course-purchase` grant source
- usage-account attribution for direct student purchases
- site-license claimability in the course resolver

Smoke passed:

- API-level grace, blocked, active-after-purchase, usage attribution, and
  site-license claimability
- CLI course package quote with course duration/grace metadata
- focused server/util/frontend tests for membership package and course helpers
- browser + Stripe test-card direct student course purchase smoke

Remaining:

- instructor course configuration UX smoke
- instructor-paid seat assignment/revocation smoke using course-visible tiers
- site-license-defaulting smoke from instructor course setup
- confirm student messaging for grace, blocked, covered-by-existing-membership,
  and covered-until-expiry cases

Why this is still a blocker:

- the backend model is now credible, but public course adoption depends on the
  actual student and instructor UX being hard to misunderstand

### 3. Minimal site license end-to-end validation

Implemented:

- one simplified `site` membership package model
- admin provisioning path
- editable seats/expiry/domain metadata
- verified-domain claim discovery
- institutional claim identity dedupe foundation
- course configuration can default to a matching site license

Remaining:

- live verified-domain claim smoke in the browser
- smoke admin edit controls for expiry, seats, and domains
- confirm user-facing "verify email to claim membership" messaging
- verify site-license precedence against direct memberships and student-pay course requirements
- usage display polish for admins

Why this is still a blocker:

- site licenses are a likely low-friction first-sale path, and the claim flow
  must be obvious and reliable

### 4. Notification delivery and outbound email

Implemented:

- per-category notification email controls
- removal of the old overlapping `no_email_new_messages` UI path
- durable notification email outbox
- immediate and digest-style delivery foundation
- daily digest email
- live SMTP/SendGrid-style configuration can be smoked on `lite4b`

Remaining:

- decide and implement the Cloudflare email adapter if it meets operational needs
- live E2E smoke for immediate email and digest email
- verify category defaults, especially billing, mentions, LLM completion, and product/news
- implement or confirm actor/responsible-account email send limits for abuse control
- expose enough admin inspection for failed delivery/retry state

Why this is still a blocker:

- billing and account-risk notifications must reach users outside the app
- noisy categories must not train users to ignore all CoCalc email
- notification-triggered email must not become a spam vector

### 5. Multibay host-state trust under churn

Required:

- stale/deleted host convergence
- "VM gone but row still live" healing
- trustworthy host inspection and search/filter
- explicit orphan workflows

Why this is a blocker:

- if the control plane lies about host state, operators and users lose trust quickly

### 6. Deployment / operator boringness

Required:

- reproducible deploy
- reproducible rollback
- standard packaging/runtime path
- less env-sensitive operator flows

Why this is a blocker:

- a public hosted release cannot depend on expert tribal knowledge for routine operations

### 7. Real hosted soak

Required:

- one real 3-bay dogfood cluster
- repeated restarts, host churn, browser reconnects, dedicated-host actions,
  purchases, site-license claims, student-pay purchases, notification sends, and
  admin workflows
- fix every correctness/trust issue found during the soak

Why this is a blocker:

- this is where the remaining scary bugs will actually show up

## Active Work That Should Not Expand Further Right Now

These areas are useful, but the right move now is bounded cleanup only.

### Dedicated-host pricing UI

Do:

- fix correctness bugs
- fix missing/lying prices
- keep the breakdown and unsupported-combination behavior coherent

Do not:

- broaden the selector indefinitely
- turn the host picker into a new product in itself

### Notification system

Do:

- finish category-level email preferences
- make immediate vs digest behavior predictable
- wire billing/host enforcement notifications into reliable outbound delivery
- keep provider-specific Cloudflare/SMTP/SendGrid details behind adapters
- add abuse controls for user-triggered outbound email

Do not:

- redesign every notification source before release
- attempt push/mobile/webhook delivery before the email path is boring

### Student Pay

Do:

- keep the model membership-based
- keep price/duration on the tier
- keep course dates out of pricing
- polish UX wording and smoke the real payment paths

Do not:

- reintroduce quota/date/project-resource-based student pricing
- rebuild the old course fee transfer complexity unless real usage proves it is needed

### Self-hosted Launchpad operator UX

This matters long term, especially:

- GCP one-line bootstrap
- Nebius one-line bootstrap
- Cloudflare bootstrap-token automation

But for the first hosted `cocalc-ai.com` release, this is not a blocker.

## Recommended Next Sequence

This is the shortest sensible path to a trustworthy first release.

1. Rebuild/restart `lite4b` and re-smoke the two dedicated-host smoke follow-ups: stale-session fresh-auth modal and project soft-delete cleanup.
2. Finish the dedicated-host role matrix smoke: owner, manager, user, unrelated user, and site admin across access editing, start/stop, RAM cap, spend cap, and project placement.
3. Finish dedicated-host billing enforcement recovery smoke and provider/funding-lane matrix.
4. Finish instructor course workflow smoke for student-pay, instructor-paid seats, and site-license defaulting.
5. Finish site-license verified-domain claim smoke and admin edit smoke.
6. Finish notification immediate/digest E2E smoke and abuse-limit review.
7. Decide whether Cloudflare email is release-critical or whether SMTP/SendGrid is acceptable for the first hosted release with Cloudflare as follow-up.
8. Harden stale/deleted host convergence and orphan healing workflows.
9. Finish deploy/rollback reproducibility.
10. Run real 3-bay hosted soak and fix only correctness/trust issues.
11. Freeze support boundaries and launch conservatively.

## What To Say "No" To Right Now

Until the blocker list above is closed, say no to:

- self-hosted Launchpad scope expansion
- Cloudflare bootstrap work unrelated to hosted email delivery
- broad notification redesign beyond first-release category email controls
- benchmark metadata UI work
- broader provider/backend expansion
- deep architectural redesign
- broad new product features unrelated to purchase, trust, or hosted robustness

## Conservative Release Standard

The first public SaaS release should be considered ready only when all of the following are true:

- dedicated-host pricing and billing semantics are trustworthy
- dedicated-host ownership, access control, RAM caps, and owner spend caps are explicit
- admin entitlement overrides work end to end
- notification email preferences and outbound delivery work
- student pay works end to end through the browser and Stripe test-card path
- site licensing works end to end through verified-domain claims
- host-state convergence is boring enough in normal churn
- deployment and rollback are reproducible
- the real hosted cluster survives a meaningful soak without unresolved trust-breaking bugs

If those are true, the release can be narrow and still strong.

If those are not true, shipping earlier would mainly create avoidable trust damage.
