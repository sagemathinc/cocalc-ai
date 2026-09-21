/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { resolveFundingApprovalConfiguration } from "./approval-config";
import {
  createCourseFundingApprovals,
  ensureCourseFundingApprovalSchema,
  registerCourseFundingApprovalService,
  registerFundingApprovalReadinessCheck,
} from "./approvals";
import { startCourseFundingApprovalServer } from "./approval-server";
import {
  initCourseFundingApprovalService,
  stopCourseFundingApprovalService,
} from "./approval-startup";
import { createCourseFundingPoolInTransaction } from "./pools";
import { changeCourseFundingPoolInTransaction } from "./pool-changes";
import { enqueueCourseFundingReceiptInTransaction } from "./receipts";
import { registerVmPersonalFundingApprovalHandler } from "./approval-personal";
import { randomUUID } from "node:crypto";
import { prepareFundingApprovalRecipients } from "./approval-recipients";

jest.mock("./approval-recipients", () => ({
  prepareFundingApprovalRecipients: jest.fn(),
}));
jest.mock("./backing", () => ({ withFundingAccountTransaction: jest.fn() }));
jest.mock("./approval-sponsorship", () => ({
  prepareSponsorshipApproval: jest.fn(async () => jest.fn()),
}));
jest.mock("./rollout-startup", () => ({
  initFundingRolloutVerifiers: jest.fn(),
}));

