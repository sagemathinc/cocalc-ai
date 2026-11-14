/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const executeHubApiCallMock = jest.fn();
const isAdminMock = jest.fn();

jest.mock("@cocalc/server/accounts/security-state", () => ({
  __esModule: true,
  isAccountBannedCached: () => false,
  startAccountSecurityStateSyncLoop: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));
jest.mock("./edge-routing", () => ({
  __esModule: true,
  executeHubApiCall: (...args: any[]) => executeHubApiCallMock(...args),
  registerHubApiLocalExecutor: jest.fn(),
}));
jest.mock("./ai-sessions", () => ({
  __esModule: true,
  interrupt: jest.fn(),
  interruptAll: jest.fn(),
  list: jest.fn(),
  upsertProjectHostSession: jest.fn(),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "22222222-2222-4222-8222-222222222222";
const REFUSAL = "host software maintenance is limited to site admins";

const LIFECYCLE: Array<[string, Record<string, unknown>]> = [
  ["hosts.pullHostRootfsImage", { id: HOST_ID, image: "x" }],
  ["hosts.deleteHostRootfsImage", { id: HOST_ID, image: "x" }],
  ["hosts.gcDeletedHostRootfsImages", { id: HOST_ID }],
  [
    "hosts.upgradeHostSoftware",
    { id: HOST_ID, targets: [{ artifact: "project-host" }] },
  ],
  ["hosts.reconcileHostSoftware", { id: HOST_ID }],
  [
    "hosts.setHostRuntimeDeployments",
    { scope_type: "host", id: HOST_ID, deployments: [] },
  ],
  ["hosts.reconcileHostRuntimeDeployments", { id: HOST_ID }],
  [
    "hosts.rollbackHostRuntimeDeployments",
    { id: HOST_ID, target_type: "artifact", target: "project-host" },
  ],
  [
    "hosts.rolloutHostManagedComponents",
    { id: HOST_ID, components: ["project-host"] },
  ],
  ["hosts.upgradeHostConnector", { id: HOST_ID }],
  [
    "hosts.listHostSoftwareVersions",
    { base_url: "https://software.example.test/software" },
  ],
];

async function call(name: string, opts: Record<string, unknown>) {
  const { handleApiRequest } = await import("./index");
  const respond = jest.fn(async () => undefined);
  await handleApiRequest({
    request: { name, args: [opts] },
    mesg: { subject: `hub.account.${ACCOUNT_ID}.api`, respond },
  });
  return respond;
}

describe("the admin-only host software methods", () => {
  it("are all hub API methods, and are all tested here", async () => {
    const { HOST_SOFTWARE_ADMIN_METHODS } =
      await import("./host-software-admin");
    const { getHubApiPrincipalPolicy } = await import("@cocalc/conat/hub/api");
    for (const name of HOST_SOFTWARE_ADMIN_METHODS) {
      expect(getHubApiPrincipalPolicy(name)).toBeTruthy();
    }
    expect([...HOST_SOFTWARE_ADMIN_METHODS].sort()).toEqual(
      LIFECYCLE.map(([name]) => name)
        .filter((name) => name !== "hosts.listHostSoftwareVersions")
        .sort(),
    );
  });
});

describe("host software maintenance at the hub API, before routing", () => {
  beforeEach(() => {
    executeHubApiCallMock.mockReset();
    executeHubApiCallMock.mockResolvedValue({ ok: true });
    isAdminMock.mockReset();
  });

  it.each(LIFECYCLE)(
    "%s refuses a non-admin without routing or running it",
    async (name, opts) => {
      isAdminMock.mockResolvedValue(false);
      const respond = await call(name, opts);
      expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
      expect(executeHubApiCallMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(null, {
        headers: expect.objectContaining({ error: REFUSAL }),
      });
    },
  );

  it.each(LIFECYCLE)(
    "%s routes an admin's call as the admin",
    async (name, opts) => {
      isAdminMock.mockResolvedValue(true);
      const respond = await call(name, opts);
      expect(executeHubApiCallMock).toHaveBeenCalledTimes(1);
      expect(executeHubApiCallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name,
          args: [opts],
          account_id: ACCOUNT_ID,
        }),
      );
      expect(respond).toHaveBeenCalledWith(
        { ok: true },
        { headers: undefined },
      );
    },
  );

  it.each([
    ["hosts.listHostSoftwareVersions", { artifacts: ["tools"] }],
    ["hosts.listHostRootfsImages", { id: HOST_ID }],
    ["hosts.getHostManagedComponentStatus", { id: HOST_ID }],
  ])("%s is left to the method for a non-admin", async (name, opts) => {
    isAdminMock.mockResolvedValue(false);
    await call(name, opts);
    expect(isAdminMock).not.toHaveBeenCalled();
    expect(executeHubApiCallMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an admin's unsafe version before routing it", async () => {
    isAdminMock.mockResolvedValue(true);
    const respond = await call("hosts.upgradeHostSoftware", {
      id: HOST_ID,
      targets: [{ artifact: "project-host", version: "../x" }],
    });
    expect(executeHubApiCallMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(null, {
      headers: expect.objectContaining({
        error: "invalid host software version or channel",
      }),
    });
  });
});
