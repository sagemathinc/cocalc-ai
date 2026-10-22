const existing = new Set<string>();
const queued: any[] = [];
let queueError: Error | undefined;
const destroyed: string[] = [];
// what `btrfs qgroup show -prc --raw /mnt/cocalc` prints
let filesystemQgroups = "";
const scans = jest.fn();
// the subvolume at each path, as `btrfs subvolume show` says
const ids = new Map<string, number>();
const subvolumeShow = (path: string) => ({
  stdout: `Subvolume ID:\t${ids.get(path) ?? 999}\n`,
  stderr: "",
  exit_code: 0,
});

jest.mock("@cocalc/file-server/btrfs/operation-cache", () => ({
  cachedBtrfsSubvolumeShow: jest.fn(async (path: string) =>
    subvolumeShow(path),
  ),
}));
jest.mock("@cocalc/file-server/btrfs/quota-queue", () => ({
  queueSyncQuotaGroup: jest.fn(async (opts: any) => {
    queued.push(opts);
    if (queueError) throw queueError;
  }),
}));
jest.mock("@cocalc/file-server/btrfs/quota-group", () => ({
  ...jest.requireActual("@cocalc/file-server/btrfs/quota-group"),
  addToQuotaGroup: jest.fn(),
  destroyQuotaGroup: jest.fn(async ({ group }: { group: string }) => {
    destroyed.push(group);
  }),
}));
jest.mock("@cocalc/file-server/btrfs/util", () => ({
  refusedByStorageWrapper: (err: unknown) =>
    /SECURITY_DENY/.test(`${(err as any)?.message ?? err}`),
  btrfs: jest.fn(async ({ args }: { args: string[] }) => {
    if (args[0] === "subvolume" && args[1] === "show") {
      return subvolumeShow(args[2]);
    }
    scans(args);
    return { stdout: filesystemQgroups, stderr: "", exit_code: 0 };
  }),
}));
jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: jest.fn(async (path: string) => existing.has(path)),
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

import {
  deleteEmptyQuotaGroups,
  effectiveQuotaUsage,
  historyReserve,
  joinProjectQuotaGroup,
  limitNewProjectQuotaGroup,
  projectQuotaGroup,
  projectQuotaGroupInSync,
  projectQuotaGroupLimit,
  projectQuotaGroupsPermitted,
  projectQuotaWithHistory,
  syncProjectQuotaGroup,
} from "./project-quota-group";
import { resetQgroupScansForTest } from "@cocalc/file-server/btrfs/qgroup-scan";

const PROJECT = "00000000-1111-4222-8333-444444444444";
const GROUP = projectQuotaGroup(PROJECT);
const HOME = `/mnt/cocalc/project-${PROJECT}`;
const HISTORY = `/mnt/cocalc/project-${PROJECT}-persist`;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const HEADER = `Qgroupid Referenced Exclusive Max referenced Parent Child Path
-------- ---------- --------- -------------- ------ ----- ----
`;

// The filesystem's quotas: the home (0/256) and history (0/257, or `id`),
// each in GROUP if `member`, and GROUP if either is.
function filesystem({
  home,
  history,
  groupLimit = "none",
}: {
  home?: { own: number; member?: boolean; limit?: number };
  history?: { own: number; member?: boolean; id?: number; limit?: number };
  groupLimit?: number | "none";
}): void {
  const rows: string[] = [`0/5 16384 16384 none - - <toplevel>`];
  const members: string[] = [];
  let total = 0;
  for (const [v, id, path] of [
    [home, 256, `project-${PROJECT}`],
    [history, history?.id ?? 257, `project-${PROJECT}-persist`],
  ] as const) {
    if (v == null) continue;
    ids.set(`/mnt/cocalc/${path}`, id);
    const member = v.member ?? true;
    if (member) {
      members.push(`0/${id}`);
      total += v.own;
    }
    rows.push(
      `0/${id} ${v.own} ${v.own} ${v.limit ?? "none"} ${member ? GROUP : "-"} - ${path}`,
    );
  }
  if (members.length > 0) {
    rows.push(
      `${GROUP} ${total} ${total} ${groupLimit} - ${members.join(",")} <${members.length} member qgroups>`,
    );
  }
  filesystemQgroups = HEADER + rows.join("\n") + "\n";
  // (read again)
  resetQgroupScansForTest();
}

beforeEach(() => {
  queueError = undefined;
  filesystemQgroups = "";
  resetQgroupScansForTest();
  ids.clear();
  existing.clear();
  queued.length = 0;
  destroyed.length = 0;
  scans.mockClear();
});

