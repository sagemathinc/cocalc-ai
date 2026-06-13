# cocalc.com Shutdown and cocalc.ai Takeover Plan

Date: 2026-06-11

Status: tightened plan after team review

## Executive Summary

CoCalc should move the active product from `cocalc.com` to `cocalc.ai` before
the July travel window. The plan is not a perfect historical migration. It is a
deadline-driven cutover that preserves paid users, lets users import the
projects they care about, and removes the old cocalc.com security and cost
surface as fast as possible.

The revised strategy is:

- Keep cocalc.com in containment mode immediately.
- Launch cocalc.ai as the forward product for new work.
- Migrate standard legacy licenses to standard cocalc.ai memberships.
- Handle special licenses and meaningful credit balances manually from reports.
- Let users import legacy project metadata from inside cocalc.ai.
- Copy project data as one normalized "latest files only" artifact per project.
- Use R2 as the shared migration artifact store for every data source.
- Run a one-time GCS Nearline conversion for `kucalc-prod2-archived-projects`
  so the old GCP bucket and old Kubernetes storage can be deleted.
- Replace Cambridge University Press special handling with signed
  site-license claim tokens plus rootfs landing pages.

This should be managed as a launch project with hard cut lines. If a feature is
not required for UCLA, CUP, standard paid licenses, or user-selected project
imports, it should be deferred.

## Hard Dates

Current date: 2026-06-11

Critical dates:

- 2026-06-20: cocalc.ai must be usable for UCLA pre-class setup.
- 2026-06-23: UCLA class starts.
- 2026-07-01: transition must be operationally stable before travel.
- 2026-07-02 to 2026-07-18: travel/vacation window.
- 2027-01-01: proposed end date for allowing new legacy project migration
  requests.

Deadline implication:

- The migration plan must optimize for working vertical slices, not complete
  generality.
- Ancient project restore must be designed now, but the first UCLA-ready system
  can prioritize recent projects and paying customers.
- Long-tail project access can be available for up to one year through R2
  artifacts instead of keeping the old GCP/Kubernetes stack alive.

## Product Cutover Definition

"Shut down cocalc.com" means removing the old product surface, not immediately
destroying all old data.

Target cocalc.com state:

- No new vouchers.
- No voucher redemption.
- No new purchases.
- No new GPU spend.
- No new normal projects.
- No new normal signups except migration/claim paths.
- Existing login only supports migration, project export, support, and account
  verification.
- Old project URLs route to cocalc.ai migration, restore, or support pages.
- Admin access remains only for containment, audit, and migration support.

Target cocalc.ai state:

- New signups happen on cocalc.ai.
- New projects happen on cocalc.ai.
- Standard paid users receive standard memberships.
- Site-license style customers receive memberships through cocalc.ai-native
  site licenses.
- Legacy projects appear in cocalc.ai after metadata import.
- Project files restore from R2 artifacts, regardless of original source.

## Scope Cuts

These are explicit cuts to make the deadline:

- Do not migrate all 4M accounts.
- Do not import every old entitlement automatically.
- Do not recreate the old license system.
- Do not transfer old bup history or ZFS snapshots.
- Do not build one giant "CoCalc 2024" compatibility image.
- Do not preserve the old CUP anonymous secret-URL flow.
- Do not require the old GCS bucket to stay online for a year.
- Do not block launch on long-tail ancient projects if the R2 artifact pipeline
  is underway.

## Minimum Viable Launch

The minimum viable launch before UCLA requires:

- cocalc.com containment remains in place.
- cocalc.ai standard memberships are production-ready.
- Standard old licenses can be converted to standard memberships.
- UCLA users can create accounts, get the right membership/access, create
  projects, and use the required image.
- Instructors can disable AI where required.
- Users can list their old projects from cocalc.ai and select projects to
  import.
- Selected project metadata is imported immediately.
- Opening a selected project starts or prioritizes latest-file data restore.
- The restore path from one normalized R2 artifact format works.
- At least one recent bup-backed project can be exported into that format.

Everything else is important but secondary.

## Cambridge University Press Replacement

CUP should not be a custom legacy exception. It should become the first customer
of a generic signed site-license claim mechanism.

