/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const executeCommandMock = jest.fn();
const executeReadMock = jest.fn();
const createServiceClientMock = jest.fn(() => ({
  executeCommand: executeCommandMock,
  executeRead: executeReadMock,
}));
const isMultiBayClusterMock = jest.fn(() => false);

jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(() => ({ kind: "hub-client" })),
}));

jest.mock("@cocalc/conat/service/typed", () => ({
  createServiceClient: (...args: any[]) => createServiceClientMock(...args),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => isMultiBayClusterMock(),
}));

import {
  executeBillingAuthorityCommand,
  executeBillingHttpCommand,
  executeBillingHubApiCall,
  resetBillingAuthorityClientForTests,
} from "./client";
import { resetBillingAuthorityContextForTests } from "./context";
import { BILLING_AUTHORITY_SUBJECT } from "./protocol";

describe("billing authority client", () => {
  beforeEach(() => {
    executeCommandMock.mockReset().mockResolvedValue({ ok: true, value: 7 });
    executeReadMock.mockReset().mockResolvedValue({ ok: true, value: 8 });
    createServiceClientMock.mockClear();
    isMultiBayClusterMock.mockReset().mockReturnValue(false);
    resetBillingAuthorityClientForTests();
    resetBillingAuthorityContextForTests();
  });

  afterEach(resetBillingAuthorityContextForTests);

  it("uses single-send request transport for commands", async () => {
    await expect(
      executeBillingAuthorityCommand<number>({
        kind: "maintenance",
        task: "statements",
      }),
    ).resolves.toBe(7);

    expect(createServiceClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "billing-authority",
        subject: BILLING_AUTHORITY_SUBJECT,
        transport: "request",
      }),
    );
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    expect(executeReadMock).not.toHaveBeenCalled();
  });

  it("uses the concurrent endpoint only for allowlisted reads", async () => {
    await expect(
      executeBillingHubApiCall({
        name: "purchases.getBalance",
        args: [],
      }),
    ).resolves.toBe(8);
    await expect(
      executeBillingHubApiCall({
        name: "purchases.getMembershipDetails",
        args: [],
      }),
    ).resolves.toBe(7);

    expect(executeReadMock).toHaveBeenCalledTimes(1);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
  });

  it("keeps pure Stripe reads concurrent but serializes reconciliation reads", async () => {
    await expect(
      executeBillingHttpCommand("get-invoice", {
        account_id: "acct-1",
        invoice_id: "in_1",
      }),
    ).resolves.toBe(8);
    await expect(
      executeBillingHttpCommand("get-payments", { account_id: "acct-1" }),
    ).resolves.toBe(7);

    expect(executeReadMock).toHaveBeenCalledTimes(1);
    expect(executeCommandMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed before contacting an authority in multi-bay mode", async () => {
    isMultiBayClusterMock.mockReturnValue(true);
    await expect(
      executeBillingAuthorityCommand({
        kind: "maintenance",
        task: "statements",
      }),
    ).rejects.toMatchObject({ code: 503, status: 503 });
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });

  it("preserves structured authority errors", async () => {
    executeCommandMock.mockResolvedValue({
      ok: false,
      error: { message: "denied", code: 403, status: 403 },
    });
    await expect(
      executeBillingAuthorityCommand({
        kind: "maintenance",
        task: "statements",
      }),
    ).rejects.toMatchObject({ message: "denied", code: 403, status: 403 });
  });
});
