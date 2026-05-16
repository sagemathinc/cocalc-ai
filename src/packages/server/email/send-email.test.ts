/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getServerSettingsMock: jest.Mock;
let sendViaSMTPMock: jest.Mock;
let sendViaSendgridMock: jest.Mock;
let sendEmailThrottleMock: jest.Mock;

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("./smtp", () => ({
  __esModule: true,
  default: (...args: any[]) => sendViaSMTPMock(...args),
}));

jest.mock("./sendgrid", () => ({
  __esModule: true,
  default: (...args: any[]) => sendViaSendgridMock(...args),
}));

jest.mock("./throttle", () => ({
  __esModule: true,
  default: (...args: any[]) => sendEmailThrottleMock(...args),
}));

describe("sendEmail", () => {
  const message = { to: "user@example.com", subject: "Test", text: "Test" };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_TEST_MODE;
    getServerSettingsMock = jest.fn(async () => ({
      email_backend: "sendgrid",
      notification_email_critical_backend: "smtp",
    }));
    sendViaSMTPMock = jest.fn(async () => undefined);
    sendViaSendgridMock = jest.fn(async () => undefined);
    sendEmailThrottleMock = jest.fn(async () => undefined);
  });

  it("uses the resolved lane backend", async () => {
    const { default: sendEmail } = await import("./send-email");

    await sendEmail(message, "account-1", "critical");

    expect(sendViaSMTPMock).toHaveBeenCalledWith(message);
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });

  it("falls back from explicit lane SMTP to default SendGrid", async () => {
    sendViaSMTPMock.mockRejectedValueOnce(Error("smtp failed"));
    const { default: sendEmail } = await import("./send-email");

    await sendEmail(message, "account-1", "critical");

    expect(sendViaSMTPMock).toHaveBeenCalledWith(message);
    expect(sendViaSendgridMock).toHaveBeenCalledWith(message);
  });

  it("does not fall back when a lane explicitly disables email", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      email_backend: "sendgrid",
      notification_email_critical_backend: "none",
    });
    const { default: sendEmail } = await import("./send-email");

    await expect(sendEmail(message, "account-1", "critical")).rejects.toThrow(
      "no email backend configured",
    );
    expect(sendViaSMTPMock).not.toHaveBeenCalled();
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });
});
