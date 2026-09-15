/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { before, after, getPool } from "@cocalc/server/test";
import createCredit from "./create-credit";
import createRefund from "./create-refund";
import getBalance from "./get-balance";
import getSpendableBalance, {
  getAccountFundingHolds,
} from "./get-spendable-balance";
import { lockAccountSpending } from "./lock-account-spending";
import {
  claimProviderRefundReconciliation,
  reconcileClaimedProviderRefund,
  reconcileProviderRefunds,
} from "./provider-refund-worker";

const mockGetConn = jest.fn();
const mockSend = jest.fn();
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args) => mockGetConn(...args),
}));
jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args) => mockSend(...args),
  support: jest.fn().mockResolvedValue("Support"),
  name: jest.fn().mockResolvedValue("Payer"),
  url: jest.fn(async (path) => path),
}));

const admin = randomUUID();
beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    "INSERT INTO accounts (account_id,groups) VALUES ($1,ARRAY['admin'])",
    [admin],
  );
}, 60_000);
afterAll(after);
beforeEach(() => {
  mockGetConn.mockReset();
  mockSend.mockReset().mockResolvedValue(undefined);
});

async function fixture(intent = false) {
  const payer = randomUUID(),
    charge = `ch_${randomUUID()}`,
    invoice = `in_${randomUUID()}`,
    payment = `pi_${randomUUID()}`;
  await getPool().query("INSERT INTO accounts (account_id) VALUES ($1)", [
    payer,
  ]);
  const purchase_id = await createCredit({
    account_id: payer,
    amount: "25",
    invoice_id: intent ? payment : invoice,
  });
  const refunds: any[] = [];
  const byKey = new Map<string, any>();
  const stripe = {
    invoices: {
      retrieve: jest
        .fn()
        .mockResolvedValue({ id: invoice, charge, payment_intent: payment }),
    },
    paymentIntents: {
      retrieve: jest.fn().mockResolvedValue({
        id: payment,
        invoice: null,
        latest_charge: null,
        metadata: { invoice_id: invoice },
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    invoicePayments: { list: jest.fn().mockResolvedValue({ data: [] }) },
    charges: {
      list: jest.fn().mockResolvedValue({ data: [{ id: charge }] }),
      retrieve: jest.fn(async () => {
        const amount_refunded = refunds
          .filter((r) => !["failed", "canceled"].includes(r.status))
          .reduce((a, r) => a + r.amount, 0);
        return {
          id: charge,
          currency: "usd",
          amount: 2500,
          amount_refunded,
          refunded: amount_refunded === 2500,
        };
      }),
    },
    refunds: {
      create: jest.fn(async (request, options) => {
        if (byKey.has(options.idempotencyKey))
          return byKey.get(options.idempotencyKey);
        const result = {
          id: `re_${randomUUID()}`,
          status: "succeeded",
          amount: request.amount,
          charge: request.charge,
          metadata: request.metadata,
        };
        refunds.push(result);
        byKey.set(options.idempotencyKey, result);
        return result;
      }),
      list: jest.fn(async () => ({ data: refunds, has_more: false })),
      retrieve: jest.fn(async (id) => refunds.find((r) => r.id === id)),
    },
  };
  mockGetConn.mockResolvedValue(stripe);
  const run = (reason: "other" | "duplicate" = "other") =>
    createRefund({
      account_id: admin,
      purchase_id,
      reason,
      notes: "Refund test",
    });
  const attempt = async () =>
    (
      await getPool().query(
        "SELECT * FROM provider_refund_attempts WHERE purchase_id=$1",
        [purchase_id],
      )
    ).rows[0];
  return {
    payer,
    charge,
    invoice,
    payment,
    purchase_id,
    stripe,
    refunds,
    run,
    attempt,
  };
}

it("commits a hold before dispatch, calls the provider outside account locks and settles once", async () => {
  const f = await fixture();
  const send = f.stripe.refunds.create.getMockImplementation()!;
  f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
    expect(
      (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
    ).toBe("25.0000000000");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "0.0000000000",
    );
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='1s'");
      await lockAccountSpending(client, f.payer);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return send(request, options);
  });
  const id = await f.run();
  expect(await f.run()).toBe(id);
  expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  const a = await f.attempt();
  expect(a.state).toBe("succeeded");
  expect(a.refund_purchase_id).toBe(id);
  expect(f.stripe.refunds.create).toHaveBeenCalledWith(
    expect.objectContaining({
      charge: f.charge,
      amount: 2500,
      metadata: {
        account_id: admin,
        purchase_id: f.purchase_id,
        refund_attempt_id: a.id,
      },
    }),
    { idempotencyKey: `cocalc-refund-${a.id}` },
  );
  expect(f.stripe.refunds.create.mock.calls[0][0].reason).toBeUndefined();
  expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
  expect(
    (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
  ).toBe("0.0000000000");
});

it("resolves a payment-intent credit through its invoice metadata", async () => {
  const f = await fixture(true);
  await f.run("duplicate");
  expect(f.stripe.paymentIntents.retrieve).toHaveBeenCalledWith(f.payment);
  expect(f.stripe.charges.list).toHaveBeenCalledWith({
    payment_intent: f.payment,
    limit: 1,
  });
});

it("resolves invoice payment records when the legacy charge field is absent", async () => {
  const f = await fixture();
  f.stripe.invoices.retrieve.mockResolvedValue({
    id: f.invoice,
    charge: null as any,
    payment_intent: null as any,
  });
  f.stripe.invoicePayments.list.mockResolvedValue({
    data: [
      {
        is_default: true,
        status: "paid",
        payment: { type: "payment_intent", payment_intent: f.payment },
      },
    ],
  } as any);
  await f.run();
  expect(f.stripe.charges.list).toHaveBeenCalledWith({
    payment_intent: f.payment,
    limit: 1,
  });
});

it("retains a hold after a lost provider reply and recovers the tagged refund without creating another", async () => {
  const f = await fixture();
  const send = f.stripe.refunds.create.getMockImplementation()!;
  f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
    await send(request, options);
    throw Error("lost reply");
  });
  await expect(f.run()).rejects.toThrow("lost reply");
  expect((await f.attempt()).state).toBe("pending");
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
  await f.run("duplicate");
  expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
});

