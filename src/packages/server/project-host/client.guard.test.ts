/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const createHostControlClientMock = jest.fn();
const resolveHostBayMock = jest.fn();
const bridgeUpgradeMock = jest.fn();

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: (...args: any[]) =>
    createHostControlClientMock(...args),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveHostBayAcrossCluster: (...args: any[]) => resolveHostBayMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: () => ({
    hostControl: () => ({
      upgradeSoftware: (...args: any[]) => bridgeUpgradeMock(...args),
      stageProjectHostArtifact: jest.fn(),
      rolloutManagedComponents: jest.fn(),
    }),
  }),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostControlClient: jest.fn(async () => ({})),
}));
jest.mock("@cocalc/server/conat/api/host-software-admin", () => {
  const actual = jest.requireActual(
    "@cocalc/server/conat/api/host-software-admin",
  );
  return { __esModule: true, ...actual };
});

const UNSAFE = "invalid host software version or channel";

function fakeClient() {
  return {
    upgradeSoftware: jest.fn(async () => ({ results: [] })),
    stageProjectHostArtifact: jest.fn(async () => ({ results: [] })),
    rolloutManagedComponents: jest.fn(async () => ({ results: [] })),
    getRuntimeLog: jest.fn(async () => "log"),
  };
}

describe("guardHostSoftwareCalls", () => {
  it.each([
    ["upgradeSoftware", { targets: [{ artifact: "tools", version: "../x" }] }],
    ["upgradeSoftware", { targets: [{ artifact: "tools", channel: "a/b" }] }],
    ["stageProjectHostArtifact", { version: "a b" }],
    ["rolloutManagedComponents", { components: [], desired_version: "a#b" }],
  ])("refuses %s with an unsafe value, sending nothing", async (name, opts) => {
    const { guardHostSoftwareCalls } = await import("./client");
    const inner = fakeClient();
    const guarded: any = guardHostSoftwareCalls(inner as any, "host-1");
    await expect(guarded[name](opts)).rejects.toThrow(UNSAFE);
    expect((inner as any)[name]).not.toHaveBeenCalled();
  });

  it("passes safe calls and every other method through", async () => {
    const { guardHostSoftwareCalls } = await import("./client");
    const inner = fakeClient();
    const guarded: any = guardHostSoftwareCalls(inner as any, "host-1");
    await guarded.upgradeSoftware({
      targets: [{ artifact: "tools", version: "tools-7", channel: "latest" }],
    });
    await guarded.stageProjectHostArtifact({ version: "ph-v2" });
    await guarded.rolloutManagedComponents({
      components: ["project-host"],
      desired_version: "ph-v2",
    });
    await guarded.getRuntimeLog({});
    expect(inner.upgradeSoftware).toHaveBeenCalledTimes(1);
    expect(inner.stageProjectHostArtifact).toHaveBeenCalledTimes(1);
    expect(inner.rolloutManagedComponents).toHaveBeenCalledTimes(1);
    expect(inner.getRuntimeLog).toHaveBeenCalledTimes(1);
  });
});

describe("guardHostSoftwareCalls over a dynamic service client", () => {
  // Like createServiceClient: a Proxy over {} whose methods are synthesized
  // on access and are not own (or enumerable) properties.
  function dynamicClient() {
    const calls: Array<[string, any[]]> = [];
    const conat = { ping: jest.fn(async () => undefined) };
    const proxy = new Proxy(
      {},
      {
        get: (_, prop) => {
          if (typeof prop !== "string") return undefined;
          if (prop === "then" || prop === "catch" || prop === "finally") {
            return undefined;
          }
          if (prop === "conat") return conat;
          return async (...args: any[]) => {
            calls.push([prop, args]);
            return { method: prop };
          };
        },
      },
    );
    return { proxy, calls, conat };
  }

  it("keeps every other method and conat, which have no own keys", async () => {
    const { guardHostSoftwareCalls } = await import("./client");
    const { proxy, calls, conat } = dynamicClient();
    expect(Object.keys(proxy)).toEqual([]);
    const guarded: any = guardHostSoftwareCalls(proxy as any, "host-1");
    await expect(guarded.getRuntimeLog({ lines: 5 })).resolves.toEqual({
      method: "getRuntimeLog",
    });
    await expect(guarded.probePublicRouteOrigin()).resolves.toEqual({
      method: "probePublicRouteOrigin",
    });
    await guarded.conat.ping();
    expect(conat.ping).toHaveBeenCalledTimes(1);
    expect(guarded.then).toBeUndefined();
    expect(calls).toEqual([
      ["getRuntimeLog", [{ lines: 5 }]],
      ["probePublicRouteOrigin", []],
    ]);
  });

  it("still checks the software calls, and sends the safe ones", async () => {
    const { guardHostSoftwareCalls } = await import("./client");
    const { proxy, calls } = dynamicClient();
    const guarded: any = guardHostSoftwareCalls(proxy as any, "host-1");
    await expect(
      guarded.upgradeSoftware({
        targets: [{ artifact: "tools", version: "../x" }],
      }),
    ).rejects.toThrow(UNSAFE);
    await expect(
      guarded.stageProjectHostArtifact({ version: "a/b" }),
    ).rejects.toThrow(UNSAFE);
    await expect(
      guarded.rolloutManagedComponents({
        components: [],
        desired_version: "?",
      }),
    ).rejects.toThrow(UNSAFE);
    expect(calls).toEqual([]);
    await guarded.upgradeSoftware({
      targets: [{ artifact: "tools", version: "tools-7" }],
    });
    expect(calls).toEqual([
      [
        "upgradeSoftware",
        [{ targets: [{ artifact: "tools", version: "tools-7" }] }],
      ],
    ]);
  });

  it("survives being awaited, as getRoutedHostControlClient's result is", async () => {
    const { guardHostSoftwareCalls } = await import("./client");
    const { proxy, calls } = dynamicClient();
    const guarded: any = await Promise.resolve(
      guardHostSoftwareCalls(proxy as any, "host-1"),
    );
    await guarded.getRuntimeLog({});
    expect(calls).toEqual([["getRuntimeLog", [{}]]]);
  });
});

describe("getRoutedHostControlClient guards host software calls", () => {
  beforeEach(() => {
    createHostControlClientMock.mockReset();
    bridgeUpgradeMock.mockReset();
  });

  it("for a host on this bay", async () => {
    resolveHostBayMock.mockResolvedValue({ bay_id: "bay-0" });
    const inner = fakeClient();
    createHostControlClientMock.mockReturnValue(inner);
    const { getRoutedHostControlClient } = await import("./client");
    const client = await getRoutedHostControlClient({ host_id: "host-1" });
    await expect(
      client.upgradeSoftware({
        targets: [{ artifact: "project-host", version: "../x" }],
      } as any),
    ).rejects.toThrow(UNSAFE);
    expect(inner.upgradeSoftware).not.toHaveBeenCalled();
  });

  it("for a host on another bay", async () => {
    resolveHostBayMock.mockResolvedValue({ bay_id: "bay-1" });
    const { getRoutedHostControlClient } = await import("./client");
    const client = await getRoutedHostControlClient({ host_id: "host-1" });
    await expect(
      client.upgradeSoftware({
        targets: [{ artifact: "project-host", version: "../x" }],
      } as any),
    ).rejects.toThrow(UNSAFE);
    expect(bridgeUpgradeMock).not.toHaveBeenCalled();
  });
});
