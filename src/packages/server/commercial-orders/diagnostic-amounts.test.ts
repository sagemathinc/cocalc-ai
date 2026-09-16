/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describePglite("invoice-based receivable amounts", () => {
  let pool: ReturnType<(typeof import("@cocalc/database/pool"))["default"]>;
  let getAmounts: (typeof import("./diagnostic-amounts"))["getDiagnosticAmounts"];
  const originalDb = process.env.COCALC_DB;
  const originalDir = process.env.COCALC_PGLITE_DATA_DIR;

  beforeAll(async () => {
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    pool = (await import("@cocalc/database/pool")).default();
    getAmounts = (await import("./diagnostic-amounts")).getDiagnosticAmounts;
    await pool.query(`CREATE TABLE commercial_orders (
      id text PRIMARY KEY, currency text, workflow_state text,
      collection_state text, fulfillment_state text, agreed_total numeric
    )`);
    await pool.query(`CREATE TABLE commercial_invoices (
      commercial_order_id text, currency text, status text,
      amount_due numeric, due_at timestamptz
    )`);
  });

  afterAll(async () => {
    await (await import("@cocalc/database/pglite")).closePglite();
    if (originalDb == null) delete process.env.COCALC_DB;
    else process.env.COCALC_DB = originalDb;
    if (originalDir == null) delete process.env.COCALC_PGLITE_DATA_DIR;
    else process.env.COCALC_PGLITE_DATA_DIR = originalDir;
  });

  it("returns no fabricated currencies for an empty ledger", async () => {
    expect(await getAmounts()).toEqual({});
  });

  it("separates partial invoice balances, pipeline, and paid fulfillment by currency", async () => {
    await pool.query(`INSERT INTO commercial_orders VALUES
      ('alternative-a','usd','draft','not_invoiced','not_provisioned',100),
      ('alternative-b','usd','draft','not_invoiced','not_provisioned',100),
      ('paid','usd','awaiting_payment','paid','not_provisioned',50),
      ('partial','usd','awaiting_payment','open','provisioned',200),
      ('cancelled','usd','cancelled','open','not_provisioned',300),
      ('euro','eur','awaiting_payment','open','not_provisioned',100),
      ('complete','usd','complete','paid','provisioned',20)`);
    await pool.query(`INSERT INTO commercial_invoices VALUES
      ('paid','usd','paid',0,NOW()-INTERVAL '1 day'),
      ('partial','usd','open',120.01,NOW()-INTERVAL '1 day'),
      ('partial','usd','void',200,NOW()-INTERVAL '1 day'),
      ('partial','usd','draft',200,NOW()-INTERVAL '1 day'),
      ('partial','usd','uncollectible',200,NOW()-INTERVAL '1 day'),
      ('cancelled','usd','open',40.02,NULL),
      ('euro','eur','open',30.03,NOW()+INTERVAL '1 day'),
      ('complete','usd','paid',0,NOW()-INTERVAL '1 day')`);
    const amounts = await getAmounts();
    expect(amounts.usd).toEqual({
      invoice_outstanding: "160.03",
      invoice_overdue: "120.01",
      fulfilled_invoice_outstanding: "120.01",
      uninvoiced_pipeline: "200",
      paid_unfulfilled_order_value: "50",
      open_order_value: "450",
    });
    expect(amounts.eur).toEqual({
      invoice_outstanding: "30.03",
      invoice_overdue: "0",
      fulfilled_invoice_outstanding: "0",
      uninvoiced_pipeline: "0",
      paid_unfulfilled_order_value: "0",
      open_order_value: "100",
    });
  });

  it("does not call already invoiced but stale not_invoiced orders pipeline", async () => {
    await pool.query(`INSERT INTO commercial_orders VALUES
      ('stale','cad','draft','not_invoiced','not_provisioned',999)`);
    await pool.query(`INSERT INTO commercial_invoices VALUES
      ('stale','cad','draft',999,NULL)`);
    expect((await getAmounts()).cad.uninvoiced_pipeline).toBe("0");
  });
});
