/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let getVerifyEmailMock: jest.Mock;
let sendEmailMock: jest.Mock;
let sendWelcomeEmailMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/email/verify", () => ({
  getVerifyEmail: (...args: any[]) => getVerifyEmailMock(...args),
}));

jest.mock("@cocalc/server/email/send-email", () => ({
  __esModule: true,
  default: (...args: any[]) => sendEmailMock(...args),
}));

jest.mock("@cocalc/server/email/welcome-email", () => ({
  __esModule: true,
  default: (...args: any[]) => sendWelcomeEmailMock(...args),
}));

describe("sendEmailVerification", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({
      rows: [{ email_address: "USER@Example.COM" }],
    }));
    getServerSettingsMock = jest.fn(async () => ({ site_name: "Alpha" }));
    getVerifyEmailMock = jest.fn(async () => ({
      html: "<p>verify</p>",
      text: "verify",
    }));
    sendEmailMock = jest.fn(async () => undefined);
    sendWelcomeEmailMock = jest.fn(async () => undefined);
  });

  it("sends verification-only mail through the critical email lane", async () => {
    const { default: sendEmailVerification } =
      await import("./send-email-verification");

    await expect(sendEmailVerification(account_id)).resolves.toBe("");

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT email_address FROM accounts WHERE account_id=$1",
      [account_id],
    );
    expect(getVerifyEmailMock).toHaveBeenCalledWith("user@example.com");
    expect(sendEmailMock).toHaveBeenCalledWith(
      {
        to: "user@example.com",
        subject: "Verify your email address on Alpha",
        text: "verify",
        html: "<p>verify</p>",
        categories: ["verify"],
        asm_group: 147985,
      },
      account_id,
      "critical",
    );
    expect(sendWelcomeEmailMock).not.toHaveBeenCalled();
  });

  it("returns the send error instead of reporting success", async () => {
    sendEmailMock.mockRejectedValueOnce(Error("no email backend configured"));
    const { default: sendEmailVerification } =
      await import("./send-email-verification");

    await expect(sendEmailVerification(account_id)).resolves.toBe(
      "no email backend configured",
    );
  });

  it("uses the welcome email path when requested", async () => {
    const { default: sendEmailVerification } =
      await import("./send-email-verification");

    await expect(sendEmailVerification(account_id, false)).resolves.toBe("");

    expect(sendWelcomeEmailMock).toHaveBeenCalledWith(
      "user@example.com",
      account_id,
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns a useful error when the account has no email address", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ email_address: "" }] });
    const { default: sendEmailVerification } =
      await import("./send-email-verification");

    await expect(sendEmailVerification(account_id)).resolves.toBe(
      "account has no email address",
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
