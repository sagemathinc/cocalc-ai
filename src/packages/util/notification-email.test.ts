/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  resolveEmailBackendForLane,
  notificationEmailBackendSettingName,
} from "./notification-email";

describe("notification email lane routing", () => {
  it("falls back to the default email backend", () => {
    expect(
      resolveEmailBackendForLane(
        {
          email_backend: "sendgrid",
        },
        "critical",
      ),
    ).toBe("sendgrid");
  });

  it("uses an explicit lane backend override", () => {
    expect(
      resolveEmailBackendForLane(
        {
          email_backend: "sendgrid",
          [notificationEmailBackendSettingName("notification")]: "smtp",
        },
        "notification",
      ),
    ).toBe("smtp");
  });
});
