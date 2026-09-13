import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import passwordHash from "@cocalc/backend/auth/password-hash";
import getPool from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import {
  prepareCreditTransferApproval,
  withCreditTransferApprovalTransaction,
  applyCreditTransferInTransaction,
  getCreditTransferRecipientLocal,
  getOutgoingCreditTransferLocal,
  deliverCreditTransferLocal,
  reconcileCreditTransfer,
  withCreditTransferAccounts,
} from "./core";
import type { CreditTransferTransport } from "./core";
import { verifyPaymentPurchase } from "./payment-verification";
import { readCreditLots, assertPaymentRootNotExported } from "./ledger";
import {
  previewCreditTransfer,
  proposeCreditTransfer,
  getCreditTransferStatus,
  listCreditTransfers,
} from "./api";
import {
  initCourseFundingApprovalService,
  stopCourseFundingApprovalService,
} from "@cocalc/server/compute/funding/approval-startup";
import { toDecimal } from "@cocalc/util/money";

const mockPayments = new Map<string, any>();
const mockHomes = new Map<string, string>();
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => ({
    paymentIntents: { retrieve: async (id: string) => mockPayments.get(id) },
  }),
}));
jest.mock("../stripe/util", () => ({
  currentStripeSite: async () => "transfer-test",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async ({ account_id }) => ({
    home_bay_id: mockHomes.get(account_id) ?? "launchpad",
  }),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id: string) =>
    (
      await require("@cocalc/database/pool")
        .default()
        .query("SELECT * FROM accounts WHERE account_id=$1", [account_id])
    ).rows[0],
  getClusterAccountsByIds: async (ids: string[]) =>
    (
      await require("@cocalc/database/pool")
        .default()
        .query("SELECT * FROM accounts WHERE account_id=ANY($1::uuid[])", [ids])
    ).rows,
}));

const originalBay = process.env.COCALC_BAY_ID;
beforeAll(async () => {
  process.env.COCALC_BAY_ID = "launchpad";
  await before({ noConat: true });
}, 60000);
afterAll(async () => {
  await after();
  if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = originalBay;
});

async function onBay<T>(bay: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.COCALC_BAY_ID;
  process.env.COCALC_BAY_ID = bay;
  try {
    return await fn();
  } finally {
    process.env.COCALC_BAY_ID = old;
  }
}
const transport: CreditTransferTransport = {
  recipient: (bay, account) =>
    onBay(bay, () => getCreditTransferRecipientLocal(account)),
  verifyRoot: (bay, account, purchase, root_id) =>
    onBay(bay, () => verifyPaymentPurchase(account, purchase, root_id)),
  outgoing: (bay, account, id) =>
    onBay(bay, () => getOutgoingCreditTransferLocal(account, id)),
  deliver: (bay, opts) =>
    onBay(bay, () => deliverCreditTransferLocal(opts, transport)),
};

async function account(bay = "launchpad") {
  const account_id = randomUUID();
  const email = `${account_id}@example.test`;
  await getPool().query(
    "INSERT INTO accounts (account_id,home_bay_id,email_address,email_address_verified,stripe_customer_id) VALUES ($1,$2,$3,$4,$5)",
    [account_id, bay, email, { [email]: Date.now() }, `cus_${account_id}`],
  );
  mockHomes.set(account_id, bay);
  return account_id;
}
async function credit(account_id: string, amount = "100") {
  const id = `pi_${randomUUID()}`;
  const {
    rows: [row],
  } = await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time,invoice_id,description) VALUES ($1,-$2::numeric,'credit',now(),$3,$4) RETURNING id",
    [account_id, amount, id, { type: "credit", purpose: "add-credit" }],
  );
  const cents = toDecimal(amount).mul(100).toNumber();
  mockPayments.set(id, {
    id,
    status: "succeeded",
    currency: "usd",
    customer: `cus_${account_id}`,
    amount_received: cents,
    metadata: {
      account_id,
      cocalc_site: "transfer-test",
      purpose: "add-credit",
      total_excluding_tax_usd: `${cents}`,
    },
    latest_charge: {
      id: `ch_${id}`,
      currency: "usd",
      customer: `cus_${account_id}`,
      payment_intent: id,
      status: "succeeded",
      paid: true,
      captured: true,
      disputed: false,
      refunded: false,
      amount_refunded: 0,
      amount_captured: cents,
      balance_transaction: {
        id: `txn_${id}`,
        currency: "usd",
        status: "available",
        available_on: 1,
        source: `ch_${id}`,
        amount: cents,
      },
    },
  });
  return { id: row.id, payment: id };
}
async function prepare(sender: string, recipient: string, amount = "40") {
  const identity = await transport.recipient(
    mockHomes.get(recipient)!,
    recipient,
  );
  return prepareCreditTransferApproval(
    {
      payer_account_id: sender,
      terms: { currency: "USD", amount_usd: amount, recipient: identity },
    },
    transport,
  );
}
async function apply(
  prepared: Awaited<ReturnType<typeof prepare>>,
  operation_id = randomUUID(),
) {
  return withCreditTransferApprovalTransaction(prepared, (db) =>
    applyCreditTransferInTransaction(
      {
        db,
        payer_account_id: prepared.payer_account_id,
        operation_id,
        intent_id: randomUUID(),
        terms: prepared.terms,
      },
      prepared,
    ),
  );
}
async function balance(account_id: string) {
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT -coalesce(sum(cost),0) AS balance FROM purchases WHERE account_id=$1",
    [account_id],
  );
  return Number(row.balance);
}

