# cocalc.com Shutdown and cocalc.ai Takeover Plan

Date: 2026-06-11

Status: planning draft for team review

## Executive Summary

CoCalc should move the primary product surface from `cocalc.com` to
`cocalc.ai` as soon as possible, but "shut down cocalc.com" must not mean
"bulk migrate every historical project before cutover."

The practical target is:

- `cocalc.ai` becomes the place for new signups, new purchases, new projects,
  GPU usage, memberships, and all new product development.
- `cocalc.com` becomes a compatibility, migration, and cold-archive access
  layer with no new economic attack surface.
- Active users and paying customers get bridged into `cocalc.ai` quickly.
- Project data is restored lazily and on demand, with targeted batch migration
  for high-value active customers.
- Old Google Cloud / Kubernetes infrastructure is reduced to the minimum needed
  to support snapshots, exports, and emergency access during the migration
  window.

This approach minimizes security risk, avoids massive GCS Nearline egress, and
lets us protect current revenue without trying to perfectly reproduce ten years
of legacy behavior.

## Why This Is Urgent

The voucher abuse incident showed that `cocalc.com` has a large, old, and
economically dangerous attack surface. Attackers found a way to mint value and
convert it into expensive GPU usage. The cocalc-ai codebase has already had
multiple targeted security and abuse-control passes around exactly this kind of
failure mode: checkout, credits, vouchers, throttling, abuse switches, launch
readiness controls, and admin observability.

The old site also has compounding operational risk:

- It costs more than $10K/month to run.
- Deploying small fixes takes too long and can destabilize production.
- The code and Kubernetes deployment are legacy and not receiving the same
  systematic hardening.
- AI-assisted vulnerability discovery makes "unknown old exploit surface" a
  near-term business risk, not a theoretical concern.
- Running both products at once consumes engineering focus and delays the
  product that can actually grow.

Summer is the best window to move because usage is roughly 25% of normal.

## Core Recommendation

Do a security-first product cutover, not a full historical migration.

The cutover should disable or redirect every cocalc.com capability that can
create new cost, new paid value, or new support burden. Existing users should
still be able to find their data, claim entitlements, and restore projects, but
the default forward path should be `cocalc.ai`.

The migration should be lazy and entitlement-first:

- Migrate account identities, account links, paid entitlements, collaborators,
  and project metadata before bulk file data.
- Restore project files only for active projects, explicit user requests, or
  high-priority institutional customers.
- Keep legacy archives in place until we know which data is actually demanded.
- Preserve enough URL compatibility that old links can lead users to the new
  system or to a restore request.

## Non-Goals

These are intentionally not required before cutover:

- Migrating all 4M accounts.
- Migrating all 4M projects.
- Downloading all GCS Nearline archives.
- Preserving all old bup and ZFS snapshot history in the new system.
- Recreating the old license/quota model exactly.
- Preserving unsafe anonymous "secret URL gives paid license" flows.
- Making every old notebook work without package/environment friction.

## Definition of "cocalc.com Is Shut Down"

The phrase "shut down cocalc.com" should mean the following operational state:

- No new cocalc.com account creation except migration/claim flows.
- No new cocalc.com purchases.
- No voucher creation or redemption.
- No new GPU spend initiated from cocalc.com.
- No new projects created on cocalc.com.
- Existing project URLs either redirect to cocalc.ai or show a restore request.
- Existing login works only to identify the user, migrate the account, download
  data, or request project restoration.
- Admin access remains available for migration, incident response, and customer
  support.

This is materially safer than running the full old product, even if some legacy
infrastructure remains online for months.

## Current System Inventory

### Legacy cocalc.com

Relevant code and deployment paths:

- `/home/user/cocalc`
- `/home/user/kucalc/cluster2`

Important legacy assets:

- A large Postgres database with accounts, projects, collaborators,
  subscriptions, purchases, credits, preferences, licenses, and operational
  metadata.
- More than 4M accounts and more than 4M projects accumulated over about ten
  years.
- Live project storage for recently touched projects on network-mounted ZFS
  pools, sparse images, and daily bup backups.
