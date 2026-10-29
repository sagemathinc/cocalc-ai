/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The home bay's record of a forwarded GPU call (5d-2c): an agent's
// forwarded scope makes an agent record, never the owner's.

const admitUserKeyUse = jest.fn(async (o: any) => ({ kind: "use", ...o }));
const admitAgentKeyUse = jest.fn(async (o: any) => ({ kind: "use", ...o }));
let home = true;
jest.mock("@cocalc/server/gpu/key-use", () => ({
  admitUserKeyUse: (o: any) => admitUserKeyUse(o),
  admitAgentKeyUse: (o: any) => admitAgentKeyUse(o),
  isGpuKeyHomeBay: async () => home,
}));

import { forwardedGpuKeyUse } from "./gpu-key-use";

const ACCOUNT = "00000000-1000-4000-8000-000000000001";
const PROJECT = "00000000-1000-4000-8000-0000000000aa";

beforeEach(() => {
  home = true;
  admitUserKeyUse.mockClear();
  admitAgentKeyUse.mockClear();
});

describe("forwardedGpuKeyUse", () => {
  it("makes an agent's record from its forwarded scope (a catalog read, a pod read)", async () => {
    await forwardedGpuKeyUse(
      {
        account_id: ACCOUNT,
        provider: "runpod",
        agent: { project_id: PROJECT, agent_id: "agent:a1", run_id: "r1" },
      },
      "catalog",
    );
    expect(admitAgentKeyUse).toHaveBeenCalledWith({
      principal: {
        account_id: ACCOUNT,
        project_id: PROJECT,
        agent_id: "agent:a1",
        run_id: "r1",
      },
      purpose: "catalog",
    });
    expect(admitUserKeyUse).not.toHaveBeenCalled();
  });

  it("makes an agent's record from a launch's principal", async () => {
    await forwardedGpuKeyUse(
      {
        account_id: ACCOUNT,
        agent: {
          principal: {
            account_id: ACCOUNT,
            project_id: PROJECT,
            agent_id: "agent:a1",
            run_id: "r1",
          },
          operation_id: "op",
        },
      },
      "launch",
    );
    expect(admitAgentKeyUse).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "launch" }),
    );
    expect(admitUserKeyUse).not.toHaveBeenCalled();
  });

  it("makes the owner's record for a person's call", async () => {
    await forwardedGpuKeyUse({ account_id: ACCOUNT }, "pod_read");
    expect(admitUserKeyUse).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      purpose: "pod_read",
    });
    expect(admitAgentKeyUse).not.toHaveBeenCalled();
  });

  it("makes nothing off the home bay, for another account's principal, or without an account", async () => {
    home = false;
    expect(await forwardedGpuKeyUse({ account_id: ACCOUNT }, "launch")).toBe(
      undefined,
    );
    home = true;
    expect(
      await forwardedGpuKeyUse(
        {
          account_id: ACCOUNT,
          agent: {
            principal: {
              account_id: "00000000-1000-4000-8000-000000000002",
              project_id: PROJECT,
              agent_id: "agent:a1",
            },
          },
        },
        "launch",
      ),
    ).toBe(undefined);
    expect(await forwardedGpuKeyUse({}, "launch")).toBe(undefined);
    expect(admitUserKeyUse).not.toHaveBeenCalled();
    expect(admitAgentKeyUse).not.toHaveBeenCalled();
  });
});
