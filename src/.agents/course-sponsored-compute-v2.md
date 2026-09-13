# Course-Sponsored Compute: Fresh Implementation

Date: 2026-09-13. Status: implementation and local validation in progress;
not release-ready.

## Implementation Checkpoint

A later live automatic-fallback test approved only the `course_expired` reason.
The worker stopped the sponsored instance before the financial deadline and
prepared the personal handoff, but activation stalled after the network usage
watermark had caught up. Running the same handoff sweep separately completed it;
the VM restarted and Python execution over SSH succeeded under personal funding.
The original scheduled stop also remained effective after the payer changed.
This is diagnostic-assisted validation, not proof of unattended fallback.
Metering and handoff maintenance start on the same worker tick and contend on
the same nonblocking resource lock. Handoff now retries that contention briefly
before financial work; normal metering remains nonblocking. PostgreSQL checks
cover eventual acquisition, persistent contention, and callback-at-most-once
behavior. A subsequent fresh unattended run on VM
`3388cc8a-4aa6-444f-8ee2-4ae52df31ce5` passed: the worker activated the
expiry-only personal consent at 03:42 UTC, persisted personal runtime billing,
and Python execution succeeded after restart. Its original stop and deletion
deadlines remained effective. The personal segment charged USD 0.01 and closed
with zero outstanding commitments. No manual handoff sweep was used in this run.

A separate USD 2 manual-collection postpaid allowance funded GCP VM
`f0f3d366-fcc7-4fce-81bc-3d32694d1a34`. SSH/Python succeeded, the worker stopped
and deleted it on its bounded deadlines, the instructor was charged USD 0.01,
and final network settlement closed the reservation. Independent GCP inventory
at 04:10 UTC showed no instances, disks, or addresses in the isolated test
namespace. The temporary instructor entitlement was restored. This does not
verify Stripe collection or transferable captured-payment provenance.

Course-credit reminders now have a separate opt-in and threshold in account
communication settings. The home-bay worker obtains authoritative source
snapshots outside account locks, then atomically records downward crossings and
durable notifications. Unknown/stale balances do not fabricate alerts. Crossing
state follows financial rehome; concurrent-worker and three-bay PostgreSQL tests
pass. Browser checks verify keyboard controls, reload persistence and reflow at
320/720/1440 pixels in light/dark themes. Narrow desktop settings now use the
existing compact navigation. Essential resource-stop/deletion notices remain a
separate incomplete requirement. Expired pools still need automatic final closure
to return their unused backing after all resource liabilities have settled.

The instructor and student budget surfaces now also have actual Chromium 200%
zoom checks in light and dark mode, with keyboard interaction and scoped axe
audits. The student totals fit without horizontal overflow; the instructor
table remains keyboard-scrollable. This does not extend the claim to every
application page or browser.

Reading and withdrawing an existing personal consent now depend on its payer's
financial authority, not a local VM/disk row. Three-bay PostgreSQL/Conat tests
move the student's account after handoff, keep the resources in their original
bay, cancel from the new payer bay, preserve outstanding cleanup backing, and
verify that VM and attached-disk service checks reject the cancelled consent.
The local VM path retains its immediate stop; remote enforcement observes the
authoritative cancellation on its normal sweep. New personal approvals and
handoffs after the student moves away from the resource bay remain incomplete.

The course budget tab, allocation preview and approval-intent APIs, student
funding selection, VM admission/billing integration, and separate financial
approval service are implemented on this branch. Focused tests exercise these
boundaries. This is not yet verification of the full acceptance path below.

An isolated development hub is running with its own database, instructor and
student test accounts, fictitious credit, and a real course project. Browser
testing has exercised enrollment, the actual course allocation preview, and
separate-origin approval of a USD 2 allowance. Both accounts see that allowance.
The same student, with zero personal balance and no payment method, launched a
disposable GCP CPU VM through the normal authenticated compute API using that
allowance. SSH and Python execution succeeded. The actual worker stopped the VM
at its five-minute scheduled deadline and deleted it at its ten-minute deletion
deadline. At 22:00 UTC, independent provider inspection confirmed no remaining
instance, boot disk, or public address. The existing purchase ledger charged the
instructor USD 0.01; the student's personal balance remained zero. A payer-home
read-only audit found no ledger discrepancies. Test account credit is fictitious;
the GCP VM was real and has been cleaned up.