- Cold archived projects in a GCS Nearline bucket, stored as tarballs containing
  bup backups and ZFS streams.
- Legacy license, site-license, subscription, voucher, and quota systems.
- A very large official software environment that many notebooks implicitly
  depend on.

### cocalc.ai

Relevant target architecture facts:

- Launchpad is the one-bay special case of the bay architecture.
- Accounts have `home_bay_id`.
- Projects have `owning_bay_id`.
- Project data-plane traffic should go directly to project hosts.
- The control plane should route, authorize, and record metadata, not proxy
  steady-state project work.

Useful migration bridge pieces already exist or are in progress:

- Memberships, membership tiers, grants, packages, and assignments.
- Project-host placement and lifecycle APIs.
- RootFS publication and project-host software distribution.
- Admin launch readiness controls, kill switches, and operator health.
- Admin Data Explorer for audited investigation and migration inventory work.
- Backup/restore concepts in the new project-host model.

Missing or incomplete pieces:

- No complete cocalc.com account/project/entitlement importer.
- No compatibility URL router for old cocalc.com project links.
- No legacy project restore worker for GCS Nearline tarball to cocalc.ai
  project data.
- No final policy audit for "turn off all AI" in course/instructor contexts.
- No cocalc-ai replacement for the Cambridge University Press flow.
- No legacy 24.04 software/rootfs compatibility image.

## Migration Principles

- Stop new risk first. Do not wait for perfect migration before removing the
  old economic attack surface.
- Preserve revenue through entitlements. Do not force active paying customers to
  repurchase.
- Migrate metadata before bytes. Metadata is cheap, file archives are not.
- Prefer lazy restore over bulk restore. Demand for ten-year-old projects is
  likely highly skewed.
- Preserve user trust. Old links and paid access should lead somewhere useful.
- Do not reproduce unsafe flows. Rewrite them with explicit capability,
  expiration, rate limits, and audit logs.
- Keep the old system available for rollback and investigation, but not for new
  product activity.
- Make every migration action observable, replayable, and auditable.

## Phased Plan

## Phase 0: Emergency Containment

Target: immediate to 48 hours

Goal: remove the most dangerous old-site attack surfaces before any large
migration work.

Tasks:

- Keep voucher creation and redemption disabled on `cocalc.com`.
- Disable new GPU purchase/spend paths on `cocalc.com`, or require manual admin
  approval for every GPU-related transition.
- Disable cocalc.com credits-to-compute flows that can turn forged value into
  cloud spend.
- Disable new paid purchases on `cocalc.com` except carefully reviewed renewal
  paths if absolutely necessary.
- Disable new cocalc.com project creation for normal users.
- Add a prominent banner that cocalc.com is entering migration mode and that
  new work should happen on cocalc.ai.
- Snapshot the old Postgres database and record the exact deployment state.
- Export current active subscriptions, site licenses, purchases, account
  balances, and recent project activity into immutable migration input files.
- Identify top active customers and institutional accounts for manual review.

Success criteria:

- Attackers can no longer mint value on cocalc.com and convert it into compute.
- New legitimate users are directed to cocalc.ai.
- We have a reliable migration snapshot for reconciliation.

## Phase 1: Product Cutover

Target: 2 to 7 days

Goal: make cocalc.ai the default product without requiring full data migration.

Tasks:

- Route marketing, pricing, signup, new project, and docs entry points from
  cocalc.com to cocalc.ai.
- Keep cocalc.com login only for migration, account linking, support, and data
  restore.
- Add cocalc.com pages for "Move to cocalc.ai", "Restore a legacy project", and
  "Contact support".
- Add a cocalc.ai landing flow for users arriving from legacy links.
- Decide whether cocalc.com DNS stays on the old app, a new compatibility app,
  or a reverse proxy that routes selected paths to cocalc.ai.
- Freeze old deployment except for security containment and migration support
  fixes.

Success criteria:

- A new visitor to cocalc.com ends up on cocalc.ai.
- An existing cocalc.com user can discover the migration path.
- Old high-risk product operations are no longer reachable through the normal
  UI.

## Phase 2: Identity and Account Migration

