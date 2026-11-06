import {
  checkHostPreconditions,
  clearRuntimeIdentityCache,
  mountFor,
  parseMountinfo,
  projectIdmappedRootfsPath,
  projectViewPath,
  projectViewSource,
  runtimeIdentityForStart,
  runtimeUidModeLabel,
  runtimeUidModeReport,
  sharedScratchPaths,
  viewSourceMountFailures,
  type HostState,
  type RuntimeHostInputs,
} from "./runtime-host";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const RUNTIME_GID = 2000;

const MOUNTINFO = [
  "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "90 22 8:17 / /mnt/cocalc rw,nosuid,nodev,relatime shared:50 - btrfs /dev/sdb rw,space_cache=v2",
  "91 22 0:25 / /run rw,nosuid,nodev,noexec shared:5 - tmpfs tmpfs rw,mode=755",
].join("\n");

type Entry = { uid: number; gid: number; mode: number; isDirectory: boolean };

function host(
  over: Partial<HostState> & {
    modes?: Record<string, number>;
    entries?: Record<string, Partial<Entry>>;
  } = {},
): HostState {
  const owners: Record<string, Entry> = {
    "/mnt/cocalc": {
      uid: 0,
      gid: RUNTIME_GID,
      mode: 0o40750,
      isDirectory: true,
    },
    "/run/cocalc/project-views": {
      uid: 0,
      gid: RUNTIME_GID,
      mode: 0o40710,
      isDirectory: true,
    },
    "/run/cocalc/project-rootfs": {
      uid: 0,
      gid: 0,
      mode: 0o40711,
      isDirectory: true,
    },
    "/run/cocalc": { uid: 0, gid: 0, mode: 0o40755, isDirectory: true },
  };
  for (const [path, mode] of Object.entries(over.modes ?? {})) {
    owners[path] = { ...owners[path], mode: 0o40000 | mode };
  }
  for (const [path, entry] of Object.entries(over.entries ?? {})) {
    owners[path] = { ...owners[path], ...entry };
  }
  return {
    stat: async (path) => (owners[path] == null ? undefined : owners[path]),
    mountinfo: async () => MOUNTINFO,
    runtimeGid: RUNTIME_GID,
    ...over,
  };
}

