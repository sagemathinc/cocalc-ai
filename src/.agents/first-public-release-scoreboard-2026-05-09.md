# First Public Release Scoreboard

Status: working scoreboard, updated 2026-05-12.

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
- recent admin override, site-license, notification, email-verification,
  student-pay, dedicated-host access-control, host-state convergence, and
  deploy/rollback implementation work through 2026-05-12

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
- explicit cloud refresh and cloud-orphan inspection commands
- rootless Podman bootstrap hardening that preserves live project state during
  project-host upgrades

The remaining release risk has shifted from "build the model" to:

- prove the whole system stays boring during real 3-bay hosted soak
- finish bounded notification/email abuse review
- tighten operator support docs and remaining deploy/rollback polish
- fix only correctness/trust issues found during soak

Latest 2026-05-12 live soak update:

- `lite4b` hub was rebuilt/restarted and `host1` was upgraded to project-host
  `20260512T163202Z-3d4ce000f522`.
- Existing project exec on `host1` continued to work after the project-host
  upgrade.
- The conmon-only `project logs` case found during soak was fixed so the CLI no
  longer reports a live workspace as "container not found"; this old pre-fix
  runtime still has no readable OCI log because its deleted runroot path is gone.
- Bounded stress passed with zero failures:
  `load three-bay --iterations 100 --concurrency 5`,
  `load projects --iterations 200 --concurrency 10`, and
  `load mentions --iterations 100 --concurrency 5`.

The right strategy is still:

- do not expand product scope
- do not redesign architecture
- finish the commercial and operational gaps that directly affect user trust

## Scoreboard

| Area                                                         | Status                     | Read                                                                                                                              | Immediate Next Step                                                          |
| ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Multibay routing / stable URL / home-bay auth                | Done                       | Real strength                                                                                                                     | Keep fixing only correctness bugs found in soak                              |
| Browser 2FA / fresh-auth / CLI auth elevation                | Done                       | Strong enough to dogfood and ship                                                                                                 | Maintenance only                                                             |
| Email verification                                           | Done                       | Verify link encoding, completion UX, address-change verification reset, and feed updates work                                     | Maintenance only                                                             |
| Project move between regions                                 | Done enough                | Release-credible path exists                                                                                                      | Soak and document semantics                                                  |
| Shared-host protection / eviction / stopping                 | Done enough                | One of the stronger release areas                                                                                                 | Keep policy/docs coherent                                                    |
| Managed spot recovery                                        | Done enough                | Real system on the supported path                                                                                                 | Final provider-matrix smoke                                                  |
| Hosted backup sharding / direct R2 backup indexes            | Done enough                | Major risk reduced materially                                                                                                     | Soak under ordinary churn                                                    |
| Dedicated-host pricing UX                                    | Done enough, bug-fix only  | Pricing breakdown, price sorting, CoreMark/value metadata, and unavailable handling are credible                                  | Fix correctness bugs only                                                    |
| Dedicated-host product definition                            | Done enough                | GCP/Nebius release catalog is intentionally narrow and frozen enough for first release                                            | Keep SKU/region/support docs aligned                                         |
| Dedicated-host billing enforcement / failed-payment handling | Done enough, soak target   | Backend drain/backup/stop/deprovision state, recovery surfaces, and notifications exist                                           | Keep under soak; fix correctness bugs only                                   |
| Dedicated-host owner access control                          | Done enough, soak target   | Owner/manager/user grants, placement enforcement, RAM caps, spend caps, manager controls, and fresh-auth gating exist             | Keep under soak; fix correctness bugs only                                   |
| Dedicated-host provider/funding-lane final smoke             | Done enough, soak target   | Supported paths have been smoke-tested enough for soak                                                                            | Keep provider matrix narrow and watch during soak                            |
| Admin entitlement overrides                                  | Done enough, bug-fix only  | Backend, multibay routing, audit trail, CLI, admin UI, user summary, and live save path work                                      | Keep wording/UX precise; only fix correctness bugs                           |
| Notification delivery controls / outbound email              | Done enough, abuse-review  | Preferences, outbox, SMTP/SendGrid-style delivery, daily digest, and live sends work                                              | Abuse/rate-limit review; Cloudflare adapter can follow unless policy changes |
| Minimal site license                                         | Done enough, soak target   | Simplified site licenses, verified-domain claim path, admin provisioning/edit UI, and domain edit smoke exist                     | Keep under soak; improve admin usage display if time permits                 |
| Student pay                                                  | Done enough, soak target   | Membership-based model, direct student purchase, instructor workflow, seats, and site-license defaulting smoke passed             | Keep under soak; polish wording only                                         |
| Stale/deleted host convergence across bays                   | Done enough, soak target   | Duplicate/stale host selection and soft-delete follow-ups have been fixed and tested                                              | Keep under soak; inspect any lying-state bug immediately                     |
| VM/provider/db orphan healing                                | Done enough, operator-safe | `host cloud-refresh` and `host cloud-orphans` give explicit no-DB-surgery inspection/reconcile paths                              | Decide later whether guarded destructive orphan cleanup is needed            |
| Deployment / packaging / rollback reproducibility            | Done enough, polish        | Rollback dry-run, rollback/forward restore, combined restore command, project-log/conmon fallback, and bootstrap hardening landed | Keep under soak; document operator workflow                                  |
| Real 3-bay hosted soak                                       | In progress blocker        | Initial `lite4b` 3-bay stress probes passed with zero failures; soak still needs time and churn coverage                          | Continue soak and fix only correctness/trust issues                          |
| Self-hosted provider bootstrap UX                            | Post-release for SaaS      | Important for Launchpad, not SaaS launch-critical                                                                                 | Resume after hosted release                                                  |
| Cloudflare bootstrap redesign                                | Post-release for SaaS      | Important but not launch-critical                                                                                                 | Treat as Launchpad workstream                                                |
| Benchmark metadata / CoreMark selector work                  | Post-release               | Valuable differentiation, not a blocker                                                                                           | Revisit after trust/commercial blockers                                      |

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
- dedicated-host explicit cloud refresh and cloud-orphan inspection
- project-host bootstrap preservation of live rootless Podman state
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
Most feature work has moved out of this list; the dominant remaining blocker is
proving the hosted system under real churn.

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

