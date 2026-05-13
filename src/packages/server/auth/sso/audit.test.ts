/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sanitizeSsoAuditReason, ssoAuditEmailDomain } from "./audit";

describe("SSO audit helpers", () => {
  it("redacts emails and uuids from denial reasons", () => {
    expect(
      sanitizeSsoAuditReason(
        new Error(
          "There is already an account with email address user@example.com for 11111111-1111-4111-8111-111111111111",
        ),
      ),
    ).toBe("There is already an account with email address <email> for <uuid>");
  });

  it("records only the email domain", () => {
    expect(ssoAuditEmailDomain("User@Example.EDU")).toBe("example.edu");
  });
});