it("keeps the public mutation API closed without isolated approval", async () => {
  const sender = await account();
  const recipient = await account();
  await expect(
    previewCreditTransfer({
      account_id: sender,
      recipient_account_id: recipient,
      amount_usd: "1",
    }),
  ).rejects.toThrow("not enabled");
  await expect(
    proposeCreditTransfer({
      account_id: sender,
      operation_id: randomUUID(),
      terms: {} as any,
    }),
  ).rejects.toThrow("not enabled");
});
it("connects public proposal, real financial sign-in, re-verification and receipts", async () => {
  const sender = await account();
  const recipient = await account();
  const payment = await credit(sender);
  const password = `test-${randomUUID()}`;
  await getPool().query(
    "UPDATE accounts SET password_hash=$2 WHERE account_id=$1",
    [sender, passwordHash(password)],
  );
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.2", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    probe.close((error) => (error ? reject(error) : done())),
  );
  const environment = {
    COCALC_ENABLE_CREDIT_TRANSFERS: "yes",
    COCALC_FUNDING_APPROVAL_ENABLED: "1",
    COCALC_FUNDING_APPROVAL_ORIGIN: `http://127.0.0.2:${port}`,
    COCALC_FUNDING_APPROVAL_PORT: `${port}`,
    COCALC_FUNDING_APPROVAL_APPLICATION_ORIGINS: "http://127.0.0.1:19200",
  };
  const original = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  let browser: any;
  try {
    await initCourseFundingApprovalService();
    const preview = await previewCreditTransfer({
      account_id: sender,
      recipient_account_id: recipient,
      amount_usd: "40",
    });
    const operation_id = randomUUID();
    const proposal = await proposeCreditTransfer({
      account_id: sender,
      operation_id,
      terms: preview.terms,
    });
    expect(proposal.state).toBe("approval_required");
    expect(
      (await listCreditTransfers({ account_id: sender })).pending_approvals,
    ).toEqual([
      expect.objectContaining({
        operation_id,
        approval_url: proposal.approval_url,
        terms: preview.terms,
      }),
    ]);
    expect(
      (await listCreditTransfers({ account_id: recipient })).pending_approvals,
    ).toEqual([]);
    expect(await balance(sender)).toBe(100);
    expect(await balance(recipient)).toBe(0);
    const playwright = require(
      require.resolve("playwright-core", {
        paths: [resolve(__dirname, "../../../cli/node_modules")],
      }),
    );
    browser = await playwright.chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--no-proxy-server"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(proposal.approval_url);
    await page
      .getByRole("textbox", { name: "Account email" })
      .fill(`${sender}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Sign In", exact: true })
      .press("Enter");
    await page
      .getByRole("heading", { name: "Approve Credit Transfer", exact: true })
      .waitFor();
    expect(await page.locator("main").innerText()).toContain(
      `${recipient}@example.test`,
    );
    expect(await page.locator("main").innerText()).toContain("USD 40.00");
    // The displayed preview cannot authorize funds which ceased to be cleared.
    mockPayments.get(payment.payment).latest_charge.balance_transaction.status =
      "pending";
    await page
      .getByRole("button", { name: "Approve Funding", exact: true })
      .press("Enter");
    await page
      .getByRole("heading", {
        name: "Financial Approval Unavailable",
        exact: true,
      })
      .waitFor();
    expect(await balance(sender)).toBe(100);
    expect(
      (await getCreditTransferStatus({ account_id: sender, operation_id }))
        .state,
    ).toBe("approval_required");
    mockPayments.get(payment.payment).latest_charge.balance_transaction.status =
      "available";
    await page.goto(proposal.approval_url);
    await page
      .getByRole("button", { name: "Approve Funding", exact: true })
      .press("Enter");
    await page.waitForLoadState("networkidle");
    const status = await getCreditTransferStatus({
      account_id: sender,
      operation_id,
    });
    expect(status.state).toBe("received");
    expect(
      (await listCreditTransfers({ account_id: sender })).pending_approvals,
    ).toEqual([]);
    expect(await balance(sender)).toBe(60);
    expect(await balance(recipient)).toBe(40);
    expect(
      (await listCreditTransfers({ account_id: sender })).receipts,
    ).toEqual([
      expect.objectContaining({ direction: "sent", state: "received" }),
    ]);
    expect(
      (await listCreditTransfers({ account_id: recipient })).receipts,
    ).toEqual([
      expect.objectContaining({ direction: "received", state: "received" }),
    ]);
    await proposeCreditTransfer({
      account_id: sender,
      operation_id,
      terms: preview.terms,
    });
    expect(await balance(sender)).toBe(60);
    expect(
      await page
        .getByRole("button", { name: "Approve Funding", exact: true })
        .count(),
    ).toBe(0);
    const { rows } = await getPool().query(
      "SELECT approved_session_hash,result FROM course_funding_approval_intents WHERE payer_account_id=$1 AND operation_id=$2",
      [sender, operation_id],
    );
    expect(rows[0].approved_session_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].result.receipt.transfer_id).toBe(
      status.receipt!.transfer_id,
    );
  } finally {
    await browser?.close();
    await stopCourseFundingApprovalService();
    for (const [key, value] of Object.entries(original)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60000);
it("commits same-bay debit, credit, provenance and two notification receipts once", async () => {
  const sender = await account();
  const recipient = await account();
  await credit(sender);
  const prepared = await prepare(sender, recipient);
  const operation = randomUUID();
  const first = await apply(prepared, operation);
  const second = await apply(prepared, operation);
  expect(second.transfer_id).toBe(first.transfer_id);
  expect(first.state).toBe("received");
  expect(await balance(sender)).toBe(60);
  expect(await balance(recipient)).toBe(40);
  const { rows } = await getPool().query(
    "SELECT * FROM credit_transfer_entries WHERE transfer_id=$1",
    [first.transfer_id],
  );
  expect(rows).toHaveLength(2);
  const { rows: notifications } = await getPool().query(
    "SELECT * FROM notification_targets WHERE dedupe_key LIKE $1",
    [`credit-transfer:${first.transfer_id}:%`],
  );
  expect(notifications).toHaveLength(2);
  await expect(
    apply(await prepare(sender, recipient, "41"), operation),
  ).rejects.toThrow("different terms");
});
it("excludes promotional, spent, held, pending and refunded payments", async () => {
  const sender = await account();
  const recipient = await account();
  const payment = await credit(sender);
  await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,90,'membership',now()),($1,-100,'credit',now())",
    [sender],
  );
  await expect(apply(await prepare(sender, recipient, "11"))).rejects.toThrow(
    "Insufficient",
  );
  mockPayments.get(payment.payment).latest_charge.balance_transaction.status =
    "pending";
  await expect(apply(await prepare(sender, recipient, "1"))).rejects.toThrow(
    "Insufficient",
  );
  mockPayments.get(payment.payment).latest_charge.balance_transaction.status =
    "available";
  mockPayments.get(payment.payment).latest_charge.amount_refunded = 1;
  await expect(apply(await prepare(sender, recipient, "1"))).rejects.toThrow(
    "Insufficient",
  );
  mockPayments.get(payment.payment).latest_charge.amount_refunded = 0;
  await getPool().query(
    "INSERT INTO account_funding_holds (id,payer_account_id,source_kind,source_id,lane,authorized_usd,remaining_usd) VALUES ($1,$2,'course-pool',$3,'prepaid',110,110)",
    [randomUUID(), sender, randomUUID()],
  );
  await expect(apply(await prepare(sender, recipient, "1"))).rejects.toThrow(
    "Insufficient",
  );
});
it("retains original payment roots on retransfer and blocks provider refunds", async () => {
  const sender = await account();
  const recipient = await account();
  const third = await account();
  const payment = await credit(sender);
  await apply(await prepare(sender, recipient, "40"));
  await apply(await prepare(recipient, third, "30"));
  const lots = await withCreditTransferAccounts([third], (db) =>
    readCreditLots(db, third),
  );
  expect(lots[0].root.account_id).toBe(sender);
  expect(lots[0].root.purchase_id).toBe(payment.id);
  await expect(
    withCreditTransferAccounts([sender], (db) =>
      assertPaymentRootNotExported(db, sender, payment.id),
    ),
  ).rejects.toThrow("transfer chain");
});
it("keeps sender debit pending across a lost cross-bay acknowledgment", async () => {
  const sender = await account();
  const recipient = await account("remote");
  await credit(sender);
  const receipt = await apply(await prepare(sender, recipient, "40"));
  const manifest = await getOutgoingCreditTransferLocal(
    sender,
    receipt.transfer_id,
  );
  expect(await balance(recipient)).toBe(0);
  expect(receipt.state).toBe("pending");
  await expect(
    reconcileCreditTransfer(manifest, {
      ...transport,
      deliver: async (bay, value) => {
        await transport.deliver(bay, value);
        throw Error("lost ack");
      },
    }),
  ).rejects.toThrow("lost ack");
  expect(await balance(sender)).toBe(60);
  expect(await balance(recipient)).toBe(40);
  await reconcileCreditTransfer(manifest, transport);
  await reconcileCreditTransfer(manifest, transport);
  expect(await balance(sender)).toBe(60);
  expect(await balance(recipient)).toBe(40);
});
it("requires a durable receiver rejection fence before sender compensation", async () => {
  const sender = await account();
  const recipient = await account("remote");
  await credit(sender);
  const receipt = await apply(await prepare(sender, recipient, "40"));
  const manifest = await getOutgoingCreditTransferLocal(
    sender,
    receipt.transfer_id,
  );
  await getPool().query(
    "UPDATE accounts SET email_address_verified='{}'::jsonb WHERE account_id=$1",
    [recipient],
  );
  await reconcileCreditTransfer(manifest, transport);
  await reconcileCreditTransfer(manifest, transport);
  expect(await balance(sender)).toBe(100);
  expect(await balance(recipient)).toBe(0);
  await getPool().query(
    "UPDATE accounts SET email_address_verified=jsonb_build_object(email_address,1) WHERE account_id=$1",
    [recipient],
  );
  expect((await transport.deliver("remote", manifest)).state).toBe("rejected");
  expect(await balance(recipient)).toBe(0);
});
it("rejects a forged preflight and wrong-bay caller", async () => {
  const sender = await account();
  const recipient = await account();
  await expect(
    withCreditTransferApprovalTransaction(
      {
        payer_account_id: sender,
        terms: {} as any,
        verified: [],
        checked_at: Date.now(),
      },
      async () => null,
    ),
  ).rejects.toThrow("trusted");
  await expect(
    onBay("remote", () => getCreditTransferRecipientLocal(recipient)),
  ).rejects.toThrow("homed");
});
const postgresTest = process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
it.each(["deleted", "moved"])(
  "durably rejects a recipient who is %s before delivery",
  async (kind) => {
    const sender = await account();
    const recipient = await account("remote");
    await credit(sender);
    const receipt = await apply(await prepare(sender, recipient, "40"));
    const manifest = await getOutgoingCreditTransferLocal(
      sender,
      receipt.transfer_id,
    );
    if (kind === "deleted")
      await getPool().query(
        "UPDATE accounts SET deleted=true WHERE account_id=$1",
        [recipient],
      );
    else {
      await getPool().query(
        "UPDATE accounts SET home_bay_id='other' WHERE account_id=$1",
        [recipient],
      );
      mockHomes.set(recipient, "other");
    }
    await reconcileCreditTransfer(manifest, transport);
    expect(await balance(sender)).toBe(100);
    expect(await balance(recipient)).toBe(0);
    expect(
      (await transport.deliver(mockHomes.get(recipient)!, manifest)).state,
    ).toBe("rejected");
  },
);
it("never converts a received fence into rejection after recipient deletion", async () => {
  const sender = await account();
  const recipient = await account("remote");
  await credit(sender);
  const receipt = await apply(await prepare(sender, recipient, "40"));
  const manifest = await getOutgoingCreditTransferLocal(
    sender,
    receipt.transfer_id,
  );
  await transport.deliver("remote", manifest);
  await getPool().query(
    "UPDATE accounts SET deleted=true WHERE account_id=$1",
    [recipient],
  );
  await reconcileCreditTransfer(manifest, transport);
  expect(await balance(sender)).toBe(60);
  expect(await balance(recipient)).toBe(40);
});
it("keeps a frozen recipient pending instead of authorizing compensation", async () => {
  const sender = await account();
  const recipient = await account("remote");
  await credit(sender);
  const receipt = await apply(await prepare(sender, recipient, "40"));
  const manifest = await getOutgoingCreditTransferLocal(
    sender,
    receipt.transfer_id,
  );
  await getPool().query(
    "UPDATE account_funding_authorities SET state='frozen' WHERE payer_account_id=$1",
    [recipient],
  );
  await expect(reconcileCreditTransfer(manifest, transport)).rejects.toThrow(
    "delivery remains pending",
  );
  expect(await balance(sender)).toBe(60);
  expect(
    (
      await getPool().query(
        "SELECT 1 FROM credit_transfer_deliveries WHERE transfer_id=$1",
        [receipt.transfer_id],
      )
    ).rows,
  ).toHaveLength(0);
  await getPool().query(
    "UPDATE account_funding_authorities SET state='active' WHERE payer_account_id=$1",
    [recipient],
  );
  await reconcileCreditTransfer(manifest, transport);
  expect(await balance(recipient)).toBe(40);
});
it("does not restore eligibility when an observed debit is later reduced", async () => {
  const sender = await account();
  const recipient = await account();
  await credit(sender);
  const {
    rows: [debit],
  } = await getPool().query(
    "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,80,'membership',now()) RETURNING id",
    [sender],
  );
  await apply(await prepare(sender, recipient, "10"));
  await getPool().query("UPDATE purchases SET cost=1 WHERE id=$1", [debit.id]);
  await expect(apply(await prepare(sender, recipient, "11"))).rejects.toThrow(
    "Insufficient",
  );
});
it("refuses unbounded ongoing liability rather than treating it as free credit", async () => {
  const sender = await account();
  const recipient = await account();
  await credit(sender);
  await getPool().query(
    "INSERT INTO purchases (account_id,service,time,period_start,cost_per_hour) VALUES ($1,'dedicated-host',now(),now(),10)",
    [sender],
  );
  await expect(apply(await prepare(sender, recipient, "1"))).rejects.toThrow(
    "unbounded",
  );
});
it.each([
  "customer",
  "site",
  "purpose",
  "amount",
  "dispute",
  "review",
  "clearing",
  "currency",
])("requires strict provider provenance: %s", async (kind) => {
  const sender = await account();
  const payment = await credit(sender);
  const pi = mockPayments.get(payment.payment);
  if (kind === "customer") pi.customer = "cus_other";
  if (kind === "site") pi.metadata.cocalc_site = "other-site";
  if (kind === "purpose") pi.metadata.purpose = "membership-package-purchase";
  if (kind === "amount") pi.metadata.total_excluding_tax_usd = "1";
  if (kind === "dispute") pi.latest_charge.disputed = true;
  if (kind === "review") pi.latest_charge.review = "pr_review";
  if (kind === "clearing")
    pi.latest_charge.balance_transaction.available_on =
      Date.now() / 1000 + 3600;
  if (kind === "currency")
    pi.latest_charge.balance_transaction.currency = "eur";
  expect(await verifyPaymentPurchase(sender, payment.id)).toBeUndefined();
});
postgresTest(
  "serializes simultaneous outgoing transfers under the ordinary spending lock",
  async () => {
    const sender = await account();
    const a = await account();
    const b = await account();
    await credit(sender);
    const p1 = await prepare(sender, a, "70");
    const p2 = await prepare(sender, b, "70");
    const results = await Promise.allSettled([apply(p1), apply(p2)]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await balance(sender)).toBe(30);
  },
);