Final egress settlement is a separate check: the live run exposed a timestamp
precision mismatch in the first owning-bay watermark update. Its focused
real-PostgreSQL regression failed before the fix and passes afterward, including
successive meter readings, retries, and final reservation release. After loading
the fix, the live worker finalized egress and released the unused reservation.
At 22:16 UTC the student had USD 1.99 available from this USD 2 allowance, zero
personal charges, and no remaining resource commitments. The payer audit was
clean. Physical deletion and financial settlement were checked separately.

The instructor/student budget surfaces have been checked in Chromium at 320,
720, and 1440 CSS pixels, in light and dark modes, with keyboard scrolling of
the instructor table and expandable student budget details. Student available
credit is visible without horizontal scrolling. Focused accessibility scans
passed. This is not yet a complete browser
VM-create, personal-handoff, or home-volume workflow. First-party email
verification succeeded for both controlled accounts; financial receipt delivery
after a repaired SMTP configuration succeeded for both recipients through the
normal retry worker. It retried the original two receipt records without a new
allocation, receipt event, or direct database reset.
The existing live checkout and previous implementation worktree remain preserved.

Classroom-size PostgreSQL checks cover simultaneous retries for both 20 and 50
students: one pool, one grant per recipient, and one backing hold. Browser VM
creation now retains both VM and optional-volume request identities on an
unchanged retry after a lost response. Shared region/machine selectors preserve
their form labels and ARIA attributes; that independently validated change is
committed as `e8624b52bf`.

The browser VM-create workflow now uses the instructor's CPU recommendation.
Its scheduled stop/deletion and fresh-browser notebook preservation checks
passed. The test student's original zero-balance result above is preserved; a
subsequent USD 2 fictitious credit was added solely for personal-payment testing.
It is not a captured payment or transferable cash.

A live separate-origin personal approval stopped a running GCP VM, waited for
network accounting, switched its payer, and restarted the retained instance.
That test found two defects: old-source release incorrectly required a network
watermark through the later storage handoff, and retained-instance restart did
not create the new billing-generation timing row. Both have fixes and focused
PostgreSQL regressions; the latter test now verifies a persisted personal runtime
start. The live attempt is not proof of correct personal runtime billing: a new
live run must validate the corrected path. The first attempt was stopped on its
timer and deletion was requested through the student's normal authenticated API.
Automatic fallback and personal home-volume takeover remain incomplete live paths.

The current checkpoint also includes a checksum/expiry-validated offline Ed25519
rollout-manifest CLI and operations runbook. No operator key is loaded into hubs;
the tool does not deploy or enable sponsorship. Personal admission now shares
the same aggregate exposure guard as course admission. Full static build and
package typechecks passed. Broader purchase/admission/rehome checks passed 376
tests (13 skipped), funding PostgreSQL checks passed 167 before the newest
regressions, and the updated VM/personal suites pass 42 tests. Three-bay tests
use real PostgreSQL and Conat with controlled directory/rollout fixtures, not
actual cloud instances in multiple bays.

Follow-up validation on September 13 used a fresh real GCP VM
`3bb18c62-fc2c-463b-ba80-fa29c19f082c`. It switched through separate-origin
personal approval, restarted with a persisted generation-2 timing row, executed
Python over SSH, and charged the student's personal purchase ledger USD 0.01.
Its scheduled stop completed at 00:31 UTC. Student-requested deletion completed
at 00:38 UTC; provider inventory independently showed no instance, disk, or
address. Both source reservations settled: the short course segment rounded to
zero and released USD 1.25; the personal segment released USD 1.24 after its
USD 0.01 charge. Fresh-browser and reload checks preserved the project notebook,
including its saved marker and unchanged disk timestamp. These are fictitious
account credits with real, now-cleaned-up cloud resources, not payment tests.

Seven three-bay PostgreSQL/Conat tests now include personal handoff from an
instructor's remote payer bay to the student's VM/account bay, with a lost
settlement reply and retry. Successor reservation confirmation routes to its
payer before taking the old payer's financial lock. The 30 personal integration
checks also cover ending deleted/expired consents without prematurely releasing
unsettled liabilities. Account rehome away from a VM's owning bay is still a
separate incomplete personal-handoff case.

