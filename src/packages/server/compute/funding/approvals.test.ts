/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import {
  canonicalFundingTerms,
  createCourseFundingApprovals,
  ensureCourseFundingApprovalSchema,
} from "./approvals";
import { validateFundingOrigin } from "./approval-config";
import { requireFundingApprovalSession } from "./approval-auth";
import { prepareFundingApprovalRecipients } from "./approval-recipients";
import { withFundingAccountTransaction } from "./backing";

jest.mock("./approval-auth", () => ({
  requireFundingApprovalSession: jest.fn(),
}));
jest.mock("./backing", () => {
  // PGlite has one session; concurrent BEGIN/ROLLBACK must not interleave.
  let previous = Promise.resolve();
  return {
    withFundingAccountTransaction: async (account_id, fn) => {
      const pending = previous;
      let release!: () => void;
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await pending;
      try {
        return await require("@cocalc/server/accounts/rehome-fence").withAccountRehomeWriteFence(
          { account_id, fn },
        );
      } finally {
        release();
      }
    },
  };
});
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: async (account_ids: string[]) =>
    account_ids.map((account_id) => ({ account_id, home_bay_id: "bay-0" })),
  getClusterAccountById: async (account_id: string) => ({
    account_id,
    home_bay_id: "bay-0",
  }),
}));

