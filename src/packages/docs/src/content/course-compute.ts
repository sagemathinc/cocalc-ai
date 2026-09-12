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
`;
