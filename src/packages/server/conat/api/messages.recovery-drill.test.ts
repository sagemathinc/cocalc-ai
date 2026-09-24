/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const sendMock = jest.fn();
const isAdminMock = jest.fn();
const getAdminsMock = jest.fn();
const getServerSettingsMock = jest.fn();
const configurationMock = jest.fn();

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => sendMock(...args),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));
jest.mock("@cocalc/server/accounts/admins", () => ({
  __esModule: true,
  default: (...args: any[]) => getAdminsMock(...args),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  getSingleBayInfo: () => ({ bay_id: "bay-0" }),
}));
jest.mock(
  "@cocalc/server/projects/recovery-notification-configuration",
  () => ({
    getProjectRecoveryNotificationConfiguration: (...args: any[]) =>
      configurationMock(...args),
  }),
);

import { sendProjectRecoveryCriticalEmailDrill } from "./messages";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ONCALL = "22222222-2222-4222-8222-222222222222";
const DRILL = "55555555-5555-4555-8555-555555555555";

describe("project recovery critical email drill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isAdminMock.mockResolvedValue(true);
    getAdminsMock.mockResolvedValue([ONCALL]);
    getServerSettingsMock.mockResolvedValue({});
    configurationMock.mockReturnValue({
      oncallAccountId: ONCALL,
      criticalEmailBackend: "sendgrid",
    });
    sendMock.mockResolvedValue(123);
  });

  it("sends one labeled operational incident through durable critical delivery", async () => {
    expect(
      await sendProjectRecoveryCriticalEmailDrill({
        account_id: ADMIN,
        drill_id: DRILL,
      }),
    ).toEqual({
      message_id: 123,
      recipient_account_id: ONCALL,
      drill_id: DRILL,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to_ids: [ONCALL],
        subject: expect.stringContaining(`TEST project recovery`),
        dedupMinutes: 60,
        dedupBySubject: true,
        requireAccountNoticeDelivery: true,
        operationalIncident: true,
      }),
    );
    expect(sendMock.mock.calls[0][0].subject).toContain(DRILL);
    expect(sendMock.mock.calls[0][0].body).toContain("No project debt");
  });

  it("rejects a non-admin, invalid id, or missing local on-call", async () => {
    isAdminMock.mockResolvedValueOnce(false);
    await expect(
      sendProjectRecoveryCriticalEmailDrill({
        account_id: ADMIN,
        drill_id: DRILL,
      }),
    ).rejects.toThrow("only admin");
    await expect(
      sendProjectRecoveryCriticalEmailDrill({
        account_id: ADMIN,
        drill_id: "invalid",
      }),
    ).rejects.toThrow("valid drill_id");
    getAdminsMock.mockResolvedValueOnce([]);
    await expect(
      sendProjectRecoveryCriticalEmailDrill({
        account_id: ADMIN,
        drill_id: DRILL,
      }),
    ).rejects.toThrow("local administrator");
    configurationMock.mockReturnValueOnce({
      oncallAccountId: ONCALL,
      criticalEmailBackend: "none",
    });
    await expect(
      sendProjectRecoveryCriticalEmailDrill({
        account_id: ADMIN,
        drill_id: DRILL,
      }),
    ).rejects.toThrow("critical email backend");
    expect(sendMock).not.toHaveBeenCalled();
  });
});