Target: 1 to 2 weeks for the first usable version

Goal: let legacy users claim or link cocalc.com identity in cocalc.ai.

Recommended model:

- Use cocalc.ai accounts as the primary identity.
- Preserve legacy account IDs in mapping tables.
- Link old accounts to existing cocalc.ai accounts when there is a verified
  email match or explicit proof through old login.
- Do not blindly merge unverified or anonymous accounts by email.
- Require proof of possession for sensitive account migration actions.

Implementation tasks:

- Create a `legacy_cocalc_accounts` or equivalent mapping table in cocalc.ai.
- Import account shell data for active users first: account ID, email, name,
  created timestamp, last active timestamp, verification status, and selected
  preferences.
- Add an account claim flow from cocalc.com to cocalc.ai using signed short-lived
  migration tokens.
- Support old-login proof for users who no longer control the old email address.
- Resolve collisions where one cocalc.ai account and one cocalc.com account use
  the same verified email.
- Build admin tools to manually link, unlink, or mark legacy accounts as
  disputed.

Security requirements:

- Migration tokens must be single-use and short-lived.
- Claims must be audit logged.
- Unverified legacy emails must not grant ownership of paid entitlements without
  additional proof.
- Anonymous accounts must only migrate through old-session proof or manual
  support.

Success criteria:

- A legacy user can sign into cocalc.ai and see that legacy account data has
  been linked.
- Support can resolve identity disputes without direct database edits.

## Phase 3: Billing and Entitlement Bridge

Target: 1 to 3 weeks

Goal: protect current MRR and annual/course revenue while moving authorization
to cocalc.ai.

Recommended model:

- Do not recreate the legacy license system.
- Map legacy rights into cocalc.ai membership grants, packages, or assignments.
- Keep existing Stripe subscriptions in place initially if moving them is risky.
- Mirror their entitlement into cocalc.ai with enough metadata to reconcile.

Migration mappings:

- Active individual subscriptions become membership grants with expiration and
  source metadata.
- Active course purchases become course or package grants with expiration and
  possibly project/class scope.
- Active site licenses become organization/package grants with seat or domain
  policy metadata.
- Remaining positive credit balances become cocalc.ai credits only after fraud
  review and clear accounting rules.
- Voucher-derived balances should be quarantined until the voucher incident is
  fully reconciled.

Implementation tasks:

- Export active subscriptions, purchases, site licenses, vouchers, and balances
  from old Postgres.
- Create a deterministic import that can be rerun without duplicating grants.
- Store source IDs for every imported entitlement.
- Add admin views for legacy entitlement import status.
- Add a customer-facing page that explains the converted entitlement.
- Keep Stripe billing receipts and subscription metadata traceable to the old
  records.

Success criteria:

- Active paying users retain access on cocalc.ai.
- The finance/support team can explain why a user has a given membership.
- Fraudulent or suspicious voucher-derived value is not imported automatically.

## Phase 4: Project Metadata Migration

Target: 1 to 3 weeks

Goal: users can see their legacy projects in cocalc.ai before all file data has
been restored.

Recommended model:

- Import project rows and collaborator relationships for active users.
- Mark each project with a legacy migration state.
- Preserve legacy project IDs where feasible, but always maintain an explicit
  mapping table.
- Do not start or restore project data until requested or prioritized.

Suggested states:

- `metadata_imported`
- `restore_requested`
- `restore_running`
- `restored`
- `restore_failed`
- `archived_remote_only`
- `manual_review_required`

Implementation tasks:

- Create a legacy project mapping table.
- Import active project metadata: title, description, owner, collaborators,
  last edited time, deleted/hidden flags, quotas, and old URL components.
- Import collaborators using migrated account mappings.
- Add a cocalc.ai project-list section or filter for legacy projects needing
  restore.
- Add a restore button with clear expectations around time and software
  compatibility.
- Add admin tooling to prioritize restore queues.

Success criteria:

- A migrated user can see a list of legacy projects.
- The system knows which legacy storage location is needed for each project.
- Users can request restore without support manually searching old databases.

## Phase 5: Project Data Restore

