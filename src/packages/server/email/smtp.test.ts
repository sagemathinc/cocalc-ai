/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createTransport } from "nodemailer";
import sendEmail from "./smtp";

const mockGetServerSettings = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args) => mockGetServerSettings(...args),
}));

jest.mock("./footer", () => ({
  __esModule: true,
  default: async (message) => message,
}));

jest.mock("nodemailer", () => {
  const actual = jest.requireActual("nodemailer");
  return {
    ...actual,
    createTransport: jest.fn(() => {
      // Generate real MIME messages, but never open a network connection.
      const transport = actual.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix",
      });
      transport.sendMail = jest.fn(transport.sendMail.bind(transport));
      return transport;
    }),
  };
});

describe("SMTP email with Nodemailer", () => {
  let serverIndex = 0;
  let settings;

  beforeEach(() => {
    jest.clearAllMocks();
    settings = {
      email_smtp_server: `smtp-${++serverIndex}.example.test`,
      email_smtp_login: "notification-user",
      email_smtp_password: "test-only-password",
      email_smtp_from: '"CoCalc Notifications" <notify@example.test>',
    };
    mockGetServerSettings.mockResolvedValue(settings);
  });

  it("preserves secure SMTP configuration and generates a multipart message", async () => {
    await sendEmail({
      to: '"Ada Example" <ada@example.test>',
      subject: "Monthly report",
      text: "The report is ready.",
      html: "<p>The report is ready.</p>",
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: settings.email_smtp_server,
      port: 465,
      secure: true,
      auth: {
        user: settings.email_smtp_login,
        pass: settings.email_smtp_password,
      },
    });
    const transport = jest.mocked(createTransport).mock.results[0].value;
    const delivery = await jest.mocked(transport.sendMail).mock.results[0]
      .value;
    expect(delivery.envelope).toEqual({
      from: "notify@example.test",
      to: ["ada@example.test"],
    });
    const mime = delivery.message.toString("utf8");
    expect(mime).toContain("Subject: Monthly report");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("The report is ready.");
    expect(mime).toContain("<p>The report is ready.</p>");
  });

  it("rejects missing SMTP credentials before creating a transport", async () => {
    mockGetServerSettings.mockResolvedValue({
      ...settings,
      email_smtp_password: "",
    });

    await expect(
      sendEmail({
        to: "ada@example.test",
        subject: "Monthly report",
        text: "The report is ready.",
        html: "<p>The report is ready.</p>",
      }),
    ).rejects.toThrow("SMTP password must be configured");
    expect(createTransport).not.toHaveBeenCalled();
  });
});