### Site-License Claim Tokens

Use site licenses as the entitlement primitive.

Flow:

- CUP has a paying customer Alice.
- CUP mints a signed one-time token for Alice.
- Alice visits a cocalc.ai URL with that token.
- Alice signs up or signs in with her own email and account.
- cocalc.ai verifies the token and grants Alice a membership seat from CUP's
  site license.
- The token is consumed and cannot be reused.

This works because Alice's identity does not need to match CUP email, SSO, or
domain policy. The token proves CUP authorized Alice.

### Token Authority Model

Recommended design:

- Each site license can have one or more external claim pools.
- Each pool stores a public verification key.
- CUP either generates the keypair or CoCalc generates it and gives CUP the
  private key once.
- CUP signs compact claim records offline or from their backend.
- cocalc.ai verifies the signature using the pool public key.
- CUP does not need an authenticated cocalc.ai API integration just to mint
  claims.

Token fields:

- `iss`: publisher or site-license issuer identifier.
- `aud`: `cocalc.ai.site-license-claim`.
- `site_license_id`: target cocalc.ai site license.
- `pool_id`: target claim pool.
- `jti`: unique one-time token ID.
- `exp`: token expiration.
- `nbf`: optional not-before timestamp.
- `membership_class`: optional if not fixed by the pool.
- `membership_expires_at`: optional if not fixed by the pool.
- `rootfs_id`: optional content/image landing target.
- `label`: optional human-readable publisher label.

Validation rules:

- Signature must verify against an active pool key.
- `aud` must match exactly.
- `exp` must be in the future.
- `jti` must not have been consumed.
- Site license and pool must be active.
- Pool seat limits and membership limits must be enforced atomically.
- Consumption must be audited.

Admin controls:

- Disable pool.
- Rotate public key.
- Revoke a key.
- Revoke unused token IDs if CUP provides a list.
- View consumed claims.
- View claim failures.
- Set pool membership class and duration.
- Set pool max claims and rate limits.

Why this is better than secret URLs:

- One-time use.
- Signed.
- Scoped.
- Expiring.
- Audited.
- Revocable by key or pool.
- Useful for customers beyond CUP.

### CUP Content Delivery

CUP's second need is content delivery. Rootfs landing pages are the right
replacement.

Desired flow:

- CUP publishes or sponsors a trusted rootfs for a publication.
- A user visits a publication/rootfs landing URL.
- The page explains the content, publisher, image, and membership requirement.
- The user signs up or signs in.
- The user optionally redeems a signed site-license claim token.
- The user creates a project using that rootfs.
- The project starts with the publication content available.

This is isomorphic to the old CUP flow:

- Display content.
- Create or sign in.
- Grant access.
- Give the user a working copy.

But the new flow uses safe primitives:

- Site-license claim tokens for access.
- Rootfs trust/publishing for content.
- Normal cocalc.ai accounts.
- Normal cocalc.ai projects.
- Normal audit logs.

CUP migration scope:

- CUP likely has around 20 publications.
- Each publication should become a rootfs or rootfs-backed content template.
- CUP can have separate claim pools for customers, editors, authors, or other
  roles.

## Legacy License Migration

The old entitlement migration should be intentionally narrow.

Policy:

- Standard cocalc.com licenses, roughly the old $9/month license, map to
  standard cocalc.ai $8/month memberships.
- All non-standard or one-off licenses are handled manually.
- Do not build a complete old-license compatibility engine.
- Do not automatically trust voucher-derived value without review.

Implementation:

- Run a DB query that lists active standard licenses.
- Import those as standard membership grants or subscriptions in cocalc.ai.
- Store source legacy license IDs for audit.
- Generate a second report of non-standard licenses for manual handling.
- Generate a report of accounts with meaningful credit balances.
- Andrey reviews the roughly 400 accounts with nontrivial credit.
- Approved credit balances are imported manually or with a reviewed one-shot
  import.

This is much simpler and safer than general license migration.

## Identity Migration

Many legacy users may know their cocalc.com password but no longer control
their university email.

Policy:

