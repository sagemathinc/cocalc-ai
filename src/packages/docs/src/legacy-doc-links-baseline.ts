/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Existing legacy public-doc links. The docs verifier fails only on new
// file/url pairs so we can migrate these deliberately without blocking all
// unrelated docs work.
export const LEGACY_DOC_LINK_BASELINE = new Set([
  "src/packages/frontend/account/ssh-keys/global-ssh-keys.tsx\thttps://doc.cocalc.com/account/ssh.html",
  "src/packages/frontend/account/ssh-keys/ssh-key-adder.tsx\thttps://doc.cocalc.com/account/ssh.html",
  "src/packages/frontend/billing/data.ts\thttps://doc.cocalc.com/account/licenses.html",
  "src/packages/frontend/billing/data.ts\thttps://doc.cocalc.com/licenses.html",
  "src/packages/frontend/billing/data.ts\thttps://doc.cocalc.com/teaching-upgrade-course.html#students-pay-for-upgrades",
  "src/packages/frontend/billing/data.ts\thttps://doc.cocalc.com/teaching-upgrade-course.html#teacher-or-institution-pays-for-upgrades",
  "src/packages/frontend/billing/faq.tsx\thttps://doc.cocalc.com/billing.html",
  "src/packages/frontend/billing/faq.tsx\thttps://doc.cocalc.com/project-faq.html",
  "src/packages/frontend/course/common/student-assignment-info.tsx\thttps://doc.cocalc.com/teaching-tips_and_tricks.html#how-exactly-are-assignments-copied-to-students",
  "src/packages/frontend/project/info/utils.ts\thttps://doc.cocalc.com/project-settings.html#ssh-keys",
  "src/packages/frontend/project/no-internet-modal.tsx\thttps://doc.cocalc.com/upgrades.html#internet-access",
  "src/packages/frontend/project/project-banner.tsx\thttps://doc.cocalc.com/trial.html",
  "src/packages/frontend/project/trial-banner.tsx\thttps://doc.cocalc.com/billing.html#what-is-member-hosting",
  "src/packages/frontend/project/trial-banner.tsx\thttps://doc.cocalc.com/trial.html",
  "src/packages/frontend/store/voucher-center-page.tsx\thttps://doc.cocalc.com/vouchers.html",
]);