Fresh 320/720/1440-pixel light/dark checks verified the vertical funding detail
layout, including screenshot inspection after the earlier narrow-label issue.
This is not yet the full required zoom/device/accessibility matrix.

The live sponsored-storage path now also covers normal API creation of a 10 GB
GCP home volume, reserved growth to 20 GB, and attachment to a disposable
course-funded VM. SSH confirmed `/home/user` was mounted from that disk and Python
execution succeeded. The VM stopped on its five-minute timer and was deleted at
its ten-minute deadline. At 01:01 UTC provider inventory showed the VM and boot
disk gone but the independent 20 GB home volume still present and detached.
Explicit student deletion then removed that disk; at 01:05 UTC inventory showed
no remaining instances, disks, or addresses for either resource. Both volume
reservation slices settled and released their unused USD 0.26 total. The VM
charged the instructor USD 0.01 and released its unused backing separately.
This verifies manual volume deletion, not a live 72-hour retention-expiry test
or personal takeover of that volume.

Storage funding dialogs passed keyboard opening, Escape/focus return, and focused
axe checks at 320/720/1440 pixels in both themes. Screenshot inspection found and
fixed the narrow-screen section header: the Create volume command now wraps
below the heading. Resource settlement responses now project current outstanding
commitments, not original authorizations. Missing payer totals remain unknown;
deleted resources remain financially "settling" until release is confirmed.
The bounded recovery sweep refreshes older closed projections without new holds
or charges. This was verified on the deleted live VM and volume above.

Attached course-funded home volumes can now be included in the same explicit
personal approval as their VM. The trusted approval names the disk, rate, and
latest deletion date. Admission rechecks its size, attachment generation, funding
epoch, and owner. VM and disk receive separate reservations atomically within the
approved combined cap. VM deletion does not cancel the surviving disk's approved
funding or delete the disk. Automatic fallback with a home disk is restricted to
the same course allowance; independently funded disks require an immediate review.

A real GCP test on September 13 used VM
`25e9ce7f-ff73-452b-83d0-8df0a3b4fb6b` and 10 GB home volume
`c2f982b5-bab5-45c6-b74d-245731e5cfc2`. Separate-origin approval switched both at
01:45 UTC, reserving USD 1.37 under a USD 1.50 personal cap. The retained VM
restarted and stopped on its original timer at 01:50 UTC. Provider inventory at
01:52 showed the VM and boot disk gone and the detached home volume retained.
Explicit student deletion removed that disk; inventory at 01:54 confirmed no
remaining instance, disk, or address. This run did not repeat SSH after handoff.

The live run exposed a meter/cutover race: an old disk snapshot could meter past
the committed cutover and prevent release. VM/disk meters and handoff now acquire
owning-bay session locks before financial transactions, including across payer
RPCs; a busy pass retries on the next sweep. A confirmed successor can reconcile
a legacy late observation only without reversing a posted charge. The normal
worker recovered this test's reservation without direct financial database edits.
At 01:58, all four reservations were settled: course segments and short disk use
rounded to zero; personal VM use cost USD 0.01, and all unused backing was released.
The run also exposed a deletion date exceeding its approval; new reservations
are capped at the reviewed date. That correction is PostgreSQL-tested, not yet
verified in another live handoff.

The focused set now passes 91 tests, including real-PostgreSQL concurrent meters,
volume-before-VM row ordering, stale review rejection, atomic cap rollback,
growth-slice settlement, and three-bay handoff with lost replies. Fresh funding
panels and the isolated approval page passed keyboard/focus and axe checks at
320/720/1440 pixels in light/dark mode where supported. The latest full static
build passed before the final server-only meter locking fix; server typecheck
also passed afterward. This is not the complete zoom/device matrix or an
independent review.

Standalone volume retention is now connected through the student storage dialog,
account-only APIs, separate-origin approval, personal reservations, metering,
and cancellation/expiry maintenance. A fixed-size detached disk can replace its
course or bounded personal agreement without authorizing any VM. Cancellation
remains available after attachment; changing funding still requires detachment.
The existing consent table supports exactly one VM or standalone volume. Its
explicit nullable-column declaration upgrades existing databases, not just fresh
test schemas.