- If a user has a verified email on cocalc.com and successfully logs in with
  their cocalc.com password, cocalc.ai may create or link that email and mark it
  verified.
- This is a grandfathering rule for verified legacy identities only.
- Anything else requires support review.

Allowed automatic cases:

- Verified legacy email plus successful legacy password login.
- Existing cocalc.ai account with same verified email and successful legacy
  claim.
- Active legacy session converted into a short-lived migration claim token.

Support-required cases:

- Unverified legacy email.
- Anonymous legacy account.
- User cannot log into cocalc.com.
- User no longer controls email and legacy email was not verified.
- Account collision or disputed claim.

Audit requirements:

- Log every legacy account claim.
- Log source legacy account ID.
- Log target cocalc.ai account ID.
- Log claim method.
- Log verified-email grandfathering.

## Project Migration UX

Project import should happen inside cocalc.ai.

Flow:

- User opens "Import projects from cocalc.com".
- User proves legacy identity if not already linked.
- cocalc.ai shows a list of legacy projects similar to cocalc.com.
- Hidden projects are hidden by default.
- User can filter by hidden status, recent activity, ownership, and
  collaborator status.
- User can select ranges.
- User can select all visible.
- User can select all recently active.
- User chooses a default image for selected projects.
- User can override image per project.
- User clicks import.
- Import creates cocalc.ai project metadata only.
- File data is copied later when opened or by background workers.

Default image choices:

- Python
- R
- Julia
- Sage
- LaTeX
- Minimal

User messaging:

- Images can be changed later.
- Packages can be installed later.
- Coding agents can help install missing software.
- Only the latest project files are migrated by default.
- Old backups and snapshots are not migrated.

## Project Ownership and Collaborators

Old cocalc.com ownership and collaboration were closer to symmetric. New
cocalc.ai ownership matters more because it determines billing responsibility.

Policy:

- The first legacy collaborator or owner who imports a project becomes the new
  cocalc.ai owner.
- If another legacy collaborator or the old owner later imports the same legacy
  project, they are added to the existing target project.
- The system should not create duplicate target projects for the same legacy
  project.
- Ownership can be changed later through normal cocalc.ai mechanisms or support.

This avoids disputes in the common case. The important invariant is one legacy
project maps to one cocalc.ai project.

Required mapping:

- `legacy_project_id`
- `target_project_id`
- `first_imported_by_account_id`
- `current_owner_account_id`
- `imported_at`
- `legacy_collaborator_account_ids`
- `migration_state`

## Project Data Migration Strategy

The project data strategy should use one normalized artifact format in R2.

Invariant:

- cocalc.ai restore code only needs to understand one artifact format.
- Every legacy source is converted into that format before cocalc.ai restores
  it.
- The artifact contains only the latest file tree, not old bup history or ZFS
  streams.

Suggested artifact:

- `legacy-project-latest-v1.tar.zst`
- Includes project files at the root or under a stable `files/` prefix.
- Includes a small `manifest.json`.
- Excludes bup internals.
- Excludes ZFS streams.
- Excludes historical snapshots.
- Has checksum and byte size metadata in R2 object metadata or sidecar JSON.

Manifest fields:

- `format_version`
- `legacy_project_id`
- `source_kind`
- `source_snapshot_time`
- `created_at`
- `file_count`
- `uncompressed_bytes`
- `compressed_bytes`
- `content_sha256`
- `exporter_version`

R2 object layout:

- `legacy-projects/v1/<legacy_project_id>/latest.tar.zst`
- `legacy-projects/v1/<legacy_project_id>/manifest.json`
- Optional `legacy-projects/v1/<legacy_project_id>/export.log`

## Source 1: Recent Bup Backup Disk

Most likely migration demand comes from projects active in the last six months.

Current facts:

- Projects active in the last six months exist in recent live storage.
- If not touched in the last 24 hours, there is an up-to-date bup backup.
- These backups sit on one large roughly 13TB disk in the Kubernetes cluster.
- The disk has roughly 5.9TB used.
- There are about 45,000 such project bup archives.
- Around 1,500 projects are touched each day, so some backups are stale.

Plan:

