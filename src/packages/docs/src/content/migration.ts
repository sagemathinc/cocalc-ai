/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const MIGRATING_FROM_COCALC_COM_BODY = String.raw`
## Before you start

Use the same email address on CoCalc.ai that you used for cocalc.com. Legacy
billing and projects are matched by verified email address. Verify the legacy
address on your CoCalc.ai account so it can find the matching records.

On CoCalc.ai, sign up or sign in with the same email address you used
on cocalc.com, then verify the email address in **profile settings**.
If you want to merge multiple accounts from cocalc.com, configure and
verify each of them in cocalc.ai's **profile settings**. 

## Use the migration banner

When CoCalc finds migration work for your verified email address, the app may
show a banner titled **Finish your cocalc.com migration**. Depending on what is
available for your account, the banner can show:

1. **Review billing migration** for legacy billing credit or membership work.
2. **Restore projects** for legacy projects that are ready to import.

If a free migration membership has already started, the banner can instead say
**Your 30-day membership grant is active.** and show **Continue membership**.

## Review billing migration

Open **Review billing migration** from the banner, or open **Billing** from
account settings. The billing panel is titled **Legacy billing migration**.

If your verified email matches legacy billing data, the panel shows **Legacy
billing data found** with **Pending credit**, **Remaining paid value**,
**Migrated credit**, **Membership grant**, and **Stripe customer** fields.

Choose **Apply now** to add the pending legacy credit to your CoCalc account
balance. If the preview offers a membership grant, the grant starts when you
choose **Apply now**. The preview shows the offered free membership period;
after applying, an active grant panel shows when it ends. The panel also records
the migrated items in your
CoCalc billing history and membership status.

If the panel says **Verify your email address to migrate legacy billing**, open
**profile settings**, verify the email address shown there, then return to
Billing and choose **Refresh**.

## Restore legacy projects

Open **Restore projects** from the banner, or open account settings and choose
**Legacy Projects**. The page is titled **Legacy cocalc.com migration**.

The page lists legacy projects matched to your verified cocalc.com account
records. Matching includes projects you owned and projects where your linked
cocalc.com account appeared in the legacy project user list.

Use the filters to find projects:

1. **All statuses**, **Ready to restore**, **Restoring**, **Restored**,
   **Unavailable**, or **Failed**.
2. **Include hidden** if you need hidden legacy projects.
3. **Include unavailable** if you want to see legacy project records without a
   recoverable archive.
4. **Max size GB** and **Search legacy projects** to narrow a long list.

For one project, choose **Restore and Open**. CoCalc opens **Import legacy
project**, where you choose an **Image** and a project host. Choose **Import and
Open** to create the CoCalc project and restore files in the background.

For several projects, select ready projects with the table checkboxes and choose
**Restore selected**. CoCalc opens **Restore selected legacy projects**. Choose
one **Image** and one host choice for the batch, then choose **Restore
selected**. Restore at most 50 projects in one batch, then select the next
batch.

The **Image** choices come from the current managed project-image catalog for
your site. Pick the image that matches the software stack you want for the
restored projects. For host placement, choose a host or region close to you or
your collaborators unless you have a project-specific reason to place it
elsewhere.

## After restoring

Projects can open before file restore is complete. CoCalc shows restore status
such as **Restoring**, **Restored**, **Restored with warnings**, **Partial
restore**, or **Failed**.

If a project opens while files are still restoring, you can leave the page and
come back later. If CoCalc reports file warnings, the restored project contains
the available files and the warning lists archive entries that were not restored.

For restored \`.sagews\` files, see the legacy Sage worksheet section in
[Using Jupyter in CoCalc](/docs/jupyter/use-jupyter) before rerunning them. Opening
a worksheet may create a notebook without historical outputs or reuse an
existing notebook.

## Troubleshooting

If you see **Verify your email address to find legacy projects**, open
**profile settings**, verify the email address, then return to **Legacy
Projects** and choose **Refresh**.

If you see **No linked cocalc.com account found**, confirm that your CoCalc.ai
account uses the same verified email address as the old cocalc.com account. To
try another address, change and verify your email address in **profile
settings**, then refresh the migration page.

If a project is **Unavailable**, no recoverable archive is available for that
legacy project. Contact support if you expected to restore it.
`;
