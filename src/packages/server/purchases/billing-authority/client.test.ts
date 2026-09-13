/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const mockHandleTransport = jest.fn();
const mockDispatch = jest.fn();
const mockClusterRole = jest.fn(() => "standalone");

jest.mock("./service", () => ({
  handleBillingAuthorityTransportRequest: (...args: unknown[]) =>
    mockHandleTransport(...args),
}));
jest.mock("./dispatch", () => ({
  dispatchBillingAuthorityCommand: (...args: unknown[]) =>
    mockDispatch(...args),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: () => mockClusterRole(),
  getConfiguredClusterSeedBayId: jest.fn(() => "seed"),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "seed"),
}));

import {
  __test__,
  executeBillingAuthorityCommand,
  executeBillingHttpCommand,
  executeBillingHubApiCall,
} from "./client";
import { resetBillingAuthorityContextForTests } from "./context";
import type {
  BillingAuthorityCommandRecord,
  BillingAuthorityTransportRequest,
} from "./protocol";

function record(
  status: BillingAuthorityCommandRecord["status"],
  command_id: string,
  extra: Partial<BillingAuthorityCommandRecord> = {},
): BillingAuthorityCommandRecord {
  const now = new Date().toISOString();
  return {
    command_id,
    operation: "test",
    lane: "interactive",
    status,
    created_at: now,
    updated_at: now,
    expires_at: now,
    ...extra,
  };
}

describe("durable billing authority client", () => {
  beforeEach(() => {
    mockClusterRole.mockReset().mockReturnValue("standalone");
    mockDispatch.mockReset().mockResolvedValue(8);
    mockHandleTransport
      .mockReset()
      .mockImplementation(async (request: BillingAuthorityTransportRequest) => {
        if (request.action === "submit") {
          return {
            ok: true,
            value: record("succeeded", request.request.command_id, {
              result: 7,
            }),
          };
        }
        return { ok: true, value: null };
      });
    resetBillingAuthorityContextForTests();
  });

  afterEach(resetBillingAuthorityContextForTests);

  it("executes reviewed side-effect-free reads without entering the journal", async () => {
    await expect(
      executeBillingHubApiCall({
        name: "purchases.getBalance",
        args: [],
      }),
    ).resolves.toBe(8);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockHandleTransport).not.toHaveBeenCalled();
  });

  it("serializes Stripe-facing reads that can recover local mappings", async () => {
    await expect(
      executeBillingHttpCommand("get-invoice", {
        account_id: "11111111-1111-4111-8111-111111111111",
        invoice_id: "in_1",
      }),
    ).resolves.toBe(7);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockHandleTransport).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit" }),
    );
  });

  it("submits mutating and reconciling operations to the journal", async () => {
    await expect(
      executeBillingHttpCommand("get-payments", {
        account_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toBe(7);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockHandleTransport).toHaveBeenCalledWith(
      expect.objectContaining({ action: "submit" }),
    );
  });

  it("derives stable command identities from provider and caller keys", () => {
    const webhook = {
      kind: "stripe-webhook" as const,
      event: { id: "evt_123" },
    };
    const local = {
      kind: "account-local" as const,
      operation: "purchase-team-license-change" as const,
      input: { idempotency_key: "purchase-123" },
    };
    expect(__test__.intrinsicCommandId(webhook)).toBe(
      __test__.intrinsicCommandId(webhook),
    );
    expect(__test__.intrinsicCommandId(local)).toBe(
      __test__.intrinsicCommandId(local),
    );
    expect(__test__.intrinsicCommandId(webhook)).not.toBe(
      __test__.intrinsicCommandId(local),
    );
  });

  it("cancels an abandoned queued command so it cannot execute later", async () => {
    const commandId = "44444444-4444-4444-8444-444444444444";
    let submittedId = "";
    mockHandleTransport.mockImplementation(
      async (request: BillingAuthorityTransportRequest) => {
        if (request.action === "submit") {
          submittedId = request.request.command_id;
          return { ok: true, value: record("queued", submittedId) };
        }
        if (request.action === "cancel") {
          expect(request.command_id).toBe(submittedId);
          return {
            ok: true,
            value: record("canceled", submittedId, {
              error: { message: "caller canceled queued command", status: 408 },
            }),
          };
        }
        return { ok: true, value: null };
      },
    );

    await expect(
      executeBillingAuthorityCommand(
        { kind: "commercial-maintenance" },
        { command_id: commandId, wait_timeout_ms: 0 },
      ),
    ).rejects.toMatchObject({
      billing_authority_command_id: commandId,
      billing_authority_status: "canceled",
    });
    expect(submittedId).toBe(commandId);
    expect(mockHandleTransport).toHaveBeenCalledTimes(2);
  });

  it("follows the authoritative ID returned by semantic deduplication", async () => {
    const requestedId = "66666666-6666-4666-8666-666666666666";
    const existingId = "77777777-7777-4777-8777-777777777777";
    mockHandleTransport.mockImplementation(
      async (request: BillingAuthorityTransportRequest) => {
        if (request.action === "submit") {
          expect(request.request.command_id).toBe(requestedId);
          return {
            ok: true,
            value: record("queued", existingId, { reused: true }),
          };
        }
        if (request.action === "cancel") {
          expect(request.command_id).toBe(existingId);
          return {
            ok: true,
            value: record("canceled", existingId, {
              error: { message: "caller canceled queued command", status: 408 },
            }),
          };
        }
        return { ok: true, value: null };
      },
    );

    await expect(
      executeBillingAuthorityCommand(
        { kind: "commercial-maintenance" },
        { command_id: requestedId, wait_timeout_ms: 0 },
      ),
    ).rejects.toMatchObject({
      billing_authority_command_id: existingId,
      billing_authority_status: "canceled",
    });
  });

  it("reports an explicit uncertain identity when cancellation loses to execution", async () => {
    const commandId = "55555555-5555-4555-8555-555555555555";
    let submittedId = "";
    mockHandleTransport.mockImplementation(
      async (request: BillingAuthorityTransportRequest) => {
        if (request.action === "submit") {
          submittedId = request.request.command_id;
          return { ok: true, value: record("queued", submittedId) };
        }
        if (request.action === "cancel") {
          return { ok: true, value: record("running", submittedId) };
        }
        return { ok: true, value: null };
      },
    );

    await expect(
      executeBillingAuthorityCommand(
        { kind: "commercial-maintenance" },
        { command_id: commandId, wait_timeout_ms: 0 },
      ),
    ).rejects.toMatchObject({
      code: "billing_authority_outcome_uncertain",
      status: 504,
      billing_authority_command_id: commandId,
    });
    expect(submittedId).toBe(commandId);
  });

  it("fails closed on attached bays without a dedicated authenticated transport", async () => {
    mockClusterRole.mockReturnValue("attached");
    await expect(
      executeBillingAuthorityCommand({ kind: "commercial-maintenance" }),
    ).rejects.toMatchObject({ code: 503, status: 503 });
    await expect(
      executeBillingHubApiCall({
        name: "purchases.getBalance",
        args: [],
      }),
    ).rejects.toMatchObject({ code: 503, status: 503 });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockHandleTransport).not.toHaveBeenCalled();
  });

  it("preserves structured authority errors", async () => {
    mockHandleTransport.mockResolvedValue({
      ok: false,
      error: { message: "frozen", code: 423, status: 423 },
    });
    await expect(
      executeBillingAuthorityCommand({ kind: "commercial-maintenance" }),
    ).rejects.toMatchObject({ message: "frozen", code: 423, status: 423 });
  });
});