- Snapshot and clone the 13TB disk to avoid disturbing live cocalc.com.
- Run an exporter over the cloned disk.
- For each project bup archive, export the latest bup commit.
- Create the normalized latest-file tarball.
- Upload the tarball and manifest to R2.
- Delete the cloned disk when done.

Benefits:

- Covers the highest-probability migration set.
- Avoids interacting with live projects.
- Produces clean R2 artifacts before users ask for them.
- Makes cocalc.ai restore fast and simple.

This should be one of the first implementation efforts.

## Source 2: Recently Modified Live Projects

Some projects will be newer than their last bup backup.

Plan:

- Add a special cocalc.com migration API protected by an API key.
- cocalc.ai calls this API only after a user explicitly selects a project for
  migration or opens an imported metadata-only project.
- cocalc.com locks the project so users cannot continue editing it there.
- cocalc.com exports the latest project files.
- cocalc.com writes the same normalized tarball format.
- cocalc.com uploads directly to the same R2 bucket.
- cocalc.ai restores from R2.

Lock policy:

- Once live export begins, the old project is no longer openable for normal
  users on cocalc.com.
- The user is directed to the cocalc.ai project.
- Failed exports should unlock only if the project was not successfully
  imported, or require admin review.

This handles the "touched today" case without requiring cocalc.ai to understand
old live storage.

## Source 3: GCS Nearline Bucket

The bucket `kucalc-prod2-archived-projects` should not remain a long-term
dependency.

Current facts:

- The bucket stores one tarball per archived project.
- Each tarball contains a bup archive and ZFS streams.
- ZFS streams should be ignored for migration.
- The latest bup version is what matters.
- The bucket costs roughly $537/month to store.
- Reading from GCS is roughly estimated at $0.01/GB.
- A full or cutoff-limited conversion is probably much cheaper than keeping the
  bucket for many months.

Recommended plan:

- Run a one-time conversion for ancient archived projects.
- Use a small GCP VM or spot VM in the appropriate region.
- Download each legacy archive tarball from GCS to the VM.
- Extract the bup archive.
- Restore the latest bup version.
- Create the normalized latest-file tarball.
- Upload the normalized tarball and manifest to R2.
- Delete temporary local data.
- After verification and retention review, delete converted objects from GCS or
  delete the bucket.

Estimated cost model:

- Worst-case old archive read: 50TB at $0.01/GB is about $500.
- More likely cutoff-limited read: 20TB is about $200.
- Processing on GCP spot instances: rough estimate $200.
- GCP egress/upload path to R2: rough estimate $500.
- Total expected one-time cost: likely under $1K, subject to real measurement.
- Resulting normalized R2 data may be about 5TB.
- R2 standard storage at $0.015/GB-month is about $75/month for 5TB.
- R2 infrequent access at $0.01/GB-month is about $50/month for 5TB.

This is likely better than keeping a $537/month GCS bucket and the operational
burden of old restore infrastructure.

Important caveat:

- These estimates must be validated with a sample of real project archives.
- The plan should start with a statistically useful sample before processing
  the full bucket.

Recommended sampling:

- 100 tiny archives.
- 100 medium archives.
- 20 large archives.
- 5 pathological huge archives.
- Include archives from different years.
- Measure download bytes, extracted latest-file size, processing time, failure
  rate, and R2 compressed size.

## One-Year Migration Window

Proposed policy:

- Users have until 2027-01-01 to request/import legacy projects.
- Projects selected for migration before the cutoff remain available from R2.
- After the cutoff, unsupported legacy migration paths are shut down.
- The old GCP bucket should not be kept until 2027 if the R2 conversion
  succeeds.

This gives users a clear deadline while still allowing old infrastructure to be
retired much sooner.

## Focused Software Images

Do not build one huge legacy compatibility image.

Instead build focused images:

- Python
- R
- Julia
- Sage
- LaTeX
- Minimal

Reasons:

- Huge rootfs images are hard to build, publish, cache, and manage.
- Users usually need one or two ecosystems, not everything.
- Smaller images are easier for users to republish.
- sudo and rootfs publication make missing software fixable.
- Coding agents make "install package X" much easier for users.
- Documentation can cover common installs such as Chromium or system libraries.