it.each(["pending", "requires_action"])(
  "keeps %s funds reserved and uses retrieval on retry",
  async (status) => {
    const f = await fixture();
    const send = f.stripe.refunds.create.getMockImplementation()!;
    f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
      const r = await send(request, options);
      r.status = status;
      return r;
    });
    await expect(f.run()).rejects.toThrow("still processing");
    expect(await getBalance({ account_id: f.payer })).toBe("25.0000000000");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "0.0000000000",
    );
    f.refunds[0].status = "succeeded";
    await f.run();
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(f.stripe.refunds.retrieve).toHaveBeenCalledWith(f.refunds[0].id);
  },
);

it.each(["failed", "canceled"])(
  "releases a verified %s refund without creating another on retry",
  async (status) => {
    const f = await fixture();
    const send = f.stripe.refunds.create.getMockImplementation()!;
    f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
      const r = await send(request, options);
      r.status = status;
      return r;
    });
    await expect(f.run()).rejects.toThrow("hold was released");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "25.0000000000",
    );
    await expect(f.run()).rejects.toThrow("failed at the payment provider");
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  },
);

it("does not resubmit an uncertain request after its retry window", async () => {
  const f = await fixture();
  f.stripe.refunds.create.mockRejectedValueOnce(Error("disconnected"));
  await expect(f.run()).rejects.toThrow("disconnected");
  await getPool().query(
    "UPDATE provider_refund_attempts SET dispatched_at=NOW()-INTERVAL '24 hours' WHERE purchase_id=$1",
    [f.purchase_id],
  );
  await expect(f.run()).rejects.toThrow("retry window expired");
  expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
});

it("reuses the exact persisted request despite different retry arguments", async () => {
  const f = await fixture();
  f.stripe.refunds.create.mockRejectedValueOnce(Error("disconnected"));
  await expect(f.run()).rejects.toThrow("disconnected");
  await f.run("duplicate");
  expect(f.stripe.refunds.create.mock.calls[0]).toEqual(
    f.stripe.refunds.create.mock.calls[1],
  );
});

it("does not dispatch after spending authority freezes", async () => {
  const f = await fixture();
  await getPool().query(
    "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
    [f.payer, randomUUID(), process.env.COCALC_BAY_ID || "bay-0"],
  );
  await expect(f.run()).rejects.toThrow("frozen");
  expect(mockGetConn).not.toHaveBeenCalled();
});