describe("funding terms and origin validation", () => {
  it("canonicalizes object keys without losing values", () => {
    expect(canonicalFundingTerms({ b: "2", a: [false, null, "1"] })).toBe(
      canonicalFundingTerms({ a: [false, null, "1"], b: "2" }),
    );
    for (const value of [
      NaN,
      Infinity,
      undefined,
      new Date(),
      { a: undefined },
    ]) {
      expect(() => canonicalFundingTerms(value)).toThrow();
    }
  });
  it("rejects ordinary site origins and production", () => {
    for (const origin of [
      "http://localhost:9200",
      "http://127.0.0.1:9200",
      "http://127.0.0.2:9200/path",
    ]) {
      expect(() => validateFundingOrigin(origin)).toThrow();
    }
    expect(validateFundingOrigin("http://127.0.0.2:9200").hostname).toBe(
      "127.0.0.2",
    );
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => validateFundingOrigin("http://127.0.0.2:9200")).toThrow();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("durable course funding intents", () => {
  const payer = randomUUID();
  const other = randomUUID();
  const terms = { amount_usd: "20.00", recipients: [other] };
  const apply = jest.fn(async ({ db, operation_id }) => {
    await db.query("INSERT INTO approval_test_allocations (id) VALUES ($1)", [
      operation_id,
    ]);
    return { pool_id: operation_id };
  });
  const approvals = createCourseFundingApprovals({
    approval_origin: "http://127.0.0.2:19200",
    validateTerms: (input: unknown) => input as typeof terms,
    resolveReview: async () => ({
      payer: {
        account_id: payer,
        name: "Payer",
        email: "payer@example.test",
        home_bay_id: "bay-0",
      },
      recipients: [
        {
          account_id: other,
          name: "Student",
          email: "student@example.test",
          home_bay_id: "bay-0",
        },
      ],
      storage_retention_hours: 72,
    }),
    apply,
  });
  const pool = getPool();
  const oldBay = process.env.COCALC_BAY_ID;
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "bay-0";
    await pool.query(
      "CREATE TABLE accounts (account_id UUID PRIMARY KEY, home_bay_id TEXT, deleted BOOLEAN, banned BOOLEAN)",
    );
    await pool.query(
      "INSERT INTO accounts (account_id,home_bay_id) VALUES ($1,'bay-0'),($2,'bay-0')",
      [payer, other],
    );
    await pool.query(
      "CREATE TABLE approval_test_allocations (id UUID PRIMARY KEY)",
    );
    await ensureCourseFundingApprovalSchema();
  });
  beforeEach(() => {
    apply.mockClear();
    (requireFundingApprovalSession as jest.Mock).mockResolvedValue(payer);
  });
  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    if (oldBay == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = oldBay;
  });
  async function propose() {
    return approvals.propose({
      payer_account_id: payer,
      terms,
      operation_id: randomUUID(),
    });
  }
  function approve(intent) {
    return approvals.approve({
      payer_account_id: payer,
      intent_id: intent.intent_id,
      terms_hash: intent.terms_hash,
      approved_session_hash: "isolated",
    });
  }
  it("deduplicates a proposal and rejects changed terms for its operation", async () => {
    const operation_id = randomUUID();
    const a = await approvals.propose({
      payer_account_id: payer,
      terms,
      operation_id,
    });
    expect(
      await approvals.propose({ payer_account_id: payer, terms, operation_id }),
    ).toEqual(a);
    await expect(
      approvals.propose({
        payer_account_id: payer,
        terms: { ...terms, amount_usd: "21.00" },
        operation_id,
      }),
    ).rejects.toThrow("terms changed");
    expect(apply).not.toHaveBeenCalled();
  });
  it("applies exact stored terms once and keeps a status receipt", async () => {
    const intent = await propose();
    const result = await approve(intent);
    expect(result.status).toBe("applied");
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        terms,
        payer_account_id: payer,
        operation_id: intent.operation_id,
      }),
    );
    await expect(approve(intent)).rejects.toThrow("already consumed");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      await approvals.status({
        payer_account_id: payer,
        intent_id: intent.intent_id,
      }),
    ).toEqual(result);
  });
  it("rejects a general fresh session before applying", async () => {
    const intent = await propose();
    (requireFundingApprovalSession as jest.Mock).mockRejectedValueOnce(
      new Error("Financial sign-in required"),
    );
    await expect(approve(intent)).rejects.toThrow("Financial sign-in");
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(["banned", "deleted", "moved", "missing"])(
    "rejects a recipient %s after proposal without consuming the intent or allocating",
    async (change) => {
      const checked = createCourseFundingApprovals({
        approval_origin: "http://127.0.0.2:19212",
        validateTerms: (input: unknown) => input as typeof terms,
        resolveReview: async () => ({
          payer: {
            account_id: payer,
            name: "Payer",
            email: "payer@example.test",
            home_bay_id: "bay-0",
          },
          recipients: [
            {
              account_id: other,
              name: "Student",
              email: "student@example.test",
              home_bay_id: "bay-0",
            },
          ],
          storage_retention_hours: 72,
        }),
        apply,
        prepare: async (intent) => {
          const check = await prepareFundingApprovalRecipients(
            intent.review,
            true,
          );
          return {
            withTransaction: (fn) => withFundingAccountTransaction(payer, fn),
            apply: async (locked) => {
              await check(locked.db);
              return await apply(locked);
            },
          };
        },
      });
      const intent = await checked.propose({
        payer_account_id: payer,
        terms,
        operation_id: randomUUID(),
      });
      try {
        if (change === "missing")
          await pool.query("DELETE FROM accounts WHERE account_id=$1", [other]);
        else
          await pool.query(
            "UPDATE accounts SET banned=$2,deleted=$3,home_bay_id=$4 WHERE account_id=$1",
            [
              other,
              change === "banned",
              change === "deleted",
              change === "moved" ? "different-home" : "bay-0",
            ],
          );
        await expect(
          checked.approve({
            payer_account_id: payer,
            intent_id: intent.intent_id,
            terms_hash: intent.terms_hash,
            approved_session_hash: "isolated",
          }),
        ).rejects.toThrow("unavailable");
        expect(apply).not.toHaveBeenCalled();
        const {
          rows: [stored],
        } = await pool.query(
          "SELECT applied_at, approved_session_hash FROM course_funding_approval_intents WHERE id=$1",
          [intent.intent_id],
        );
        expect(stored).toEqual({
          applied_at: null,
          approved_session_hash: null,
        });
        expect(
          (
            await pool.query(
              "SELECT * FROM approval_test_allocations WHERE id=$1",
              [intent.operation_id],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await pool.query(
          "INSERT INTO accounts (account_id,home_bay_id) VALUES ($1,'bay-0') ON CONFLICT(account_id) DO UPDATE SET home_bay_id='bay-0',deleted=false,banned=false",
          [other],
        );
      }
    },
  );
  it("rolls back pool writes and consumption on callback failure", async () => {
    const intent = await propose();
    apply.mockImplementationOnce(async ({ db, operation_id }) => {
      await db.query("INSERT INTO approval_test_allocations (id) VALUES ($1)", [
        operation_id,
      ]);
      throw new Error("pool failure");
    });
    await expect(approve(intent)).rejects.toThrow("pool failure");
    expect(
      (
        await pool.query(
          "SELECT * FROM approval_test_allocations WHERE id=$1",
          [intent.operation_id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await approvals.status({
          payer_account_id: payer,
          intent_id: intent.intent_id,
        })
      ).status,
    ).toBe("pending");
    expect((await approve(intent)).status).toBe("applied");
  });
  it("serializes concurrent approval attempts", async () => {
    const intent = await propose();
    const results = await Promise.allSettled([
      approve(intent),
      approve(intent),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("runs specialized preflight before its transaction and atomically rolls back failed execution", async () => {
    const order: string[] = [];
    const specialized = createCourseFundingApprovals({
      approval_origin: "http://127.0.0.2:19212",
      validateTerms: (input: unknown) => input as typeof terms,
      resolveReview: async () => ({
        payer: {
          account_id: payer,
          name: "Payer",
          email: "payer@example.test",
          home_bay_id: "bay-0",
        },
        recipients: [],
        storage_retention_hours: 72,
      }),
      apply: async () => {
        throw new Error("default callback must not run");
      },
      prepare: async () => {
        order.push("preflight");
        return {
          withTransaction: async (fn) => {
            order.push("transaction");
            const db = await pool.connect();
            try {
              await db.query("BEGIN");
              const result = await fn(db);
              await db.query("COMMIT");
              return result;
            } catch (error) {
              await db.query("ROLLBACK");
              throw error;
            } finally {
              db.release();
            }
          },
          apply: async ({ db, operation_id }) => {
            order.push("apply");
            await db.query(
              "INSERT INTO approval_test_allocations (id) VALUES ($1)",
              [operation_id],
            );
            throw new Error("core rejected stale binding");
          },
        };
      },
    });
    const intent = await specialized.propose({
      payer_account_id: payer,
      terms,
      operation_id: randomUUID(),
    });
    expect(
      await specialized.statusByOperation({
        payer_account_id: payer,
        operation_id: intent.operation_id,
      }),
    ).toEqual(intent);
    await expect(
      specialized.approve({
        payer_account_id: payer,
        intent_id: intent.intent_id,
        terms_hash: intent.terms_hash,
        approved_session_hash: "isolated-session",
      }),
    ).rejects.toThrow("core rejected stale binding");
    expect(order).toEqual(["preflight", "transaction", "apply"]);
    expect(
      (
        await pool.query(
          "SELECT * FROM approval_test_allocations WHERE id=$1",
          [intent.operation_id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT applied_at,approved_session_hash FROM course_funding_approval_intents WHERE id=$1",
          [intent.intent_id],
        )
      ).rows[0],
    ).toMatchObject({ applied_at: null, approved_session_hash: null });
  });
  it("rejects another payer, altered hash, and expiration", async () => {
    const intent = await propose();
    await expect(
      approvals.retrieve({
        payer_account_id: other,
        intent_id: intent.intent_id,
      }),
    ).rejects.toThrow("not found");
    await expect(approve({ ...intent, terms_hash: "altered" })).rejects.toThrow(
      "terms changed",
    );
    await pool.query(
      "UPDATE course_funding_approval_intents SET expires_at=now()-interval '1 second' WHERE id=$1",
      [intent.intent_id],
    );
    await expect(approve(intent)).rejects.toThrow("expired");
    expect(apply).not.toHaveBeenCalled();
  });
  it("rejects rehomed and banned payers", async () => {
    const intent = await propose();
    await pool.query(
      "UPDATE accounts SET home_bay_id='bay-1' WHERE account_id=$1",
      [payer],
    );
    await expect(approve(intent)).rejects.toThrow("homed on bay-1");
    await pool.query(
      "UPDATE accounts SET home_bay_id='bay-0',banned=true WHERE account_id=$1",
      [payer],
    );
    await expect(approve(intent)).rejects.toThrow("unavailable");
    await pool.query("UPDATE accounts SET banned=false WHERE account_id=$1", [
      payer,
    ]);
    expect(apply).not.toHaveBeenCalled();
  });
});