Launch requirement:

- The Python image must be strong.
- The uv-based approach used for CoCalc Star is the right model.
- Sage, R, Julia, and LaTeX images should be good enough for major course use.
- The project import UI should make image selection clear and reversible.

## AI-Off Requirement

Instructor "turn off all AI" is a launch blocker for courses.

Requirements:

- Server-side enforcement.
- Applies to accounts, projects, course/site-license contexts, and relevant
  project-host agent services.
- UI hiding is not enough.
- Admin/support can see why AI is disabled.
- Tests prove blocked users cannot reach LLM/Codex/agent APIs.

This should be handled as a separate focused implementation/audit workstream.

## Operational Reports

The migration should start from concrete reports, not generalized assumptions.

Immediate reports:

- Active standard licenses that map to standard memberships.
- Non-standard licenses requiring manual handling.
- Accounts with meaningful credit balances.
- Active users in the last 3, 6, and 12 months.
- Projects active in the last 3, 6, and 12 months.
- Projects owned by paying customers.
- Projects with recent edits newer than latest bup backup.
- Size distribution of recent bup exports.
- Size distribution of GCS archive conversions.
- Top institutional customers and their project counts.

These reports can be generated from old Postgres and reviewed before automation
is trusted.

## Admin and Audit Requirements

Required admin tools:

- View legacy account mapping.
- Manually link a legacy account to a cocalc.ai account.
- Import a standard license as a membership.
- Manually grant or adjust membership for special cases.
- View reviewed credit balances.
- View legacy project mapping.
- Prioritize a project data export.
- Retry a failed export.
- Mark a project as support-required.
- View CUP/site-license claim token consumption.
- Disable a site-license claim pool.

Required audit events:

- Legacy login proof accepted.
- Verified legacy email grandfathered.
- Standard license imported.
- Manual license grant created.
- Credit balance imported.
- Project metadata imported.
- Project artifact exported.
- Project artifact restored.
- Live cocalc.com project locked for migration.
- Site-license claim token consumed.
- Site-license claim token rejected.

## Implementation Workstreams

### Workstream A: Containment

Owner: immediate operations/security

Deliverables:

- cocalc.com vouchers remain disabled.
- cocalc.com new purchases disabled or sharply limited.
- cocalc.com GPU spend disabled or manual-approved.
- cocalc.com new project creation disabled for normal users when ready.
- Migration banner and redirect paths.

### Workstream B: Entitlements

Owner: billing/membership

Deliverables:

- Standard license report.
- Standard membership import.
- Non-standard license report.
- Credit balance report for Andrey review.
- Manual special-case tooling.

### Workstream C: Identity

Owner: auth/accounts

Deliverables:

- Legacy account mapping table.
- Legacy login proof flow.
- Verified email grandfathering.
- Support path for all other cases.

### Workstream D: Project Metadata Import

Owner: frontend/projects/control plane

Deliverables:

- cocalc.ai import page.
- Legacy project list.
- Hidden/recent filters.
- Range/select-all controls.
- Default image selection.
- Per-project image override.
- Metadata-only project creation.
- Legacy project to target project mapping.
- Subsequent collaborator import adds user to existing target project.

### Workstream E: R2 Artifact Restore

Owner: project-host/storage

Deliverables:

- Normalized artifact spec.
- R2 credentials/config.
- cocalc.ai restore from R2.
- Manifest validation.
- Restore progress state.
- Restore failure diagnostics.

### Workstream F: Recent Bup Export

Owner: legacy storage/migration

Deliverables:

- Clone/snapshot 13TB bup disk.
- Export latest bup commit per project.
- Normalize to tarball.
- Upload to R2.
- Progress and failure report.

### Workstream G: Live Project Export

Owner: legacy cocalc.com

Deliverables:

- Protected migration API.
- Project lock.
- Latest file export.
- R2 upload.
- State update for cocalc.ai restore.

### Workstream H: GCS Nearline Conversion

Owner: migration/storage

Deliverables:

- GCP VM conversion worker.
- Sample conversion report.
- Full or cutoff-limited conversion.
- R2 upload.
- Verification.
- GCS delete plan.

