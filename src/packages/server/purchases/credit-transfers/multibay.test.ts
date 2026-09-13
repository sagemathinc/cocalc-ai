/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema";
import { before, after, client as fabric } from "@cocalc/server/test";
import { createServiceHandler } from "@cocalc/conat/service/typed";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
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
import {
  exportCreditTransferStateInTransaction,
  importCreditTransferStateInTransaction,
} from "./portability";
import { assertPaymentRootNotExported } from "./ledger";
import { getPendingCreditTransferManifests } from "./worker";
import {
  rehomeAccountOnHomeBay,
  runAccountRehomeOperation,
  acceptAccountRehome,
  copyAccountRehomeState,
  getAccountRehomeOperation,
} from "@cocalc/server/accounts/rehome";
import {
  activateAccountFinancialState,
  getAccountFinancialHandoff,
  ensureFinancialRehomeSchema,
} from "@cocalc/server/accounts/financial-rehome";
import { withFundingAccountTransaction } from "@cocalc/server/compute/funding/backing";
import { createCourseFundingPoolInTransaction } from "@cocalc/server/compute/funding/pools";
import {
  reserveComputeVmFundingLocal,
  checkComputeVmFundingLocal,
} from "@cocalc/server/compute/funding/vm-reservations";
import { settleComputeVmFundingLocal } from "@cocalc/server/compute/funding/vm-settlement";
import { getAccountFundingHolds } from "../get-spendable-balance";
import { recordProviderRefundResult } from "../provider-refund-attempts";
import { localPaymentSubscriptionId } from "../payment-local-reference";
import { claimDueSubscriptionRenewalAttempts } from "../subscription-renewal-attempts";

const mockPools = new Map<string, Pool>();
const mockHomes = new Map<string, string>();
const mockPayments = new Map<string, any>();
jest.mock("@cocalc/server/project-host/admission", () =>
  require("@cocalc/server/compute/funding/__tests__/policy-source").mockPolicySource(),
);
jest.mock("@cocalc/database/pool", () => {
  // Lazy exports avoid the pool/schema synchronization import cycle.
  return new Proxy(
    { __esModule: true },
    {
      get: (_target, key) => {
        if (key === "__esModule") return true;
        if (key === "default")
          return (...args) =>
            mockPools.get(process.env.COCALC_BAY_ID ?? "") ??
            jest.requireActual("@cocalc/database/pool").default(...args);
        if (key === "getClient")
          return () => {
            const pool = mockPools.get(process.env.COCALC_BAY_ID ?? "");
            return pool
              ? new (require("pg").Client)((pool as any).options)
              : jest.requireActual("@cocalc/database/pool").getClient();
          };
        if (key === "getTransactionClient")
          return async () => {
            const pool = mockPools.get(process.env.COCALC_BAY_ID ?? "");
            if (!pool)
              return jest
                .requireActual("@cocalc/database/pool")
                .getTransactionClient();
            const client = await pool.connect();
            await client.query("BEGIN");
            return client;
          };
        return jest.requireActual("@cocalc/database/pool")[key];
      },
    },
  );
});
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async ({ account_id }) => ({
    home_bay_id: mockHomes.get(account_id),
  }),
  listConfiguredBays: async () =>
    ["transfer-a", "transfer-b", "transfer-c"].map((bay_id) => ({ bay_id })),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: async (account_id) => ({
    account_id,
    home_bay_id: mockHomes.get(account_id),
  }),
  updateClusterAccountHomeBay: async ({ account_id, home_bay_id }) => {
    mockHomes.set(account_id, home_bay_id);
  },
  updateClusterAccountApiKeysHomeBay: async () => {},
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => require("@cocalc/server/test").client,
}));
jest.mock("@cocalc/server/accounts/persist-portability", () => ({
  loadAccountPersistState: async () => [],
  restoreAccountPersistState: async () => {},
  clearAccountPersistState: async () => {},
}));
jest.mock("@cocalc/server/conat/api/browser-sessions", () => ({
  listBrowserSessionsForAccount: async () => [],
}));
jest.mock("@cocalc/server/bay-registry", () => ({
  listClusterBayRegistry: async () =>
    ["transfer-a", "transfer-b", "transfer-c"].map((bay_id) => ({ bay_id })),
}));
jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: async () => ({
    paymentIntents: { retrieve: async (id) => mockPayments.get(id) },
  }),
}));
jest.mock("../stripe/util", () => ({
  currentStripeSite: async () =>
    `transfer-multibay-test:${process.env.COCALC_BAY_ID}`,
}));

