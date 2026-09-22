/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import {
  routeComputeOwnerMutation,
  computeOwnerMutationOnBay,
  requireComputeOwnerFreshAuth,
  checkComputeOwnerFreshAuthOnHome,
} from "./owner-resource-mutation";
const mockHome = jest.fn();
const mockResources = jest.fn();
const mockMutate = jest.fn();
const mockRemoteAuth = jest.fn();
const mockAuth = jest.fn();
const mockQuery = jest.fn();
const mockStop = jest.fn();
let mockBay = "home";
let mockMulti = true;
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockBay,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: () => mockHome(),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => mockMulti,
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: () => ({
    computeOwnerMutate: (r) => mockMutate(r),
    computeOwnerCheckFreshAuth: (r) => mockRemoteAuth(r),
  }),
}));
jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  getBrowserAuthSessionHash: () => "test-session-hash",
}));
jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (r) => mockAuth(r),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => mockQuery(...args) }),
}));
jest.mock("./owner-resource-routing", () => ({
  ...jest.requireActual("./owner-resource-routing"),
  routeComputeOwnerRead: () => true,
  listComputeOwnerResources: (r) => mockResources(r),
  withLocalComputeResource: (fn) => fn(),
}));
jest.mock("@cocalc/server/conat/api/compute", () => ({
  stopVm: (r) => mockStop(r),
}));

const account_id = randomUUID(),
  id = randomUUID();
const vm = {
  id,
  name: "my-vm",
  owner_account_id: account_id,
  owning_bay_id: "resource",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockBay = "home";
  mockMulti = true;
  mockHome.mockResolvedValue({ home_bay_id: "home" });
  mockResources.mockResolvedValue([vm]);
  mockMutate.mockResolvedValue({ ...vm, value: vm });
  mockQuery.mockResolvedValue({ rows: [{ id }] });
  mockAuth.mockResolvedValue(undefined);
  mockRemoteAuth.mockResolvedValue(undefined);
  mockStop.mockResolvedValue(vm);
});
it("routes the resource ID and captured session identity, not an authentication bypass", async () => {
  await routeComputeOwnerMutation("deleteVm", {
    account_id,
    id_or_name: vm.name,
    idempotency_key: randomUUID(),
    browser_id: randomUUID(),
  });
  expect(mockMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "deleteVm",
      account_home_bay: "home",
      opts: expect.objectContaining({
        account_id,
        id_or_name: id,
        session_hash: "test-session-hash",
      }),
    }),
  );
  expect(mockAuth).not.toHaveBeenCalled();
});
it("rejects stale account-home routing before dispatch", async () => {
  mockHome.mockResolvedValue({ home_bay_id: "new-home" });
  await expect(
    routeComputeOwnerMutation("stopVm", {
      account_id,
      id_or_name: id,
      idempotency_key: randomUUID(),
    }),
  ).rejects.toThrow(/home changed/);
  expect(mockMutate).not.toHaveBeenCalled();
});
it("returns non-resource SSH results only with the expected resource identity", async () => {
  const value = [
    {
      fingerprint: "SHA256:test",
      key_type: "ssh-ed25519",
      ssh_public_key: "ssh-ed25519 AAAATEST",
    },
  ];
  mockMutate.mockResolvedValue({ ...vm, value });
  await expect(
    routeComputeOwnerMutation("listVmSshKeys", { account_id, id_or_name: id }),
  ).resolves.toEqual(value);
  mockMutate.mockResolvedValue({ ...vm, id: randomUUID(), value });
  await expect(
    routeComputeOwnerMutation("listVmSshKeys", { account_id, id_or_name: id }),
  ).rejects.toThrow(/authority changed/);
});
it("checks fresh authentication at the current home, not the resource bay", async () => {
  mockBay = "resource";
  await requireComputeOwnerFreshAuth({
    account_id,
    session_hash: "current-session",
  });
  expect(mockRemoteAuth).toHaveBeenCalledWith({
    account_id,
    session_hash: "current-session",
  });
  expect(mockAuth).not.toHaveBeenCalled();
  mockRemoteAuth.mockRejectedValue(Error("revoked session"));
  await expect(
    requireComputeOwnerFreshAuth({
      account_id,
      session_hash: "current-session",
    }),
  ).rejects.toThrow("revoked session");
});
it("does not let the private auth endpoint approve from the wrong bay", async () => {
  mockBay = "resource";
  await expect(
    checkComputeOwnerFreshAuthOnHome({
      account_id,
      session_hash: "current-session",
    }),
  ).rejects.toThrow(/home changed/);
  expect(mockAuth).not.toHaveBeenCalled();
});
it("keeps single-bay fresh authentication unchanged", async () => {
  mockMulti = false;
  await requireComputeOwnerFreshAuth({
    account_id,
    session_hash: "current-session",
  });
  expect(mockHome).not.toHaveBeenCalled();
  expect(mockAuth).toHaveBeenCalledWith({
    account_id,
    session_hash: "current-session",
    require_second_factor: "if_enabled",
  });
});
it("invokes the existing owning-bay stop implementation after its owner check", async () => {
  mockBay = "resource";
  const opts = { account_id, id_or_name: id, idempotency_key: randomUUID() };
  await computeOwnerMutationOnBay({
    method: "stopVm",
    account_home_bay: "home",
    opts,
  });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("owner_account_id=$2 AND owning_bay_id=$3"),
    [id, account_id, "resource"],
  );
  expect(mockStop).toHaveBeenCalledWith(opts);
});
it.each(["missing", "wrong-home", "unknown-method"])(
  "rejects %s at private dispatch",
  async (cause) => {
    mockBay = "resource";
    if (cause === "missing") mockQuery.mockResolvedValue({ rows: [] });
    if (cause === "wrong-home")
      mockHome.mockResolvedValue({ home_bay_id: "new-home" });
    await expect(
      computeOwnerMutationOnBay({
        method: cause === "unknown-method" ? ("createVm" as any) : "stopVm",
        account_home_bay: "home",
        opts: { account_id, id_or_name: id, idempotency_key: randomUUID() },
      }),
    ).rejects.toThrow();
    expect(mockStop).not.toHaveBeenCalled();
  },
);
