/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sweepBayCredentialConnections } from "./bay-credential-sweep";

const bay = (id: string, bay_id: string) =>
  [id, { bay_id, bay_credential_id: `cred-${bay_id}` }] as [string, any];

describe("sweepBayCredentialConnections", () => {
  it("disconnects only connections whose credential was revoked", async () => {
    const disconnect = jest.fn();
    await sweepBayCredentialConnections({
      connections: [bay("a", "bay-1"), bay("b", "bay-2")],
      isActive: async (user) => user.bay_id !== "bay-2",
      disconnect,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(["b"]);
  });

  it("keeps every bay when a failed check succeeds on retry", async () => {
    // e.g., an event loop stall expired the registry check's timer.
    const disconnect = jest.fn();
    let calls = 0;
    await sweepBayCredentialConnections({
      connections: [bay("a", "bay-1"), bay("b", "bay-2")],
      isActive: async () => {
        calls += 1;
        if (calls === 1) throw Error("bay credential registry check timed out");
        return true;
      },
      disconnect,
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("still applies revocations found by the retry", async () => {
    const disconnect = jest.fn();
    let failed = false;
    await sweepBayCredentialConnections({
      connections: [bay("a", "bay-1"), bay("b", "bay-2")],
      isActive: async (user) => {
        if (!failed) {
          failed = true;
          throw Error("timed out");
        }
        return user.bay_id === "bay-1";
      },
      disconnect,
    });
    expect(disconnect).toHaveBeenCalledWith(["b"]);
  });

  it("fails closed when the registry stays unavailable", async () => {
    const disconnect = jest.fn();
    const isActive = jest.fn(async () => {
      throw Error("registry unavailable");
    });
    await sweepBayCredentialConnections({
      connections: [bay("a", "bay-1"), bay("b", "bay-2")],
      isActive,
      disconnect,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does nothing without bay connections", async () => {
    const disconnect = jest.fn();
    const isActive = jest.fn(async () => true);
    await sweepBayCredentialConnections({
      connections: [],
      isActive,
      disconnect,
    });
    expect(isActive).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
