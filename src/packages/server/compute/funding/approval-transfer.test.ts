/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { toDecimal } from "@cocalc/util/money";
import {
  prepareTransferApproval,
  registerTransferApprovals,
  resolveTransferApprovalReview,
} from "./approval-transfer";
import {
  prepareCreditTransferApproval,
  withCreditTransferApprovalTransaction,
  transferableInTransaction,
  applyCreditTransferInTransaction,
} from "@cocalc/server/purchases/credit-transfers/core";
import { registerCreditTransferApprovalService } from "@cocalc/server/purchases/credit-transfers/api";
import { requireCreditTransfersEnabled } from "@cocalc/server/purchases/credit-transfers/config";

jest.mock("@cocalc/server/purchases/credit-transfers/core", () => ({
  prepareCreditTransferApproval: jest.fn(),
  withCreditTransferApprovalTransaction: jest.fn(),
  transferableInTransaction: jest.fn(),
  applyCreditTransferInTransaction: jest.fn(),
}));
jest.mock("@cocalc/server/purchases/credit-transfers/api", () => ({
  creditTransferTransport: {},
  registerCreditTransferApprovalService: jest.fn(),
}));
jest.mock("@cocalc/server/purchases/credit-transfers/config", () => ({
  requireCreditTransfersEnabled: jest.fn().mockResolvedValue(undefined),
}));
const terms = {
  kind: "creditTransfer" as const,
  currency: "USD" as const,
  amount_usd: "5.00",
  recipient: {
    account_id: randomUUID(),
    home_bay_id: "bay-0",
    authority_epoch: "1",
    email_address: "recipient@example.test",
    display_name: "Recipient",
  },
};
beforeEach(() => {
  jest.resetAllMocks();
  (registerCreditTransferApprovalService as jest.Mock).mockReturnValue(
    jest.fn(),
  );
  (requireCreditTransfersEnabled as jest.Mock).mockResolvedValue(undefined);
});

it("registers by default and rejects operations after an administrator opt-out", async () => {
  registerTransferApprovals({} as any);
  expect(registerCreditTransferApprovalService).toHaveBeenCalledTimes(1);
  (requireCreditTransfersEnabled as jest.Mock).mockRejectedValue(
    new Error("Credit transfers are disabled"),
  );
  await expect(
    resolveTransferApprovalReview(randomUUID(), terms),
  ).rejects.toThrow("disabled");
});
it("refreshes evidence per approval and uses only the core sorted transaction", async () => {
  const prepared = {};
  (prepareCreditTransferApproval as jest.Mock).mockResolvedValue(prepared);
  const db = {};
  (withCreditTransferApprovalTransaction as jest.Mock).mockImplementation(
    async (p, fn) => {
      expect(p).toBe(prepared);
      return fn(db);
    },
  );
  const intent = {
    terms,
    payer_account_id: randomUUID(),
    operation_id: randomUUID(),
    intent_id: randomUUID(),
  } as any;
  const execute = await prepareTransferApproval(intent);
  const receipt = { transfer_id: randomUUID() };
  (applyCreditTransferInTransaction as jest.Mock).mockResolvedValue(receipt);
  expect(
    await execute!.withTransaction((client) =>
      execute!.apply({ ...intent, db: client }),
    ),
  ).toEqual({ receipt });
  expect(applyCreditTransferInTransaction).toHaveBeenCalledWith(
    { ...intent, db },
    prepared,
  );
  await prepareTransferApproval(intent);
  expect(prepareCreditTransferApproval).toHaveBeenCalledTimes(2);
  (requireCreditTransfersEnabled as jest.Mock).mockRejectedValue(
    new Error("Credit transfers are disabled"),
  );
  await expect(execute!.apply({ ...intent, db })).rejects.toThrow("disabled");
});
it("stores verified transferable and remaining USD for human review", async () => {
  (prepareCreditTransferApproval as jest.Mock).mockResolvedValue({});
  (withCreditTransferApprovalTransaction as jest.Mock).mockImplementation(
    async (_p, fn) => fn({}),
  );
  (transferableInTransaction as jest.Mock).mockResolvedValue({
    available: toDecimal("10.00"),
  });
  expect(await resolveTransferApprovalReview(randomUUID(), terms)).toEqual({
    transferable_usd: "10.0000000000",
    remaining_transferable_usd: "5.0000000000",
  });
  (transferableInTransaction as jest.Mock).mockResolvedValue({
    available: toDecimal("4.00"),
  });
  await expect(
    resolveTransferApprovalReview(randomUUID(), terms),
  ).rejects.toThrow("Insufficient");
});
it("adapts public operation status and rejects a different stored operation kind", async () => {
  const value = {
    operation_id: randomUUID(),
    intent_id: randomUUID(),
    status: "pending",
    approval_url: "https://approve.example.test/funding/intent",
  };
  const service = {
    propose: jest.fn().mockResolvedValue(value),
    statusByOperation: jest.fn().mockResolvedValue(value),
    retrieve: jest.fn().mockResolvedValue({ terms }),
  };
  registerTransferApprovals(service as any);
  const adapter = (registerCreditTransferApprovalService as jest.Mock).mock
    .calls[0][0];
  expect(
    await adapter.propose({
      payer_account_id: randomUUID(),
      operation_id: value.operation_id,
      terms,
    }),
  ).toMatchObject({
    state: "approval_required",
    approval_url: value.approval_url,
  });
  expect(
    await adapter.status({
      payer_account_id: randomUUID(),
      operation_id: value.operation_id,
    }),
  ).toMatchObject({ state: "approval_required" });
  service.retrieve.mockResolvedValue({
    terms: { kind: "personalVMfallback" },
  } as any);
  await expect(
    adapter.status({
      payer_account_id: randomUUID(),
      operation_id: value.operation_id,
    }),
  ).rejects.toThrow("Not a transfer");
});
