# Course-Sponsored Compute Implementation Plan

Status: proposed implementation plan for review; no implementation is implied by
this document. Date: 2026-09-11. Source inspection: CoCalc-ai commit `6e21649058`.

## 1. Outcome And Scope

An instructor reserves a compute budget, gives named students time-limited
allowances, and sees their spending in the `.course` interface. Students own and
operate their own dedicated VMs, including GPU VMs, using either course funding
or their own explicitly selected funding. Paying does not confer VM ownership.

The reference acceptance scenario is **USD 1,000, 20 students, USD 50 each, for
seven days**. A class of 50 must be equally straightforward to configure. The
instructor chooses students, an amount, dates, and optional recommended VM
templates, then confirms one allocation. Students choose a template and start.

The target is a focused release in roughly ten working days, followed by a
small Manchester pilot. Financial invariants and security review are release
gates, not work to defer to meet a date.

### Required In The First Release

- One payer per pool; account-bound student allowances; explicit start/end times.
- Locked prepaid funds and bounded commitments against approved postpaid limits.
- Managed dedicated VMs and their billable storage, initially GCP and Nebius.
- Recommended templates, not a compulsory machine/provider allowlist.
- Server-side affordability checks for all ways to incur or increase costs.
- Instructor and student spending views with recent usage and exhaustion forecasts.
- Explicit, bounded student consent to use personal funds after course funding.
- Scheduled shutdown, running-GPU visibility, and low-credit notifications.
- Disclosed storage retention and deletion, with no promise of a VM backup.
- Direct account-credit transfers between instructors, without vouchers.
- USD accounting with optional local-currency display, initially useful for GBP.
- Equivalent enforcement for browser, CLI, agent, worker, and recovery operations.

### Explicit Non-Goals

- Transferring ownership of students' VMs to the instructor.
- Idle-detection heuristics, automatic file synchronization, or VM backups.
- A new general organization/team billing product or a generic quota engine.
- Native multi-currency settlement or converting arbitrary compute units to cash.
- Billing third-party machines merely because a remote Jupyter kernel uses them.
- Mandatory VM templates or an assumption that any GPU configuration stays available.
- Automatically migrating existing personally funded VMs into a course pool.

Remote kernels remain independent: the notebook experience already works with
managed VMs and external SSH targets. This feature pays for managed resources;
it does not change the Jupyter transport or turn all remote kernels into billed VMs.

## 2. Existing Implementation To Reuse

| Area                                                                                                                 | Current behavior and required change                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [VM schema](../packages/util/db-schema/compute-vms.ts)                                                               | Separates VM state, pricing snapshots, and prepaid/postpaid/site-funded modes, but describes the owner as also responsible for costs. Keep ownership; add explicit funding bindings.                   |
| [VM worker](../packages/server/compute/worker.ts)                                                                    | Bills through `vm.owner_account_id`, checks funding, stops blocked VMs, and eventually deletes them. Resolve the payer independently and enforce aggregate reserved funding.                           |
| [Dedicated-host spending](../packages/server/project-host/spend.ts)                                                  | Already meters VM usage, creates/rotates purchase sessions, and routes purchases to the payer's account home bay. Extend this path, rather than create a second billing ledger.                        |
| [Funding enforcement](../packages/server/project-host/spend-enforcement.ts)                                          | Uses prepaid balance, 5-hour/7-day limits, and postpaid billing readiness; the existing disk grace constant is 72 hours. Reuse policy inputs, but explicitly fund retention and aggregate liabilities. |
| [Postpaid policy](../packages/server/project-host/funding-policy.ts)                                                 | Recognizes explicit trusted-admin postpaid overrides as distinct from normal automatic billing requirements. Preserve that distinction.                                                                |
| [Purchase schema](../packages/util/db-schema/purchases.ts)                                                           | Has precise monetary storage, active metering, invoice/statement integration. Attribution used for enforcement needs indexed fields, not only descriptive JSON.                                        |
| [Balance calculation](../packages/server/purchases/get-balance.ts)                                                   | Calculates ledger balance, including active metered costs; it does not itself represent a new course hold. Expose ledger balance and spendable balance separately.                                     |
| [Purchase admission](../packages/server/purchases/is-purchase-allowed.ts)                                            | A shared place to integrate hold-aware available funds. Inspect all other balance-consuming paths as well; changing a displayed balance is insufficient.                                               |
| [Membership windows](../packages/server/membership/usage-windows.ts)                                                 | Uses account usage windows with starts, resets, and epochs. Preserve these semantics; do not introduce a second, subtly different rolling-window implementation.                                       |
| [Monthly billing](../packages/server/purchases/maintain-automatic-payments.ts)                                       | Reuse statement and collection machinery for approved postpaid usage. A reservation is not an invoice charge.                                                                                          |
| [Course backend](../packages/server/projects/course/set-course-info.ts)                                              | Maintains course/project associations with backend permission checks. Association is useful context, not authorization to spend a collaborator's money.                                                |
| [Course manager access](../packages/server/projects/course/ensure-manager-access.ts)                                 | Existing examples of backend-validated course operations and project ownership routing. Do not copy collaborator permissions as financial permissions.                                                 |
| [VM UI](../packages/frontend/project/compute-vms.tsx)                                                                | Has a deletion deadline under advanced options. `expires_at` deletes; it is not a shutdown timer. Add a distinct normal-use shutdown control.                                                          |
| [Compute API](../packages/server/conat/api/compute.ts) and [agent grants](../packages/server/compute/turn-grants.ts) | Already authorize compute mutations, including scoped project VM start/stop access. Funding admission must remain mandatory after operation authorization.                                             |

The existing [runtime sponsorship plan](sponsored-projects-runtime-slots-plan-2026-05-14.md)
concerns project runtime slots and membership sponsorship. Do not overload
`projects.usage_account_id` or those slots to implement a student's VM allowance.

Follow [multibay architecture](scalable-architecture.md),
[frontend accessibility](accessibility.md), and [security policy](../../SECURITY.md).
The security requirements below describe the new feature's threat model, not an
investigation or disclosure of an existing vulnerability.

## 3. Product Contract

### Roles And Identity

- **Payer:** owns the reserved money/credit commitment and approves financial changes.
- **Beneficiary:** the verified student account allowed to consume a grant.
- **VM owner:** that same beneficiary in v1; retains existing VM/data permissions.
- **Course manager:** can administer teaching workflows, but is not thereby a payer.
- **Actor:** the person, agent, or service requesting an operation; not necessarily
  its payer. Never derive the payer from the last person who clicked Start.