Target: prototype in 1 to 2 weeks, production in 3 to 6 weeks

Goal: restore project files economically and reliably without bulk-downloading
the entire archive.

Recommended model:

- Restore active projects from live ZFS/bup storage first.
- Restore archived projects from GCS Nearline only when requested or prioritized.
- Convert restored data into the cocalc.ai project-host storage/backup format.
- Avoid importing all old snapshots unless explicitly needed.
- Prefer restoring the current working tree plus selected recent history.

Restore worker design:

- Run restore workers close to the GCS bucket or old storage when possible.
- Read old Postgres metadata to locate storage artifacts.
- Extract only the needed project content.
- Produce a normalized project data bundle for cocalc.ai project hosts.
- Upload to cocalc.ai object storage or directly seed a project host.
- Record byte counts, cost estimates, duration, errors, and source artifact IDs.

Cost controls:

- Require explicit user/admin request for cold archive restore.
- Rate limit restore requests per account and per site.
- Queue large restores for background processing.
- Show users that very old projects may take time to restore.
- Avoid repeated GCS egress by caching converted restore bundles when practical.

Success criteria:

- Restore succeeds for representative live ZFS projects.
- Restore succeeds for representative GCS Nearline archived projects.
- Restore cost and duration are visible before scaling the queue.

## Phase 6: Domain and URL Compatibility

Target: parallel with phases 1 through 5

Goal: old links remain useful even after the old product is no longer active.

URL behavior:

- Old account URLs redirect to cocalc.ai account or migration claim pages.
- Old project URLs redirect to the migrated project if restored.
- Old project URLs show a restore request if metadata exists but data is not
  restored.
- Unknown old URLs show support/contact guidance.
- Public-share URLs need separate handling because they may not map to a signed
  in user.

Implementation tasks:

- Inventory the most common old URL patterns.
- Build a compatibility router or route table.
- Store old-to-new project/account URL mappings.
- Add telemetry for legacy URL hits so we know which paths matter.
- Keep search engine behavior intentional: avoid exposing private migration
  state and avoid indexing restore pages for private projects.

Success criteria:

- A user clicking an old class/project link gets a meaningful migration path.
- Support can diagnose a broken old URL from logs.

## Phase 7: Feature Gap Closures

Target: before broad institutional migration

Goal: remove blockers that would cause major customer regressions.

### Turn Off All AI

This is a must-have for instructors.

Requirements:

- Policy must be enforceable at account, project, course/package, and
  site-license or organization scope.
- The enforcement point must be server-side for all LLM/Codex/agent APIs.
- UI hiding alone is not sufficient.
- Project-host services must honor scoped tokens or policy claims.
- The admin UI must show why AI is disabled for a user/project.
- The policy must be testable with a small suite of negative tests.

### Cambridge University Press Flow

The old anonymous secret-URL flow should not be preserved as-is.

Replacement design:

- Customer-owned content templates.
- Signed invitation links with expiration, rate limits, and revocation.
- Optional anonymous access only if sandboxed and explicitly scoped.
- Per-link and per-customer audit logs.
- Abuse controls for clone volume and compute usage.
- A support/admin console to revoke leaked links.

If CUP cannot move immediately, keep them as a temporary legacy island with
restricted blast radius rather than blocking the whole migration.

### Legacy Software Environment

The old official environment is a major compatibility issue.

Recommended approach:

- Publish a "Legacy CoCalc 24.04" rootfs image.
- Do not make it the default for new cocalc.ai users.
- Offer it for migrated projects and selected classes.
- Document differences clearly.
- Prefer letting advanced users install packages with sudo/rootfs publication
  instead of growing one huge default image forever.

Success criteria:

- Instructors can disable AI reliably.
- CUP has either a replacement path or an explicitly isolated legacy exception.
- Common migrated notebooks have a credible compatibility environment.

## Phase 8: Operations and Observability

Target: before large-scale rollout

Goal: make migration measurable and recoverable.

Required dashboards:

