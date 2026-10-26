/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveHostBay = jest.fn();
const forwardHubApiCall = jest.fn();
const queueHostStop = jest.fn(async () => ({ op_id: "op-1" }));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({ resolveHostBay }));
jest.mock("./edge-routing", () => ({ forwardHubApiCall }));
jest.mock("./hosts", () => ({ queueHostStop }));

import {
  runHostActionAsSystem,
  runSystemHostActionHere,
} from "./system-host-actions";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const HOST = "55555555-5555-4555-8555-555555555555";

beforeEach(() => jest.clearAllMocks());

describe("system host actions", () => {
  it("runs an allow-listed action here when this bay owns the host", async () => {
    resolveHostBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    expect(
      await runHostActionAsSystem("hosts.stopHost", {
        account_id: ACCOUNT,
        id: HOST,
      }),
    ).toEqual({ op_id: "op-1" });
    expect(queueHostStop).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      id: HOST,
      skip_backups: false,
    });
    expect(forwardHubApiCall).not.toHaveBeenCalled();
  });

  it("forwards it, marked as a system call, to the host's owning bay", async () => {
    resolveHostBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forwardHubApiCall.mockResolvedValue({ op_id: "remote" });
    expect(
      await runHostActionAsSystem("hosts.stopHost", {
        account_id: ACCOUNT,
        id: HOST,
      }),
    ).toEqual({ op_id: "remote" });
    expect(forwardHubApiCall).toHaveBeenCalledWith("bay-1", {
      name: "hosts.stopHost",
      args: [{ account_id: ACCOUNT, id: HOST }],
      account_id: ACCOUNT,
      system: true,
    });
    expect(queueHostStop).not.toHaveBeenCalled();
  });

  it("refuses anything not on the allow-list, on either side", async () => {
    await expect(
      runHostActionAsSystem("hosts.deleteHost", {
        account_id: ACCOUNT,
        id: HOST,
      }),
    ).rejects.toThrow("not a system host action");
    await expect(
      runSystemHostActionHere("hosts.deleteHost", {
        account_id: ACCOUNT,
        id: HOST,
      }),
    ).rejects.toMatchObject({ code: 403 });
    // Not an inherited property either.
    await expect(
      runSystemHostActionHere("toString", { account_id: ACCOUNT, id: HOST }),
    ).rejects.toMatchObject({ code: 403 });
    expect(resolveHostBay).not.toHaveBeenCalled();
    expect(forwardHubApiCall).not.toHaveBeenCalled();
    expect(queueHostStop).not.toHaveBeenCalled();
  });
});
