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

  function counts(): { sql: string; params: unknown[] }[] {
    return queryMock.mock.calls
      .filter(([sql]) => sql.includes("SELECT COUNT(*)::INT AS count"))
      .map(([sql, params]) => ({ sql, params }));
  }

  it("records NULL and counts only NULL-source rows by default", async () => {
    const { assertSupportTicketRateLimit } = await import("./rate-limit");
    await assertSupportTicketRateLimit({
      email: "user@example.com",
      ip_address: "192.0.2.1",
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO support_ticket_attempts"),
    );
    expect(insert[0]).toContain("source");
    expect(insert[1][6]).toBeNull();
    expect(counts()).toHaveLength(6);
    for (const { sql, params } of counts()) {
      expect(sql).toContain(
        `source IS NOT DISTINCT FROM $${params.length}::TEXT`,
      );
      expect(params[params.length - 1]).toBeNull();
    }
  });

  it("records and counts only its own namespace for a source", async () => {
    const { assertSupportTicketRateLimit } = await import("./rate-limit");
    await assertSupportTicketRateLimit({
      email: "user@example.com",
      ip_address: "192.0.2.1",
      source: "sagebrush-intake",
    });
    const insert = queryMock.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO support_ticket_attempts"),
    );
    expect(insert[1][6]).toBe("sagebrush-intake");
    expect(counts()).toHaveLength(6);
    for (const { params } of counts()) {
      expect(params[params.length - 1]).toBe("sagebrush-intake");
    }
  });

  it("skip_email_rules drops every rule keyed on the email", async () => {
    const { assertSupportTicketRateLimit } = await import("./rate-limit");
    await assertSupportTicketRateLimit({
      email: "no-reply@sagebrush.example",
      ip_address: "192.0.2.1",
      source: "sagebrush-intake",
      skip_email_rules: true,
    });
    expect(counts()).toHaveLength(2);
    for (const { sql } of counts()) {
      expect(sql).not.toContain("email_address");
      expect(sql).toContain("ip_address=$1::inet");
    }
  });

  it("fails closed when the attempt cannot be recorded", async () => {
    queryMock = jest.fn(async () => {
      throw Error('column "source" does not exist');
    });
    const { assertSupportTicketRateLimit } = await import("./rate-limit");
    await expect(
      assertSupportTicketRateLimit({
        email: "user@example.com",
        source: "sagebrush-intake",
      }),
    ).rejects.toThrow("does not exist");
  });
});
