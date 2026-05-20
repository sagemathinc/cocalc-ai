/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { create_email_body, escape_email_body } from "./email";

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

describe("create_email_body", () => {
  it("uses a short token invite call to action", () => {
    const body = create_email_body(
      "Course invite",
      "<p>Please join</p>",
      "student@example.com",
      "Course <script>alert(1)</script>",
      "https://example.com/invites/secret",
      false,
    );

    expect(body).toContain("Accept or reject this invitation");
    expect(body).toContain("review the invitation before joining");
    expect(body).not.toContain("To accept the invitation");
    expect(body).not.toContain("Sign in or create an account");
    expect(body).not.toContain("exactly");
    expect(body).not.toContain("<script>");
  });
});