Live validation used 10 GB GCP volume
`c1d5d54e-e82a-49f7-9bf3-52a2212ca494`, with no VM. At 02:40 UTC the student
previewed and approved USD 0.50 on the isolated financial origin, then applied
the storage switch in the browser. Cancellation ended service without discarding
its protected cleanup obligation. A second separate approval extended that same
retained disk at 02:45. Student-requested deletion completed, and independent
provider inventory at 02:47 showed no disk, instance, or address. All three payer
segments settled and released USD 0.12 apiece. These short storage charges rounded
to zero; this is not evidence of a nonzero storage purchase. The instructor audit
reported no discrepancies, and account balances remained unchanged.

Two live boundary cases were corrected. Admission now clips service to an
approaching payer-window or allowance boundary while retaining its minimum-runway
and cleanup backing. The live creation occurred before the instructor's 5-hour
reset and stopped its authorization at that reset; real-PostgreSQL checks also
cover the 7-day boundary. Retained-volume reconciliation now observes provider
state without provisioning/resizing or treating protected retention as a failed
disk. Its update is fenced by funding epoch and attachment generation. The normal
worker recovered the live disk so the second funding review could proceed.

The updated focused PostgreSQL/approval set passes 96 tests; worker tests pass 8,
frontend funding tests 21, CLI tests 13, and docs tests 8. Dependency consistency,
frontend lint and server typecheck pass. The full development build passed before
the final server-only corrections, which were subsequently compiled. Browser
preview/approval/apply/cancel, keyboard entry and focus return, and focused axe
checks ran at 320/720/1440 pixels in light/dark mode. The dev stale-build overlay
obscured parts of some captured screenshots: those captures are not complete
visual sign-off, and the 200% zoom/device matrix remains outstanding.

Pre-existing personally funded home volumes are now included in VM approval as
unchanged resources, outside the VM's new cap. They retain their payer and storage
agreement. Incomplete funding records and post-approval funding changes block the
handoff. Real-PostgreSQL tests verify that the entire disk row remains unchanged
and only the VM receives a reservation. Trusted approval/browser tests cover the
distinct disclosure; this case has not yet been exercised with a real attached
cloud disk. Server/frontend typechecks, frontend lint, 68 funding/approval tests,
13 updated isolated approval tests, 6 frontend tests, 13 CLI tests and 8 docs
tests pass (these overlapping sets are not a combined unique-test count).

Fresh browser validation found and fixed VM-details focus restoration and a
320-pixel cancellation-button overflow. The modal now stays mounted through its
close transition, uses a keyboard boundary, and wraps its title/status clear of
the close button. Normal Chromium checks at 320/720/1440 pixels and actual 200%
browser zoom pass in both themes, including focus return and focused axe scans.
The updated static build and 19 focused frontend tests pass. This covers VM
funding details, not the entire instructor/student zoom/device matrix.

The earlier diagnostic-assisted fallback VM
`c3da759c-7acd-4575-b927-de54c7b67fb6` was deleted and settled. The fresh
unattended run described at the top supersedes that attempt as fallback evidence.

Remaining implementation/validation includes live independent personal home volumes,
live volume retention expiry, live exhaustion-triggered fallback, transfer/payment
provenance validation, automatic payment collection, and optional currency display. The
isolated hub has no Stripe configuration; the maintainer has been asked to
configure test mode without sending keys in chat. Fictitious credits are correctly
ineligible for credit transfer and are not a substitute for captured-payment
validation. Nothing in this checkpoint enables production.

Other work in progress includes pool changes, nonbinding recommendations,
historical student balances, personal funding handoff, transfers, sponsored
storage, and multibay/rehome behavior. Do not infer completion from the presence
of a UI component, table, or passing unit test. The independent review and pilot
gates remain outstanding.

Implementation decisions:

- Financial approvals use a separately hosted page and independent sign-in;
  an ordinary application RPC can propose but cannot approve spending.
- Test cloud resources must have an isolated ownership namespace before cloud
  credentials are enabled, so orphan cleanup cannot touch another dev hub.
- A new course can establish its identity from the budget workflow without
  requiring a prior visit to an unrelated Configuration panel.
- Stale or failed funding lookups disable sponsored creation and retain the
  selected payer; they never silently switch the student to personal payment.
- The first user guide remains a draft until the implemented workflow and
  release gates have been verified.
- Operations have a read-only payer-home audit API and CLI command. Its bounded
  repeatable-read report explicitly excludes provider inventory and remote worker
  verification; it cannot repair balances or declare the pilot reconciled.