describe("the project's quota group", () => {
  it("is numbered by the start of the project's id", () => {
    expect(projectQuotaGroup(PROJECT)).toBe(`1/${0x000000001111}`);
    expect(projectQuotaGroup("ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe(
      `1/${2 ** 48 - 1}`,
    );
    expect(() => projectQuotaGroup("../x")).toThrow(/invalid project id/);
  });

  it("has room for the history beyond the disk quota", () => {
    // a tenth of the quota, at least 256 MiB
    expect(historyReserve(10 * GiB, {})).toBe(GiB);
    expect(historyReserve(GiB, {})).toBe(256 * MiB);
    expect(projectQuotaGroupLimit(10 * GiB, {})).toBe(11 * GiB);
    expect(
      historyReserve(10 * GiB, {
        COCALC_PERSIST_HISTORY_RESERVE_PERCENT: "0",
        COCALC_PERSIST_HISTORY_RESERVE_MIN_BYTES: "0",
      }),
    ).toBe(0);
  });

  it("is full when the files fill the quota, or files and history the group", () => {
    const reserve = GiB;
    expect(
      effectiveQuotaUsage({ files: 3 * GiB, total: 4 * GiB, reserve }),
    ).toBe(3 * GiB);
    // deleting files makes room for history
    expect(
      effectiveQuotaUsage({ files: 3 * GiB, total: 11 * GiB, reserve }),
    ).toBe(10 * GiB);
  });

  it("is synced only when it is not as it should be", async () => {
    existing.add(HISTORY);
    const opts = {
      project_id: PROJECT,
      mount: "/mnt/cocalc",
      home: HOME,
      history: HISTORY,
      quota: 10 * GiB,
      env: {},
    };
    // no group yet
    filesystem({
      home: { own: GiB, member: false },
      history: { own: GiB, member: false },
    });
    await syncProjectQuotaGroup(opts);
    expect(queued).toEqual([
      expect.objectContaining({
        mount: "/mnt/cocalc",
        group: GROUP,
        members: [HOME, HISTORY],
        size: 11 * GiB,
        project_id: PROJECT,
      }),
    ]);
    // what was read of the filesystem says so now: in sync, without reading
    // it again
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota: { size: 10 * GiB, used: GiB },
      }),
    ).toMatchObject({ used: GiB, history_used: GiB, files_used: GiB });
    expect(scans).toHaveBeenCalledTimes(1);
    await syncProjectQuotaGroup(opts);
    expect(queued).toHaveLength(1);
    await syncProjectQuotaGroup({ ...opts, force: true });
    expect(queued).toHaveLength(2);
    // a new disk quota
    expect(await projectQuotaGroupInSync({ ...opts, quota: 20 * GiB })).toBe(
      false,
    );
    // as read from the filesystem
    filesystem({
      home: { own: GiB },
      history: { own: GiB },
      groupLimit: 11 * GiB,
    });
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
    // the history isn't in it (e.g., a restore put a new one in place)
    filesystem({
      home: { own: GiB },
      history: { own: GiB, member: false, id: 258 },
      groupLimit: 11 * GiB,
    });
    expect(await projectQuotaGroupInSync(opts)).toBe(false);
    // no history volume yet: just the home
    existing.delete(HISTORY);
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
  });

  it("counts the history in the project's usage", async () => {
    existing.add(HISTORY);
    const quota = { size: 10 * GiB, used: 3 * GiB, warning: "x" };
    // not in a group yet: as before
    filesystem({ home: { own: 3 * GiB, member: false } });
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota,
      }),
    ).toEqual(quota);
    filesystem({
      home: { own: 3 * GiB },
      history: { own: 8 * GiB },
      groupLimit: 11 * GiB,
    });
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota,
      }),
    ).toEqual({
      ...quota,
      // the group is full
      used: 10 * GiB,
      files_used: 3 * GiB,
      history_used: 8 * GiB,
      history_reserve: GiB,
    });
  });

  it("never takes more room for the history than configured", async () => {
    existing.add(HISTORY);
    // the quota was lowered from 50 to 10 GiB, but the group's limit didn't
    // follow (yet): R is still about 1 GiB, not 45 GiB
    filesystem({
      home: { own: 3 * GiB },
      history: { own: 8 * GiB },
      groupLimit: 55 * GiB,
    });
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota: { size: 10 * GiB, used: 3 * GiB },
        env: {},
      }),
    ).toMatchObject({ used: 10 * GiB, history_reserve: GiB });
    // and a group limit not yet raised leaves less room
    filesystem({
      home: { own: 3 * GiB },
      history: { own: 8 * GiB },
      groupLimit: 10.5 * GiB,
    });
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota: { size: 10 * GiB, used: 3 * GiB },
        env: {},
      }),
    ).toMatchObject({ used: 10.5 * GiB, history_reserve: 0.5 * GiB });
  });
});

describe("a copied project's group", () => {
  it("gets the limit for the copied home's quota at once", async () => {
    existing.add(HISTORY);
    // the copy's home (quota 10 GiB) and history joined, the group unlimited
    filesystem({
      home: { own: GiB, limit: 10 * GiB },
      history: { own: GiB },
    });
    await limitNewProjectQuotaGroup({
      project_id: PROJECT,
      mount: "/mnt/cocalc",
      home: HOME,
      history: HISTORY,
      env: {},
    });
    expect(queued).toEqual([
      expect.objectContaining({
        group: GROUP,
        members: [HOME, HISTORY],
        size: 11 * GiB,
      }),
    ]);
    // no limit on the home: nothing to go by (its quota check sets it)
    queued.length = 0;
    filesystem({ home: { own: GiB }, history: { own: GiB } });
    await limitNewProjectQuotaGroup({
      project_id: PROJECT,
      mount: "/mnt/cocalc",
      home: HOME,
      history: HISTORY,
      env: {},
    });
    expect(queued).toEqual([]);
  });
});