it("does not refund credit already consumed by a pending product payment", async () => {
  const f = await fixture();
  await getPool().query(
    "INSERT INTO payment_fulfillments (payment_id,account_id,credit_id,purpose,amount,request) VALUES ($1,$2,$3,'test',25,'{}')",
    [f.invoice, f.payer, f.purchase_id],
  );
  await expect(f.run()).rejects.toThrow("spent or reserved");
  expect(mockGetConn).not.toHaveBeenCalled();
  expect(await f.attempt()).toBeUndefined();
});

it("can reconcile a fully successful out-of-band refund without a new dispatch", async () => {
  const f = await fixture();
  f.refunds.push({
    id: "re_manual",
    charge: f.charge,
    amount: 2500,
    status: "succeeded",
  });
  await f.run();
  expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
});

it("does not mistake a partially pending full-charge refund for complete success", async () => {
  const f = await fixture();
  f.refunds.push(
    { id: "re_done", charge: f.charge, amount: 1000, status: "succeeded" },
    { id: "re_pending", charge: f.charge, amount: 1500, status: "pending" },
  );
  await expect(f.run()).rejects.toThrow("still unresolved");
  expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
});

it("does not undo settlement if ancillary metadata updating fails", async () => {
  const f = await fixture();
  f.stripe.paymentIntents.update.mockRejectedValueOnce(Error("metadata error"));
  const id = await f.run();
  expect(await f.run()).toBe(id);
  expect((await f.attempt()).state).toBe("succeeded");
});

it("keeps the hold when posting fails after provider success, then settles the existing refund", async () => {
  const f = await fixture();
  const spy = jest
    .spyOn(require("./create-purchase"), "default")
    .mockRejectedValueOnce(Error("settlement unavailable"));
  try {
    await expect(f.run()).rejects.toThrow("settlement unavailable");
  } finally {
    spy.mockRestore();
  }
  expect((await f.attempt()).state).toBe("pending");
  expect(await getBalance({ account_id: f.payer })).toBe("25.0000000000");
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
  await f.run();
  expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
});

it("retains funds if the provider returns a different amount", async () => {
  const f = await fixture();
  const send = f.stripe.refunds.create.getMockImplementation()!;
  f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
    const r = await send(request, options);
    r.amount = 1;
    return r;
  });
  await expect(f.run()).rejects.toThrow("amount does not match");
  expect((await f.attempt()).state).toBe("pending");
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
});

it("retains funds when a remainder fails after a prior partial refund", async () => {
  const f = await fixture();
  f.refunds.push({
    id: "re_partial",
    charge: f.charge,
    amount: 1000,
    status: "succeeded",
  });
  const send = f.stripe.refunds.create.getMockImplementation()!;
  f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
    const r = await send(request, options);
    r.status = "failed";
    return r;
  });
  await expect(f.run()).rejects.toThrow("Partial refund needs reconciliation");
  expect(f.stripe.refunds.create.mock.calls[0][0].amount).toBe(1500);
  expect((await f.attempt()).previous_refunded_cents).toBe(1000);
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
});

it("rechecks authority after a read-only provider lookup and before dispatch", async () => {
  const f = await fixture();
  const inspect = f.stripe.charges.retrieve.getMockImplementation()!;
  f.stripe.charges.retrieve.mockImplementationOnce(async () => {
    await getPool().query(
      "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
      [f.payer, randomUUID(), process.env.COCALC_BAY_ID || "bay-0"],
    );
    return inspect();
  });
  await expect(f.run()).rejects.toThrow("frozen");
  expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  expect(await getSpendableBalance({ account_id: f.payer })).toBe(
    "0.0000000000",
  );
});

const concurrentTest =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
concurrentTest(
  "concurrent callers share one intent, provider key and ledger debit",
  async () => {
    const f = await fixture();
    const results = await Promise.all([f.run(), f.run()]);
    expect(results[0]).toBe(results[1]);
    expect(f.refunds).toHaveLength(1);
    expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
  },
);