## Baseline

- Branch: `feature/course-sponsored-compute-v2`.
- Base: `origin/main` at `b024f77b31`.
- Worktree: `/home/user/cocalc-course-funding-v2`.
- Previous implementation remains on `feature/course-sponsored-compute` at
  `545c8e413e`, in `/home/user/cocalc-course-funding-impl`.
- The annotated [implementation plan](course-sponsored-compute-plan-2026-09-11.md)
  remains the requirements contract, including the user's section 17 decisions.

Do not wholesale cherry-pick the previous implementation. Consult its code and
tests for lessons, then reuse individual pieces only when needed by the connected
workflow. Do not treat its passing tests as verification of this branch.

## First Acceptance Path

Build and exercise one connected instructor/student workflow before broadening
the implementation. Initially use controlled development accounts and a bounded,
disposable CPU VM. Keep sponsorship disabled for ordinary customers until the
full release gates are met.

1. An instructor selects a verified student in the course UI, enters a budget and
   dates, and approves the exact allocation through the trusted financial flow.
2. The server locks the backing, records the allowance, and exposes it to that
   student's account. A retry does not create another allocation. Course-file
   edits and course collaboration do not grant financial authority.
3. The student, with no personal balance or payment method, chooses that allowance
   in the existing VM form and starts an affordable VM. The student is its owner;
   the instructor is its payer. Personal VM behavior remains unchanged.
4. The existing compute worker and purchase metering charge the selected payer
   and update both dashboards, including reserved funds and data timestamps.
5. Expiry or exhaustion prevents further unfunded work, stops compute, preserves
   the funded storage obligation, and ultimately deletes only the disclosed VM
   resources. The project notebook survives. No implicit personal charge occurs.
6. A duplicate request, worker restart, or lost provider reply does not duplicate
   charges, launch an extra VM, or prematurely release backing.

This is an ordering decision, not a waiver of security or accounting. The path
must include atomic backing, authorization, payer-home routing, durable resource
commitments, and cleanup before it spends actual funds. Mocked provider tests can
exercise it earlier, but must be labeled as such.

## Existing Product Integration Points

- `server/conat/api/compute.ts`: existing create/start/mutation authorization and
  affordability admission. Connect here rather than add an unused launch API.
- `server/compute/worker.ts`: actual metering, funding checks, stop and deletion.
  It currently uses `owner_account_id` as payer. Preserve ownership permissions
  while giving sponsored billing an explicit, authorized payer.
- `server/project-host/spend.ts`: reuse purchase metering and account-home routing;
  do not create a second charge ledger.
- `server/purchases/is-purchase-allowed.ts` and other balance consumers: allocation
  backing must reduce genuinely spendable funds, not just the displayed balance.
- `frontend/course` and `frontend/project/compute-vms.tsx`: connect instructor
  allocation and student selection to the same real APIs used by CLI and agents.

Each completed increment needs its real caller and a test crossing that boundary.
Do not accumulate unregistered RPCs, unused worker adapters, or schema-only
milestones and describe them as a working product.

## Subsequent Acceptance Paths

After the first connected path, extend it to 20/50 students, concurrent resources,
postpaid limits, GCP/Nebius failure recovery, bounded personal handoff, credit
transfers, notifications, recommendations, and CLI/agent context. All requirements
and release gates in the original plan still apply. Multi-bay authorization and
accounting are design constraints from the start, not a later retrofit.

Before pilot: real-PostgreSQL concurrency checks, multi-bay exercises, live VM
cleanup, independent security/accounting review, accessible light/dark UI checks,
reconciliation, and operational rollback verification. USD-only display is fine
for the pilot; GBP is explicitly not a pilot prerequisite.

## Provider Identity Clarification

`server/compute/resource-names.ts` already derives provider names from the VM ID
and environment, independently of the user-facing name. The previous explanation
incorrectly implied that this separation was missing.

The narrower lifecycle question concerns replacing a physical cloud instance for
the same logical VM. Normal stop/start of the same instance is not replacement.
If a replacement path reuses a provider name, prefer a fresh, durably recorded
creation name: retries of that creation reuse it; a new physical creation does
not. Keep the old identity available for cleanup and fence stale operations.
Verify the actual replacement paths before changing naming or migration behavior.
Do not block the entire product on hypothetical numeric-ID API support.
