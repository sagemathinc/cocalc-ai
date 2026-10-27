/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createSiteFundedClaudeTurns } from "./site-funded-claude-turns";

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
jest.mock("../codex/codex-site-metering", () => ({}));

function setup() {
  const relay = {
    socketPath: "/tmp/x",
    token: "t",
    activate: jest.fn(),
    deactivate: jest.fn(),
    close: jest.fn(),
  };
  const deps = {
    reserve: jest.fn(async () => ({
      allowed: true as const,
      reservation: {
        reservationId: "reservation-1",
        heartbeatIntervalMs: 60_000,
      } as any,
    })),
    getKey: jest.fn(async () => "sk-ant-site-key"),
    heartbeat: jest.fn(async () => true),
    finish: jest.fn(async () => {}),
    persistUsage: jest.fn(async () => {}),
  };
  const turns = createSiteFundedClaudeTurns({
    relay,
    projectId: "project-1",
    accountId: "account-1",
    deps,
  });
  return { relay, deps, turns };
}

describe("site-funded Claude turns", () => {
  it("admits a turn as Claude, funds the relay with its key, and settles it", async () => {
    const { relay, deps, turns } = setup();
    await turns.begin({ path: "a.chat" } as any);
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        accountId: "account-1",
        projectId: "project-1",
        path: "a.chat",
      }),
    );
    expect(deps.getKey).toHaveBeenCalledWith("reservation-1");
    expect(relay.activate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-site-key" }),
    );
    await turns.end({ status: "committed" });
    expect(relay.deactivate).toHaveBeenCalledWith("reservation-1");
    expect(deps.finish).toHaveBeenCalledWith({
      reservation_id: "reservation-1",
      status: "committed",
      outcome: undefined,
    });
    // Settled once.
    await turns.end({ status: "failed" });
    expect(deps.finish).toHaveBeenCalledTimes(1);
  });

  it("returns the admission's usage warning, and none without one", async () => {
    const { deps, turns } = setup();
    await expect(turns.begin()).resolves.toEqual({});
    await turns.end({ status: "committed" });
    const usageWarning = {
      window: "7d",
      percent: 96,
      threshold: 95,
      resetAt: "2026-10-30T12:00:00.000Z",
    };
    deps.reserve.mockResolvedValueOnce({
      allowed: true,
      reservation: {
        reservationId: "reservation-2",
        heartbeatIntervalMs: 60_000,
      },
      usageWarning,
    } as any);
    await expect(turns.begin()).resolves.toEqual({ usageWarning });
    await turns.close();
  });

  it("refuses with the admission's reason, funding nothing", async () => {
    const { relay, deps, turns } = setup();
    deps.reserve.mockRejectedValueOnce(Error("weekly allowance used up"));
    await expect(turns.begin()).rejects.toThrow("weekly allowance used up");
    expect(relay.activate).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("releases the reservation when its key cannot be fetched", async () => {
    const { relay, deps, turns } = setup();
    deps.getKey.mockRejectedValueOnce(Error("key unavailable"));
    await expect(turns.begin()).rejects.toThrow("key unavailable");
    expect(relay.activate).not.toHaveBeenCalled();
    expect(deps.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released" }),
    );
  });

  it("releases a running turn when the harness closes", async () => {
    const { deps, turns } = setup();
    await turns.begin();
    await turns.close();
    expect(deps.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released" }),
    );
    await expect(turns.begin()).rejects.toThrow("closed");
  });
});