### Workstream I: CUP and External Claims

Owner: site licenses/rootfs

Deliverables:

- Site-license claim pools.
- Public key storage.
- Token verification and consumption.
- Claim audit logs.
- CUP sample token generator.
- Rootfs landing page.
- Create project from rootfs landing flow.

### Workstream J: Focused Images

Owner: rootfs/software

Deliverables:

- Python image.
- R image.
- Julia image.
- Sage image.
- LaTeX image.
- Minimal image.
- Install docs for common missing packages.

## Proposed Timeline

### 2026-06-11 to 2026-06-13

- Finalize this plan.
- Keep cocalc.com containment in place.
- Generate standard license report.
- Generate credit balance report.
- Generate active project/user reports.
- Define normalized R2 artifact spec.
- Start recent bup exporter prototype.
- Start cocalc.ai project metadata import UI.

### 2026-06-14 to 2026-06-16

- Implement standard license to membership import.
- Implement verified legacy email grandfathering design.
- Implement project metadata mapping.
- Implement R2 restore from normalized artifact.
- Export and restore first real bup-backed project.
- Sample GCS Nearline archives and validate cost assumptions.
- Begin focused Python image work if not already ready.

### 2026-06-17 to 2026-06-20

- UCLA-ready path works end-to-end.
- AI-off enforcement audited or implemented.
- Import UI usable by real users.
- Recent bup disk export is running or ready to run.
- Standard paid users can receive memberships.
- First rootfs/image selection flow is usable.

### 2026-06-21 to 2026-06-23

- Support UCLA onboarding.
- Monitor import/restore failures.
- Fix high-impact launch bugs only.
- Keep old cocalc.com economic paths disabled.

### 2026-06-24 to 2026-07-01

- Run broad recent-project bup export to R2.
- Implement live project export for too-recent projects.
- Start or complete GCS Nearline conversion depending on sample results.
- Add CUP signed site-license claim MVP if needed before July.
- Reduce old cocalc.com services to migration-critical paths.

### 2026-07-02 and After

- No fragile old cocalc.com operations should depend on unavailable personnel.
- R2 artifacts should be the main long-tail migration source.
- Old GCP bucket deletion proceeds after verification and business signoff.

## Open Decisions

- What active-project cutoff should be preconverted to R2: 6 months, 1 year, 2
  years, all paying-customer-owned projects, or some combination?
- What is the exact standard license query?
- What is the exact standard membership class in cocalc.ai?
- Do we convert all selected recent bup projects immediately or only those
  linked to active users and paying customers?
- How aggressively do we delete converted objects from GCS?
- What support policy applies after 2027-01-01?
- Does CUP need the signed claim flow before UCLA, or can it follow after the
  course launch?
- Which focused images are launch blockers for UCLA?

## Recommended Decisions

- Preconvert all projects active in the last 6 months.
- Also preconvert all projects owned by currently paying customers.
- Also estimate 1-year and 2-year active cutoffs before deciding whether to
  preconvert more.
- Convert the GCS Nearline bucket to R2 artifacts if the sample confirms the
  cost is under a few thousand dollars.
- Use 2027-01-01 as the public legacy migration request deadline.
- Do not keep the old GCP bucket merely to preserve bup/ZFS history.
- Do not build a giant compatibility image.
- Treat site-license claim tokens as the CUP replacement and a reusable
  product primitive.

## Bottom Line

The revised plan is more aggressive and more realistic.

The most important simplification is the normalized R2 project artifact. If all
legacy sources become the same "latest files only" artifact, then cocalc.ai only
needs one restore path. That makes it feasible to preconvert recent projects,
paying-customer projects, and even the old GCS Nearline bucket quickly enough to
retire the expensive old GCP storage and reduce cocalc.com to a migration shell.

The second most important simplification is entitlement scope. Standard old
licenses become standard memberships. Everything unusual is manual. That avoids
spending the launch window rebuilding legacy licensing complexity.

The third most important simplification is CUP. Signed site-license claim tokens
and rootfs landing pages solve CUP's current flow using general cocalc.ai
primitives instead of preserving a dangerous anonymous secret-URL system.