For v1, only the payer can allocate/increase/release their pool, change recipients,
or transfer their credit. Explicit read-only budget access may be granted to
other instructors; course collaboration alone does not grant it. Broader delegated
financial administration is deferred.

A stable server-side course-funding association identifies the course project
and course instance. A `.course` file may store that association's ID and display
preferences, never balances, binding permissions, or approval credentials.
Copying a course file, editing a student row, renaming a path, or restoring
TimeTravel must not create, duplicate, or redirect funding. Support explicit
association updates on rename/move without making paths financial identities.

Resolve recipients to account IDs before confirming spendable grants. Pending
email invitations may be shown as proposed allocations, backed by unassigned
pool funds, but are not spendable grants. Activate them only after verified
account resolution and payer approval of that binding. Do not automatically
reassign credit when an email, student row, collaborator list, or course membership
changes. Removing a student offers an explicit revoke-future-funding action; it
does not rewrite history. Enforce `grant.beneficiary_account_id == resource.owner_account_id`
on the server; access to another student's VM is not permission to charge this grant.

### Pool And Allowance Rules

- A pool has a payer, currency, total ceiling, funding lane, validity interval,
  course association, state, and version.
- An allowance has a beneficiary, cumulative ceiling, validity interval within
  the pool, state, and version. Extending dates does not reset spent money.
- The first UI action may create the pool and batch of allowances together;
  users should not have to learn separate accounting objects to get started.
- Default: the sum of allowance ceilings fits within the pool, including any
  unassigned pool amount. The same beneficiary cannot get duplicate allowances
  through repeated submission of one batch.
- Advanced overcommit is explicit, off by default, and requires confirmation
  showing total promised ceilings, actual backing, and the exact shortfall.
  Label this **DANGER: not every student can use their full allowance**. Students
  also see that their allocation depends on shared funds remaining.
- Overcommit never permits spending beyond the pool. Without overcommit, other
  students cannot consume a student's earmarked share. The payer can explicitly
  revise future allocations, but cannot reclaim incurred or reserved liabilities.
- A student may have grants from several courses. Select a named funding source;
  do not silently combine pools or spill into a different instructor's money.
- Course funding is a permission to consume eligible compute, not transferable
  cash in the student's personal balance.

## 4. Accounting Invariants

Use `@cocalc/util/money` and database numeric values. API monetary amounts are
decimal strings with an explicit currency. Do not use floating-point arithmetic
for authorization, caps, transfers, or settlement. Preserve precise metering and
the existing finalization rules; reconcile any rounding remainder exactly once.

### One Ledger, Three Levels Of Reservation

1. **Account backing:** lock unspent prepaid money or approved postpaid commitment
   capacity for the pool.
2. **Allowance earmark:** assign part of that same pool to a student.
3. **Resource reservation:** authorize part of that same allowance for concrete
   VM/storage work, including shutdown and retention obligations.

These are nested allocations of the same funds, not three charges. Only actual
usage becomes a purchase. No income, charge, or invoice is created just because
the instructor reserves USD 1,000.

For a pool with authorized total `P`, irreversible releases `X`, charged usage
`C`, and outstanding resource liabilities `R`, enforce:

```text
C + R <= P - X
remaining backing H = P - X - C
unreserved pool capacity = H - R
```

Apply the same `spent + reserved <= authorized ceiling` invariant per allowance.
Here `R` includes incurred-but-unsettled work and remaining authorized work,
without counting the same interval twice. `C` and `R` move together on settlement.
Administrative reductions may remove only capacity not already committed.

For a prepaid payer, expose:

```text
ledger balance
- remaining prepaid pool backing
- other outstanding liabilities not already reflected in that ledger balance
= spendable prepaid balance
```

Read these at one consistent accounting point. Existing active purchases already
reduce ledger balance, so they must not also be subtracted as unpaid usage in a
second place. Settlement reduces backing and ledger balance by the same amount
in the same payer-home transaction. Reconcile sponsored metering through the
transaction's as-of time before calculating spendable funds, or use an equivalent
single consistent projection of both accrual and remaining backing. Display
caches never authorize spending.

Every prepaid outflow must honor backing holds: personal VMs, dedicated hosts,
subscriptions or other balance-funded purchases, another pool, transfers,
refunds, and administrative adjustments. Audit both admission and recurring
workers. A path that checks raw `accounts.balance` cannot be considered migrated
merely because the course API uses reservations.

### Payer Versus Beneficiary Attribution

Purchases debit the actual payer once. Add explicit attribution for pool, grant,
beneficiary, resource, and funding epoch. The student gets a usage projection,
not a second debit. Personal spending after a switch is a new payer segment;
prior sponsored spending remains with its original payer.

Keep separate notions of customer billable cost and provider cost. Refunds and
meter corrections reference the original segment and payer. Corrections after
pool closure return value to that payer; they do not revive an expired student
allowance. Never delete financial history to correct it.

### Postpaid Is A Bounded Commitment, Not A Deposit

Support approved postpaid in v1. Use the existing entitlement policy, payment
readiness checks, and trusted-admin overrides. A payment method on file neither
establishes a limit nor overrides membership limits.

Recommended initial backing rule: use the payer's existing 7-day postpaid limit
as a conservative commitment envelope. Current window usage, other outstanding
authorizations, and all remaining course commitments must fit that envelope.
Personal postpaid work cannot consume capacity already committed to a course.
Short service reservations inside a pool are subsets of its commitment, not an
additional subtraction of that commitment.

Independently enforce both 5-hour and 7-day limits when authorizing service,
including simultaneous sponsored and personal resources. A USD 1,000 course
ceiling does not promise USD 1,000 can be consumed in one five-hour window.
Show temporary window exhaustion and its reset distinctly from exhausted funds.
Apply prepaid window limits to the prepaid payer too. Do not require a student
using a grant to have their own payment method or personal postpaid entitlement.
Student identity, resource-access, and abuse restrictions still apply.

Window resets do not erase outstanding commitments, and outstanding usage is
assigned to its actual window/epoch, not its eventual settlement time. Future
windows are not automatically pre-approved without regard to current policy.
Account rehoming, tier changes, epoch resets, failed collection, and credit-line
reductions must trigger re-evaluation. Suspend new authorizations when backing
is no longer valid; settle already authorized work and arrange bounded shutdown.