jest.mock("./approval-config", () => ({
  resolveFundingApprovalConfiguration: jest.fn(),
  FUNDING_APPROVAL_HEALTH_PATH: "/.well-known/cocalc-financial-approval-health",
  FUNDING_APPROVAL_HEALTH_SERVICE: "cocalc-financial-approval",
}));
jest.mock("./approvals", () => ({
  createCourseFundingApprovals: jest.fn(),
  ensureCourseFundingApprovalSchema: jest.fn(),
  registerCourseFundingApprovalService: jest.fn(),
  registerFundingApprovalReadinessCheck: jest.fn(),
}));
jest.mock("./approval-server", () => ({
  startCourseFundingApprovalServer: jest.fn(),
}));
jest.mock("./approval-review", () => ({
  resolveCourseFundingReview: jest.fn(),
}));
jest.mock("./approval-transfer", () => ({
  normalizeTransferApprovalTerms: jest.fn(),
  prepareTransferApproval: jest.fn(),
  registerTransferApprovals: jest.fn(),
}));
jest.mock("./pools", () => ({
  createCourseFundingPoolInTransaction: jest.fn(),
}));
jest.mock("./pool-changes", () => ({
  normalizeCourseFundingPoolChangeDraft: jest.fn(),
  changeCourseFundingPoolInTransaction: jest.fn(),
}));
jest.mock("./receipts", () => ({
  enqueueCourseFundingReceiptInTransaction: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(async () => {
  await stopCourseFundingApprovalService();
});

it("does nothing when disabled", async () => {
  (resolveFundingApprovalConfiguration as jest.Mock).mockResolvedValue({
    state: "disabled",
    source: "environment",
    reason: "disabled",
  });
  await initCourseFundingApprovalService();
  expect(ensureCourseFundingApprovalSchema).not.toHaveBeenCalled();
  expect(startCourseFundingApprovalServer).not.toHaveBeenCalled();
  expect(registerCourseFundingApprovalService).not.toHaveBeenCalled();
});

it("leaves centralized approval to the seed bay", async () => {
  const before = {
    enabled: process.env.COCALC_BILLING_AUTHORITY_ENABLED,
    role: process.env.COCALC_CLUSTER_ROLE,
  };
  process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
  process.env.COCALC_CLUSTER_ROLE = "attached";
  try {
    await initCourseFundingApprovalService();
    expect(resolveFundingApprovalConfiguration).not.toHaveBeenCalled();
    expect(ensureCourseFundingApprovalSchema).not.toHaveBeenCalled();
    expect(startCourseFundingApprovalServer).not.toHaveBeenCalled();
    expect(registerCourseFundingApprovalService).not.toHaveBeenCalled();
  } finally {
    if (before.enabled == null)
      delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    else process.env.COCALC_BILLING_AUTHORITY_ENABLED = before.enabled;
    if (before.role == null) delete process.env.COCALC_CLUSTER_ROLE;
    else process.env.COCALC_CLUSTER_ROLE = before.role;
  }
});

it("registers the same process service only after listening and cleans up on stop", async () => {
  (resolveFundingApprovalConfiguration as jest.Mock).mockResolvedValue({
    state: "configured",
    source: "environment",
    config: { origin: "http://127.0.0.2:19202" },
  });
  const service = { propose: jest.fn(), status: jest.fn() };
  (createCourseFundingApprovals as jest.Mock).mockReturnValue(service);
  const unregister = jest.fn();
  const unregisterReadiness = jest.fn();
  (registerCourseFundingApprovalService as jest.Mock).mockReturnValue(
    unregister,
  );
  (registerFundingApprovalReadinessCheck as jest.Mock).mockReturnValue(
    unregisterReadiness,
  );
  const server = new EventEmitter() as EventEmitter & { close: jest.Mock };
  server.close = jest.fn((done) => {
    server.emit("close");
    done();
  });
  (startCourseFundingApprovalServer as jest.Mock).mockImplementation(
    async () => {
      expect(registerCourseFundingApprovalService).not.toHaveBeenCalled();
      return server;
    },
  );
  await Promise.all([
    initCourseFundingApprovalService(),
    initCourseFundingApprovalService(),
  ]);
  await initCourseFundingApprovalService();
  expect(startCourseFundingApprovalServer).toHaveBeenCalledTimes(1);
  expect(registerCourseFundingApprovalService).toHaveBeenCalledWith(service);
  expect(registerFundingApprovalReadinessCheck).toHaveBeenCalledTimes(1);
  const { prepare, apply: uncheckedApply } = (
    createCourseFundingApprovals as jest.Mock
  ).mock.calls[0][0];
  const check = jest.fn().mockResolvedValue({ payer: "bay-0" });
  (prepareFundingApprovalRecipients as jest.Mock).mockResolvedValue(check);
  const apply = async (args) => (await prepare(args)).apply(args);
  const db = {};
  await expect(
    uncheckedApply({ terms: {}, review: { storage_retention_hours: 72 } }),
  ).rejects.toThrow("current recipient checks");
  (createCourseFundingPoolInTransaction as jest.Mock).mockResolvedValue({
    pool: { id: "pool" },
  });
  expect(
    await apply({
      db,
      payer_account_id: "payer",
      operation_id: "operation",
      terms: {},
      review: {
        storage_retention_hours: 72,
        payer: { account_id: "payer", home_bay_id: "bay-0" },
        recipients: [],
      },
    }),
  ).toEqual({ pool_id: "pool" });
  expect(createCourseFundingPoolInTransaction).toHaveBeenCalledWith(db, {
    payer_account_id: "payer",
    operation_id: "operation",
    terms: {},
  });
  expect(enqueueCourseFundingReceiptInTransaction).toHaveBeenCalledWith(
    db,
    expect.objectContaining({
      action: "allocated",
      operation_id: "operation",
      payer_account_id: "payer",
      home_bay_by_account_id: { payer: "bay-0" },
    }),
  );
  (changeCourseFundingPoolInTransaction as jest.Mock).mockResolvedValue({
    pool_id: "pool",
  });
  const change = { action: "close" };
  expect(
    await apply({
      db,
      payer_account_id: "payer",
      operation_id: "change",
      terms: change,
      review: {
        storage_retention_hours: 72,
        payer: { account_id: "payer", home_bay_id: "bay-0" },
        recipients: [],
      },
    }),
  ).toEqual({ pool_id: "pool" });
  expect(changeCourseFundingPoolInTransaction).toHaveBeenCalledWith(db, {
    payer_account_id: "payer",
    operation_id: "change",
    terms: change,
    home_bay_by_account_id: { payer: "bay-0" },
  });
  expect(createCourseFundingPoolInTransaction).toHaveBeenCalledTimes(1);
  expect(enqueueCourseFundingReceiptInTransaction).toHaveBeenCalledTimes(1);
  check.mockRejectedValue(new Error("Recipient deleted"));
  await expect(apply({ db, terms: {}, review: {} })).rejects.toThrow(
    "Recipient deleted",
  );
  expect(createCourseFundingPoolInTransaction).toHaveBeenCalledTimes(1);
  await stopCourseFundingApprovalService();
  expect(server.close).toHaveBeenCalledTimes(1);
  expect(unregister).toHaveBeenCalledTimes(1);
  expect(unregisterReadiness).toHaveBeenCalledTimes(1);
});

it("fails closed without taking down the hub when the port is occupied", async () => {
  (resolveFundingApprovalConfiguration as jest.Mock).mockResolvedValue({
    state: "configured",
    source: "environment",
    config: { origin: "http://127.0.0.2:19202" },
  });
  (startCourseFundingApprovalServer as jest.Mock).mockRejectedValue(
    new Error("EADDRINUSE"),
  );
  await expect(initCourseFundingApprovalService()).resolves.toBeUndefined();
  expect(registerCourseFundingApprovalService).not.toHaveBeenCalled();
});

it("dispatches personal consent to its registered core using the exact approval transaction and snapshot", async () => {
  (resolveFundingApprovalConfiguration as jest.Mock).mockResolvedValue({
    state: "configured",
    source: "environment",
    config: { origin: "http://127.0.0.2:19212" },
  });
  const handler = {
    resolveReview: jest.fn(),
    apply: jest.fn().mockResolvedValue({ consent_id: "consent" }),
  };
  const unregisterHandler = registerVmPersonalFundingApprovalHandler(handler);
  try {
    await initCourseFundingApprovalService({ listen: false });
    const { apply, validateTerms } = (createCourseFundingApprovals as jest.Mock)
      .mock.calls[0][0];
    const payer = randomUUID();
    const terms = validateTerms({
      kind: "personalVMfallback",
      vm_id: randomUUID(),
      expected_funding_version: "version-1",
      home_volume_ids: [],
      lane: "prepaid",
      cap_usd: "5.00",
      ends_at: "2099-10-01T12:00:00Z",
      activation: "fallback",
      fallback_reasons: ["course_exhausted"],
    });
    const personal = {
      vm_id: terms.vm_id,
      vm_name: "Student VM",
      owner_account_id: payer,
      owning_bay_id: "bay-0",
      resource_generation: 3,
      funding_epoch: terms.expected_funding_version,
      hourly_usd: "0.25",
      protected_storage_usd: "0.75",
      egress_cap_usd: "0.50",
      storage_delete_at: "2099-10-04T12:00:00Z",
      home_volumes: [],
    };
    const opts = {
      db: {},
      payer_account_id: payer,
      intent_id: randomUUID(),
      operation_id: randomUUID(),
      terms,
      review: { storage_retention_hours: 72, personal_vm_fallback: personal },
    };
    expect(await apply(opts)).toEqual({ consent_id: "consent" });
    expect(handler.apply).toHaveBeenCalledWith({ ...opts, review: personal });
    expect(createCourseFundingPoolInTransaction).not.toHaveBeenCalled();
    expect(changeCourseFundingPoolInTransaction).not.toHaveBeenCalled();
    handler.apply.mockRejectedValue(new Error("generation changed"));
    await expect(apply(opts)).rejects.toThrow("generation changed");
    unregisterHandler();
    await expect(apply(opts)).rejects.toThrow("not configured");
  } finally {
    unregisterHandler();
  }
});
