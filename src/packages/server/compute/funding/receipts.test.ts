import { randomUUID } from "node:crypto";
import { resolveNotificationDeliveryPolicy } from "@cocalc/util/notification-delivery-policy";
import type { CourseFundingPoolRow, CourseFundingGrantRow } from "./pools";

const mockGraph = jest.fn();
const mockRequireTransaction = jest.fn();
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: (...args) => mockGraph(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "payer-home",
}));
jest.mock("./backing", () => ({
  requireFundingAccountTransaction: (...args) =>
    mockRequireTransaction(...args),
}));
import { enqueueCourseFundingReceiptInTransaction } from "./receipts";

const payer = randomUUID();
const first = randomUUID();
const second = randomUUID();
const operation = randomUUID();
const budget = {
  authorized_usd: "100",
  spent_usd: "0",
  reserved_usd: "0",
  released_usd: "0",
};
const pool = {
  id: randomUUID(),
  payer_account_id: payer,
  course_project_id: randomUUID(),
  lane: "prepaid",
  starts_at: new Date(),
  ends_at: new Date(Date.now() + 86400000),
  state: "active",
  ...budget,
} as CourseFundingPoolRow;
const grants = [first, second].map((id) => ({
  id: randomUUID(),
  pool_id: pool.id,
  beneficiary_account_id: id,
  ...budget,
  authorized_usd: "50",
  starts_at: pool.starts_at,
  ends_at: pool.ends_at,
  state: "active",
})) as CourseFundingGrantRow[];
const homes = {
  [payer]: "payer-home",
  [first]: "first-home",
  [second]: "second-home",
};

beforeEach(() => jest.resetAllMocks());

it("atomically enqueues separate private payer/student receipts through the existing durable outbox", async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) } as any;
  await enqueueCourseFundingReceiptInTransaction(db, {
    payer_account_id: payer,
    operation_id: operation,
    action: "allocated",
    pool,
    grants,
    home_bay_by_account_id: homes,
  });
  expect(mockRequireTransaction).toHaveBeenCalledWith(db, payer);
  expect(mockGraph).toHaveBeenCalledTimes(3);
  for (const [{ db: usedDb, input }] of mockGraph.mock.calls) {
    expect(usedDb).toBe(db);
    const target = input.targets[0];
    expect(input.targets).toHaveLength(1);
    expect(target.target_home_bay_id).toBe(homes[target.target_account_id]);
    const policy = resolveNotificationDeliveryPolicy({
      kind: input.kind,
      summary: target.summary_json,
      target_account_id: target.target_account_id,
      preferences: { email: { billing: "none", course: "none" } },
    });
    expect(policy).toMatchObject({
      category: "billing",
      lane: "critical",
      required: true,
      delivery_mode: "immediate",
    });
    if (target.target_account_id !== payer) {
      expect(JSON.stringify(input)).not.toContain(
        target.target_account_id === first ? second : first,
      );
      expect(input.payload_json.funding_receipt).not.toHaveProperty("grants");
      expect(input.payload_json.funding_receipt.budget.authorized_usd).toBe(
        "50",
      );
    }
  }
});

it("requires all target homes before enqueueing any receipt", async () => {
  const db = { query: jest.fn() } as any;
  await expect(
    enqueueCourseFundingReceiptInTransaction(db, {
      payer_account_id: payer,
      operation_id: operation,
      action: "allocated",
      pool,
      grants,
      home_bay_by_account_id: { [payer]: "payer-home" },
    }),
  ).rejects.toThrow("resolved home bay");
  expect(mockGraph).not.toHaveBeenCalled();
});

it("propagates enqueue errors so the caller's financial transaction rolls back", async () => {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) } as any;
  mockGraph.mockRejectedValue(Error("outbox unavailable"));
  await expect(
    enqueueCourseFundingReceiptInTransaction(db, {
      payer_account_id: payer,
      operation_id: operation,
      action: "allocated",
      pool,
      grants,
      home_bay_by_account_id: homes,
    }),
  ).rejects.toThrow("outbox unavailable");
});

it("does not duplicate durable events on a replay", async () => {
  const db = {
    query: jest.fn().mockResolvedValue({ rows: [{ event_id: randomUUID() }] }),
  } as any;
  await enqueueCourseFundingReceiptInTransaction(db, {
    payer_account_id: payer,
    operation_id: operation,
    action: "allocated",
    pool,
    grants,
    home_bay_by_account_id: homes,
  });
  expect(mockGraph).not.toHaveBeenCalled();
});
