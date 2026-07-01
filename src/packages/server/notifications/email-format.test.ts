/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  escapeNotificationEmailHtml,
  normalizeNotificationEmailText,
  renderNotificationEmailMarkdownHtml,
  renderNotificationEmailMarkdownText,
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

  it("renders markdown email bodies as HTML instead of escaped markdown", () => {
    const html = renderNotificationEmailMarkdownHtml(
      [
        "Dear User,",
        "<br/>",
        "## Statement",
        "",
        "- **NO PAYMENT IS REQUIRED.**",
        "",
        "| Id | Amount |",
        "| :-- | -----: |",
        "| 1 | $10.00 |",
        "",
        "[Open statements](https://cocalc.test/settings/statements)",
      ].join("\n"),
    );

    expect(html).toContain("<h2>Statement</h2>");
    expect(html).toContain("<strong>NO PAYMENT IS REQUIRED.</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain(
      '<a href="https://cocalc.test/settings/statements">Open statements</a>',
    );
    expect(html).not.toContain("&lt;br");
    expect(html).not.toContain("**NO PAYMENT");
  });

  it("renders markdown email bodies as readable plaintext", () => {
    expect(
      renderNotificationEmailMarkdownText("**NO PAYMENT IS REQUIRED.**"),
    ).toBe("NO PAYMENT IS REQUIRED.");
  });
});
