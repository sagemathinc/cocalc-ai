/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { escape_email_body } from "./email";

describe("escape_email_body", () => {
  it("drops disallowed xmp raw-text contents", () => {
    expect(
      escape_email_body("<xmp><img src=x onerror=alert(1)></xmp>", true),
    ).not.toContain("<img");
    expect(
      escape_email_body("<xmp><script>alert(1)</script></xmp>", true),
    ).not.toContain("<script");
  });

  it("keeps links only when URL links are allowed", () => {
    expect(
      escape_email_body('<a href="https://cocalc.com">CoCalc</a>', true),
    ).toContain('<a href="https://cocalc.com">');
    expect(
      escape_email_body('<a href="https://cocalc.com">CoCalc</a>', false),
    ).toBe("CoCalc");
  });
});
