import {
  configuredRuntimeUidMode,
  parseHelperCapabilities,
  keepIdUsernsArgs,
  parseIdMap,
  resolveRuntimeIdentity,
  separateInnerId,
  separateUsernsArgs,
} from "./runtime-identity";

// The live rootless map of a host whose namespace has the block (measured on
// staging2 with the block appended after the container ranges).
const LIVE_WITH_BLOCK = [
  "         0       2000          1",
  "         1     231072      65536",
  "     65537     327680    4128768",
  "   4194305 1073741824      65536",
].join("\n");
const LIVE_WITHOUT_BLOCK = LIVE_WITH_BLOCK.split("\n").slice(0, 3).join("\n");

function inputs(
  over: Partial<{
    mode: string;
    helper: string | undefined;
    uidMap: string;
    gidMap: string;
    fail: boolean;
    unsafe: string[] | "throw";
  }> = {},
) {
  const helper = "helper" in over ? over.helper : "project-view:1 overlay-idmap:1\n";
  return {
    env: { COCALC_PROJECT_RUNTIME_UID_MODE: over.mode ?? "separate" },
    helperProbe: async () => helper,
    liveMaps: async () => {
      if (over.fail) throw new Error("podman unshare failed");
      return {
        uidMap: over.uidMap ?? LIVE_WITH_BLOCK,
        gidMap: over.gidMap ?? LIVE_WITH_BLOCK,
      };
    },
    hostPreconditions: async () => {
      if (over.unsafe === "throw") throw new Error("stat failed");
      return over.unsafe ?? [];
    },
  };
}

describe("runtime identity", () => {
  it("reads the configured mode", () => {
    expect(configuredRuntimeUidMode({})).toEqual({
      configured: "keep-id",
      mode: "keep-id",
    });
    expect(
      configuredRuntimeUidMode({ COCALC_PROJECT_RUNTIME_UID_MODE: " separate " }),
    ).toEqual({ configured: "separate", mode: "separate" });
    expect(
      configuredRuntimeUidMode({ COCALC_PROJECT_RUNTIME_UID_MODE: "sideways" }),
    ).toEqual({ configured: "sideways" });
  });

  it("parses the helper's capabilities", () => {
    expect(parseHelperCapabilities("project-view:1 overlay-idmap:2\n")).toEqual(
      new Map([
        ["project-view", 1],
        ["overlay-idmap", 2],
      ]),
    );
    for (const bad of [undefined, "", "usage: ...", "project-view"]) {
      expect(parseHelperCapabilities(bad).size).toBe(0);
    }
  });

  it("finds the block's inner id in the live map", () => {
    expect(separateInnerId(parseIdMap(LIVE_WITH_BLOCK)!)).toEqual({ inner: 4194305 });
    expect(separateInnerId(parseIdMap(LIVE_WITHOUT_BLOCK)!)).toEqual({
      reason: "map-missing-block",
    });
  });

  it("refuses an inner id that falls inside the container ranges", () => {
    // the block listed BEFORE the second container range: inner P = 65537,
    // which the container map already gives to container id 65537
    const reordered = [
      "0 2000 1",
      "1 231072 65536",
      "65537 1073741824 65536",
      "131073 327680 4128768",
    ].join("\n");
    expect(separateInnerId(parseIdMap(reordered)!)).toMatchObject({
      reason: "map-collision",
    });
  });

  it("builds today's container map with 2001 pointed at the block", () => {
    expect(separateUsernsArgs(4194305, 4194305)).toEqual([
      "--uidmap", "0:1:2001",
      "--uidmap", "2001:4194305:1",
      "--uidmap", "2002:2002:63535",
      "--uidmap", "65537:65537:4128768",
      "--gidmap", "0:1:2001",
      "--gidmap", "2001:4194305:1",
      "--gidmap", "2002:2002:63535",
      "--gidmap", "65537:65537:4128768",
    ]);
  });

  it("is separate only when the mode, the helper and the live map allow it", async () => {
    const ok = await resolveRuntimeIdentity(inputs());
    expect(ok).toMatchObject({
      mode: "separate",
      uid: 1073741824,
      gid: 1073741824,
      status: { configured: "separate", effective: "separate" },
    });
    expect(ok.usernsArgs).toContain("2001:4194305:1");

    const cases: [Parameters<typeof inputs>[0], string][] = [
      [{ mode: "keep-id" }, "mode-off"],
      [{ mode: "sideways" }, "mode-invalid"],
      [{ helper: undefined }, "helper-old"],
      [{ helper: "project-view:1" }, "helper-old"],
      [{ helper: "project-view:0 overlay-idmap:1" }, "helper-old"],
      // a newer schema number without the verb is still refused
      [{ helper: "20261031-v63" }, "helper-old"],
      [{ uidMap: LIVE_WITHOUT_BLOCK }, "map-missing-block"],
      [{ gidMap: LIVE_WITHOUT_BLOCK }, "map-missing-block"],
      [{ uidMap: "garbage" }, "map-unparsable"],
      [{ fail: true }, "map-unparsable"],
      [{ unsafe: ["/mnt/cocalc is 0755, not 0750"] }, "host-unsafe"],
      [{ unsafe: "throw" }, "host-unsafe"],
    ];
    for (const [over, reason] of cases) {
      const identity = await resolveRuntimeIdentity(inputs(over));
      expect(identity.mode).toBe("keep-id");
      expect(identity.usernsArgs).toEqual(keepIdUsernsArgs());
      expect(identity.status).toMatchObject({ effective: "keep-id", reason });
    }
  });

  it("doesn't look at the helper or the map when the mode is off", async () => {
    const helperProbe = jest.fn();
    const liveMaps = jest.fn();
    const hostPreconditions = jest.fn();
    await resolveRuntimeIdentity({ env: {}, helperProbe, liveMaps, hostPreconditions });
    expect(helperProbe).not.toHaveBeenCalled();
    expect(hostPreconditions).not.toHaveBeenCalled();
    expect(liveMaps).not.toHaveBeenCalled();
  });
});
