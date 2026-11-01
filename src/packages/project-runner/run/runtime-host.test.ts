import {
  checkHostPreconditions,
  mountFor,
  parseMountinfo,
  projectIdmappedRootfsPath,
  projectViewPath,
  projectViewSource,
  type HostState,
} from "./runtime-host";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const RUNTIME_GID = 2000;

const MOUNTINFO = [
  "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "90 22 8:17 / /mnt/cocalc rw,nosuid,nodev,relatime shared:50 - btrfs /dev/sdb rw,space_cache=v2",
  "91 22 0:25 / /run rw,nosuid,nodev,noexec shared:5 - tmpfs tmpfs rw,mode=755",
].join("\n");

function host(over: Partial<HostState> & { modes?: Record<string, number> } = {}): HostState {
  const owners: Record<string, { uid: number; gid: number; mode: number }> = {
    "/mnt/cocalc": { uid: 0, gid: RUNTIME_GID, mode: 0o40750 },
    "/run/cocalc/project-views": { uid: 0, gid: RUNTIME_GID, mode: 0o40710 },
    "/run/cocalc/project-rootfs": { uid: 0, gid: 0, mode: 0o40711 },
    "/run/cocalc": { uid: 0, gid: 0, mode: 0o40755 },
  };
  for (const [path, mode] of Object.entries(over.modes ?? {})) {
    owners[path] = { ...owners[path], mode: 0o40000 | mode };
  }
  return {
    stat: async (path) =>
      owners[path] == null ? undefined : { ...owners[path], isDirectory: true },
    mountinfo: async () => MOUNTINFO,
    runtimeGid: RUNTIME_GID,
    ...over,
  };
}

describe("runtime host", () => {
  it("names the sources and views the root helper accepts", () => {
    expect(projectViewSource(PROJECT, "home")).toBe(`/mnt/cocalc/project-${PROJECT}`);
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
    expect(mountFor(mounts, "/run/cocalc/project-views")?.mountpoint).toBe("/run");
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
        mountinfo: async () => MOUNTINFO.replace("rw,nosuid,nodev,relatime shared:50", "rw,relatime shared:50"),
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
      stat: async (path) => (paths.includes(path) ? undefined : await base.stat(path)),
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
});