This conservative envelope is a proposed v1 policy to confirm before coding.
If larger long-lived institutional commitments are needed, authorize a separate
explicit commitment limit through the existing entitlement mechanism; do not
quietly infer one from a card or implement unlimited monthly credit.

Use one lane per pool in v1. A payer can fund another pool or explicitly increase
backing in the same lane. Do not invisibly blend prepaid deposits and new debt.

## 5. Backend Records And Ownership

Names below are proposed; reuse existing durable approval, event, and outbox
infrastructure rather than create duplicates solely to match this list.

| Record                         | Required contents and authority                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compute_funding_pools`        | UUID, payer account, authoritative home-bay routing epoch, stable course association, USD total, lane, backing/commitment, dates, overcommit setting, state, version, approval/audit references. Payer home bay.                      |
| `compute_funding_grants`       | Pool, beneficiary account or verified pending-recipient binding, authorized ceiling, dates, state, version, derived spent/reserved summaries. Payer home bay.                                                                         |
| `account_funding_holds`        | Backing and other encumbrances, source/lane, remaining amount, lifecycle, idempotency key. Payer home bay, shared by spendable-balance calculation.                                                                                   |
| `compute_funding_reservations` | Pool/grant or personal source, resource ID and generation, operation ID, funding epoch, tariff snapshot, authorized amounts/intervals, incurred/settled amounts, service deadline, protected teardown amount, status. Payer home bay. |
| Resource funding binding       | VM/volume owner remains unchanged; add payer/source reference, funding epoch, reservation IDs, authorized-until and stop/retention deadlines. Resource owning bay; it cannot mint funding.                                            |
| Financial events and outbox    | Append-only operation/actor/approval/version records and notifications, plus idempotent inter-bay commands and accounting receipts. Same transaction as the authoritative change.                                                     |
| Credit transfer record         | Transfer UUID, source/destination accounts and routing epochs, currency/amount, eligibility provenance, sender authorization, debit/credit identifiers, state. Coordinated by sender home bay.                                        |
| Read projections               | Payer course table, beneficiary allowance summary, VM status, aggregate rates and timestamps. Account home bays; rebuildable, never authoritative for spending.                                                                       |

Extend `purchases` with indexed foreign identifiers for funding attribution, or
use a normalized allocation table linked to the purchase. Pick one representation
in the first schema PR. Do not query JSON descriptions as the security boundary.
Resource ID, funding epoch, and interval/segment sequence identify billing segments
across retries, price changes, source changes, and month boundaries. A funding
epoch may contain several tariff or invoice-period segments.

Require foreign-key/check constraints locally, stable global identifiers across
bays, unique operation IDs scoped to the authenticated actor, and version-checked
mutations. Reusing an idempotency key with different parameters is an error.
Repeated requests with identical parameters return the original result.

### Lifecycle States

- Pool: `draft -> scheduled/active -> closing -> closed`; suspension blocks new
  reservations without erasing obligations. Closing begins at expiry or explicit
  closure. Closed means settled and unused backing released, not merely hidden.
- Grant: `scheduled -> active -> exhausted/expired/revoked`; unsettled obligations
  remain attached. An approved increase may reactivate an exhausted grant, but
  does not reset its cumulative spend. Unresolved recipients are not active grants.
- Reservation: `reserved -> dispatched -> consuming -> settling -> settled`;
  cancellation releases only the proven unused portion. `uncertain` preserves
  backing and schedules reconciliation rather than guessing whether work occurred.
- Funding handoff: `prepared -> committed -> reconciled`, with a resource epoch
  fence and a recorded cutover point. Abandonment before commitment releases the
  new source only after proving no work used it.
- Transfer: `prepared -> debited/pending_delivery -> credited -> completed`;
  rejection/compensation is durable and mutually exclusive with late crediting.

Store all dates in UTC and render the course's selected timezone, including the
offset in confirmations. Use half-open validity intervals `[starts_at, ends_at)`
and trusted server time. Delayed jobs recheck current versions and state; they
do not resurrect expired grants or replay already applied transitions.

### Transaction And Routing Rules

- Course/project permissions resolve through the project's owning bay; financial
  authority resolves through the payer's account home bay; VM lifecycle resolves
  through the VM's owning bay. These can all be different.
- Make the payer-home DB the single writer for that pool's grants, backing,
  reservations, and purchase attribution. Do not attempt a cross-bay SQL transaction.
- Use a documented common lock order: account funding lock, pool IDs in sorted
  order, grant IDs in sorted order, reservation IDs in sorted order, then purchase
  mutation locks/rows. Include existing billing helpers in the audit; no path may
  acquire those locks in reverse. Retry serialization/deadlock errors only around
  transactions with no external side effects.
- Reserve and write a durable outbox command in one transaction; commit before
  provider calls. Never hold database locks while calling another bay or provider.
- Use authenticated inter-bay methods with ownership checks. Client-provided
  payer IDs, rates, timestamps, amounts, and `trusted` flags are not proof.
- Ownership/routing epochs fence stale workers during account or resource moves.
  Move funding records, pending outbox work, and idempotency receipts with account
  authority; do not recreate holds at the destination.
- Launchpad executes the same protocol locally. Cross-bay tests are required
  even if the initial customer runs entirely in one bay.

## 6. VM Admission, Metering, And Exhaustion

### Quote And Reserve Before Provider Work

1. Authenticate the actor; verify VM ownership/access and beneficiary eligibility.
   Resolve the selected funding source, current versions, and authoritative bays.
2. Produce a server quote from current catalog/pricing snapshots, including the
   compute rate, boot disk, optional home volume, provider minimum billable periods,
   any other supported charges, and allowed Spot fallback cost.
3. At the payer home bay, atomically verify account backing, pool/grant dates and
   limits, window headroom, and aggregate outstanding resource reservations.
4. Reserve a useful initial run interval plus provisioning/stop margin and a
   fully funded retention/cleanup allowance. Reject unaffordable configurations
   with the actual required and available amounts. Thus USD 3 cannot authorize a
   USD 100/hour VM with a huge disk just because its first second is affordable.
5. Persist an operation with a stable provider idempotency key and outbox command.
   The VM-owning worker accepts only that authorized resource/generation/quote.
6. Observe provider state, meter trusted intervals, settle idempotently, and renew
   bounded service authorization before the previously funded interval runs out.

Suggested pilot tuning, to validate against real provider latency: a 15-minute
minimum useful initial run, five-minute renewal horizons, and a provider-specific
shutdown margin. Reservation amounts, not these example timings, are the contract.
Do not set the margin shorter than observed provisioning/stop/deletion behavior.

All paths use the same admission helper: create, start, restart, resize, larger
disks, home-volume creation, storage extension, provider recovery, and
Spot-to-on-demand fallback. Templates do not exempt a VM; picking a different
template does not require a new allowlist. A price increase requires a larger
valid reservation before incurring it, or the transition is refused.

### Bounded Ongoing Work

- Compute available headroom for the entire payer/pool/grant, including all VMs
  and volumes. Per-VM balance divided by rate is not sufficient admission logic.
- Track `authorized_until` and a generation-bound shutdown deadline at the VM
  owning bay. An independent sweep must stop work when renewals cease, even if
  the browser, project, guest, or payer-bay connection disappears.
- Use an enforcement interval shorter than the funded margin. Provide worker
  heartbeat alerts and an independent overdue-resource watchdog; do not depend
  on code inside a root-accessible student VM to enforce spending.
- Failure to reach the payer stops new starts/renewals. It does not release
  reservations while the resource may still be billable.
- A timed-out create is uncertain, not free. Reconcile provider identity before
  releasing its hold or retrying creation. Record and clean up orphan resources.
- Unknown tariff, missing usage, or stale enforcement data blocks new paid work;
  it must not be interpreted as zero cost or unlimited credit.
- Expiry/revocation stops future service authorization. Existing valid reserves
  remain for incurred cost and disclosed teardown; closing a pool cannot refund
  money still backing a running or uncertain resource.

Provider control is asynchronous. Do not claim mathematically zero provider
overspend during outages. Enforce customer-authorized caps, reserve measured
margins, limit site-wide outstanding exposure, and separately account for any
excess platform liability. Late invoices or failed provider shutdown must not
silently become unauthorized instructor debt, student debt, or money taken from
another student's allocation. Alert operators and disable new admission when
exposure or reconciliation lag exceeds configured limits.

### Settlement And Window Boundaries

Meter from server/provider observations, never browser, notebook, or agent claims.
Deduplicate intervals, provider events, and cumulative measurements. Split usage
at price, payer, membership-window, and invoice-period boundaries. Record which
reservation covered each segment. Keep old backing until uncertain segments are
resolved; a reservation TTL is not evidence that a VM stopped.

Within the payer-home transaction, settle the purchase, consume the corresponding
reservation and backing, update grant/pool summaries, and enqueue projections and
receipts. Reconciliation can replay this transaction without charging twice.
Financial reports must distinguish posted costs, recent unposted estimates,
outstanding reservations, and refundable/releasable unused backing.

In particular, do not let an open `cost_per_hour` purchase extrapolate customer
debt indefinitely past its authorized cost/interval. Bound the sponsored metering
path used by balance, invoice, and usage-window calculations. Provider work beyond
that authority belongs in an explicit overrun/reconciliation record, not an
uncapped purchase that already reduced the customer's balance before review.

## 7. Explicit Personal Funding

Default behavior is **stop when course funding ends**, not charge the student.
Present a clear action such as **Continue using my credit** with the current rate,
student's own available funding, the VM/storage scope, an additional spending cap,
and an end/stop time. Persist the student's account-authenticated consent and its
exact scope. Do not infer consent from adding a card, using an agent, joining a
course, or dismissing a warning.

Support both an immediate funding switch and optional advance fallback consent.
For v1, personal prepaid is the simplest default; approved personal postpaid can
be explicitly selected using the student's own limits. Fallback consumes no
instructor funds beyond the original grant and does not move VM ownership.

Switching is a durable operation:

1. Reserve the new payer's capacity and record the consent/version before enabling it.
2. Serialize against the VM resource generation and funding epoch. Select one
   authoritative cutover time; stop authorizing new intervals against the old source.
3. Finalize old-source usage through that time and bill the new source only after it.
4. Retain old-source reservations for unsettled intervals, then release the unused part.

Across bays, use a retryable handoff with prepared state and durable acknowledgments,
not an assumption of two-DB atomicity. Ambiguous handoffs stop at the last funded
deadline and reconcile; they must never create overlapping charges or an unfunded
interval. Consent cancellation races with fallback through the same versioned
operation. Cancellation blocks future use, not collection for authorized past use.

Automatic fallback occurs only for reasons included in the consent, initially
allowance/pool exhaustion or the stated expiry. Do not automatically switch
payers on an unknown error, provider issue, account suspension, or revoked security
authorization. Exhausting the personal cap stops compute; no second implicit fallback.

## 8. Shutdown, Storage, And Deletion

### Stop Is Not Delete

Add `stop_at` separately from existing `expires_at`. The start UI exposes
**Stop after 6 hours** as a proposed checked default, plus editable duration/time.
The backend computes and stores an absolute timestamp on each start generation.
Persist the student's choice; a restart must explicitly establish its new deadline,
not accidentally remove it or revive a stale timer. Extending a deadline is a
billable policy change subject to current funding and actor permissions.

The effective running deadline is the earliest applicable limit for the current
funding epoch: scheduled stop, funded service deadline, active grant expiry or
personal-consent end, and an explicit deletion deadline. A committed personal
handoff replaces the old grant deadline; it does not remove an independent
scheduled stop or deletion deadline. No activity/idle heuristic extends a deadline.
Stopping early saves compute, but not all storage costs. A dismissed warning
never disables enforcement.

### What Is Kept And Lost

| Data/resource                                                                                         | Stop VM                       | Delete VM and its boot disk                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `.ipynb` files saved in the CoCalc project, including saved code, Markdown, and captured cell outputs | Kept                          | Kept; this operation does not delete project files.                                     |
| Other files already copied into the CoCalc project                                                    | Kept                          | Kept, subject to the project's normal storage/backup policies.                          |
| Remote kernel variables and in-memory computation                                                     | Lost when the kernel/VM stops | Lost. Saved notebook outputs are not a copy of arbitrary in-memory data.                |
| Software installed on the VM's boot disk                                                              | Kept on retained disk         | Deleted.                                                                                |
| Datasets imported or generated on the VM's boot disk, not copied out                                  | Kept on retained disk         | Deleted. A path/link printed in a notebook does not copy the target file.               |
| Separately attached persistent home volume                                                            | Retained and billable         | Not deleted merely by deleting the VM; governed by its own funding and deletion policy. |

**There is no automatic backup or file synchronization for dedicated VM data.**
Normal CoCalc project protection does not extend to a remote disk, an external
file link, or a kernel's memory. The project notebook remains usable and can be
connected to another kernel, but unsaved remote state is not recoverable from it.

Use explicit deletion confirmation copy along these lines:

> Your notebooks and saved outputs in your CoCalc project will remain. This
> deletes the VM and its boot disk, including installed software and data you
> have not copied elsewhere. VM files are not automatically backed up. Any
> separately retained home volume is listed below with its own cost and deadline.

Never reuse project-host backup/recovery wording to imply dedicated VM recovery.

### Funded Retention

Recommended initial policy: retain stopped storage for up to the existing
72-hour grace after funding ends, **only with that cost reserved in advance**.
Include the grace and possible deletion in the initial funding confirmation;
show exact compute-access end and storage-deletion dates separately. The amount
protected for storage comes from the student's allowance, not a hidden extra
invoice to the instructor. Reject or reduce the disk choice if it cannot fit.

Normal usage before course expiry may fund stopped storage as usual. The final
protected reserve must remain available for expiry, revocation, or exhaustion.
It can settle after the course spending window because it covers explicitly
authorized retention/cleanup, not permission to run more GPU work. Returning
unused pool backing waits for those obligations to finish.

Offer the student explicit personal funding to retain storage longer, restart,
or copy data out. There is no promised export service or automatic copy-out in
v1. Warn before stop/deletion so a student can copy data while the VM is running;
any rescue restart still needs funding.

Treat a separate home volume as its own resource. Do not inherit automatic
deletion of a pre-existing personally funded volume from a course-funded VM.
For course-funded volumes, record their own retention agreement and backing;
detachments, attachments to another VM, and different funding sources cannot
leave an orphaned bill. Each volume has one payer epoch, not one bill per
attached VM. Do not delete an attached or ambiguously owned volume to reclaim
credit; stop admission, reconcile, and escalate uncertain cases.

Expiration/revocation notifications are transactional and retried, but email
delivery is not a condition that can keep billable disks alive indefinitely.
At an acknowledged deletion, release only the unused reserve. A provider failure
leaves a cleanup obligation and operator alert, not a fabricated successful deletion.

## 9. Financial Authorization And Abuse Controls

Threat model: malicious student/recipient, accidental course edits, compromised
project/agent credentials, replayed requests, concurrency across bays, and hostile
rich content in an instructor's notebook or chat. A course collaborator or code
running in a project must not be able to designate another account as a payer.

### Transaction-Bound Approval

- Stage a server-generated intent containing payer, recipients, USD amount,
  funding lane, dates, overcommit, retention obligations, and version/hash.
- Require account-bound interactive approval and existing dangerous-action
  fresh-auth checks, including the enabled second factor. Approval is single-use,
  short-lived, and valid only for those server-stored terms and actor.
- Use the same mechanism for pool creation/increases, changed recipients,
  overcommit, transfers, and personal fallback consent. Scope reductions and
  revocations also require authenticated financial authority and an audit event.
- Do not accept a project token, agent grant, arbitrary bearer key, or a frontend
  `confirmed: true` flag as financial approval. Agents may prepare proposals but
  cannot mint or redeem the human approval on the user's behalf.
- Receipt emails go to the payer's verified account address, not a course-file
  field. One allocation of 20 students produces a useful batch receipt, not
  20 requests to authorize individual payments. Changes produce new receipts.

Fresh auth, CSRF protection, and email are layers, **not an XSS solution**. A modal
in the same compromised origin cannot reliably confirm a transfer or new pool.
Before enabling this feature, identify and test a trusted approval surface whose
origin/session boundary excludes notebook/project-controlled execution. Render
only escaped server-stored transaction details there; use restrictive framing,
opener, script, and cookie policies, and validate any cross-window messages.

Reuse existing first-party approval infrastructure where it provides that
boundary; extend it narrowly if it does not. The security reviewer must validate
that notebook-origin code cannot submit approval, read a reusable approval token,
or alter the confirmed recipient/amount. Do not describe cosmetic separation or
an email sent after allocation as satisfying this gate. The full Jupyter/XSS
hardening project is separate, but the new financial authorization boundary is
not optional. Actual vulnerabilities found while doing this follow `SECURITY.md`.

### Additional Guardrails

- Enforce pool/grant amounts and dates in the backend, including batch totals,
  duplicate recipients, negative/NaN/overflow values, precision, and stale versions.
- Rate-limit funding intents, transfers, VM starts, and failed approvals. Apply
  existing account sanctions to payer and beneficiary without leaking private reasons.
- Bound aggregate site exposure, active authorizations, and unreconciled work.
  A kill switch blocks new commitments while preserving settlement and cleanup.
- Make refund/chargeback/payment-failure paths aware of locked backing. An external
  payment reversal is not prevented by a DB hold; freeze new work, reconcile
  exposure, notify operators, and never hide the resulting liability.
- Audit actor, beneficiary, payer, approvals, resource versions, pricing versions,
  and money movements. Do not log credentials, private keys, notebook contents,
  or unnecessary student personal data.
- Payer dashboards show sponsored resource costs/status, not personal balances,
  personal VM history, or new shell/file access. Students see only their grants.
- Pool revocation ends sponsorship, not student ownership. A VM legitimately
  switched to personal funding must not be deleted by a stale sponsor cleanup job.

## 10. User Interfaces

### Instructor: `.course` Compute Budget

Use a compact configuration form and a normal student table, not a new billing
dashboard application. The common workflow is:

1. Select students, enter per-student amount, choose start/end dates.
2. See the total needed, available prepaid funds or approved postpaid capacity,
   and optional recommended templates. Default pool size is the total needed.
3. Confirm once on the trusted financial surface; return to the course with results.

Show pool backing, spent, reserved, available, students' individual ceilings,
recent burn rates, running VM counts, and earliest funding/stop deadlines. Include
as-of time, clear pending/error states, sorting, and CSV export. Distinguish
**reserved**, **spent**, and **returned** rather than make users infer them from
one changing number. Return unused money explicitly or at completed pool closure.

Bulk increases/extensions use one preview and approval. Bulk revoke explains
which work will stop and which storage obligations remain. A changed course file
cannot trigger a financial mutation merely because it was opened or synchronized.

Templates store configuration recommendations and labels, not stale price promises
or credentials. Re-quote current availability and cost on selection; offer nearby
alternatives and an ordinary custom configuration route. A missing GPU offer is
not an exhausted allowance.

### Student: Funding And Running Resources

The VM creation/start form shows **Manchester course credit**, amount remaining,
estimated current cost, approximate runtime affordable, and **Stop after**. List
eligible course sources and personal funding by name; do not expose backend IDs
as the main workflow. Keep the existing remote-kernel setup available afterward.

Show allowance total, spent, protected storage amount, currently committed work,
and available-to-start amount, with plain distinctions. Forecast against aggregate
student VM/storage burn and the earliest grant, pool, funding-window, or timer
limit. Label forecasts as estimates; a shared overcommitted pool cannot promise
an individual's entire displayed ceiling. Stopped storage can still have a burn rate.

An account-wide running-GPU indicator links to running resources and stop actions.
Allow dismissing an expanded reminder; keep resource status discoverable and
re-alert on material changes such as another VM starting or a low-budget threshold.
Do not display zero running VMs when state is unknown/stale. Notifications should
work outside the particular project associated with a VM.

Provide configurable low-credit thresholds and notification channels, plus essential
expiry, funding-stop, and deletion notices. Deduplicate crossings and messages by
event/version; a polling loop must not send repeated email. Store preferences in
account settings, not a browser-only flag that vanishes on another device.

### Freshness, Accessibility, And Error States

Target budget/status refresh within 15 seconds during normal operation, with
Conat projection updates and bounded polling recovery. Forecast locally from a
timestamped authoritative rate between updates, but never use that forecast as
the admission balance. Mark stale values after a documented threshold. Financial
control traffic does not change Jupyter's data path: notebook, terminal, and agent
traffic continues directly to the project host rather than through the payer bay.

Distinguish loading, unavailable pricing, SSH/kernel setup problems, insufficient
course funds, temporary membership-window exhaustion, expired grant, payment
attention, and unavailable provider capacity. Give the relevant action instead
of silently selecting another payer.

Use existing Ant Design controls and `UI_COLORS`; verify light/dark themes,
iPhone/iPad/desktop, 200% zoom, keyboard navigation, accessible names, focus
restoration, and announcement of important asynchronous state changes. Budget
warnings and confirmation content are functional information, not color-only cues.

## 11. Currency And Later Non-Cash Units

Keep the authoritative v1 ledger and provider/customer quotes in USD. Add a
display-currency preference with optional course presentation override. Format
with locale-aware currency formatting; never replace a dollar sign with a pound
sign without conversion.

Use a server-maintained, timestamped rate snapshot with source/version. GBP is
an approximate display, not a second spendable balance. Always make the actual
USD cap and charged amounts accessible. FX changes must not change an already
approved USD allowance or consume additional backing.

For v1, authorize USD amounts and show GBP equivalents; native GBP budget entry
can wait unless needed for the pilot. If offered, convert once in the preview,
show the resulting USD authorization, and bind the rate snapshot to that approval.
Reject stale conversion previews; when rates are unavailable, show USD plainly.
Do not mix currencies in an allocation, transfer, or refund, or imply that this
display establishes GBP invoicing or local tax treatment.

The pool/grant/reservation/meter structure can later support self-hosted units
such as GPU-hours. Keep currency/unit explicit at service boundaries and avoid
UI strings that assume all future quantities are dollars. Do not implement that
generalization now: non-cash units need their own metering and policy adapter,
cannot be added to USD, and must never become transferable or redeemable cash
merely because they use an allowance table.

## 12. Direct Credit Transfers

Provide an account billing action: choose another verified account, enter an
amount, preview recipient identity and remaining transferable balance, approve,
and receive a receipt. The recipient does not need a voucher or code. Do not
transfer funds to an unresolved email or create an account implicitly.

Only eligible, unencumbered prepaid account credit transfers. Exclude pool
backing, resource holds, postpaid commitments, student allowances, disputed funds,
and promotional/restricted credit that is not transferable. Define eligibility
from authoritative payment/credit provenance; total displayed balance alone is
not evidence of eligibility. Preserve provenance through subsequent transfers
and keep refunds attached to their original payment/transfer chain. This is
account credit, not a new cash-withdrawal product.

Record equal and opposite ledger entries linked by `transfer_id`, excluded from
compute revenue and usage-window consumption. Transferred credit must not be
reported as another customer payment or give the recipient extra membership
spending entitlement. Receiving credit and permission to consume it are distinct.

Same-bay transfer: lock accounts in stable order, validate sender funds, and commit
debit, credit, audit, and notifications atomically. Cross-bay transfer: reserve
sender funds, durably commit the debit and outgoing event, idempotently credit
the recipient, then acknowledge completion. Show **pending** while delivery is
uncertain; never restore sender funds merely because the acknowledgment timed out.

Recipient rejection requires a durable rejection/cancellation fence before a
compensating sender credit. Once credited, reversal is a separately authorized
compensating transfer, not deletion of entries. Concurrent transfer/refund/pool
allocation must all use the same backing-aware account lock. Document lock order
for two-account operations as well as single-payer reservations.

Use transaction-bound fresh approval, verified-recipient confirmation, receipts
to both accounts, rate/amount limits, and structured support-visible status.
Transfers must not alter pool payers or send unused course grants to students.

## 13. CLI And Agent Support

Extend existing typed Conat compute/purchases APIs rather than add a parallel
Next API. Keep browser/CLI adapters thin; call the same backend services.

Proposed logical operations:

| Operation group     | Methods and authority                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Course funding      | Preview/create pool and allocation batch, get summary, list grants, revise/revoke, close/release; payer approval for financial mutations. |
| Student funding     | List eligible sources, quote a VM, get usage/runway, propose personal fallback, cancel consent; only the beneficiary's data/authority.    |
| Compute lifecycle   | Existing create/start/stop/resize/storage APIs gain source references and quote/version checks; no bypass route.                          |
| Internal accounting | Reserve/renew/settle/release, handoff, and projection events; authenticated bay services only.                                            |
| Transfers           | Preview, approve/submit, status; sender financial authorization with durable idempotency.                                                 |

Responses include funding source display name and ID, lane, payer/beneficiary
where authorized, amounts, currency, reservations, current aggregate rates,
as-of time, relevant window resets, `authorized_until`, `stop_at`, retention/deletion
times, and structured denial/recovery codes. Expose only information needed by
that actor; a project-scoped agent does not get the instructor's private account view.

Existing project-scoped VM start/stop grants remain useful. Bind authorizations
to the relevant resource/funding policy version and always recheck live backing
at start, even when the agent has availability permission. The agent can explain
cost, stop its authorized VM, and propose a source/timer change; it cannot approve
course allocations, credit transfers, or personal fallback. A generic start/stop
grant does not imply authority to extend a timer or switch who pays.

Use first-party human login/fresh-auth/approval flows for CLI financial actions.
Return an approval URL/status for a pending proposal; never request passwords,
tokens, or approval codes in a chat/question response. Document the added funding
context for agents and add task-oriented examples to `src/packages/docs`.

## 14. Implementation Sequence

Every phase should land as a reviewable change set with focused checks. Dates
are a capacity plan, not a reason to skip a prerequisite or deploy partial billing.

### Phase 0: Contract And Release Decisions (Day 1)

- Confirm the proposed postpaid commitment rule, storage grace, transfer eligibility,
  personal fallback scope, FX source, and trusted approval surface.
- Inventory every balance-consuming path, recurring charge, compute mutation,
  agent entry point, and inter-bay billing call that must honor holds.
- Freeze invariants, lock order, state transitions, API decimal types, and error codes.
- Produce an accounting example for 20 students, two courses, multiple VMs per
  student, a concurrent transfer, and a prepaid/postpaid payer.
- Agree on site exposure limits and provider shutdown margin measurements.

Exit: reviewed financial/threat-model contract and no unresolved critical
authority or conservation question.

### Phase 1: Ledger Integration And Reservations (Days 2-3)

- Add schemas/migrations, indexed purchase attribution, holds, versions, and outbox.
- Implement payer routing, lock discipline, spendable-balance API, grant allocation,
  and precise reserve/settle/release with idempotency.
- Integrate hold-aware admission into other prepaid outflows and postpaid commitments.
- Add real-PostgreSQL concurrency/window/rounding tests before provider integration.

Exit: no double spend when course funding competes with personal activity, refunds,
or another pool; totals conserve under retries and failures.

### Phase 2: Dedicated VM And Storage Enforcement (Days 4-5)

- Separate payer from owner in worker billing and all lifecycle admission paths.
- Add quote-bound reservations, renewal, trusted metering, uncertain-operation
  reconciliation, service deadlines, and the independent enforcement sweep.
- Add generation-safe `stop_at`, funded storage grace, volume funding, and stale
  cleanup fencing. Preserve existing personal/site-funded behavior.
- Implement personal funding handoff and consent-bound fallback.

Exit: real VM start/stop/exhaustion/expiry works with no browser or guest cooperation;
student ownership and project notebooks remain intact.

### Phase 3: Financial Approval And Account Transfers (Days 4-6)

- Build transaction-bound approval using the agreed isolated trust boundary.
- Add pool/transfer receipts, revision/revocation audits, and notification outbox.
- Implement eligible-credit transfers and retry-safe same/cross-bay delivery.
- Complete independent authorization review before enabling funded UI paths.

Exit: financial mutations cannot be authorized by course files, project tokens,
agent availability grants, stale approvals, or untrusted notebook execution.

### Phase 4: Course And Student Experience (Days 6-8)

- Add the compact course allocation form, status table, bulk operations, and export.
- Add named funding selection, live affordability, recommendations, stop controls,
  visible personal-funding consent, and precise deletion notices to VM UI.
- Add timestamped account projections, running-GPU indicator, notifications, and
  display-currency preferences. Connect CLI/agent read surfaces.
- Validate mobile/desktop, themes, keyboard/focus, and actual student workflows.

Exit: instructor can fund 20 or 50 students without managing their VMs; a student
with no personal funds can start funded compute and understand what will be charged.

### Phase 5: Reconciliation, Pilot, And Release (Days 9-10)

- Exercise multi-bay and provider-failure tests; verify collection/statement exports.
- Run an independent security/accounting review and end-to-end classroom rehearsal.
- Document operations, alerts, kill switches, data-loss policy, and support actions.
- Enable a limited real-money pilot with explicit caps, then expand after reconciling it.

If schedule pressure arises, defer richer template editing, notification polish,
or native local-currency entry. Do not defer backing holds, postpaid limits,
source consent, funded deletion policy, inter-bay idempotency, or approval security.

## 15. Validation Matrix

### Accounting And PostgreSQL

- Concurrent 20/50-student allocation, duplicate requests, overlapping pools,
  simultaneous VM starts, and multiple resources sharing one allowance.
- No-overcommit default and explicit overcommit both enforce pool and grant caps.
- Pool holds compete correctly with personal VMs, ordinary purchases, recurring
  billing, refunds, transfers, and administrative balance changes.
- Prepaid and postpaid, 5-hour/7-day boundaries and epochs, tier downgrade,
  payment loss, approved manual collection, and membership changes mid-reservation.
- Micro-cost accumulation, final-cent rounding, mixed running/stopped rates,
  late usage, corrected usage, and month-end source segments do not lose/create money.
- Deterministic real-PostgreSQL lock-order tests covering admission, settlement,
  source switches, expiry, transfers, and refunds; do not rely on mocked locks.
- Property/state-machine tests: charged plus reserved never exceeds authorization;
  retries preserve totals; no operation releases uncertain liabilities twice.

### Multibay And Lifecycle

- Payer, student VM, and course project on three different bays; same-bay equivalent.
- Lost/delayed/duplicated reserve, provider, settlement, transfer, and handoff replies.
- Account rehome with in-flight holds/outbox entries; restored stale worker fencing.
- Provider create timeout after success; stop/delete failure; orphan disk/resource;
  outage beyond service deadline; watcher catches a stalled primary worker.
- Restart/resize/fallback/volume growth all re-quote and reserve. Guest root access
  cannot disable account-side deadlines. Browser/project shutdown cannot disable them.
- Timer change versus old queued stop; new personal funding versus old course deletion.
- Separate home volume retained/deleted only under its own policy, never billed twice.

### Security, UX, And Data

- Payer/beneficiary/actor confusion, collaborator edits, forged IDs, stale approvals,
  repeat approval consumption, moved accounts, and approval-message origin checks.
- Malicious course/notebook metadata does not authorize allocation or transfers;
  test the trusted approval boundary in a controlled environment without production data.
- Instructor cannot see students' personal funds/history or obtain new VM access.
- Fresh student account with no payment method can use its grant. Exhaustion stops
  it unless that student explicitly approved a bounded personal source.
- Dashboard totals, timestamps, low-budget alerts, deduplication, currency conversion,
  disabled/error states, focus, screen-reader labels, narrow screens, and dark mode.
- Delete a disposable VM containing test files: verify project `.ipynb`, saved outputs,
  and previously copied project files survive; VM-only data is not falsely recoverable.
- Normal remote-kernel reconnect/replacement works after stopping/deleting the old VM.
- Paid-credit transfer receipt, pending delivery, explicit rejection, and retry show
  conserved balances and do not inflate revenue or membership headroom.

Run package-local typechecks and focused tests for `util`, `database`, `conat`,
`server`, `frontend`, and `cli` as touched; run frontend lint/accessibility checks
and the dependency consistency check. Use real PostgreSQL, a two/three-bay test
configuration, and disposable CPU/GPU VMs for the release gates, not just unit mocks.

## 16. Rollout, Reconciliation, And Support

- Feature-flag sponsorship and transfers separately, initially disabled.
- Deploy additive schemas and hold-aware account consumers first, then all owning-
  and payer-bay workers. Enable creation only after a capability/version check proves
  every relevant writer honors holds. Old workers must not operate sponsored resources.
- Existing resources keep their existing owner-as-payer behavior. Never reinterpret
  a null new column as permission to choose some available instructor.
- Shadow-report estimates only; shadow validation must not reserve real money,
  double-bill, or create duplicate provider resources.
- Start with named pilot payers and small caps; reconcile customer ledger, pool/grant
  sums, reservations, provider inventory, and billing intervals before expansion.
- Alert on stale metering, overdue authorized deadlines, unexplained provider resources,
  negative headroom, unmatched transfer legs, and backing/purchase discrepancies.
- Provide internal reports and safe retry/reconcile commands with actor auditing.
  Show support staff why money remains reserved and which resource/operation owns it.
- Instructors can download sponsored usage by student/resource; monthly invoices and
  collection remain existing account workflows with clear sponsored attribution.
- Rollback blocks new commitments and permits stop/cleanup/settlement. Do not drop
  financial tables, release all holds, or roll back to a worker that charges owners
  instead of committed payers. Existing obligations survive disabling the UI.
- Funding release after closure is automatic once obligations settle, with a receipt;
  retain immutable history and a repairable reconciliation queue if completion is delayed.

## 17. Decisions To Confirm Before Implementation

The core requirements above are settled by the product discussion. These are
proposed operational defaults or implementation choices needing explicit review:

1. **Postpaid backing:** use the current 7-day limit as the conservative total
   commitment envelope, alongside live 5-hour/7-day checks; expand via explicit
   entitlement only if the institution needs a larger long-lived commitment. [[YES]]
2. **Retention:** use 72 hours of prepaid/reserved stopped-storage grace, within
   the student's ceiling, with independently disclosed home-volume policy. [[yes]]
3. **Scheduled stop:** default to six hours; allow explicit changes, with earlier
   financial deadlines always taking precedence. [[yes]]
4. **Personal fallback:** per-resource consent, additional monetary cap, end time,
   and enumerated eligible reasons; no account-wide unbounded opt-in by default. [[yes]]
5. **Transfers:** define eligible prepaid-credit provenance and refund treatment;
   do not ship a raw balance-to-balance copy that launders restricted credit.
6. **Approval surface:** identify the concrete origin/auth flow and review its
   isolation from notebook/project execution before building the financial UI.
7. **Risk settings:** choose measured provider shutdown margins, initial/renewal
   intervals, and a site exposure ceiling; excess unauthorized cost is not passed
   silently to a customer.
8. **Currency display:** select a maintained FX source/cache policy; keep USD entry
   and authorization for the initial release unless GBP entry is a pilot requirement.

## 18. Completion Checklist

- [ ] Financial contract, threat model, and proposed defaults reviewed.
- [ ] Backing-aware ledger, grants, reservations, and postpaid windows implemented.
- [ ] VM/volume owner and payer separated without regressing existing resources.
- [ ] Admission, shutdown, retention, deletion, and personal handoff verified live.
- [ ] Trusted approval, receipts, and direct credit transfers independently reviewed.
- [ ] Course/student UI, recommendations, status, notifications, and currency display complete.
- [ ] CLI/agent context and identical server-side enforcement verified.
- [ ] Real-PostgreSQL concurrency, multibay, and provider-failure tests passing.
- [ ] Project notebook preservation and absence of VM backups clearly documented/tested.
- [ ] Pilot reconciled; operations documentation, kill switches, and safe rollback ready.

## 19. Future Sponsorship Contexts (Out Of Scope For V1)

Course sponsorship is the first user-facing workflow, not a requirement of the
underlying accounting model. Research groups, laboratories, departments, and
short-lived collaborative projects have the same basic problem: one payer backs
a budget, named people receive bounded allowances, and those people own and
operate their resources.

The reusable core is account backing, pools, account-bound grants, resource
reservations, payer attribution, settlement, and explicit personal fallback.
Keep these operations independent of editable course contents. Course-specific
work belongs at the association, recipient-selection, recommendation, and
presentation boundaries.

The initial pool schema requires a course project and course instance. That is
an intentional v1 association, not a claim that other contexts work already.
A later release can introduce a server-owned sponsorship context with a kind
and stable identity, migrate existing course associations into it, and add a
research-group setup interface. Non-course pools should not require a dummy
course file, and they should reuse the same ledger and funding invariants rather
than obtain a separate accounting implementation.

For example, a principal investigator could allocate a time-limited research
budget to named group members, recommend GPU templates, monitor spending, and
let members explicitly continue with personal funds. Paying would still not
transfer ownership of their VMs or grant access to their data.

Group membership or a group-manager role must not automatically authorize
spending the payer's money. Any future delegated financial administration needs
its own explicit approval and revocation contract; retain the payer/beneficiary/
actor distinction and account-home authority described above.

**Out of scope for the first release:** non-course setup screens, organization
or research-group membership management, delegated financial administrators,
multi-payer pools, and a generalized sponsorship-context framework. This section
records the extension path and architectural boundary, not additional v1
deliverables or permission to delay the Manchester course workflow.
