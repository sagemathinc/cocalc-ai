import { randomUUID } from "node:crypto";
import {
  routeVmToHomeVolume,
  createVmWithVolumeOnBay,
} from "./volume-placement";
import type { ComputeCreateVmWithVolumeRequest } from "@cocalc/conat/inter-bay/api";
const mockHome = jest.fn(),
  mockResources = jest.fn(),
  mockRemote = jest.fn(),
  mockQuery = jest.fn(),
  mockCreate = jest.fn();
let mockBay = "home",
  mockRoute = true;
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockBay,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: () => mockHome(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountLocalClient: () => ({
    computeCreateVmWithVolume: (opts) => mockRemote(opts),
  }),
}));
jest.mock("@cocalc/server/conat/socketio/browser-auth-sessions", () => ({
  getBrowserAuthSessionHash: () => "captured-session",
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => mockQuery(...args) }),
}));
jest.mock("./owner-resource-routing", () => ({
  ...jest.requireActual("./owner-resource-routing"),
  routeComputeOwnerRead: () => mockRoute,
  listComputeOwnerResources: (opts) => mockResources(opts),
  withLocalComputeResource: (fn) => fn(),
}));
jest.mock("@cocalc/server/conat/api/compute", () => ({
  createVm: (opts) => mockCreate(opts),
}));
const account_id = randomUUID(),
  volume_id = randomUUID(),
  vm_id = randomUUID();
const volume = {
  id: volume_id,
  name: "retained-disk",
  owner_account_id: account_id,
  owning_bay_id: "resource",
};
const vm = {
  id: vm_id,
  owner_account_id: account_id,
  owning_bay_id: "resource",
  home_volume_id: volume_id,
};
const opts: ComputeCreateVmWithVolumeRequest["opts"] = {
  account_id,
  name: "new-vm",
  home_volume: volume_id,
  provider: "gcp",
  region: "us-central1",
  zone: "us-central1-a",
  machine_type: "e2-standard-2",
  pricing_model: "on_demand",
  idempotency_key: randomUUID(),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockBay = "home";
  mockRoute = true;
  mockHome.mockResolvedValue({ home_bay_id: "home" });
  mockResources.mockResolvedValue([volume]);
  mockRemote.mockResolvedValue({ ...volume, value: vm });
  mockQuery.mockResolvedValue({ rows: [{ id: volume_id }] });
  mockCreate.mockResolvedValue(vm);
});
it("routes the canonical disk ID and original operation and session to its resource bay", async () => {
  expect(
    await routeVmToHomeVolume({ ...opts, home_volume: volume.name }),
  ).toEqual(vm);
  expect(mockRemote).toHaveBeenCalledWith({
    account_home_bay: "home",
    opts: { ...opts, session_hash: "captured-session" },
  });
});
it("leaves single-bay, local-disk and no-disk creation on the normal path", async () => {
  expect(
    await routeVmToHomeVolume({ ...opts, home_volume: undefined }),
  ).toBeUndefined();
  mockRoute = false;
  expect(await routeVmToHomeVolume(opts)).toBeUndefined();
  mockRoute = true;
  mockResources.mockResolvedValue([{ ...volume, owning_bay_id: "home" }]);
  expect(await routeVmToHomeVolume(opts)).toBeUndefined();
  expect(mockRemote).not.toHaveBeenCalled();
});
it.each(["stale-home", "other-owner", "missing-disk"])(
  "refuses %s before dispatch",
  async (reason) => {
    if (reason === "stale-home")
      mockHome.mockResolvedValue({ home_bay_id: "moved" });
    if (reason === "other-owner")
      mockResources.mockResolvedValue([
        { ...volume, owner_account_id: randomUUID() },
      ]);
    if (reason === "missing-disk") mockResources.mockResolvedValue([]);
    await expect(routeVmToHomeVolume(opts)).rejects.toThrow();
    expect(mockRemote).not.toHaveBeenCalled();
  },
);
it.each(["envelope", "vm-owner", "vm-disk"])(
  "rejects a mismatched %s response",
  async (reason) => {
    mockRemote.mockResolvedValue({
      ...volume,
      ...(reason === "envelope" ? { id: randomUUID() } : {}),
      value: {
        ...vm,
        ...(reason === "vm-owner" ? { owner_account_id: randomUUID() } : {}),
        ...(reason === "vm-disk" ? { home_volume_id: randomUUID() } : {}),
      },
    });
    await expect(routeVmToHomeVolume(opts)).rejects.toThrow();
  },
);
it("rechecks disk authority and invokes normal creation with the unchanged operation key", async () => {
  mockBay = "resource";
  expect(
    await createVmWithVolumeOnBay({ account_home_bay: "home", opts }),
  ).toEqual({ ...volume, name: undefined, value: vm });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining(
      "owner_account_id=$2 AND owning_bay_id=$3 AND deleted_at IS NULL",
    ),
    [volume_id, account_id, "resource"],
  );
  expect(mockCreate).toHaveBeenCalledWith(opts);
});
it("does not invoke creation after a disk deletion or account move", async () => {
  mockBay = "resource";
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(
    createVmWithVolumeOnBay({ account_home_bay: "home", opts }),
  ).rejects.toThrow();
  mockHome.mockResolvedValue({ home_bay_id: "new-home" });
  await expect(
    createVmWithVolumeOnBay({ account_home_bay: "home", opts }),
  ).rejects.toThrow();
  expect(mockCreate).not.toHaveBeenCalled();
});
