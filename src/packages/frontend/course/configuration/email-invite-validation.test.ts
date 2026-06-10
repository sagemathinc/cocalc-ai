/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  EMAIL_INVITE_URL_ERROR,
  getEmailInviteValidationError,
} from "./email-invite-validation";

describe("course email invite validation", () => {
  it("allows the built-in course invite template variables", () => {
    expect(
      getEmailInviteValidationError(
        "Hello,\n\n{name} invited you to join **{title}**.\n\nThanks,\n{name}",
      ),
    ).toBe("");
  });

  it("rejects explicit web links", () => {
    expect(
      getEmailInviteValidationError("Read the syllabus at https://example.com"),
    ).toBe(EMAIL_INVITE_URL_ERROR);
  });

  it("rejects plain domain names", () => {
    expect(
      getEmailInviteValidationError("Read the syllabus at example.com/course"),
    ).toBe(EMAIL_INVITE_URL_ERROR);
  });
});
