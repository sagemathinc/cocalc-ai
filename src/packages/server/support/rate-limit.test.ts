/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("uuid", () => ({
  v4: () => "11111111-1111-4111-8111-111111111111",
}));

describe("support ticket rate limit", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO support_ticket_attempts")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COUNT(*)::INT AS count")) {
        return { rows: [{ count: 1 }] };
      }
      if (sql.includes("UPDATE support_ticket_attempts")) {
        return { rows: [] };
      }
      throw Error(`unexpected query: ${sql}`);
    });
  });

  it("records and accepts requests below the configured limits", async () => {
    const { assertSupportTicketRateLimit } = await import("./rate-limit");

    await expect(
      assertSupportTicketRateLimit({
        email: " USER@example.COM ",
        ip_address: " 192.0.2.1 ",
      }),
    ).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO support_ticket_attempts"),
      expect.arrayContaining([
        "11111111-1111-4111-8111-111111111111",
        expect.any(Date),
        "192.0.2.1",
        "user@example.com",
        null,
        "pending",
      ]),
    );
    expect(queryMock).toHaveBeenLastCalledWith(
      "UPDATE support_ticket_attempts SET accepted=$2, reason=$3 WHERE id=$1",
      ["11111111-1111-4111-8111-111111111111", true, null],
    );
  });

  it("blocks and records the first exceeded rule", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO support_ticket_attempts")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COUNT(*)::INT AS count")) {
        return { rows: [{ count: 4 }] };
      }
      if (sql.includes("UPDATE support_ticket_attempts")) {
        return { rows: [] };
      }
      throw Error(`unexpected query: ${sql}`);
    });

    const { assertSupportTicketRateLimit, SupportTicketRateLimitError } =
      await import("./rate-limit");

    await expect(
      assertSupportTicketRateLimit({
        email: "user@example.com",
        ip_address: "192.0.2.1",
      }),
    ).rejects.toBeInstanceOf(SupportTicketRateLimitError);

    expect(queryMock).toHaveBeenLastCalledWith(
      "UPDATE support_ticket_attempts SET accepted=$2, reason=$3 WHERE id=$1",
      ["11111111-1111-4111-8111-111111111111", false, "email_hour"],
    );
  });
});