describe("runtime host", () => {
  it("names the sources and views the root helper accepts", () => {
    expect(projectViewSource(PROJECT, "home")).toBe(
      `/mnt/cocalc/project-${PROJECT}`,
    );
    expect(projectViewSource(PROJECT, "scratch")).toBe(
      `/mnt/cocalc/project-${PROJECT}-scratch`,
    );
    expect(projectViewSource(PROJECT, "secrets")).toBe(
      `/mnt/cocalc/data/tmp/cocalc-project-secrets/${PROJECT}`,
    );
    expect(projectViewSource(PROJECT, "browser-run")).toBe(
      `/mnt/cocalc/data/tmp/cocalc-browser-run/${PROJECT}`,
    );
    expect(projectViewPath(PROJECT, "home")).toBe(
      `/run/cocalc/project-views/${PROJECT}/home`,
    );
    expect(projectIdmappedRootfsPath(PROJECT)).toBe(
      `/run/cocalc/project-rootfs/${PROJECT}/root`,
    );
  });

  it("finds the mount that holds a path, with its options", () => {
    const mounts = parseMountinfo(MOUNTINFO);
    expect(mountFor(mounts, "/mnt/cocalc")?.options).toEqual(
      expect.arrayContaining(["nosuid", "nodev"]),
    );
    expect(mountFor(mounts, "/mnt/cocalcx")?.mountpoint).toBe("/");
    expect(mountFor(mounts, "/run/cocalc/project-views")?.mountpoint).toBe(
      "/run",
    );
  });

  it("passes a hardened host", async () => {
    expect(await checkHostPreconditions(host())).toEqual([]);
  });

  it("lists every unsafe precondition", async () => {
    const failures = await checkHostPreconditions(
      host({
        modes: {
          "/mnt/cocalc": 0o755,
          "/run/cocalc/project-views": 0o711,
          "/run/cocalc": 0o775,
        },
        mountinfo: async () =>
          MOUNTINFO.replace(
            "rw,nosuid,nodev,relatime shared:50",
            "rw,relatime shared:50",
          ),
        sharedScratch: "/mnt/cocalc/data/shared-scratch",
      }),
    );
    expect(failures).toEqual([
      expect.stringContaining("/mnt/cocalc is 0:2000 755"),
      expect.stringContaining("/run/cocalc/project-views is 0:2000 711"),
      "/run/cocalc is not root-owned or is group/other-writable",
      "/mnt/cocalc is not mounted nosuid",
      "/mnt/cocalc is not mounted nodev",
      expect.stringContaining("shared scratch"),
    ]);
  });

  it("allows the helper's dirs to be missing before the first mount, not the data root", async () => {
    const base = host();
    const missing = (paths: string[]): HostState => ({
      ...base,
      stat: async (path) =>
        paths.includes(path) ? undefined : await base.stat(path),
    });
    expect(
      await checkHostPreconditions(
        missing(["/run/cocalc/project-views", "/run/cocalc/project-rootfs"]),
      ),
    ).toEqual([]);
    expect(await checkHostPreconditions(missing(["/mnt/cocalc"]))).toEqual([
      "/mnt/cocalc is missing",
    ]);
  });

  it("checks the group of the data root and the views dir", async () => {
    // any other group might be one the project user is in
    expect(
      await checkHostPreconditions(
        host({
          entries: {
            "/mnt/cocalc": { gid: 0 },
            "/run/cocalc/project-views": { gid: 100 },
          },
        }),
      ),
    ).toEqual([
      expect.stringContaining("/mnt/cocalc is 0:0 750, not 0:2000 750"),
      expect.stringContaining(
        "/run/cocalc/project-views is 0:100 710, not 0:2000 710",
      ),
    ]);
  });

  it("refuses a symlink or a file where a directory belongs", async () => {
    // stat is lstat: a symlink to a good dir is not a directory
    expect(
      await checkHostPreconditions(
        host({
          entries: {
            "/mnt/cocalc": { isDirectory: false, mode: 0o120777 },
            "/run/cocalc/project-rootfs": { isDirectory: false },
          },
        }),
      ),
    ).toEqual([
      "/mnt/cocalc is not a directory",
      "/run/cocalc/project-rootfs is not a directory",
    ]);
  });

  it("reads the mount in effect when mounts are stacked", async () => {
    const over = (lower: string, upper: string) =>
      [
        "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
        `90 22 8:17 / /mnt/cocalc ${lower} shared:50 - btrfs /dev/sdb rw`,
        `95 90 8:18 / /mnt/cocalc ${upper} shared:51 - btrfs /dev/sdc rw`,
      ].join("\n");
    const hidden = over("rw,nosuid,nodev,relatime", "rw,relatime");
    expect(
      mountFor(parseMountinfo(hidden), "/mnt/cocalc/x")?.options,
    ).not.toContain("nosuid");
    expect(
      await checkHostPreconditions(host({ mountinfo: async () => hidden })),
    ).toEqual([
      "/mnt/cocalc is not mounted nosuid",
      "/mnt/cocalc is not mounted nodev",
    ]);
    // control: the flags on the mount in effect pass
    const shown = over("rw,relatime", "rw,nosuid,nodev,relatime");
    expect(
      await checkHostPreconditions(host({ mountinfo: async () => shown })),
    ).toEqual([]);
  });

  it("refuses shared scratch on the host even when projects don't mount it", async () => {
    const paths = sharedScratchPaths({});
    expect(paths).toEqual(["/mnt/cocalc-scratch"]);
    expect(
      sharedScratchPaths({ COCALC_SHARED_SCRATCH_HOST_MOUNT: "/srv/scratch" }),
    ).toEqual(["/mnt/cocalc-scratch", "/srv/scratch"]);
    // mounted
    expect(
      await checkHostPreconditions(
        host({
          sharedScratchPaths: paths,
          mountinfo: async () =>
            `${MOUNTINFO}\n92 22 8:33 / /mnt/cocalc-scratch rw,relatime shared:60 - ext4 /dev/sdd rw`,
        }),
      ),
    ).toEqual([
      "shared scratch /mnt/cocalc-scratch is mounted outside /mnt/cocalc",
    ]);
    // present but not a mount
    expect(
      await checkHostPreconditions(
        host({
          sharedScratchPaths: paths,
          entries: {
            "/mnt/cocalc-scratch": {
              uid: 2000,
              gid: 2000,
              mode: 0o41777,
              isDirectory: true,
            },
          },
        }),
      ),
    ).toEqual([
      "shared scratch /mnt/cocalc-scratch exists outside /mnt/cocalc",
    ]);
    // control: absent
    expect(
      await checkHostPreconditions(host({ sharedScratchPaths: paths })),
    ).toEqual([]);
  });

  it("requires each view source on a nosuid,nodev mount", () => {
    const home = projectViewSource(PROJECT, "home");
    expect(viewSourceMountFailures(MOUNTINFO, [home])).toEqual([]);
    const bound = `${MOUNTINFO}\n93 90 8:17 /x ${home} rw,relatime shared:61 - btrfs /dev/sdb rw`;
    expect(viewSourceMountFailures(bound, [home])).toEqual([
      `${home} is on ${home}, not mounted nosuid`,
      `${home} is on ${home}, not mounted nodev`,
    ]);
  });

  it("never shows a partial or fallen-back host as plainly separate or keep-id", () => {
    expect(
      runtimeUidModeLabel({ configured: "separate", effective: "separate" }),
    ).toBe("separate (partial)");
    expect(
      runtimeUidModeLabel({
        configured: "separate",
        effective: "keep-id",
        reason: "host-unsafe",
      }),
    ).toBe("keep-id (fallback: host-unsafe)");
    expect(
      runtimeUidModeLabel({ configured: "seperate", effective: "keep-id" }),
    ).toBe("keep-id (fallback: unknown)");
    expect(
      runtimeUidModeLabel({ configured: "keep-id", effective: "keep-id" }),
    ).toBe("keep-id");
  });
});

