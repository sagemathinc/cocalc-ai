/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  escapeNotificationEmailHtml,
  normalizeNotificationEmailText,
} from "./email-format";

describe("notification email formatting", () => {
  it("converts CoCalc mention spans to readable text", () => {
    expect(
      normalizeNotificationEmailText(
        'Please see <span class="user-mention" account-id=11111111-1111-4111-8111-111111111111 >Ada Lovelace</span> before release.',
      ),
    ).toBe("Please see @Ada Lovelace before release.");
  });

  it("preserves an existing mention marker and decodes the mention label", () => {
    expect(
      normalizeNotificationEmailText(
        `Ping <span account-id="11111111-1111-4111-8111-111111111111" class="foo user-mention">@Ada &amp; Grace</span>`,
      ),
    ).toBe("Ping @Ada & Grace");
  });

  it("does not strip unrelated literal html before the normal email escape step", () => {
    const text = normalizeNotificationEmailText("Use <b>bold</b> literally.");
    expect(text).toBe("Use <b>bold</b> literally.");
    expect(escapeNotificationEmailHtml(text)).toBe(
      "Use &lt;b&gt;bold&lt;/b&gt; literally.",
    );
  });
});
