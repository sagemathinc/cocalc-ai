/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const resolveProjectBay = jest.fn();
const forward = jest.fn();
const createInterBayHubApiClient = jest.fn(() => ({ call: forward }));
const isAccountBannedCached = jest.fn(() => false);

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({ fabric: true }),
}));
jest.mock("@cocalc/conat/inter-bay/hub-api", () => ({
  createInterBayHubApiClient,
}));
jest.mock("@cocalc/server/accounts/security-state", () => ({
  isAccountBannedCached,
}));

import {
  executeHubApiCall,
  handleForwardedHubApiCall,
  registerHubApiLocalExecutor,
} from "./edge-routing";

const ACCOUNT = "1f8d5b7c-3c55-4a43-9f43-3ef8b2b2d0a1";
const PROJECT = "6b0f0b1e-2a1f-4b7e-8d7c-0c2f8a9b1c3d";
const local = jest.fn(async (call) => ({ ranHere: call.name }));

const routed = (
  args: any[] = [{ project_id: PROJECT, patch: { title: "t" } }],
) => ({
  name: "projects.setProjectMetadata",
  args,
  account_id: ACCOUNT,
  auth_session_hash: "session",
});

beforeEach(() => {
  jest.clearAllMocks();
  registerHubApiLocalExecutor(local);
  isAccountBannedCached.mockReturnValue(false);
});

describe("executeHubApiCall at the edge", () => {
  it("runs a method without a route here", async () => {
    const call = { name: "projects.listAccountProjectWindow", args: [{}] };
    expect(await executeHubApiCall(call)).toEqual({
      ranHere: call.name,
    });
    expect(resolveProjectBay).not.toHaveBeenCalled();
  });

  it("runs a routed method here when this bay owns the project", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    await executeHubApiCall(routed());
    expect(local).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it("runs a malformed routed call here, where the method rejects it", async () => {
    await executeHubApiCall(routed([{ project_id: "nope" }]));
    expect(resolveProjectBay).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("forwards the whole authenticated call to the owning bay once", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward.mockResolvedValue({ ok: true, result: { done: true } });
    expect(await executeHubApiCall(routed())).toEqual({ done: true });
    expect(createInterBayHubApiClient).toHaveBeenCalledWith(
      expect.objectContaining({ bay_id: "bay-1" }),
    );
    expect(forward).toHaveBeenCalledWith({
      ...routed(),
      source_bay_id: "bay-0",
    });
    expect(local).not.toHaveBeenCalled();
  });

  it("raises the owning bay's error as if the call had run here", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-1", epoch: 0 });
    forward.mockResolvedValue({
      ok: false,
      error: "only collaborators may do this",
      attrs: { code: 403 },
    });
    await expect(executeHubApiCall(routed())).rejects.toMatchObject({
      message: "only collaborators may do this",
      code: 403,
    });
  });
});

describe("handleForwardedHubApiCall on the owning bay", () => {
  const forwarded = (overrides = {}) => ({
    ...routed(),
    source_bay_id: "bay-1",
    ...overrides,
  });

  it("runs the call through the local pipeline without the transport field", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    expect(await handleForwardedHubApiCall(forwarded())).toEqual({
      ok: true,
      result: { ranHere: "projects.setProjectMetadata" },
    });
    expect(local).toHaveBeenCalledWith(routed());
  });

  it("refuses methods that are not routable", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ name: "projects.deleteProject" }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("re-checks the method's principal policy", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ account_id: undefined, host_id: "host" }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses agent principals", async () => {
    const result = await handleForwardedHubApiCall(
      forwarded({ auth_actor: "agent", project_id: PROJECT }),
    );
    expect(result).toMatchObject({ ok: false, attrs: { code: 403 } });
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses banned accounts", async () => {
    isAccountBannedCached.mockReturnValue(true);
    const result = await handleForwardedHubApiCall(forwarded());
    expect(result).toMatchObject({ ok: false, error: "account is banned" });
    expect(local).not.toHaveBeenCalled();
  });

  it("never forwards a second time when ownership moved", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-2", epoch: 0 });
    const result = await handleForwardedHubApiCall(forwarded());
    expect(result).toMatchObject({ ok: false, attrs: { code: 409 } });
    expect(forward).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it("returns the method's error with its attributes", async () => {
    resolveProjectBay.mockResolvedValue({ bay_id: "bay-0", epoch: 0 });
    local.mockRejectedValueOnce(
      Object.assign(new Error("not a collaborator"), { code: 403 }),
    );
    expect(await handleForwardedHubApiCall(forwarded())).toEqual({
      ok: false,
      error: "not a collaborator",
      attrs: { code: 403 },
    });
  });
});
