/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const loadEffectiveMock = jest.fn();
const listMock = jest.fn();
const isAdminMock = jest.fn();

jest.mock("@cocalc/database/postgres/project-host-runtime-deployments", () => ({
  __esModule: true,
  loadEffectiveProjectHostRuntimeDeployments: (...args: any[]) =>
    loadEffectiveMock(...args),
  listProjectHostRuntimeDeployments: (...args: any[]) => listMock(...args),
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

describe("host software versions and channels", () => {
  it.each([
    "1776486535462",
    "2026_10_02.cba3570",
    "5.8.2",
    "ph-v2",
    "bundle-b",
    "tools-20260330",
    "20260501T024149Z-d8da8fa36b1e-dirty-789d9dbc",
    "x".repeat(128),
  ])("accepts the version %s", async (version) => {
    const { isSafeHostSoftwareVersion } = await import("./host-software-admin");
    expect(isSafeHostSoftwareVersion(version)).toBe(true);
  });

  it.each([
    ["traversal", "../x"],
    ["embedded traversal", "a/../b"],
    ["a dot pair", "a..b"],
    ["a slash", "a/b"],
    ["a backslash", "a\\b"],
    ["an encoded dot pair", "%2e%2e"],
    ["an encoded slash", "a%2fb"],
    ["a query", "a?b"],
    ["a fragment", "a#b"],
    ["a colon", "a:b"],
    ["a space", "a b"],
    ["a tab", "a\tb"],
    ["a newline", "a\nb"],
    ["a control character", "a\u0000b"],
    ["a leading dot", ".hidden"],
    ["a leading hyphen", "-x"],
    ["a plus", "1.0+build"],
    ["the reserved current", "current"],
    ["the reserved downloads", "downloads"],
    ["an empty value", ""],
    ["129 characters", "x".repeat(129)],
    ["a non-ASCII letter", "vé"],
    ["a number", 5],
    ["an object", { toString: () => "ph-v2" }],
  ])("refuses a version with %s", async (_label, version) => {
    const { isSafeHostSoftwareVersion } = await import("./host-software-admin");
    expect(isSafeHostSoftwareVersion(version)).toBe(false);
  });

  it("accepts exactly the latest and staging channels", async () => {
    const { isSafeHostSoftwareChannel } = await import("./host-software-admin");
    expect(isSafeHostSoftwareChannel("latest")).toBe(true);
    expect(isSafeHostSoftwareChannel("staging")).toBe(true);
    for (const channel of ["stable", "LATEST", "", "latest/..", " latest", 1]) {
      expect(isSafeHostSoftwareChannel(channel)).toBe(false);
    }
  });

  it.each([
    ["an upgrade target's version", { targets: [{ version: "../x" }] }],
    ["an upgrade target's channel", { targets: [{ channel: "x/y" }] }],
    ["a deployment's version", { deployments: [{ desired_version: "a b" }] }],
    ["a desired version", { desired_version: "a?b" }],
    ["a version", { version: "current" }],
  ])("finds an unsafe selection in %s", async (_label, input) => {
    const { unsafeHostSoftwareSelection, assertSafeHostSoftwareSelection } =
      await import("./host-software-admin");
    expect(unsafeHostSoftwareSelection(input)).toBe(true);
    expect(() => assertSafeHostSoftwareSelection(input)).toThrow(
      "invalid host software version or channel",
    );
  });

  it("accepts a selection that names nothing, or only safe values", async () => {
    const { unsafeHostSoftwareSelection } =
      await import("./host-software-admin");
    for (const input of [
      undefined,
      {},
      { targets: [{ artifact: "project-host" }] },
      {
        targets: [
          { artifact: "tools", version: "tools-7", channel: "staging" },
        ],
      },
      { deployments: [{ desired_version: "ph-v2" }] },
      { desired_version: "ph-v2", version: null },
    ]) {
      expect(unsafeHostSoftwareSelection(input)).toBe(false);
    }
  });
});

describe("loadTrustedEffectiveRuntimeDeployments", () => {
  const row = (scope_type: "global" | "host", extra: any) => ({
    scope_type,
    scope_id: scope_type === "global" ? "global" : "host-1",
    host_id: scope_type === "global" ? undefined : "host-1",
    target_type: "artifact",
    target: "project-host",
    desired_version: "ph-v2",
    requested_by: "admin-account",
    requested_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...extra,
  });
  const globalRow = row("global", { desired_version: "ph-global" });

  beforeEach(() => {
    isAdminMock.mockReset();
    isAdminMock.mockImplementation(
      async (id: string) => id === "admin-account",
    );
    listMock.mockReset();
    listMock.mockResolvedValue([globalRow]);
    loadEffectiveMock.mockReset();
  });

  it("keeps the global defaults and a host's own rows that an admin set", async () => {
    const hostRow = row("host", { target: "tools", desired_version: "t-1" });
    loadEffectiveMock.mockResolvedValue([globalRow, hostRow]);
    const { loadTrustedEffectiveRuntimeDeployments } =
      await import("./host-software-admin");
    await expect(
      loadTrustedEffectiveRuntimeDeployments({ host_id: "host-1" }),
    ).resolves.toEqual([globalRow, hostRow]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it.each([
    ["set by a non-admin", { requested_by: "owner-account" }],
    ["set by nobody", { requested_by: "" }],
    ["with an unsafe version", { desired_version: "../x" }],
  ])(
    "falls back to the global default for a host row %s",
    async (_label, extra) => {
      loadEffectiveMock.mockResolvedValue([row("host", extra)]);
      const { loadTrustedEffectiveRuntimeDeployments } =
        await import("./host-software-admin");
      await expect(
        loadTrustedEffectiveRuntimeDeployments({ host_id: "host-1" }),
      ).resolves.toEqual([globalRow]);
      expect(listMock).toHaveBeenCalledWith({ scope_type: "global" });
    },
  );

  it("drops an untrusted host row when there is no global default", async () => {
    listMock.mockResolvedValue([]);
    loadEffectiveMock.mockResolvedValue([
      row("host", { requested_by: "owner-account" }),
    ]);
    const { loadTrustedEffectiveRuntimeDeployments } =
      await import("./host-software-admin");
    await expect(
      loadTrustedEffectiveRuntimeDeployments({ host_id: "host-1" }),
    ).resolves.toEqual([]);
  });

  it("treats a requester whose admin status can't be read as a non-admin", async () => {
    isAdminMock.mockRejectedValue(new Error("home bay unreachable"));
    loadEffectiveMock.mockResolvedValue([row("host", {})]);
    const { loadTrustedEffectiveRuntimeDeployments } =
      await import("./host-software-admin");
    await expect(
      loadTrustedEffectiveRuntimeDeployments({ host_id: "host-1" }),
    ).resolves.toEqual([globalRow]);
  });

  it("drops a global row with an unsafe version", async () => {
    const bad = row("global", { desired_version: "a b" });
    loadEffectiveMock.mockResolvedValue([bad]);
    const { loadTrustedEffectiveRuntimeDeployments } =
      await import("./host-software-admin");
    await expect(
      loadTrustedEffectiveRuntimeDeployments({ host_id: "host-1" }),
    ).resolves.toEqual([]);
  });
});

describe("automatic artifact upgrade planning", () => {
  it("skips a stored version that is not safe, and keeps the safe ones", async () => {
    const { computeAutomaticArtifactUpgradeTargets } =
      await import("./hosts-runtime-deployment-planning");
    const deployment = (target: string, desired_version: string) => ({
      scope_type: "global",
      scope_id: "global",
      target_type: "artifact",
      target,
      desired_version,
      requested_by: "admin-account",
      requested_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    });
    expect(
      computeAutomaticArtifactUpgradeTargets({
        status: {
          effective: [
            deployment("project-host", "../../etc"),
            deployment("tools", "tools-7"),
          ],
          observed_targets: [],
        } as any,
      }),
    ).toEqual([{ artifact: "tools", version: "tools-7" }]);
  });
});

describe("who reads a host's effective runtime deployments", () => {
  it("is only the trusted loader: no other server code reads them unfiltered", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "..", "..");
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (
          /\.(ts|tsx|js|mjs)$/.test(name) &&
          !/\.test\.(ts|tsx|js|mjs)$/.test(name) &&
          readFileSync(path, "utf8").includes(
            "loadEffectiveProjectHostRuntimeDeployments",
          )
        ) {
          readers.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(readers).toEqual(["conat/api/host-software-admin.ts"]);
  });
});

describe("the last check before a version reaches a host", () => {
  it("refuses an unsafe selection for a host, and passes a safe one", async () => {
    const { assertSafeHostSoftwareSelectionForHost } =
      await import("./host-software-admin");
    expect(() =>
      assertSafeHostSoftwareSelectionForHost(
        { targets: [{ version: "../x" }] },
        "host-1",
        "upgrade",
      ),
    ).toThrow("invalid host software version or channel");
    expect(() =>
      assertSafeHostSoftwareSelectionForHost(
        { version: "ph-v2" },
        "host-1",
        "stage",
      ),
    ).not.toThrow();
  });

  it("keeps a safe version and drops an unsafe or empty one", async () => {
    const { safeHostSoftwareVersionOrUndefined } =
      await import("./host-software-admin");
    expect(safeHostSoftwareVersionOrUndefined("ph-v2", "h", "x")).toBe("ph-v2");
    for (const value of ["../x", "a/b", "", undefined, null, 5]) {
      expect(
        safeHostSoftwareVersionOrUndefined(value, "h", "x"),
      ).toBeUndefined();
    }
  });
});
