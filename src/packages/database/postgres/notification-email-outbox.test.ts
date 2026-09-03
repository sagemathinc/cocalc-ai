/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { codexNotificationEmailEnabled } from "./notification-email-outbox";

describe("Codex notification email rollout gate", () => {
  const original = process.env.COCALC_CODEX_ATTENTION_EMAIL;

  afterEach(() => {
    if (original == null) {
      delete process.env.COCALC_CODEX_ATTENTION_EMAIL;
    } else {
      process.env.COCALC_CODEX_ATTENTION_EMAIL = original;
    }
  });

  it("is default-off and can be enabled independently", () => {
    delete process.env.COCALC_CODEX_ATTENTION_EMAIL;
    expect(codexNotificationEmailEnabled()).toBe(false);
    process.env.COCALC_CODEX_ATTENTION_EMAIL = "1";
    expect(codexNotificationEmailEnabled()).toBe(true);
  });
});