- Active legacy accounts imported.
- Active paid entitlements imported.
- Projects with metadata imported.
- Restore requests by state.
- Restore failures by cause.
- Restore cost and bytes transferred.
- Legacy URL hits by route type.
- cocalc.com blocked purchase/voucher/GPU attempts.
- Support tickets linked to migration state.

Required admin tools:

- Link or unlink legacy account mapping.
- Re-run entitlement import for a single account or customer.
- Grant temporary membership while investigating migration issues.
- Prioritize or cancel project restore.
- Mark a project as manual review.
- Export a user-facing migration summary for support.

Required audit logs:

- Account claim.
- Entitlement import.
- Entitlement manual override.
- Project restore request.
- Project restore completion/failure.
- Legacy URL redirect/restore decisions for private resources.
- Admin migration actions.

## Rollout Strategy

### Canary 0: Internal Accounts

Scope:

- Staff accounts.
- A mix of old active projects, archived projects, subscriptions, and purchases.

Exit criteria:

- Account link works.
- Entitlement import works.
- At least one active project restore works.
- At least one archived project restore works.
- Old URL redirect works.

### Canary 1: Friendly Active Users

Scope:

- 25 to 50 known users during summer.
- Include at least one course-like use case and one paid individual subscriber.

Exit criteria:

- No support-blocking identity issues.
- Restores complete within acceptable time.
- Billing entitlements are understandable.

### Canary 2: High-Value Customers

Scope:

- Annual institutional customers.
- Customers with known support contacts.
- CUP only if replacement flow is ready or isolated.

Exit criteria:

- Customer-specific migration checklist signed off.
- Support and billing can answer entitlement questions.

### Broad Active User Cutover

Scope:

- Users active in the last 6 to 12 months.
- Projects touched in the last 6 to 12 months.

Exit criteria:

- cocalc.com no longer accepts normal new work.
- cocalc.ai handles normal active-user demand.
- Restore backlog is bounded.

### Long Tail Archive

Scope:

- Inactive users and old projects.

Policy:

- Restore on request.
- Consider eventual archival retention policy and deletion policy after the
  business and legal review.

## Data Migration Details

### Account Mapping

Suggested table fields:

- `legacy_account_id`
- `cocalc_ai_account_id`
- `legacy_email`
- `legacy_email_verified`
- `claim_method`
- `claim_time`
- `migration_state`
- `last_error`
- `created_at`
- `updated_at`

### Project Mapping

Suggested table fields:

- `legacy_project_id`
- `cocalc_ai_project_id`
- `legacy_owner_account_id`
- `owning_bay_id`
- `legacy_storage_kind`
- `legacy_storage_locator`
- `last_edited`
- `restore_state`
- `restore_requested_by`
- `restore_requested_at`
- `restore_completed_at`
- `restore_bytes`
- `restore_error`

### Entitlement Mapping

Suggested table fields:

- `legacy_source_type`
- `legacy_source_id`
- `cocalc_ai_grant_id`
- `account_id`
- `project_id`
- `organization_id`
- `starts_at`
- `expires_at`
- `amount`
- `currency`
- `fraud_review_state`
- `created_at`
- `updated_at`

## Business Rules to Decide

These should be decided explicitly before broad migration:

- Which users count as "active" for the first migration wave.
- Whether to preserve old account IDs directly when there is no collision.
- Whether old project IDs should be reused as cocalc.ai project IDs or only
  stored in mapping tables.
- Which legacy credit balances are trusted enough to import.
- How to handle voucher-derived balances from the incident window.
- Whether old free users get a temporary membership trial on cocalc.ai.
- How much old snapshot history is restored by default.
- How long cocalc.com remains available as a restore portal.
- What public announcement timeline is acceptable.

## Immediate Technical Work Items

Recommended first vertical slice:

- Build a migration inventory report from old Postgres for active accounts,
  active projects, active subscriptions, active site licenses, purchases, and
  balances.
- Create cocalc-ai mapping tables for legacy accounts, projects, and
  entitlements.
- Implement one account claim flow.
- Import one active paid account into cocalc.ai with a membership grant.
- Import that account's project metadata and collaborators.
- Restore one live recent project.
- Restore one GCS Nearline archived project.
- Redirect one old cocalc.com project URL to the new migration/restore flow.

