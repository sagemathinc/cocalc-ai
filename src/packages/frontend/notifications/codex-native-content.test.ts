/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { codexNativeNotificationContent } from "./codex-native-content";

describe("Codex native notification privacy", () => {
  it("contains only fixed, privacy-minimal text", () => {
    const hostileDetails = [
      "sk-secret-value",
      "/home/user/private/customer.chat",
      "https://attacker.invalid/action?token=secret",
    ];
    const content = [
      codexNativeNotificationContent(true),
      codexNativeNotificationContent(false),
    ];

    expect(content).toEqual([
      {
        title: "Codex needs your attention",
        body: "Open CoCalc to view details.",
      },
      {
        title: "Codex finished",
        body: "Open CoCalc to view details.",
      },
    ]);
    expect(JSON.stringify(content)).not.toContain(hostileDetails.join(""));
    for (const detail of hostileDetails) {
      expect(JSON.stringify(content)).not.toContain(detail);
    }
  });
});
