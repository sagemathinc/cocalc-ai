/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("./dispatch", () => ({
  dispatchBillingAuthorityCommand: jest.fn(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: jest.fn(() => "standalone"),
  getConfiguredClusterSeedBayId: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(),
}));

import { performance } from "node:perf_hooks";

import {
  __test__,
  handleBillingAuthorityTransportRequest,
  isBillingAuthorityCommand,
} from "./service";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const originalAuthorityEnabled = process.env.COCALC_BILLING_AUTHORITY_ENABLED;

describe("billing authority service boundary", () => {
  beforeEach(() => {
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
  });

  afterEach(() => {
    Object.assign(__test__.runtime, {
      lease: undefined,
      local_deadline_ms: 0,
      draining: false,
      stopping: false,
      active_command_id: undefined,
    });
  });

  afterAll(() => {
    if (originalAuthorityEnabled == null) {
      delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    } else {
      process.env.COCALC_BILLING_AUTHORITY_ENABLED = originalAuthorityEnabled;
    }
  });

  it("accepts only explicit operation unions", () => {
    expect(
      isBillingAuthorityCommand({
        kind: "http",
        operation: "create-payment-intent",
        input: {},
      }),
    ).toBe(true);
    expect(
      isBillingAuthorityCommand({
        kind: "account-local",
        operation: "purchase-team-license-change",
        input: {},
      }),
    ).toBe(true);
    expect(
      isBillingAuthorityCommand({
        kind: "maintenance",
        task: "automatic-payments",
      }),
    ).toBe(true);
    expect(
      isBillingAuthorityCommand({
        kind: "hub-api",
        call: { name: "purchases.getBalance", args: [] },
      }),
    ).toBe(true);

    for (const command of [
      { kind: "http", operation: "future-unreviewed-operation", input: {} },
      { kind: "account-local", operation: "raw-query", input: {} },
      { kind: "maintenance", task: "arbitrary-script" },
      {
        kind: "hub-api",
        call: { name: "system.setSiteSettings", args: [] },
      },
    ]) {
      expect(isBillingAuthorityCommand(command)).toBe(false);
    }
  });

  it("rejects malformed submissions before database access", async () => {
    await expect(
      handleBillingAuthorityTransportRequest({
        action: "submit",
        request: {
          command_id: "not-a-uuid",
          expires_at: new Date().toISOString(),
          command: {
            kind: "http",
            operation: "not-allowed",
            input: {},
          },
        },
      } as any),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 400, status: 400 }),
    });
  });

  it("revokes local authority before its database lease expires", () => {
    const lease = { instance_id: INSTANCE_ID, generation: 4 };
    Object.assign(__test__.runtime, {
      lease,
      local_deadline_ms: performance.now() + 1_000,
      stopping: false,
    });
    expect(__test__.authorityLocallyActive(lease)).toBe(true);
    __test__.runtime.local_deadline_ms = performance.now() - 1;
    expect(__test__.authorityLocallyActive(lease)).toBe(false);
  });

  it("fail-stops rather than continuing after lease-safety failure", () => {
    const calls: number[] = [];
    expect(() =>
      __test__.failStopBillingAuthorityWorker({
        err: new Error("lease lost"),
        exit: (code): never => {
          calls.push(code);
          throw new Error("worker exited");
        },
      }),
    ).toThrow("worker exited");
    expect(calls).toEqual([1]);
    expect(__test__.runtime.stopping).toBe(true);
    expect(__test__.runtime.local_deadline_ms).toBe(0);
  });

  it("marks provider ambiguity and post-provider failures uncertain", () => {
    expect(
      __test__.classifyCommandOutcome({
        provider: { successful: false, ambiguous: true },
      }),
    ).toMatchObject({
      status: "uncertain",
      error: { code: "stripe_mutation_outcome_ambiguous" },
    });
    expect(
      __test__.classifyCommandOutcome({
        error: { message: "local commit failed" },
        provider: { successful: true, ambiguous: false },
      }),
    ).toEqual({
      status: "uncertain",
      error: { message: "local commit failed" },
    });
    expect(
      __test__.classifyCommandOutcome({
        error: { message: "card declined" },
        provider: { successful: false, ambiguous: false },
      }),
    ).toEqual({
      status: "failed",
      error: { message: "card declined" },
    });
  });
});
