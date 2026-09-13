/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export const COURSE_COMPUTE_BODY = String.raw`
## Course credit for student VMs

Course-sponsored compute lets an instructor pay for student-owned dedicated VMs
from a shared, bounded budget. It is separate from course membership or student
project subscriptions. **This feature is under development and is not yet
approved for general customer use.** The following describes the intended
workflow on sites where sponsorship has been enabled for testing.

Each student owns and operates their VM. Paying for it does not give the
instructor new SSH, filesystem, or administrative access to that VM. Course
collaboration by itself does not authorize spending another person's credit.

## Instructors: allocate a budget

1. Open your course file and choose **Compute budget**.
2. Select students with linked CoCalc accounts. Review the actual recipient
   accounts, not just the names or email addresses typed into the course file.
3. Enter each student's allowance and the start and end dates. Amounts and
   authorizations are in USD for the initial version.
4. Choose prepaid balance or eligible postpaid capacity. A payment card alone
   does not grant postpaid capacity; membership limits still apply.
5. Preview the total commitment and request authorization. Open the separate
   financial approval page, sign in, and review the exact recipients, amounts,
   dates, and storage obligations before approving.

For example, 20 allowances of $50 fit a $1,000 pool. Allocating prepaid funding
locks that backing: it is not simultaneously available for personal purchases,
another course, or a credit transfer. Unused backing is released only when the
associated obligations have settled.

The default is no overcommit. Enabling overcommit permits student ceilings whose
sum exceeds the pool, not extra money. Earlier spending can exhaust the shared
pool before every student uses their individual ceiling.

Recommended VM configurations help students start with a sensible machine.
Recommendations are not restrictions: students may choose other affordable
configurations. Availability and the current price are checked when starting.

## Students: choose a funding source

Open **Virtual Machines**, create a VM, and explicitly choose your course
allowance in **Course funding**. A student with a valid allowance does not need
personal credit or a payment card to spend that allowance. Account security and
compute eligibility requirements still apply.

Review the machine, price, disks, funding source, and stop time before creating
the VM. Scheduled stop defaults to six hours; an earlier financial deadline
takes precedence. Closing your browser does not stop a VM. This is a scheduled
deadline, not an idle-activity heuristic.

After the VM is available, connect its kernel from your project notebook using
[Remote Jupyter kernels](/docs/jupyter/remote-kernels). Your code runs on the VM;
the notebook remains in the project. Stopping only the kernel does not stop VM
billing.

## Understand balances and deadlines

- **Allocated** is the allowance's total authorization.
- **Spent** is usage already accounted for.
- **Committed** is money reserved for authorized work, storage, and cleanup.
- **Available to start** excludes both spent and committed amounts.
- **Updated** identifies the data timestamp. Delayed or unavailable information
  is not a zero balance or a promise that a VM is free.

The VM's funding details show its authorized runtime and storage deadline.
Retention and cleanup must also fit the budget, so $3 of credit is not permission
to start an expensive VM with a large disk. Network charges can be additional;
review the provider-specific quote and disclosed cap.

The course budget view shows the instructor sponsored spending. It does not
expose students' personal balances or unrelated personal VM history. Students
can check their own course credit from the VM page. A running-GPU indicator and
optional low-credit notifications provide reminders, not billing guarantees.

## Exhaustion and personal credit

The default is to stop when course funding ends. CoCalc must not infer permission
to charge you personally from adding a card, joining a course, asking an agent,
or dismissing a warning.

Continuing with personal funding requires your explicit authorization for that
resource, an additional monetary cap, and an end time. Advance fallback is also
limited to the reasons you approved, such as credit exhaustion or the stated
expiry. A provider failure or unknown funding error is not permission to change
payers. Reaching the personal limit stops compute; it does not authorize another
unbounded charge.

## Stop, retain, and delete

**Stopping is not deleting.** A stopped VM can still have billable disks.
Sponsored storage has a disclosed, funded retention period, initially 72 hours,
within the allowance. Separately attached home volumes have their own policy;
do not assume that deleting a VM also deletes or stops billing its home volume.

| Item | What VM deletion means |
| --- | --- |
| Notebook file and saved cell outputs in your CoCalc project | They remain in your project |
| Files you explicitly copied from the VM to the project | The project copies remain |
| Software installed on the VM's deleted boot disk | Removed |
| Datasets, model checkpoints, or other files only on a deleted VM disk | Removed |
| Unsaved kernel variables | Lost when the kernel or VM stops |

**There are no automatic VM backups and no automatic file synchronization.**
Project TimeTravel, snapshots, and backups protect the applicable project files,
not data stored only on the VM. Copy anything you need to preserve to the project
or another durable destination before the storage deletion deadline.

## Transfers between instructors

Credit transfer is separate from course allocation and does not use vouchers.
Only eligible paid prepaid credit can be transferred. Locked backing, borrowed
postpaid capacity, promotional or otherwise restricted credit cannot be treated
as freely transferable cash. Review the recipient and exact amount through the
trusted financial approval flow. A pending delivery must not be submitted again
as a new transfer merely because it has not appeared at the destination yet.

## CLI and agents

The CLI uses the same authorization and funding checks as the browser. With
account authentication, inspect your own allowances, including their timestamps:

~~~sh
cocalc compute-funding sources --include-inactive --json
~~~

An instructor can inspect the budget for a particular course instance:

~~~sh
cocalc compute-funding summary --course-project PROJECT_UUID --course-instance COURSE_UUID --json
~~~

For a VM you are authorized to inspect, read its current funding and deadlines:

~~~sh
cocalc vm funding VM_UUID --json
~~~

The VM creation dialog provides a CLI command for its selected configuration.
A course-funded creation includes all three identifiers: **--funding-payer**,
**--funding-pool**, and **--funding-grant**. Keep those together; omitting the
source is not an instruction to spend the course allowance. The server checks
the beneficiary, available backing, and current policy again at admission.

For account-authenticated personal-funding changes, use **vm personal-funding**
to preview and propose bounded terms, inspect status, or cancel consent. An
immediate change has a separate **apply** operation after approval; submitting
a proposal alone does not change the payer.

### Personal funding from the CLI

Use your own account-authenticated CLI session. Read **funding_status.source**,
**funding_status.funding_version**, **funding_status.as_of**, **stop_at**, and
**expires_at** from **vm funding**. The resource's **updated_at** is not a fresh
funding observation. A null funding status means unavailable, not zero cost.
VM price fields are not an account-wide aggregate rate or a guaranteed runway.
Read the complete preview before requesting approval.

Prepare a JSON terms file with every field explicit; replace the placeholders
with the reviewed VM UUID, funding version and a future end time within its
deletion deadline. The cap is a decimal USD string, not a JSON number:

~~~json
{
  "vm_id": "VM_UUID",
  "expected_funding_version": "REVIEWED_FUNDING_VERSION",
  "home_volume_ids": [],
  "lane": "prepaid",
  "cap_usd": "12.34",
  "ends_at": "ABSOLUTE_ISO_TIMESTAMP_WITH_TIMEZONE",
  "activation": "immediate",
  "fallback_reasons": []
}
~~~

The example cap is illustrative, not a recommendation or automatic default.
Each operation UUID must be unique to an action and reused only when retrying
that identical action after an uncertain response.

~~~sh
cocalc vm personal-funding preview --terms terms.json --json
cocalc vm personal-funding propose --terms terms.json --operation PROPOSAL_UUID --json
cocalc vm personal-funding status VM_UUID --json
~~~

Open the returned **approval_url** in your own browser and review the exact
terms on the isolated approval surface. After human approval, run **status**
again: approval changes the consent version. Use that current consent version
and the unchanged funding version approved in the terms:

~~~sh
cocalc vm personal-funding apply VM_UUID --consent CONSENT_UUID --expected-version APPROVED_CONSENT_VERSION --expected-funding-version REVIEWED_FUNDING_VERSION --operation APPLY_UUID --json
cocalc vm personal-funding status VM_UUID --json
cocalc vm get VM_UUID --json
~~~

**preparing** means the handoff was accepted, not completed. The backend queues a
stop, waits for provider and metering reconciliation, validates personal backing,
changes the funding epoch, and queues a restart. Check both consent status and
VM state. Do not replace an uncertain operation with a new operation UUID.

To cancel the exact consent, first read its current version:

~~~sh
cocalc vm personal-funding cancel VM_UUID --consent CONSENT_UUID --expected-version CURRENT_CONSENT_VERSION --operation CANCEL_UUID --json
~~~

Cancelling active or preparing consent can stop the VM; it does not refund
already incurred charges or remove storage obligations. A pending fallback
proposal uses **activation: fallback** and explicit **course_exhausted** and/or
**course_expired** reasons. The **apply** command accepts immediate consent only;
the backend evaluates approved fallback reasons after a confirmed funded stop.
An unknown funding error, manual stop, or reached scheduled stop is not a
fallback reason. This path still needs deployment-specific live acceptance;
do not force it using a CLI workaround.

Personal handoff of attached home volumes is still backend work. The current
backend rejects a nonempty home-volume scope and VMs that have an attached home
volume even if the array is empty. Do not remove scope or use **vm funding --set**
to bypass a rejection. Separately sponsored home-volume creation and resize are
also capability-gated; VM-only personal handoff readiness does not enable them.

### Denials and agent context

Structured CLI errors retain the server's denial **code** and **message**, with
recovery guidance where available. **funding_unavailable** or a changed version
requires refreshing the authorized readouts and reviewing the exact terms,
not increasing a cap or automatically substituting a new version. Home-bay
denials require the correct account/bay context, not an arbitrary routing retry.
For course spending, inspect **sources --include-inactive** to distinguish an
exhausted or expired allowance from a missing source; never remove the three
course-source flags to get past an error.

Project/agent authentication uses the project-scoped VM read/start/stop methods.
It cannot call account-only source listings or personal-consent commands. An
agent can prepare a bounded proposal for the human owner and report the
authorized VM context; the owner submits and approves it using their own
session. No private instructor-account lookup or internal accounting command is
added to this path.

Financial proposals return a separate approval URL. Only the human account
holder can sign in there and approve the exact transaction. Never give an agent
your password, authentication code, or session cookie. Project-scoped agents
cannot inspect an instructor's private budget or authorize allocations,
transfers, or personal fallback. Existing permission to start or stop a VM does
not grant permission to change its payer or extend its financial deadline.

Ask an agent to identify the selected source, the **as-of** time, the scheduled
stop and storage-deletion deadlines before acting. Missing or stale information
means it must refresh or report the uncertainty, not assume free usage. Stopping
a VM remains useful when funding information is unavailable.
`;
