const btrfsMock = jest.fn(async (_opts?: any) => ({ stdout: "", stderr: "" }));

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
}));

import {
  getQgroupScan,
  invalidateQgroupScan,
  lookupQgroup,
  noteQgroupLimit,
  parseQgroupScan,
  resetQgroupScansForTest,
} from "./qgroup-scan";

const MOUNT = "/mnt/cocalc";

// what `btrfs qgroup show -prc --raw` prints, with a project's group
const SCAN = `
Qgroupid            Referenced    Exclusive  Max referenced Parent            Child              Path
--------            ----------    ---------  -------------- ------            -----              ----
0/5                   10473472     10473472            none -                 -                  <toplevel>
0/262               1767661568   1767661568            none 1/77              -                  <stale>
0/300                   200000       200000      1000000000 1/77              -                  project-a
0/301                    16384        16384            none 1/77              -                  project-a/.snapshots/2026-10-22T00:00:00.000Z
0/302                    50000        50000       100000000 1/77              -                  project-a-persist
1/77                1768000000   1768000000      1100000000 -                 0/262,0/300,0/301,0/302 <4 member qgroups>
`;

const getSubvolumeId = jest.fn(async () => 300);

beforeEach(() => {
  resetQgroupScansForTest();
  btrfsMock.mockReset();
  btrfsMock.mockResolvedValue({ stdout: SCAN, stderr: "" });
  getSubvolumeId.mockClear();
  delete process.env.COCALC_BTRFS_QGROUP_SCAN_CACHE_MS;
});

describe("parseQgroupScan", () => {
  it("has every qgroup, with parents, children and paths", () => {
    const scan = parseQgroupScan(SCAN);
    expect(scan.rows.size).toBe(6);
    expect(scan.rows.get("0/300")).toEqual({
      qgroupid: "0/300",
      referenced: 200000,
      exclusive: 200000,
      max_referenced: 1000000000,
      parents: ["1/77"],
      children: [],
      path: "project-a",
    });
    expect(scan.rows.get("1/77")!.children).toEqual([
      "0/262",
      "0/300",
      "0/301",
      "0/302",
    ]);
    expect(scan.rows.get("0/262")!.path).toBeUndefined();
    expect([...scan.byPath.keys()]).toEqual([
      "project-a",
      "project-a/.snapshots/2026-10-22T00:00:00.000Z",
      "project-a-persist",
    ]);
  });
});

describe("lookupQgroup", () => {
  it("finds a subvolume by its path, with the groups it is in", async () => {
    const found = await lookupQgroup({
      mount: MOUNT,
      path: `${MOUNT}/project-a`,
      getSubvolumeId,
    });
    expect(found!.row.qgroupid).toBe("0/300");
    expect(found!.parents.map((r) => r.qgroupid)).toEqual(["1/77"]);
    expect(getSubvolumeId).not.toHaveBeenCalled();
  });

  it("reads the filesystem once for many lookups", async () => {
    await Promise.all(
      [
        "project-a",
        "project-a-persist",
        "project-a/.snapshots/2026-10-22T00:00:00.000Z",
      ].map(
        async (p) =>
          await lookupQgroup({
            mount: MOUNT,
            path: `${MOUNT}/${p}`,
            getSubvolumeId,
          }),
      ),
    );
    await getQgroupScan(MOUNT);
    expect(btrfsMock).toHaveBeenCalledTimes(1);
    expect(btrfsMock).toHaveBeenCalledWith({
      verbose: false,
      args: ["qgroup", "show", "-prc", "--raw", MOUNT],
    });
  });

  it("reads again once what it read is old", async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      await getQgroupScan(MOUNT);
      spy.mockReturnValue(now + 29_000);
      await getQgroupScan(MOUNT);
      expect(btrfsMock).toHaveBeenCalledTimes(1);
      spy.mockReturnValue(now + 31_000);
      await getQgroupScan(MOUNT);
      expect(btrfsMock).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("finds by subvolume id if not by path, and reads again for one it doesn't know", async () => {
    // (a mount that isn't the top level: paths don't match)
    const found = await lookupQgroup({
      mount: "/elsewhere",
      path: "/elsewhere/x",
      getSubvolumeId: async () => 302,
    });
    expect(found!.row.path).toBe("project-a-persist");
    // a subvolume made since: not in what was read a while ago
    await getQgroupScan(MOUNT);
    expect(btrfsMock).toHaveBeenCalledTimes(2);
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + 5_000);
    try {
      btrfsMock.mockResolvedValueOnce({
        stdout: `${SCAN}0/400 16384 16384 none - - project-new\n`,
        stderr: "",
      });
      const fresh = await lookupQgroup({
        mount: MOUNT,
        path: `${MOUNT}/project-new`,
        getSubvolumeId: async () => 400,
      });
      expect(fresh!.row.qgroupid).toBe("0/400");
      expect(btrfsMock).toHaveBeenCalledTimes(3);
      // one that doesn't exist: not found, without reading again at once
      expect(
        await lookupQgroup({
          mount: MOUNT,
          path: `${MOUNT}/project-gone`,
          getSubvolumeId: async () => 999,
        }),
      ).toBeUndefined();
      expect(btrfsMock).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("keeping what was read current", () => {
  it("updates a limit this host set, without reading again", async () => {
    await getQgroupScan(MOUNT);
    noteQgroupLimit({ mount: MOUNT, path: `${MOUNT}/project-a`, size: "5000" });
    const found = await lookupQgroup({
      mount: MOUNT,
      path: `${MOUNT}/project-a`,
      getSubvolumeId,
    });
    expect(found!.row.max_referenced).toBe(5000);
    expect(btrfsMock).toHaveBeenCalledTimes(1);
  });

  it("reads again after a limit it can't place, or other changes", async () => {
    await getQgroupScan(MOUNT);
    noteQgroupLimit({ mount: MOUNT, path: `${MOUNT}/project-a`, size: "10G" });
    await getQgroupScan(MOUNT);
    expect(btrfsMock).toHaveBeenCalledTimes(2);
    invalidateQgroupScan(`${MOUNT}/project-a/.snapshots`);
    await getQgroupScan(MOUNT);
    expect(btrfsMock).toHaveBeenCalledTimes(3);
  });

  it("never keeps a read that was under way when something changed", async () => {
    let finish!: () => void;
    btrfsMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finish = () => resolve({ stdout: SCAN, stderr: "" });
        }),
    );
    const reading = getQgroupScan(MOUNT);
    await new Promise((r) => setImmediate(r));
    noteQgroupLimit({ mount: MOUNT, path: `${MOUNT}/project-a`, size: 5000 });
    finish();
    await reading;
    await getQgroupScan(MOUNT);
    expect(btrfsMock).toHaveBeenCalledTimes(2);
  });
});
