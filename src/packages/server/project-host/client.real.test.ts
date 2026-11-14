/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// The guarded host-control client, built from the REAL typed clients (only
// the conat transport is faked): every method still works, the software
// calls are checked, and the client stays non-thenable.

export {};

const requests: Array<{ subject: string; data: any }> = [];
let resolveHostBayMock: jest.Mock;

const fakeConat: any = {
  request: async (subject: string, data: any) => {
    requests.push({ subject, data });
    return { data: { ok: true } };
  },
};

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
    hostControl: (dest_bay: string) => {
      const { createInterBayHostControlClient } = jest.requireActual(
        "@cocalc/conat/inter-bay/api",
      );
      return createInterBayHostControlClient({ client: fakeConat, dest_bay });
    },
  }),
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostControlClient: async () => fakeConat,
}));

const UNSAFE = "invalid host software version or channel";

async function interBayMethodNames(): Promise<string[]> {
  const { createInterBayHostControlClient } =
    await import("@cocalc/conat/inter-bay/api");
  return Object.keys(
    createInterBayHostControlClient({ client: fakeConat, dest_bay: "x" }),
  );
}

describe.each([
  ["a host on this bay", "bay-0"],
  ["a host on another bay", "bay-1"],
])("getRoutedHostControlClient for %s", (_label, bay_id) => {
  beforeEach(() => {
    requests.length = 0;
    resolveHostBayMock = jest.fn(async () => ({ bay_id }));
  });

  it("returns an awaited, non-thenable client", async () => {
    const { getRoutedHostControlClient } = await import("./client");
    const client: any = await getRoutedHostControlClient({ host_id: "host-1" });
    expect(client.then).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("keeps every host-control method callable", async () => {
    const { getRoutedHostControlClient } = await import("./client");
    const client: any = await getRoutedHostControlClient({ host_id: "host-1" });
    const names = await interBayMethodNames();
    expect(names.length).toBeGreaterThan(40);
    const missing = names.filter((name) => typeof client[name] !== "function");
    expect(missing).toEqual([]);
  });

  it("sends a non-software call end to end", async () => {
    const { getRoutedHostControlClient } = await import("./client");
    const client: any = await getRoutedHostControlClient({ host_id: "host-1" });
    await client.getRuntimeLog({ lines: 5 });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].data)).toContain("lines");
  });

  it("refuses unsafe software calls with nothing sent, and sends safe ones", async () => {
    const { getRoutedHostControlClient } = await import("./client");
    const client: any = await getRoutedHostControlClient({ host_id: "host-1" });
    await expect(
      client.upgradeSoftware({
        targets: [{ artifact: "project-host", version: "../x" }],
      }),
    ).rejects.toThrow(UNSAFE);
    await expect(
      client.stageProjectHostArtifact({ version: "a/b" }),
    ).rejects.toThrow(UNSAFE);
    await expect(
      client.rolloutManagedComponents({
        components: ["project-host"],
        desired_version: "a b",
      }),
    ).rejects.toThrow(UNSAFE);
    expect(requests).toEqual([]);
    await client.upgradeSoftware({
      targets: [{ artifact: "project-host", version: "ph-v2" }],
    });
    await client.stageProjectHostArtifact({ version: "ph-v2" });
    await client.rolloutManagedComponents({
      components: ["project-host"],
      desired_version: "ph-v2",
    });
    expect(requests).toHaveLength(3);
  });
});