// Calls are sequential: real Conat handlers enter the destination context and
// restore it before replying. Each context has a separate PostgreSQL database.
async function onBay<T>(bay: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.COCALC_BAY_ID;
  process.env.COCALC_BAY_ID = bay;
  try {
    return await fn();
  } finally {
    if (old == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = old;
  }
}
const remote = (bay: string) =>
  createInterBayAccountLocalClient({
    client: fabric,
    dest_bay: bay,
    timeout: 5000,
  });
const transport: CreditTransferTransport = {
  recipient: (bay, account_id) =>
    remote(bay).creditTransferRecipient({ account_id }),
  verifyRoot: (bay, account_id, purchase_id, root_id) =>
    remote(bay).creditTransferVerifyRoot({ account_id, purchase_id, root_id }),
  outgoing: (bay, account_id, transfer_id) =>
    remote(bay).creditTransferOutgoing({ account_id, transfer_id }),
  deliver: (bay, opts) =>
    remote(bay).creditTransferDeliver({
      sender_home_bay_id: opts.sender_home_bay_id,
      sender_account_id: opts.sender_account_id,
      transfer_id: opts.transfer_id,
    }),
};

const describePg =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe.skip : describe;
describePg(
  "credit transfers across independent bay databases and Conat",
  () => {
    const skipEnsure = process.env.COCALC_DB_SKIP_ENSURE_EXISTS;
    const names: string[] = [];
    const handlers: ReturnType<typeof createServiceHandler>[] = [];
    let admin: Pool;
    beforeAll(async () => {
      process.env.COCALC_DB_SKIP_ENSURE_EXISTS = "1";
      await before();
      const source = getPool();
      const options = (source as any).options;
      if (options.database !== "smc_ephemeral_testing_database")
        throw Error("Requires the ephemeral test database");
      admin = new Pool({ ...options, database: "postgres" });
      await source.end();
      for (const bay of ["transfer-a", "transfer-b", "transfer-c"]) {
        const database = `transfer_test_${randomUUID().replace(/-/g, "")}`;
        await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
        names.push(database);
        const pool = new Pool({ ...options, database, max: 4 });
        mockPools.set(bay, pool);
        await onBay(bay, () => syncSchema());
        const service = createServiceHandler({
          client: fabric,
          service: "inter-bay-account-local",
          subject: `bay.${bay}.rpc.account-local.credit-transfers`,
          impl: {
            creditTransferRecipient: ({ account_id }) =>
              onBay(bay, () => getCreditTransferRecipientLocal(account_id)),
            creditTransferVerifyRoot: ({ account_id, purchase_id, root_id }) =>
              onBay(bay, () =>
                verifyPaymentPurchase(account_id, purchase_id, root_id),
              ),
            creditTransferOutgoing: ({ account_id, transfer_id }) =>
              onBay(bay, () =>
                getOutgoingCreditTransferLocal(account_id, transfer_id),
              ),
            creditTransferDeliver: (opts) =>
              onBay(bay, () => deliverCreditTransferLocal(opts, transport)),
          },
        });
        handlers.push(service);
      }
    }, 60000);
    afterAll(async () => {
      for (const handler of handlers) handler.close();
      for (const pool of mockPools.values()) await pool.end();
      mockPools.clear();
      for (const name of names) await admin.query(`DROP DATABASE "${name}"`);
      await admin?.end();
      await after();
      if (skipEnsure == null) delete process.env.COCALC_DB_SKIP_ENSURE_EXISTS;
      else process.env.COCALC_DB_SKIP_ENSURE_EXISTS = skipEnsure;
    }, 60000);

    async function account(bay: string) {
      const id = randomUUID();
      const email = `${id}@example.test`;
      await mockPools
        .get(bay)!
        .query(
          "INSERT INTO accounts (account_id,home_bay_id,email_address,email_address_verified,stripe_customer_id) VALUES ($1,$2,$3,$4,$5)",
          [id, bay, email, { [email]: Date.now() }, `cus_${id}`],
        );
      mockHomes.set(id, bay);
      return id;
    }
    async function paidCredit(id: string) {
      const payment = `pi_${randomUUID()}`;
      const { rows } = await mockPools
        .get(mockHomes.get(id)!)!
        .query(
          "INSERT INTO purchases (account_id,cost,service,time,invoice_id,description) VALUES ($1,-100,'credit',now(),$2,$3) RETURNING id",
          [id, payment, { type: "credit", purpose: "add-credit" }],
        );
      mockPayments.set(payment, {
        id: payment,
        status: "succeeded",
        currency: "usd",
        customer: `cus_${id}`,
        amount_received: 10000,
        metadata: {
          account_id: id,
          cocalc_site: `transfer-multibay-test:${mockHomes.get(id)}`,
          purpose: "add-credit",
          total_excluding_tax_usd: "10000",
        },
        latest_charge: {
          id: `ch_${payment}`,
          currency: "usd",
          customer: `cus_${id}`,
          payment_intent: payment,
          status: "succeeded",
          paid: true,
          captured: true,
          disputed: false,
          refunded: false,
          amount_refunded: 0,
          amount_captured: 10000,
          balance_transaction: {
            id: `txn_${payment}`,
            currency: "usd",
            status: "available",
            available_on: 1,
            source: `ch_${payment}`,
            amount: 10000,
          },
        },
      });
      return { purchase_id: rows[0].id, payment };
    }
    async function send(sender: string, recipient: string, amount_usd: string) {
      return onBay(mockHomes.get(sender)!, async () => {
        const identity = await transport.recipient(
          mockHomes.get(recipient)!,
          recipient,
        );
        const terms = {
          recipient: identity,
          currency: "USD" as const,
          amount_usd,
        };
        const prepared = await prepareCreditTransferApproval(
          { payer_account_id: sender, terms },
          transport,
        );
        const receipt = await withCreditTransferApprovalTransaction(
          prepared,
          (db) =>
            applyCreditTransferInTransaction(
              {
                db,
                payer_account_id: sender,
                operation_id: randomUUID(),
                intent_id: randomUUID(),
                terms,
              },
              prepared,
            ),
        );
        return getOutgoingCreditTransferLocal(sender, receipt.transfer_id);
      });
    }
    async function balance(account_id: string) {
      const { rows } = await mockPools
        .get(mockHomes.get(account_id)!)!
        .query(
          "SELECT -coalesce(sum(cost),0) AS balance FROM purchases WHERE account_id=$1",
          [account_id],
        );
      return Number(rows[0].balance);
    }

    it("conserves paid provenance with colliding ledger IDs, lost ack and a third-bay retransfer", async () => {
      const sender = await account("transfer-a");
      const recipient = await account("transfer-b");
      const third = await account("transfer-c");
      const root = await paidCredit(sender);
      const manifest = await send(sender, recipient, "40");
      await expect(
        onBay("transfer-a", () =>
          reconcileCreditTransfer(manifest, {
            ...transport,
            deliver: async (bay, opts) => {
              await transport.deliver(bay, opts);
              throw Error("lost receiving-bay acknowledgment");
            },
          }),
        ),
      ).rejects.toThrow("lost receiving-bay");
      expect(await balance(sender)).toBe(60);
      expect(await balance(recipient)).toBe(40);
      expect(
        (
          await mockPools
            .get("transfer-a")!
            .query("SELECT state FROM credit_transfers WHERE transfer_id=$1", [
              manifest.transfer_id,
            ])
        ).rows[0].state,
      ).toBe("pending");
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      const received = await mockPools
        .get("transfer-b")!
        .query(
          "SELECT purchase_id FROM credit_transfer_entries WHERE account_id=$1",
          [recipient],
        );
      expect(received.rows[0].purchase_id).toBe(root.purchase_id);
      const next = await send(recipient, third, "30");
      expect(next.fragments[0].root.account_id).toBe(sender);
      expect(next.fragments[0].root.home_bay_id).toBe("transfer-a");
      expect(next.fragments[0].root.purchase_id).toBe(root.purchase_id);
      await onBay("transfer-b", () => reconcileCreditTransfer(next, transport));
      expect([
        await balance(sender),
        await balance(recipient),
        await balance(third),
      ]).toEqual([60, 10, 30]);
      mockPayments.get(root.payment).latest_charge.disputed = true;
      await expect(send(third, sender, "1")).rejects.toThrow("Insufficient");
      for (const [bay, forbidden] of [
        ["transfer-a", recipient],
        ["transfer-b", third],
        ["transfer-c", sender],
      ]) {
        expect(
          (
            await mockPools
              .get(bay)!
              .query("SELECT 1 FROM purchases WHERE account_id=$1", [forbidden])
          ).rows,
        ).toHaveLength(0);
      }
    }, 60000);

    it("compensates once only after the independent recipient persists a rejection fence", async () => {
      const sender = await account("transfer-a");
      const recipient = await account("transfer-b");
      await paidCredit(sender);
      const manifest = await send(sender, recipient, "40");
      await mockPools
        .get("transfer-b")!
        .query("UPDATE accounts SET deleted=true WHERE account_id=$1", [
          recipient,
        ]);
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      expect(await balance(sender)).toBe(100);
      expect(await balance(recipient)).toBe(0);
      expect(
        (
          await mockPools
            .get("transfer-a")!
            .query(
              "SELECT 1 FROM credit_transfer_entries WHERE transfer_id=$1 AND leg='compensation'",
              [manifest.transfer_id],
            )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await mockPools
            .get("transfer-b")!
            .query(
              "SELECT state FROM credit_transfer_deliveries WHERE transfer_id=$1",
              [manifest.transfer_id],
            )
        ).rows[0].state,
      ).toBe("rejected");
      await mockPools
        .get("transfer-b")!
        .query("UPDATE accounts SET deleted=false WHERE account_id=$1", [
          recipient,
        ]);
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      expect(await balance(recipient)).toBe(0);
    }, 60000);

    async function moveParticipant(sender: string, from: string, to: string) {
      const snapshot = await onBay(from, () =>
        withCreditTransferAccounts([sender], async (db) => {
          await db.query(
            "UPDATE account_funding_authorities SET state='frozen' WHERE payer_account_id=$1",
            [sender],
          );
          return exportCreditTransferStateInTransaction(db, sender);
        }),
      );
      const source = mockPools.get(from)!;
      const {
        rows: [accountRow],
      } = await source.query("SELECT * FROM accounts WHERE account_id=$1", [
        sender,
      ]);
      const { rows: purchases } = await source.query(
        "SELECT * FROM purchases WHERE account_id=$1 ORDER BY id",
        [sender],
      );
      const purchase_ids: Record<string, number> = {};
      await onBay(to, async () => {
        const db = await getPool().connect();
        try {
          await db.query("BEGIN");
          // Simulate the coordinator's complete ledger copy and frozen successor.
          // This test does not claim the account-rehome state machine is wired.
          await db.query(
            "INSERT INTO accounts (account_id,home_bay_id,email_address,email_address_verified,stripe_customer_id) VALUES ($1,$5,$2,$3,$4)",
            [
              sender,
              accountRow.email_address,
              accountRow.email_address_verified,
              accountRow.stripe_customer_id,
              to,
            ],
          );
          await db.query(
            "INSERT INTO account_funding_authorities (payer_account_id,epoch,home_bay_id,state) VALUES ($1,$2,$3,'frozen')",
            [sender, randomUUID(), to],
          );
          await db.query(
            "SELECT setval(pg_get_serial_sequence('purchases','id'),(SELECT COALESCE(max(id),1)+1000 FROM purchases))",
          );
          for (const purchase of purchases) {
            const {
              rows: [row],
            } = await db.query(
              "INSERT INTO purchases (account_id,cost,service,time,invoice_id,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
              [
                sender,
                purchase.cost,
                purchase.service,
                purchase.time,
                purchase.invoice_id,
                purchase.description,
              ],
            );
            purchase_ids[purchase.id] = row.id;
          }
          if (purchases.length > 1) {
            const reversed = {
              ...purchase_ids,
              [purchases[0].id]: purchase_ids[purchases[1].id],
              [purchases[1].id]: purchase_ids[purchases[0].id],
            };
            await expect(
              importCreditTransferStateInTransaction(db, {
                account_id: sender,
                state: snapshot,
                purchase_ids: reversed,
              }),
            ).rejects.toThrow("posting order");
          }
          await importCreditTransferStateInTransaction(db, {
            account_id: sender,
            state: snapshot,
            purchase_ids,
          });
          await importCreditTransferStateInTransaction(db, {
            account_id: sender,
            state: snapshot,
            purchase_ids,
          });
          await db.query(
            "UPDATE account_funding_authorities SET state='active' WHERE payer_account_id=$1",
            [sender],
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
      });
      await source.query(
        "UPDATE account_funding_authorities SET state='retired' WHERE payer_account_id=$1",
        [sender],
      );
      await source.query(
        "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
        [sender, to],
      );
      mockHomes.set(sender, to);
      return { snapshot, purchase_ids };
    }

    it("moves the transfer participant with remapped purchases and an in-flight sender outbox", async () => {
      const sender = await account("transfer-a");
      const recipient = await account("transfer-b");
      const third = await account("transfer-c");
      const root = await paidCredit(sender);
      const manifest = await send(sender, recipient, "40");
      const { snapshot, purchase_ids } = await moveParticipant(
        sender,
        "transfer-a",
        "transfer-c",
      );
      expect(purchase_ids[root.purchase_id]).not.toBe(root.purchase_id);
      expect(
        (await onBay("transfer-a", getPendingCreditTransferManifests)).some(
          (m) => m.transfer_id === manifest.transfer_id,
        ),
      ).toBe(false);
      expect(
        (await onBay("transfer-c", getPendingCreditTransferManifests)).some(
          (m) => m.transfer_id === manifest.transfer_id,
        ),
      ).toBe(true);
      await expect(
        onBay("transfer-a", () => reconcileCreditTransfer(manifest, transport)),
      ).rejects.toThrow("sender home authority");
      await onBay("transfer-c", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      const next = await send(recipient, third, "25");
      expect(next.fragments[0].root).toEqual(manifest.fragments[0].root);
      await onBay("transfer-b", () => reconcileCreditTransfer(next, transport));
      expect([
        await balance(sender),
        await balance(recipient),
        await balance(third),
      ]).toEqual([60, 15, 25]);
      const afterMove = await send(sender, recipient, "1");
      expect(afterMove.fragments[0].root).toEqual(manifest.fragments[0].root);
      await onBay("transfer-c", () =>
        reconcileCreditTransfer(afterMove, transport),
      );
      await expect(
        onBay("transfer-c", () =>
          withCreditTransferAccounts([sender], (db) =>
            assertPaymentRootNotExported(
              db,
              sender,
              purchase_ids[root.purchase_id],
            ),
          ),
        ),
      ).rejects.toThrow("transfer chain");
      await expect(
        onBay("transfer-c", () =>
          withCreditTransferAccounts([sender], (db) =>
            importCreditTransferStateInTransaction(db, {
              account_id: sender,
              state: snapshot,
              purchase_ids,
            }),
          ),
        ),
      ).rejects.toThrow("frozen local");
    }, 60000);

    it("retains the original receiver fence when its credited account moves before acknowledgment", async () => {
      const sender = await account("transfer-a");
      const recipient = await account("transfer-b");
      await paidCredit(sender);
      const manifest = await send(sender, recipient, "40");
      await transport.deliver("transfer-b", manifest);
      await moveParticipant(recipient, "transfer-b", "transfer-c");
      // A restored old bay lacking its receipt must not mint a credit/rejection.
      await mockPools
        .get("transfer-b")!
        .query("DELETE FROM credit_transfer_deliveries WHERE transfer_id=$1", [
          manifest.transfer_id,
        ]);
      await mockPools
        .get("transfer-b")!
        .query(
          "UPDATE accounts SET home_bay_id='transfer-b' WHERE account_id=$1",
          [recipient],
        );
      await mockPools
        .get("transfer-b")!
        .query(
          "UPDATE account_funding_authorities SET state='active' WHERE payer_account_id=$1",
          [recipient],
        );
      await expect(transport.deliver("transfer-b", manifest)).rejects.toThrow(
        "recipient routing changed",
      );
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      await onBay("transfer-a", () =>
        reconcileCreditTransfer(manifest, transport),
      );
      expect([await balance(sender), await balance(recipient)]).toEqual([
        60, 40,
      ]);
      const returned = await send(recipient, sender, "10");
      await onBay("transfer-c", () =>
        reconcileCreditTransfer(returned, transport),
      );
      expect([await balance(sender), await balance(recipient)]).toEqual([
        70, 30,
      ]);
    }, 60000);

    it("preserves NUMERIC high-water observations exactly during portability", async () => {
      const sender = await account("transfer-a");
      const cost = "1000000000.1234567891";
      await onBay("transfer-a", () =>
        withCreditTransferAccounts([sender], async (db) => {
          const {
            rows: [purchase],
          } = await db.query(
            "INSERT INTO purchases (account_id,cost,service,time) VALUES ($1,$2,'membership',now()) RETURNING id",
            [sender, cost],
          );
          await db.query(
            "INSERT INTO credit_transfer_ledger_observations (account_id,purchase_id,max_cost) VALUES ($1,$2,$3)",
            [sender, purchase.id, cost],
          );
        }),
      );
      const { snapshot } = await moveParticipant(
        sender,
        "transfer-a",
        "transfer-c",
      );
      expect(
        snapshot.rows.credit_transfer_ledger_observations[0].max_cost,
      ).toBe(cost);
      const {
        rows: [observation],
      } = await mockPools
        .get("transfer-c")!
        .query(
          "SELECT max_cost::text FROM credit_transfer_ledger_observations WHERE account_id=$1",
          [sender],
        );
      expect(observation.max_cost).toBe(cost);
    }, 60000);

    it("runs the actual account coordinator with frozen copy, lost copy/activation acknowledgments and pending transfers", async () => {
      const oldFlag = process.env.COCALC_ENABLE_FINANCIAL_REHOME;
      process.env.COCALC_ENABLE_FINANCIAL_REHOME = "yes";
      let loseCopy = true;
      let loseActivation = true;
      for (const bay of ["transfer-a", "transfer-b", "transfer-c"]) {
        for (const [method, impl] of Object.entries({
          "accept-rehome": {
            acceptRehome: (opts) => onBay(bay, () => acceptAccountRehome(opts)),
          },
          "copy-rehome-state": {
            copyRehomeState: (opts) =>
              onBay(bay, async () => {
                await copyAccountRehomeState(opts);
                if (loseCopy) {
                  loseCopy = false;
                  throw Error("lost financial copy acknowledgment");
                }
              }),
          },
          "get-rehome-operation": {
            getRehomeOperation: (opts) =>
              onBay(bay, () => getAccountRehomeOperation(opts.op_id)),
          },
          "activate-financial-rehome": {
            activateFinancialRehome: (opts) =>
              onBay(bay, async () => {
                await activateAccountFinancialState(opts);
                if (loseActivation) {
                  loseActivation = false;
                  throw Error("lost financial activation acknowledgment");
                }
              }),
          },
        }))
          handlers.push(
            createServiceHandler({
              client: fabric,
              service: "inter-bay-account-local",
              subject: `bay.${bay}.rpc.account-local.${method}`,
              impl,
            }),
          );
      }
      try {
        const payer = await account("transfer-a");
        const recipient = await account("transfer-b");
        const paid = await paidCredit(payer);
        const manifest = await send(payer, recipient, "30");
        const source = mockPools.get("transfer-a")!;
        const dest = mockPools.get("transfer-c")!;
        await onBay("transfer-a", ensureFinancialRehomeSchema);
        const bindings = await onBay("transfer-a", async () => {
          const result: Awaited<
            ReturnType<typeof reserveComputeVmFundingLocal>
          >[] = [];
          for (const lane of ["prepaid", "postpaid"] as const) {
            const allocation = await withFundingAccountTransaction(
              payer,
              (db) =>
                createCourseFundingPoolInTransaction(db, {
                  payer_account_id: payer,
                  operation_id: randomUUID(),
                  terms: {
                    course_project_id: randomUUID(),
                    course_instance_id: randomUUID(),
                    currency: "USD",
                    lane,
                    amount_usd: "20",
                    allow_overcommit: false,
                    starts_at: new Date(Date.now() - 1000).toISOString(),
                    ends_at: new Date(Date.now() + 86400000).toISOString(),
                    recipients: [
                      { beneficiary_account_id: recipient, amount_usd: "20" },
                    ],
                  },
                }),
            );
            const binding = await reserveComputeVmFundingLocal({
              account_id: payer,
              source: {
                kind: "course",
                payer_account_id: payer,
                pool_id: allocation.pool.id,
                grant_id: allocation.grants[0].id,
              },
              resource_id: randomUUID(),
              resource_generation: 1,
              funding_epoch: randomUUID(),
              owner_account_id: recipient,
              owning_bay_id: "transfer-b",
              provider: "nebius",
              hourly_cost_usd: "6",
              storage_hourly_cost_usd: "0.01",
              pricing_snapshot: { provider: "nebius" },
              requested_until: new Date(Date.now() + 25 * 60000).toISOString(),
            });
            await source.query(
              "UPDATE compute_funding_reservations SET dispatched_at=now()-interval '2 minutes',state='consuming' WHERE id=$1",
              [binding.reservation_id],
            );
            result.push(binding);
          }
          return result;
        });
        const {
          rows: [extra],
        } = await source.query(
          "INSERT INTO purchases(account_id,cost,service,time,invoice_id,description) VALUES($1,-10,'credit',now(),$2,'{}') RETURNING id",
          [payer, `pi_refund_${randomUUID()}`],
        );
        const refundId = randomUUID();
        await source.query(
          `INSERT INTO provider_refund_attempts(id,purchase_id,account_id,invoice_id,amount,request,provider_request,dispatched_at,reconcile_token,reconcile_lease_expires_at)
          SELECT $1,id,account_id,invoice_id,10,$3,$4,now(),$5,now()+interval '2 minutes' FROM purchases WHERE id=$2`,
          [
            refundId,
            extra.id,
            {
              admin_account_id: payer,
              reason: "requested_by_customer",
              notes: "",
            },
            {
              charge: "ch_uncertain",
              amount: 1000,
              metadata: { account_id: payer, purchase_id: extra.id },
            },
            randomUUID(),
          ],
        );
        const {
          rows: [oldRefund],
        } = await source.query(
          "SELECT * FROM provider_refund_attempts WHERE id=$1",
          [refundId],
        );
        const renewalId = randomUUID();
        const renewalPayment = `pi_renewal_${randomUUID()}`;
        const {
          rows: [subscription],
        } = await source.query(
          `INSERT INTO subscriptions(account_id,status,cost,interval,current_period_start,current_period_end,latest_purchase_id,metadata,payment)
          VALUES($1,'active',8,'month',now()-interval '1 month',date_trunc('milliseconds',now())-interval '1 day',$2,'{"type":"membership","class":"member"}',$3) RETURNING id,current_period_end`,
          [
            payer,
            paid.purchase_id,
            { payment_intent_id: renewalPayment, status: "processing" },
          ],
        );
        await source.query(
          `INSERT INTO subscription_renewal_attempts(id,subscription_id,account_id,period_end,target_period_end,amount,balance_applied,funding_version,state,not_before,next_attempt_at,lease_expires_at,payment_intent_id)
          VALUES($1,$2,$3,$4,$4::timestamp+interval '1 month',8,3,1,'processing',now(),now(),now()+interval '2 minutes',$5)`,
          [
            renewalId,
            subscription.id,
            payer,
            subscription.current_period_end,
            renewalPayment,
          ],
        );
        const beforeHolds = await onBay("transfer-a", () =>
          getAccountFundingHolds({ account_id: payer }),
        );
        await expect(
          onBay("transfer-a", () =>
            rehomeAccountOnHomeBay({
              account_id: payer,
              target_account_id: payer,
              dest_bay_id: "transfer-c",
            }),
          ),
        ).rejects.toThrow("lost financial copy");
        const {
          rows: [operation],
        } = await source.query(
          "SELECT * FROM account_rehome_operations WHERE account_id=$1",
          [payer],
        );
        expect(operation.status).toBe("failed");
        expect(
          (
            await source.query(
              "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1",
              [payer],
            )
          ).rows[0].state,
        ).toBe("frozen");
        expect(
          (
            await dest.query(
              "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1",
              [payer],
            )
          ).rows[0].state,
        ).toBe("frozen");
        for (const pool of [source, dest])
          await expect(
            pool.query(
              "INSERT INTO purchases(account_id,cost,service,time) VALUES($1,-1,'credit',now())",
              [payer],
            ),
          ).rejects.toThrow("frozen or retired");
        await expect(
          onBay("transfer-a", () => runAccountRehomeOperation(operation.op_id)),
        ).rejects.toThrow("lost financial activation");
        await onBay("transfer-a", () =>
          runAccountRehomeOperation(operation.op_id),
        );
        expect(mockHomes.get(payer)).toBe("transfer-c");
        expect(
          (
            await source.query(
              "SELECT state FROM account_funding_authorities WHERE payer_account_id=$1",
              [payer],
            )
          ).rows[0].state,
        ).toBe("retired");
        const h = (await onBay("transfer-a", () =>
          getAccountFinancialHandoff(operation.op_id),
        ))!;
        const {
          rows: [receipt],
        } = await dest.query(
          "SELECT id_maps,state FROM account_financial_handoffs WHERE op_id=$1",
          [operation.op_id],
        );
        expect(receipt.state).toBe("active");
        expect(receipt.id_maps.purchases[paid.purchase_id]).not.toBe(
          paid.purchase_id,
        );
        expect(
          await onBay("transfer-c", () =>
            getAccountFundingHolds({ account_id: payer }),
          ),
        ).toEqual(beforeHolds);
        const {
          rows: [movedRefund],
        } = await dest.query(
          "SELECT * FROM provider_refund_attempts WHERE id=$1",
          [refundId],
        );
        expect(movedRefund.purchase_id).toBe(
          receipt.id_maps.purchases[extra.id],
        );
        expect(movedRefund.provider_request).toEqual(
          oldRefund.provider_request,
        );
        expect(movedRefund.reconcile_token).toBeNull();
        expect(movedRefund.reconcile_lease_expires_at).toBeNull();
        expect(
          await onBay("transfer-c", () =>
            localPaymentSubscriptionId(payer, {
              id: renewalPayment,
              metadata: {
                subscription_id: subscription.id,
                renewal_attempt_id: renewalId,
              },
            }),
          ),
        ).toBe(receipt.id_maps.subscriptions[subscription.id]);
        expect(
          await onBay("transfer-a", () =>
            claimDueSubscriptionRenewalAttempts({ limit: 10 }),
          ),
        ).toEqual([]);
        expect(
          (
            await onBay("transfer-c", () =>
              claimDueSubscriptionRenewalAttempts({ limit: 10 }),
            )
          ).map((a) => a.id),
        ).toContain(renewalId);
        for (const binding of bindings) {
          expect(
            await onBay("transfer-c", () =>
              checkComputeVmFundingLocal({ account_id: payer, binding }),
            ),
          ).toEqual(binding);
          await expect(
            onBay("transfer-c", () =>
              checkComputeVmFundingLocal({
                account_id: payer,
                binding: { ...binding, resource_generation: 2 },
              }),
            ),
          ).rejects.toThrow("Stale payer");
          const end = new Date();
          const usage = {
            account_id: payer,
            binding,
            running_started_at: new Date(end.valueOf() - 60000).toISOString(),
            running_until: end.toISOString(),
          };
          const settled = await onBay("transfer-c", () =>
            settleComputeVmFundingLocal(usage),
          );
          expect(Number(settled.charged_usd)).toBeCloseTo(0.1, 2);
          expect(
            await onBay("transfer-c", () => settleComputeVmFundingLocal(usage)),
          ).toEqual(settled);
          await expect(
            onBay("transfer-a", () => settleComputeVmFundingLocal(usage)),
          ).rejects.toThrow();
        }
        const refundResult = {
          id: "re_uncertain",
          charge: "ch_uncertain",
          amount: 1000,
          status: "succeeded" as const,
        };
        await expect(
          onBay("transfer-a", () =>
            recordProviderRefundResult(oldRefund, refundResult),
          ),
        ).rejects.toThrow();
        await onBay("transfer-c", () =>
          recordProviderRefundResult(movedRefund, refundResult),
        );
        await onBay("transfer-c", () =>
          recordProviderRefundResult(movedRefund, refundResult),
        );
        await expect(
          source.query("UPDATE purchases SET cost=-200 WHERE id=$1", [
            paid.purchase_id,
          ]),
        ).rejects.toThrow("frozen or retired");
        expect(
          await onBay("transfer-a", () => getPendingCreditTransferManifests()),
        ).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ transfer_id: manifest.transfer_id }),
          ]),
        );
        await onBay("transfer-c", () =>
          reconcileCreditTransfer(manifest, transport),
        );
        await remote("transfer-c").copyRehomeState({
          target_account_id: payer,
          source_bay_id: "transfer-a",
          dest_bay_id: "transfer-c",
          financial_handoff: h,
        });
        expect([await balance(payer), await balance(recipient)]).toEqual([
          69.8, 30,
        ]);
        expect(
          (
            await dest.query(
              "SELECT count(*)::integer AS n FROM purchases WHERE account_id=$1",
              [payer],
            )
          ).rows[0].n,
        ).toBe(6);
        // A return move replaces only the retired shadow, never resurrecting
        // its old ledger or dropping successor settlement/receipt history.
        await onBay("transfer-c", () =>
          rehomeAccountOnHomeBay({
            account_id: payer,
            target_account_id: payer,
            dest_bay_id: "transfer-a",
          }),
        );
        expect(mockHomes.get(payer)).toBe("transfer-a");
        expect(await balance(payer)).toBe(69.8);
        for (const binding of bindings)
          expect(
            await onBay("transfer-a", () =>
              checkComputeVmFundingLocal({ account_id: payer, binding }),
            ),
          ).toEqual(binding);
        const returning = await send(payer, recipient, "1");
        expect(returning.fragments[0].root.purchase_id).toBe(paid.purchase_id);
        await onBay("transfer-a", () =>
          reconcileCreditTransfer(returning, transport),
        );
        expect([await balance(payer), await balance(recipient)]).toEqual([
          68.8, 31,
        ]);
        await onBay("transfer-b", () =>
          rehomeAccountOnHomeBay({
            account_id: recipient,
            target_account_id: recipient,
            dest_bay_id: "transfer-c",
          }),
        );
        await transport.deliver("transfer-c", manifest);
        await transport.deliver("transfer-c", returning);
        expect(await balance(recipient)).toBe(31);
        const back = await send(recipient, payer, "1");
        await onBay("transfer-c", () =>
          reconcileCreditTransfer(back, transport),
        );
        expect([await balance(payer), await balance(recipient)]).toEqual([
          69.8, 30,
        ]);
        // Simulate restored pre-cutover local ownership. Fresh directory
        // resolution still fences stale source settlement and refund workers.
        await dest.query(
          "UPDATE accounts SET home_bay_id='transfer-c' WHERE account_id=$1",
          [payer],
        );
        await dest.query(
          "UPDATE account_funding_authorities SET state='active' WHERE payer_account_id=$1",
          [payer],
        );
        await expect(
          onBay("transfer-c", () =>
            checkComputeVmFundingLocal({
              account_id: payer,
              binding: bindings[0],
            }),
          ),
        ).rejects.toThrow("another home bay");
        await expect(
          onBay("transfer-c", () =>
            recordProviderRefundResult(movedRefund, refundResult),
          ),
        ).rejects.toThrow("another home bay");
      } finally {
        if (oldFlag == null) delete process.env.COCALC_ENABLE_FINANCIAL_REHOME;
        else process.env.COCALC_ENABLE_FINANCIAL_REHOME = oldFlag;
      }
    }, 60000);
  },
);