- keep billing enforcement, recovery, start/stop/delete, access-control, and
  role-matrix paths under the 3-bay soak
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

- confirm student messaging for grace, blocked, covered-by-existing-membership,
  and covered-until-expiry cases
- keep browser purchase and instructor workflows under soak

Why this is still a blocker:

- public course adoption depends on the student and instructor UX being hard to
  misunderstand, so any confusing soak finding should be fixed quickly

### 3. Minimal site license end-to-end validation

Implemented:

- one simplified `site` membership package model
- admin provisioning path
- editable seats/expiry/domain metadata
- verified-domain claim discovery
- institutional claim identity dedupe foundation
- course configuration can default to a matching site license

Remaining:

- keep verified-domain claim, admin edit controls, and site-license precedence
  under soak
- confirm user-facing "verify email to claim membership" messaging remains clear
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

- verify category defaults, especially billing, mentions, LLM completion, and product/news
- implement or confirm actor/responsible-account email send limits for abuse
  control
- expose enough admin inspection for failed delivery/retry state
- decide whether Cloudflare email is a launch blocker; current read is no if
  SMTP/SendGrid remains acceptable for hosted launch

Why this is still a blocker:

- billing and account-risk notifications must reach users outside the app
- noisy categories must not train users to ignore all CoCalc email
- notification-triggered email must not become a spam vector

### 5. Multibay host-state trust under churn

Implemented:

- stale/deleted host selection fixes
- soft-delete cleanup follow-up smoke
- `cocalc host cloud-refresh <host>`
- `cocalc host cloud-refresh <host> --confirm-missing`
- `cocalc host cloud-orphans --provider <provider>`
- rootless Podman bootstrap fix that avoids deleting live Podman metadata
- live lite4b smoke for GCP/Nebius orphan listing and host refresh
- conmon-only runtime log fallback so an old live workspace is not reported as a
  missing container after prior Podman metadata damage
