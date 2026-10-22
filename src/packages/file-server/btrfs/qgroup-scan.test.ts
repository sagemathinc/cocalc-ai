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

// the subvolume at each path, as `btrfs subvolume show` says
let ids: Record<string, number>;
let scanText: string;
const scans = () =>
  btrfsMock.mock.calls.filter(
    ([opts]) => opts.args[1] === "show" && opts.args[0] === "qgroup",
  ).length;

beforeEach(() => {
  resetQgroupScansForTest();
  btrfsMock.mockReset();
  ids = { [`${MOUNT}/project-a`]: 300, [`${MOUNT}/project-a-persist`]: 302 };
  scanText = SCAN;
  btrfsMock.mockImplementation(async ({ args }: { args: string[] }) => {
    if (args[0] === "subvolume" && args[1] === "show") {
      const id = ids[args[2]];
      if (id == null) throw new Error("not a subvolume");
      return { stdout: `Name: x\nSubvolume ID:\t\t${id}\n`, stderr: "" };
    }
    return { stdout: scanText, stderr: "" };
  });
  delete process.env.COCALC_BTRFS_QGROUP_SCAN_CACHE_MS;
});

const idOf = (path: string) => async () => ids[path];

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
  });
});

describe("lookupQgroup", () => {
  it("finds a subvolume by its id, with the groups it is in", async () => {
    const found = await lookupQgroup({
      mount: MOUNT,
      getSubvolumeId: idOf(`${MOUNT}/project-a`),
    });
    expect(found!.row.qgroupid).toBe("0/300");
    expect(found!.parents.map((r) => r.qgroupid)).toEqual(["1/77"]);
  });

  it("reads the filesystem once for many lookups", async () => {
    await Promise.all(
      [300, 301, 302].map(
        async (id) =>
          await lookupQgroup({ mount: MOUNT, getSubvolumeId: async () => id }),
      ),
    );
    await getQgroupScan(MOUNT);
    expect(scans()).toBe(1);
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
      expect(scans()).toBe(1);
      spy.mockReturnValue(now + 31_000);
      await getQgroupScan(MOUNT);
      expect(scans()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("reads again for a subvolume it doesn't know, once", async () => {
    await getQgroupScan(MOUNT);
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + 5_000);
    try {
      // a subvolume made since
      scanText = `${SCAN}0/400 16384 16384 none - - project-new\n`;
      const fresh = await lookupQgroup({
        mount: MOUNT,
        getSubvolumeId: async () => 400,
      });
      expect(fresh!.row.qgroupid).toBe("0/400");
      expect(scans()).toBe(2);
      // one that doesn't exist: not found, without reading again at once
      expect(
        await lookupQgroup({ mount: MOUNT, getSubvolumeId: async () => 999 }),
      ).toBeUndefined();
      expect(scans()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("keeping what was read current", () => {
  it("updates a limit this host set, without reading again", async () => {
    await getQgroupScan(MOUNT);
    await noteQgroupLimit({
      mount: MOUNT,
      path: `${MOUNT}/project-a`,
      size: "5000",
    });
    const found = await lookupQgroup({
      mount: MOUNT,
      getSubvolumeId: idOf(`${MOUNT}/project-a`),
    });
    expect(found!.row.max_referenced).toBe(5000);
    expect(scans()).toBe(1);
  });

  it("never puts a limit on the row of a subvolume no longer at the path", async () => {
    await getQgroupScan(MOUNT);
    // a restore put another home (0/400) at project-a's path
    ids[`${MOUNT}/project-a`] = 400;
    scanText = `${SCAN}0/400 16384 16384 none - - project-a\n`.replace(
      "project-a\n",
      "<stale>\n",
    );
    await noteQgroupLimit({
      mount: MOUNT,
      path: `${MOUNT}/project-a`,
      size: 5000,
    });
    // the new home is read as it is, the old one's row left alone
    const found = await lookupQgroup({
      mount: MOUNT,
      getSubvolumeId: idOf(`${MOUNT}/project-a`),
    });
    expect(found!.row.qgroupid).toBe("0/400");
    expect(found!.row.max_referenced).toBe("none");
    expect(scans()).toBe(2);
  });

  it("reads again after a limit it can't place, or other changes", async () => {
    await getQgroupScan(MOUNT);
    await noteQgroupLimit({
      mount: MOUNT,
      path: `${MOUNT}/project-a`,
      size: "10G",
    });
    await getQgroupScan(MOUNT);
    expect(scans()).toBe(2);
    invalidateQgroupScan(`${MOUNT}/project-a/.snapshots`);
    await getQgroupScan(MOUNT);
    expect(scans()).toBe(3);
  });

  it("gives no one a read that was under way when something changed", async () => {
    let finish!: () => void;
    btrfsMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finish = () => resolve({ stdout: SCAN, stderr: "" });
        }),
    );
    const old = getQgroupScan(MOUNT);
    await new Promise((r) => setImmediate(r));
    // e.g., a limit set, as btrfs now says
    scanText = SCAN.replace("200000      1000000000", "200000            5000");
    invalidateQgroupScan(MOUNT);
    // asked after the change: a new read, not the one under way
    const found = lookupQgroup({
      mount: MOUNT,
      getSubvolumeId: async () => 300,
    });
    expect((await found)!.row.max_referenced).toBe(5000);
    // the old read finishing never replaces the newer one
    finish();
    await old;
    expect(
      (await lookupQgroup({ mount: MOUNT, getSubvolumeId: async () => 300 }))!
        .row.max_referenced,
    ).toBe(5000);
    expect(scans()).toBe(2);
  });
});

describe("forgetSubvolumePaths", () => {
  it("drops the quota scan and the cached subvolume ids of moved paths", async () => {
    const { cachedBtrfsSubvolumeShow, forgetSubvolumePaths } =
      await import("./operation-cache");
    await getQgroupScan(MOUNT);
    expect(
      (await cachedBtrfsSubvolumeShow(`${MOUNT}/project-a`)).stdout,
    ).toMatch(/Subvolume ID:\s*300/);
    // a restore puts another home at the path
    ids[`${MOUNT}/project-a`] = 400;
    forgetSubvolumePaths(`${MOUNT}/project-a`);
    expect(
      (await cachedBtrfsSubvolumeShow(`${MOUNT}/project-a`)).stdout,
    ).toMatch(/Subvolume ID:\s*400/);
    await getQgroupScan(MOUNT);
    expect(scans()).toBe(2);
  });
});
