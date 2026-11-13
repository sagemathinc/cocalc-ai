/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type * as RateLimit from "./rate-limit";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const INTAKE = "sagebrush-intake";

describePglite("support ticket rate-limit namespaces", () => {
  const originalEnv = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_CLUSTER_SEED_BAY_ID: process.env.COCALC_CLUSTER_SEED_BAY_ID,
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };
  let pool: Awaited<
    ReturnType<(typeof import("@cocalc/database/pool"))["default"]>
  >;
  let rateLimit: typeof RateLimit;
  let schema: any;

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "support-rate-limit-test-seed";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "support-rate-limit-test-seed";
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    const getPool = (await import("@cocalc/database/pool")).default;
    pool = getPool();
    const { SCHEMA } = await import("@cocalc/util/schema");
    schema = { support_ticket_attempts: SCHEMA.support_ticket_attempts };
    const { schemaNeedsSync, syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    await syncSchema(schema);
    expect(await schemaNeedsSync(schema)).toBe(false);
    rateLimit = await import("./rate-limit");
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM support_ticket_attempts");
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function attempt(opts: {
    email: string;
    ip_address?: string;
    source?: string;
    skip_email_rules?: boolean;
  }): Promise<"ok" | "limited"> {
    try {
      await rateLimit.assertSupportTicketRateLimit(opts);
      return "ok";
    } catch (err) {
      if (err instanceof rateLimit.SupportTicketRateLimitError) {
        return "limited";
      }
      throw err;
    }
  }

  let ipCounter = 0;
  // a distinct address per call, so only the rule under test can trip
  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${ipCounter % 250}`;
  }

  async function times(n: number, f: () => Promise<string>) {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await f());
    return out;
  }

  it("intake requests for one email leave the public form's email limit untouched, and vice versa", async () => {
    // 6 intake requests from different IPs exhaust the intake email/hour rule
    const intake = await times(6, async () =>
      attempt({
        email: "reader@example.com",
        ip_address: nextIp(),
        source: INTAKE,
      }),
    );
    expect(intake.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    expect(intake.slice(3)).toEqual(["limited", "limited", "limited"]);
    expect(
      await attempt({ email: "reader@example.com", ip_address: "192.0.2.50" }),
    ).toBe("ok");

    await pool.query("DELETE FROM support_ticket_attempts");
    const pub = await times(4, async () =>
      attempt({ email: "reader@example.com", ip_address: "192.0.2.51" }),
    );
    expect(pub[3]).toBe("limited");
    expect(
      await attempt({
        email: "reader@example.com",
        ip_address: "192.0.2.51",
        source: INTAKE,
      }),
    ).toBe("ok");
  });

  it("the same holds for one IP", async () => {
    const ip = "203.0.113.9";
    const intake = await times(11, async () =>
      attempt({
        email: "no-reply@sagebrush.example",
        ip_address: ip,
        source: INTAKE,
        skip_email_rules: true,
      }),
    );
    expect(intake.slice(0, 10).every((r) => r === "ok")).toBe(true);
    expect(intake[10]).toBe("limited");
    expect(
      await attempt({ email: "someone@example.com", ip_address: ip }),
    ).toBe("ok");
  });

  it("a typed default address keeps the email rules; an omitted email skips them", async () => {
    const typed = await times(4, async () =>
      attempt({
        email: "no-reply@sagebrush.example",
        ip_address: nextIp(),
        source: INTAKE,
      }),
    );
    expect(typed[3]).toBe("limited");

    await pool.query("DELETE FROM support_ticket_attempts");
    const omitted = await times(8, async () =>
      attempt({
        email: "no-reply@sagebrush.example",
        ip_address: nextIp(),
        source: INTAKE,
        skip_email_rules: true,
      }),
    );
    expect(omitted.every((r) => r === "ok")).toBe(true);
  });

  it("email-less requests from two IPs don't share a bucket", async () => {
    const a = await times(11, async () =>
      attempt({
        email: "no-reply@sagebrush.example",
        ip_address: "203.0.113.20",
        source: INTAKE,
        skip_email_rules: true,
      }),
    );
    expect(a[10]).toBe("limited");
    expect(
      await attempt({
        email: "no-reply@sagebrush.example",
        ip_address: "203.0.113.21",
        source: INTAKE,
        skip_email_rules: true,
      }),
    ).toBe("ok");
  });

  it("records the server-chosen source on every row; public rows stay NULL", async () => {
    await attempt({ email: "a@example.com", ip_address: "192.0.2.1" });
    await attempt({
      email: "b@example.com",
      ip_address: "192.0.2.2",
      source: INTAKE,
    });
    const { rows } = await pool.query(
      "SELECT email_address, source FROM support_ticket_attempts ORDER BY email_address",
    );
    expect(rows).toEqual([
      { email_address: "a@example.com", source: null },
      { email_address: "b@example.com", source: INTAKE },
    ]);
  });

  it("fails closed without the source column", async () => {
    await pool.query("ALTER TABLE support_ticket_attempts DROP COLUMN source");
    try {
      await expect(
        rateLimit.assertSupportTicketRateLimit({
          email: "a@example.com",
          ip_address: "192.0.2.1",
          source: INTAKE,
        }),
      ).rejects.not.toBeInstanceOf(rateLimit.SupportTicketRateLimitError);
    } finally {
      const { syncSchema } =
        await import("@cocalc/database/postgres/schema/sync");
      await syncSchema(schema);
    }
  });
});