- initial bounded 3-bay control-plane stress on `lite4b`:
  100/100 three-bay iterations, 200/200 project-list iterations, and 100/100
  mentions iterations with zero failures

Why this is a blocker:

- if the control plane lies about host state, operators and users lose trust quickly
- this is now primarily a soak blocker, not a missing-command blocker

### 6. Deployment / operator boringness

Implemented:

- standard hub build/restart/status commands are documented for the 3-bay dev
  hub
- project-host runtime status, history, reconcile, and rollback commands are
  available under `cocalc host deploy`
- `host deploy rollback --dry-run` resolves previous-version and
  last-known-good rollback targets without changing desired state or queuing
  work
- live `host1` smoke confirmed rollback target selection and aligned
  `acp-worker` reconcile behavior
- one intentional `host1` project-host rollback and forward restore completed
  successfully
- post-restart project exec smoke succeeded in a running project on `host1`
- detailed smoke notes:
  [deploy-rollback-reproducibility-smoke-2026-05-11.md](/home/user/cocalc-ai/src/.agents/deploy-rollback-reproducibility-smoke-2026-05-11.md)

Remaining:

- decide whether project-bundle/tools upgrade LRO noise during rollback smoke
  needs clearer history grouping
- decide whether rollback dry-run belongs in admin UI before first public release
- write the short operator restore/rollback runbook

Why this is a blocker:

- public release operation must not depend on undocumented SSH/DB intervention
- remaining work is now polish around operator ergonomics and follow-up
  observability, not the core rollback path

### 7. Real hosted soak

Current status:

- started on `lite4b` after the 2026-05-12 hub rebuild/restart and `host1`
  project-host upgrade
- confirmed all three bays are visible and accepting project ownership
- confirmed `host1` bootstrap/software lifecycle is in sync and project-host is
  running the latest deployed bundle
- confirmed a live project on `host1` still accepts `project exec` after upgrade
- fixed the first soak trust issue found: `project logs` now reports conmon-only
  live runtimes as running instead of missing
- passed bounded stress probes for 3-bay routing, project listing, and mentions
  reads with zero failures

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

1. Run the real 3-bay hosted soak on `lite4b`.
2. During soak, repeatedly cover browser reconnects, hub restarts, project
   start/stop, project move, dedicated-host access control, dedicated-host
   billing safety, site-license claims, student-pay purchases, notifications,
   and admin workflows.
3. Run bounded stress/load probes that exercise real release risks without
   creating uncontrolled cost or noisy false positives.
4. Fix only correctness, trust, data-loss, billing, auth, and operator-recovery
   issues found during soak.
5. Decide whether Cloudflare email is release-critical or whether SMTP/SendGrid
   is acceptable for the first hosted release with Cloudflare as follow-up.
6. Polish deploy/rollback history grouping only if soak shows it is confusing in
   practice.
7. Write narrow support-boundary and operator runbook docs.
8. Freeze support boundaries and launch conservatively.

## Bounded Stress / Load Testing

Yes, do serious load/stress testing, but keep it targeted. The useful first
release goal is not "maximum benchmark number"; it is proving that admission,
backpressure, reconnect, and operator recovery behavior is predictable.

Do:

- browser reconnect churn across all three bays
- concurrent project starts and stops against shared hosts
- concurrent project starts and moves involving dedicated hosts
- ACP/chat admission-limit pressure from several projects/accounts
- notification outbox pressure with category/rate-limit checks
- control-plane API concurrency around host list/get/refresh/orphan inspection
- hub restart while browser sessions, project terminals, and host operations are active
- billing-risk notification and host-stop safety paths under controlled conditions

Do not:

- run unbounded VM creation loops
- run unbounded email sends
- run provider stress that can create surprise cloud cost
- interpret synthetic throughput numbers as launch readiness
- broaden provider/SKU scope during the soak

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
