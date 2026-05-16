/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let sendViaSMTPMock: jest.Mock;
let sendViaSendgridMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: queryMock }),
}));

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

describe("sendTestEmail", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({
      rows: [{ email_address: "ADMIN@Example.COM" }],
    }));
    getServerSettingsMock = jest.fn(async () => ({
      site_name: "Alpha",
      email_backend: "sendgrid",
      notification_email_critical_backend: "smtp",
    }));
    sendViaSMTPMock = jest.fn(async () => undefined);
    sendViaSendgridMock = jest.fn(async () => undefined);
  });

  it("sends through the resolved critical lane backend", async () => {
    const { sendTestEmail } = await import("./test-email");

    await expect(sendTestEmail({ account_id })).resolves.toMatchObject({
      to: "admin@example.com",
      mode: "critical",
      lane: "critical",
      success: true,
      resolved_backend: "smtp",
      default_backend: "sendgrid",
      lane_backend: "smtp",
      route: [{ backend: "smtp", source: "primary-smtp", status: "accepted" }],
    });
    expect(sendViaSMTPMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: "CoCalc test email from Alpha",
      }),
      "email",
    );
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });

  it("falls back to the default backend when the lane backend fails", async () => {
    sendViaSMTPMock.mockRejectedValueOnce(
      Error("SMTP authentication failed password=secret"),
    );
    const { sendTestEmail } = await import("./test-email");

    const result = await sendTestEmail({ account_id });

    expect(result.success).toBe(true);
    expect(result.route).toEqual([
      {
        backend: "smtp",
        source: "primary-smtp",
        status: "failed",
        error: "SMTP authentication failed password=[redacted]",
      },
      { backend: "sendgrid", source: "default-fallback", status: "accepted" },
    ]);
    expect(sendViaSendgridMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" }),
    );
  });

  it("returns a diagnostic result when no backend is configured", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      email_backend: "none",
      notification_email_critical_backend: "default",
    });
    const { sendTestEmail } = await import("./test-email");

    await expect(sendTestEmail({ account_id })).resolves.toMatchObject({
      success: false,
      resolved_backend: "none",
      default_backend: "none",
      lane_backend: "default",
      route: [],
    });
    expect(sendViaSMTPMock).not.toHaveBeenCalled();
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });

  it("does not fall back when the lane explicitly disables email", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      email_backend: "sendgrid",
      notification_email_critical_backend: "none",
    });
    const { sendTestEmail } = await import("./test-email");

    await expect(sendTestEmail({ account_id })).resolves.toMatchObject({
      success: false,
      resolved_backend: "none",
      default_backend: "sendgrid",
      lane_backend: "none",
      route: [],
    });
    expect(sendViaSMTPMock).not.toHaveBeenCalled();
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });

  it("tests the verification route using secondary smtp before critical fallback", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      site_name: "Alpha",
      email_backend: "sendgrid",
      notification_email_critical_backend: "smtp",
      password_reset_override: "smtp",
      password_reset_smtp_server: "smtp.example.com",
      password_reset_smtp_from: "noreply@example.com",
      password_reset_smtp_login: "user",
      password_reset_smtp_password: "password",
    });
    const { sendTestEmail } = await import("./test-email");

    await expect(
      sendTestEmail({ account_id, mode: "verification" }),
    ).resolves.toMatchObject({
      mode: "verification",
      success: true,
      route: [
        { backend: "smtp", source: "secondary-smtp", status: "accepted" },
      ],
    });
    expect(sendViaSMTPMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        subject: "CoCalc verification test email from Alpha",
      }),
      "password_reset",
    );
    expect(sendViaSendgridMock).not.toHaveBeenCalled();
  });

  it("falls back from secondary smtp to the critical route for verification tests", async () => {
    getServerSettingsMock.mockResolvedValueOnce({
      site_name: "Alpha",
      email_backend: "sendgrid",
      notification_email_critical_backend: "smtp",
      password_reset_override: "smtp",
      password_reset_smtp_server: "smtp.example.com",
      password_reset_smtp_from: "noreply@example.com",
      password_reset_smtp_login: "user",
      password_reset_smtp_password: "password",
    });
    sendViaSMTPMock
      .mockRejectedValueOnce(Error("secondary down"))
      .mockRejectedValueOnce(Error("primary down"));
    const { sendTestEmail } = await import("./test-email");

    await expect(
      sendTestEmail({ account_id, mode: "verification" }),
    ).resolves.toMatchObject({
      mode: "verification",
      success: true,
      route: [
        {
          backend: "smtp",
          source: "secondary-smtp",
          status: "failed",
          error: "secondary down",
        },
        {
          backend: "smtp",
          source: "primary-smtp",
          status: "failed",
          error: "primary down",
        },
        { backend: "sendgrid", source: "default-fallback", status: "accepted" },
      ],
    });
    expect(sendViaSendgridMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com" }),
    );
  });
});