describe("read-only background refund reconciliation", () => {
  async function pending() {
    const f = await fixture();
    const send = f.stripe.refunds.create.getMockImplementation()!;
    f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
      const result = await send(request, options);
      result.status = "pending";
      return result;
    });
    await expect(f.run()).rejects.toThrow("still processing");
    return f;
  }

  async function expectHeld(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await f.attempt()).state).toBe("pending");
    expect(await getBalance({ account_id: f.payer })).toBe("25.0000000000");
    expect(await getSpendableBalance({ account_id: f.payer })).toBe(
      "0.0000000000",
    );
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  }

  it("settles a pending refund once without sending another provider request", async () => {
    const f = await pending();
    f.refunds[0].status = "succeeded";
    expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(1);
    expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(0);
    expect((await f.attempt()).state).toBe("succeeded");
    expect((await f.attempt()).reconcile_token).toBeNull();
    expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
    expect(
      (await getAccountFundingHolds({ account_id: f.payer })).prepaid_held_usd,
    ).toBe("0.0000000000");
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost receipt after the provider retry window has expired", async () => {
    const f = await fixture();
    const send = f.stripe.refunds.create.getMockImplementation()!;
    f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
      await send(request, options);
      throw Error("lost reply");
    });
    await expect(f.run()).rejects.toThrow("lost reply");
    await getPool().query(
      "UPDATE provider_refund_attempts SET dispatched_at=NOW()-INTERVAL '2 days' WHERE purchase_id=$1",
      [f.purchase_id],
    );
    await reconcileProviderRefunds({ account_id: f.payer });
    expect((await f.attempt()).state).toBe("succeeded");
    expect(f.stripe.refunds.list).toHaveBeenCalled();
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "canceled"])(
    "releases a verified %s refund without replacement",
    async (status) => {
      const f = await pending();
      f.refunds[0].status = status;
      await reconcileProviderRefunds({ account_id: f.payer });
      expect((await f.attempt()).state).toBe("failed");
      expect(await getSpendableBalance({ account_id: f.payer })).toBe(
        "25.0000000000",
      );
      expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    },
  );

  it("backs off an unresolved refund without releasing its hold", async () => {
    const f = await pending();
    expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(1);
    const row = await f.attempt();
    expect(row.last_reconcile_error).toBe("provider_pending");
    expect(row.reconcile_attempts).toBe(1);
    expect(new Date(row.next_reconcile_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(0);
    await expectHeld(f);
  });

  it("never creates a refund when a dispatched attempt has no provider receipt", async () => {
    const f = await fixture();
    f.stripe.refunds.create.mockRejectedValueOnce(Error("lost reply"));
    await expect(f.run()).rejects.toThrow("lost reply");
    await reconcileProviderRefunds({ account_id: f.payer });
    expect((await f.attempt()).last_reconcile_error).toBe(
      "no_provider_receipt",
    );
    await expectHeld(f);
  });

  it("does not claim an undispatched hold", async () => {
    const f = await fixture();
    f.stripe.invoices.retrieve.mockRejectedValueOnce(
      Error("lookup unavailable"),
    );
    await expect(f.run()).rejects.toThrow("lookup unavailable");
    mockGetConn.mockClear();
    expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(0);
    expect(mockGetConn).not.toHaveBeenCalled();
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    expect((await f.attempt()).provider_request).toBeNull();
  });

  it.each(["frozen", "remote", "deleted"])(
    "does not claim a %s account",
    async (state) => {
      const f = await pending();
      if (state === "frozen") {
        await getPool().query(
          "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
          [f.payer, randomUUID(), process.env.COCALC_BAY_ID || "bay-0"],
        );
      } else if (state === "remote") {
        await getPool().query(
          "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
          [f.payer, `remote-${randomUUID()}`],
        );
      } else {
        await getPool().query(
          "UPDATE accounts SET deleted=TRUE WHERE account_id=$1",
          [f.payer],
        );
      }
      mockGetConn.mockClear();
      expect(await reconcileProviderRefunds({ account_id: f.payer })).toBe(0);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect((await f.attempt()).state).toBe("pending");
    },
  );

  it("rejects an expired worker without clearing its successor's lease", async () => {
    const f = await pending();
    const first = (await claimProviderRefundReconciliation(f.payer))!;
    expect(first).toBeDefined();
    await getPool().query(
      "UPDATE provider_refund_attempts SET reconcile_lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [first.id],
    );
    const second = (await claimProviderRefundReconciliation(f.payer))!;
    expect(second.reconcile_token).not.toBe(first.reconcile_token);
    mockGetConn.mockClear();
    await reconcileClaimedProviderRefund(first);
    expect(mockGetConn).not.toHaveBeenCalled();
    expect((await f.attempt()).reconcile_token).toBe(second.reconcile_token);
    f.refunds[0].status = "succeeded";
    await reconcileClaimedProviderRefund(second);
    expect((await f.attempt()).state).toBe("succeeded");
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it.each(["lease expiry", "authority freeze"])(
    "rechecks %s after the provider lookup",
    async (change) => {
      const f = await pending();
      f.refunds[0].status = "succeeded";
      const claim = (await claimProviderRefundReconciliation(f.payer))!;
      f.stripe.refunds.retrieve.mockImplementationOnce(async () => {
        if (change === "lease expiry") {
          await getPool().query(
            "UPDATE provider_refund_attempts SET reconcile_lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
            [claim.id],
          );
        } else {
          await getPool().query(
            "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
            [f.payer, randomUUID(), process.env.COCALC_BAY_ID || "bay-0"],
          );
        }
        return f.refunds[0];
      });
      await reconcileClaimedProviderRefund(claim);
      expect((await f.attempt()).last_reconcile_error).toBe(
        "reconciliation_failed",
      );
      await expectHeld(f);
    },
  );

  it("discards a provider response arriving after the lookup timeout", async () => {
    const f = await pending();
    const claim = (await claimProviderRefundReconciliation(f.payer))!;
    let resolve!: (value: any) => void;
    f.stripe.refunds.retrieve.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await reconcileClaimedProviderRefund(claim, 20);
    expect(resolve).toBeDefined();
    await expectHeld(f);
    resolve({ ...f.refunds[0], status: "succeeded" });
    await new Promise((r) => setImmediate(r));
    await expectHeld(f);
    expect((await f.attempt()).last_reconcile_error).toBe(
      "reconciliation_failed",
    );
  });

  it("does not release a hold for a failed remainder after a partial refund", async () => {
    const f = await fixture();
    f.refunds.push({
      id: "re_partial",
      charge: f.charge,
      amount: 1000,
      status: "succeeded",
    });
    const send = f.stripe.refunds.create.getMockImplementation()!;
    f.stripe.refunds.create.mockImplementationOnce(async (request, options) => {
      const result = await send(request, options);
      result.status = "pending";
      return result;
    });
    await expect(f.run()).rejects.toThrow("still processing");
    f.refunds[1].status = "failed";
    await reconcileProviderRefunds({ account_id: f.payer });
    expect((await f.attempt()).last_reconcile_error).toBe(
      "partial_refund_needs_review",
    );
    await expectHeld(f);
  });

  it("retains the hold when a provider receipt has a different charge", async () => {
    const f = await pending();
    f.stripe.refunds.retrieve.mockResolvedValueOnce({
      ...f.refunds[0],
      charge: "ch_other",
      status: "succeeded",
    });
    await reconcileProviderRefunds({ account_id: f.payer });
    expect((await f.attempt()).last_reconcile_error).toBe(
      "reconciliation_failed",
    );
    await expectHeld(f);
  });

  it("does not duplicate a manual settlement after a background claim", async () => {
    const f = await pending();
    const claim = (await claimProviderRefundReconciliation(f.payer))!;
    f.refunds[0].status = "succeeded";
    const id = await f.run();
    mockGetConn.mockClear();
    await reconcileClaimedProviderRefund(claim);
    expect(mockGetConn).not.toHaveBeenCalled();
    expect((await f.attempt()).refund_purchase_id).toBe(id);
    expect(await getBalance({ account_id: f.payer })).toBe("0.0000000000");
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  concurrentTest(
    "performs provider reads outside the account spending lock",
    async () => {
      const f = await pending();
      f.stripe.refunds.retrieve.mockImplementationOnce(async () => {
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout='1s'");
          await lockAccountSpending(client, f.payer);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return { ...f.refunds[0], status: "succeeded" };
      });
      await reconcileProviderRefunds({ account_id: f.payer });
      expect((await f.attempt()).state).toBe("succeeded");
      expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    },
  );

  concurrentTest(
    "competing database workers have exactly one claim winner",
    async () => {
      const f = await pending();
      const claims = await Promise.all([
        claimProviderRefundReconciliation(f.payer),
        claimProviderRefundReconciliation(f.payer),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await f.attempt()).reconcile_attempts).toBe(1);
      await reconcileClaimedProviderRefund(claims.find(Boolean)!);
      await expectHeld(f);
    },
  );
});
