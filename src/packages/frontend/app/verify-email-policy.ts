/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function shouldShowVerifyEmailReminder({
  accountLoaded,
  accountOldEnough,
  emailNeedsVerification,
  emailSendingEnabled,
  emailVerificationEnabled,
  reminderDismissed,
}: {
  accountLoaded: boolean;
  accountOldEnough: boolean;
  emailNeedsVerification: boolean;
  emailSendingEnabled: boolean;
  emailVerificationEnabled: boolean;
  reminderDismissed: boolean;
}): boolean {
  return (
    accountLoaded &&
    accountOldEnough &&
    emailNeedsVerification &&
    emailSendingEnabled &&
    emailVerificationEnabled &&
    !reminderDismissed
  );
}