This slice is the highest-value next step because it tests identity, billing,
metadata, file restore, and URL compatibility without committing to bulk
migration.

## Customer Communication Plan

Public messaging should be direct and operational:

- CoCalc is moving to cocalc.ai.
- Existing paid access will be honored.
- Existing projects remain available.
- Some very old projects may require restore time.
- New projects should be created on cocalc.ai.
- Legacy software compatibility options are being provided.
- Instructors will have AI-off controls.

Support should have canned answers for:

- "Where is my project?"
- "Why is my old project not restored yet?"
- "What happened to my license?"
- "Can I disable AI for my class?"
- "My notebook package is missing."
- "I have an old public/share link."
- "I no longer control my old email."

## Risks

### Security Risk

Risk: cocalc.com remains exploitable during migration.

Mitigation: remove new economic activity immediately, keep vouchers disabled,
disable GPU spend, and freeze high-risk flows.

### Revenue Risk

Risk: paid users lose access or lose confidence.

Mitigation: import entitlements before file data, preserve Stripe subscriptions
initially, and manually review top customers.

### Data Restore Cost Risk

Risk: GCS Nearline egress and huge tarballs create unacceptable cost.

Mitigation: lazy restore, restore near the bucket, avoid full history by
default, and measure sample projects first.

### Compatibility Risk

Risk: notebooks fail in the new smaller environment.

Mitigation: provide a legacy rootfs option and support sudo/rootfs publication
for self-service fixes.

### Identity Risk

Risk: users claim the wrong account or lose access to old unverified accounts.

Mitigation: use verified-email matching only where safe, require old-session
proof or support review for ambiguous accounts, and audit every claim.

### Institutional Workflow Risk

Risk: CUP and course workflows do not map cleanly to cocalc.ai.

Mitigation: build explicit replacements for high-value workflows and keep
temporary legacy islands only where necessary.

## Decision Points for the Team Meeting

- Do we agree that product cutover should happen before full project data
  migration?
- What exact date should cocalc.com stop new signups, purchases, projects, and
  GPU spend?
- Which active-user window should drive the first import: 3 months, 6 months,
  or 12 months?
- Do we mirror existing Stripe subscriptions into cocalc.ai first, instead of
  trying to migrate Stripe billing objects immediately?
- Which legacy credit balances are imported automatically, and which require
  fraud review?
- Is preserving old project IDs worth making a hard requirement?
- Who owns the CUP replacement design and customer conversation?
- What is the minimum acceptable "turn off all AI" implementation before course
  migration?
- Do we announce a firm migration date publicly or start with targeted customer
  outreach?

## Proposed Timeline

### First 48 Hours

- Lock down cocalc.com economic attack surfaces.
- Snapshot old DB and deployment state.
- Produce migration inventory reports.
- Identify top customers and active project volume.

### First Week

- Build account/entitlement/project mapping tables.
- Implement first account claim and entitlement import.
- Add cocalc.com migration banner and redirect new-user paths.
- Prototype active project restore.

### Weeks 2 to 3

- Canary staff and friendly active users.
- Prototype GCS Nearline restore.
- Add admin migration dashboard.
- Implement or audit AI-off enforcement.
- Start legacy rootfs image work.

### Weeks 4 to 6

- Migrate broad active-user cohort.
- Move normal product traffic to cocalc.ai.
- Keep cocalc.com as compatibility and restore portal.
- Reduce old infrastructure to migration-critical services.

### After Broad Cutover

- Migrate long-tail projects on request.
- Convert or retire remaining old customer-specific flows.
- Establish retention policy for inactive archives.
- Decommission old Kubernetes components progressively.

## Bottom Line

The safest path is to separate the business/product cutover from the historical
data migration.

Move users, billing rights, and new work to cocalc.ai quickly. Keep cocalc.com
only as a locked-down compatibility and restore system. Restore projects lazily.
Rewrite unsafe legacy workflows instead of preserving them. This protects
revenue, reduces security exposure, avoids unnecessary GCS costs, and lets the
team focus on the product that can grow.