describe("runtime identity for a start", () => {
  const LIVE_WITH_BLOCK = [
    "         0       2000          1",
    "         1     231072      65536",
    "     65537     327680    4128768",
    "   4194305 1073741824      65536",
  ].join("\n");
  const saved = process.env.COCALC_PROJECT_RUNTIME_UID_MODE;

  function startInputs(state: { mountinfo: string }) {
    const counts = { probe: 0, maps: 0, harden: 0 };
    const inputs: RuntimeHostInputs = {
      helperProbe: async () => {
        counts.probe += 1;
        return "project-view:1 overlay-idmap:1\n";
      },
      liveMaps: async () => {
        counts.maps += 1;
        return { uidMap: LIVE_WITH_BLOCK, gidMap: LIVE_WITH_BLOCK };
      },
      harden: async () => {
        counts.harden += 1;
      },
      host: (sharedScratch) =>
        host({ sharedScratch, mountinfo: async () => state.mountinfo }),
    };
    return { inputs, counts };
  }

  beforeEach(() => {
    clearRuntimeIdentityCache();
    process.env.COCALC_PROJECT_RUNTIME_UID_MODE = "separate";
  });

  afterEach(() => {
    if (saved == null) delete process.env.COCALC_PROJECT_RUNTIME_UID_MODE;
    else process.env.COCALC_PROJECT_RUNTIME_UID_MODE = saved;
  });

  it("checks the host on every start; only the probe and the map are cached", async () => {
    const state = { mountinfo: MOUNTINFO };
    const { inputs, counts } = startInputs(state);
    const first = await runtimeIdentityForStart({ inputs });
    expect(first.mode).toBe("separate");
    expect(runtimeUidModeReport()?.label).toBe("separate (partial)");

    // /mnt/cocalc loses nosuid between two starts; nothing clears the cache
    state.mountinfo = MOUNTINFO.replace(
      "rw,nosuid,nodev,relatime shared:50",
      "rw,nodev,relatime shared:50",
    );
    const second = await runtimeIdentityForStart({ inputs });
    expect(second.mode).toBe("keep-id");
    expect(second.status).toMatchObject({
      configured: "separate",
      effective: "keep-id",
      reason: "host-unsafe",
      detail: expect.stringContaining("/mnt/cocalc is not mounted nosuid"),
    });
    expect(runtimeUidModeReport()?.label).toBe(
      "keep-id (fallback: host-unsafe)",
    );
    expect(counts).toEqual({ probe: 1, maps: 1, harden: 2 });
  });

  it("refuses a configured shared scratch on a later start", async () => {
    const { inputs } = startInputs({ mountinfo: MOUNTINFO });
    expect((await runtimeIdentityForStart({ inputs })).mode).toBe("separate");
    const later = await runtimeIdentityForStart({
      inputs,
      sharedScratch: "/mnt/cocalc-scratch",
    });
    expect(later.status.reason).toBe("host-unsafe");
  });

  it("does not keep a failed map read", async () => {
    const { inputs, counts } = startInputs({ mountinfo: MOUNTINFO });
    let fail = true;
    const liveMaps = inputs.liveMaps;
    inputs.liveMaps = async () => {
      if (fail) throw new Error("podman unshare failed");
      return await liveMaps();
    };
    expect((await runtimeIdentityForStart({ inputs })).status.reason).toBe(
      "map-unparsable",
    );
    fail = false;
    expect((await runtimeIdentityForStart({ inputs })).mode).toBe("separate");
    expect(counts.maps).toBe(1);
  });
});
