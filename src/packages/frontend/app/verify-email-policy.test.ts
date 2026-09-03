/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { shouldShowVerifyEmailReminder } from "./verify-email-policy";

const eligibleAccount = {
  accountLoaded: true,
  accountOldEnough: true,
  emailNeedsVerification: true,
  emailSendingEnabled: true,
  emailVerificationEnabled: true,
  reminderDismissed: false,
};

describe("shouldShowVerifyEmailReminder", () => {
  it("shows the reminder when verification and email delivery are enabled", () => {
    expect(shouldShowVerifyEmailReminder(eligibleAccount)).toBe(true);
  });

  it("does not prompt when email verification is disabled", () => {
    expect(
      shouldShowVerifyEmailReminder({
        ...eligibleAccount,
        emailVerificationEnabled: false,
      }),
    ).toBe(false);
  });

  it("does not prompt when email delivery is disabled", () => {
    expect(
      shouldShowVerifyEmailReminder({
        ...eligibleAccount,
        emailSendingEnabled: false,
      }),
    ).toBe(false);
  });
});