describe("deleteEmptyQuotaGroups", () => {
  it("destroys only project groups with no members and no usage", async () => {
    resetQgroupScansForTest();
    filesystemQgroups =
      HEADER +
      `0/5 16384 16384 none - - <toplevel>\n` +
      `0/256 100 100 none 1/1 - project-a\n` +
      `1/1 100 100 1000 - 0/256 <1 member qgroups>\n` +
      `1/2 0 0 1000 - - <0 member qgroups>\n` +
      // usage without members (never expected): left alone
      `1/3 4096 4096 1000 - - <0 member qgroups>\n` +
      `1/4 0 0 none - - <0 member qgroups>\n`;
    expect(await deleteEmptyQuotaGroups({ mount: "/mnt/cocalc" })).toEqual([
      "1/2",
      "1/4",
    ]);
    expect(destroyed).toEqual(["1/2", "1/4"]);
  });
});

// last: it leaves the module refusing quota groups for an hour
describe("a host whose root helper refuses quota groups", () => {
  it("keeps separate limits for a while, then tries again", async () => {
    const opts = {
      project_id: PROJECT,
      mount: "/mnt/cocalc",
      home: HOME,
      quota: 10 * GiB,
      env: {},
    };
    expect(await projectQuotaGroupsPermitted("/mnt/cocalc")).toBe(true);
    queueError = new Error(
      "btrfs quota queue item x failed after 1 attempts: SECURITY_DENY code=relative-path-not-allowed detail=1/7",
    );
    await expect(syncProjectQuotaGroup(opts)).rejects.toThrow("SECURITY_DENY");
    expect(queued).toHaveLength(1);
    // not again, and nothing for the audit to repair
    await syncProjectQuotaGroup(opts);
    expect(queued).toHaveLength(1);
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
    expect(await projectQuotaGroupsPermitted("/mnt/cocalc")).toBe(true);
    // an hour later
    queueError = undefined;
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + 61 * 60_000);
    try {
      await syncProjectQuotaGroup(opts);
      expect(queued).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("is noticed by asking to destroy a group that doesn't exist", async () => {
    const { destroyQuotaGroup } = jest.requireMock(
      "@cocalc/file-server/btrfs/quota-group",
    );
    (destroyQuotaGroup as jest.Mock).mockRejectedValueOnce(
      new Error("SECURITY_DENY code=relative-path-not-allowed"),
    );
    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now + 3 * 60 * 60_000);
    try {
      expect(await projectQuotaGroupsPermitted("/mnt/cocalc")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("still makes the joins a restore requires", async () => {
    const { addToQuotaGroup, destroyQuotaGroup } = jest.requireMock(
      "@cocalc/file-server/btrfs/quota-group",
    );
    const deny = new Error(
      "SECURITY_DENY code=relative-path-not-allowed detail=1/7",
    );
    // refused when the file server starts: no groups for an hour
    (destroyQuotaGroup as jest.Mock).mockRejectedValueOnce(deny);
    expect(await projectQuotaGroupsPermitted("/mnt/cocalc")).toBe(false);
    (addToQuotaGroup as jest.Mock).mockClear();
    const join = { project_id: PROJECT, mount: "/mnt/cocalc", path: HISTORY };
    // a join that can wait (the quota audit adds it) does
    await joinProjectQuotaGroup(join);
    expect(addToQuotaGroup).not.toHaveBeenCalled();
    // a required one is tried, and a refusal is thrown
    (addToQuotaGroup as jest.Mock).mockRejectedValueOnce(deny);
    await expect(
      joinProjectQuotaGroup({ ...join, required: true }),
    ).rejects.toThrow("SECURITY_DENY");
    // and is made as soon as the helper allows groups, within the hour
    await joinProjectQuotaGroup({ ...join, required: true });
    expect(addToQuotaGroup).toHaveBeenCalledTimes(2);
    expect((addToQuotaGroup as jest.Mock).mock.calls[1][0]).toEqual({
      mount: "/mnt/cocalc",
      group: GROUP,
      path: HISTORY,
    });
    // the rest still waits for the hour
    await joinProjectQuotaGroup(join);
    expect(addToQuotaGroup).toHaveBeenCalledTimes(2);
    // with quotas off, nothing is required
    process.env.COCALC_DISABLE_BTRFS_QUOTAS = "1";
    try {
      await joinProjectQuotaGroup({ ...join, required: true });
    } finally {
      delete process.env.COCALC_DISABLE_BTRFS_QUOTAS;
    }
    expect(addToQuotaGroup).toHaveBeenCalledTimes(2);
  });
});
