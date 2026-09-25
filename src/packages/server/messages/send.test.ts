/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let mirrorSystemMessageToAccountNoticeMock: jest.Mock;
let mirrorSystemMessageToAccountNoticeBestEffortMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/database/postgres/changefeed/messages", () => ({
  __esModule: true,
  updateUnreadMessageCount: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/purchases/statements/email-statement", () => ({
  __esModule: true,
  getUser: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/hub/site-url", () => ({
  __esModule: true,
  default: jest.fn(async () => "https://example.com"),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: jest.fn(async () => true),
}));

jest.mock("./support-account", () => ({
  __esModule: true,
  getSupportAccountId: jest.fn(
    async () => "22222222-2222-4222-8222-222222222222",
  ),
}));

jest.mock("./account-notice", () => ({
  __esModule: true,
  mirrorSystemMessageToAccountNotice: (...args: any[]) =>
    mirrorSystemMessageToAccountNoticeMock(...args),
  mirrorSystemMessageToAccountNoticeBestEffort: (...args: any[]) =>
    mirrorSystemMessageToAccountNoticeBestEffortMock(...args),
}));

describe("system message delivery", () => {
  beforeEach(() => {
    jest.resetModules();
    mirrorSystemMessageToAccountNoticeMock = jest.fn(async () => undefined);
    mirrorSystemMessageToAccountNoticeBestEffortMock = jest.fn(
      async () => undefined,
    );
  });

  it("waits for the durable account notice when required", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM messages")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO messages")) {
        return { rows: [{ id: 17 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { default: send } = await import("./send");
    await send({
      to_ids: ["11111111-1111-4111-8111-111111111111"],
      subject: "Billing notice",
      body: "Fix billing.",
      dedupMinutes: 60,
      requireAccountNoticeDelivery: true,
    });

    expect(mirrorSystemMessageToAccountNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: 17,
        subject: "Billing notice",
      }),
    );
    expect(
      mirrorSystemMessageToAccountNoticeBestEffortMock,
    ).not.toHaveBeenCalled();
  });

  it("retries required notice delivery for a deduplicated message", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM messages")) {
        return { rows: [{ id: 23 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { default: send } = await import("./send");
    const id = await send({
      to_ids: ["11111111-1111-4111-8111-111111111111"],
      subject: "Billing notice",
      body: "Fix billing.",
      dedupMinutes: 60,
      requireAccountNoticeDelivery: true,
    });

    expect(id).toBe(23);
    expect(mirrorSystemMessageToAccountNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 23 }),
    );
  });

  it("passes operational priority to the durable account notice", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM messages")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO messages")) {
        return { rows: [{ id: 42 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { default: send } = await import("./send");
    await send({
      to_ids: ["11111111-1111-4111-8111-111111111111"],
      subject: "Project recovery incident",
      body: "Paying backup overdue.",
      operationalIncident: true,
      requireAccountNoticeDelivery: true,
    });
    expect(mirrorSystemMessageToAccountNoticeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: 42,
        operationalIncident: true,
      }),
    );
    await expect(
      send({
        from_id: "22222222-2222-4222-8222-222222222222",
        to_ids: ["11111111-1111-4111-8111-111111111111"],
        subject: "Fake incident",
        body: "",
        operationalIncident: true,
        requireAccountNoticeDelivery: true,
      }),
    ).rejects.toThrow("must be internal system messages");
  });
});
