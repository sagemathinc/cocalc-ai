/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const executeHubApiCall = jest.fn(async () => ({ op_id: "op-1" }));
jest.mock("./edge-routing", () => ({ executeHubApiCall }));
const waitForDurableLroCompletion = jest.fn(async (opts: any) => {
  return await opts.getSummary();
});
jest.mock("@cocalc/server/lro/wait", () => ({ waitForDurableLroCompletion }));

import {
  getHostRuntimeDeploymentStatus,
  rolloutHostManagedComponents,
  upgradeHostSoftware,
  waitForHostLro,
} from "./hosts-routed";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const HOST = "55555555-5555-4555-8555-555555555555";

describe("host methods for server code, on the host's bay", () => {
  it("runs each as the routed hub API call, as the given account", async () => {
    await getHostRuntimeDeploymentStatus({ account_id: ACCOUNT, id: HOST });
    const upgrade = {
      account_id: ACCOUNT,
      id: HOST,
      targets: [{ artifact: "project-host" as const, version: "v2" }],
    };
    await upgradeHostSoftware(upgrade);
    const rollout = {
      account_id: ACCOUNT,
      id: HOST,
      components: ["project-host" as const],
    };
    await rolloutHostManagedComponents(rollout);
    expect(executeHubApiCall.mock.calls).toEqual([
      [
        {
          name: "hosts.getHostRuntimeDeploymentStatus",
          args: [{ account_id: ACCOUNT, id: HOST }],
          account_id: ACCOUNT,
        },
      ],
      [
        {
          name: "hosts.upgradeHostSoftware",
          args: [upgrade],
          account_id: ACCOUNT,
        },
      ],
      [
        {
          name: "hosts.rolloutHostManagedComponents",
          args: [rollout],
          account_id: ACCOUNT,
        },
      ],
    ]);
  });

  it("waits for a host operation, reading it on the host's bay", async () => {
    executeHubApiCall.mockClear();
    executeHubApiCall.mockResolvedValueOnce({
      op_id: "op-9",
      status: "succeeded",
    } as any);
    const client = {} as any;
    const op = { op_id: "op-9", scope_type: "host" as const, scope_id: HOST };
    expect(
      await waitForHostLro({
        account_id: ACCOUNT,
        op,
        client,
        timeout_ms: 1000,
      }),
    ).toEqual({ op_id: "op-9", status: "succeeded" });
    expect(waitForDurableLroCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op-9",
        scope_type: "host",
        scope_id: HOST,
        client,
        timeout_ms: 1000,
        poll_ms: 5_000,
      }),
    );
    // The summary is the routed lro.get, naming the host.
    expect(executeHubApiCall).toHaveBeenCalledWith({
      name: "lro.get",
      args: [{ op_id: "op-9", scope_type: "host", scope_id: HOST }],
      account_id: ACCOUNT,
    });
  });
});
