const qgroupShow = new Map<string, string>();
const existing = new Set<string>();
const queued: any[] = [];
const destroyed: string[] = [];
let filesystemQgroups = "";

jest.mock("@cocalc/file-server/btrfs/operation-cache", () => ({
  cachedBtrfsQgroupShowRawForPath: jest.fn(async (path: string) => ({
    stdout: qgroupShow.get(path) ?? "",
    stderr: "",
    exit_code: 0,
  })),
  invalidateBtrfsQgroupShowRaw: jest.fn(),
}));
jest.mock("@cocalc/file-server/btrfs/quota-queue", () => ({
  queueSyncQuotaGroup: jest.fn(async (opts: any) => {
    queued.push(opts);
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
  btrfs: jest.fn(async () => ({
    stdout: filesystemQgroups,
    stderr: "",
    exit_code: 0,
  })),
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
  projectQuotaGroup,
  projectQuotaGroupInSync,
  projectQuotaGroupLimit,
  projectQuotaWithHistory,
  syncProjectQuotaGroup,
} from "./project-quota-group";

const PROJECT = "00000000-1111-4222-8333-444444444444";
const GROUP = projectQuotaGroup(PROJECT);
const HOME = `/mnt/cocalc/project-${PROJECT}`;
const HISTORY = `/mnt/cocalc/project-${PROJECT}-persist`;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const HEADER = `Qgroupid Referenced Exclusive Max referenced Parent Child Path
-------- ---------- --------- -------------- ------ ----- ----
`;

// what btrfs qgroup show -prcF shows from a subvolume in GROUP
function show({
  id,
  own,
  limit = "none",
  member = true,
  total,
  groupLimit,
}: {
  id: number;
  own: number;
  limit?: number | "none";
  member?: boolean;
  total: number;
  groupLimit: number | "none";
}): string {
  if (!member) return `${HEADER}0/${id} ${own} ${own} ${limit} - - x\n`;
  return (
    HEADER +
    `0/${id} ${own} ${own} ${limit} ${GROUP} - x\n` +
    `${GROUP} ${total} ${total} ${groupLimit} - 0/256,0/257 <2 member qgroups>\n`
  );
}

beforeEach(() => {
  qgroupShow.clear();
  existing.clear();
  queued.length = 0;
  destroyed.length = 0;
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
    // as it should be
    qgroupShow.set(
      HOME,
      show({ id: 256, own: GiB, total: 2 * GiB, groupLimit: 11 * GiB }),
    );
    qgroupShow.set(
      HISTORY,
      show({ id: 257, own: GiB, total: 2 * GiB, groupLimit: 11 * GiB }),
    );
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
    await syncProjectQuotaGroup(opts);
    expect(queued).toHaveLength(1);
    await syncProjectQuotaGroup({ ...opts, force: true });
    expect(queued).toHaveLength(2);
    // a new disk quota
    expect(await projectQuotaGroupInSync({ ...opts, quota: 20 * GiB })).toBe(
      false,
    );
    // the history isn't in it (e.g., a restore put a new one in place)
    qgroupShow.set(
      HISTORY,
      show({ id: 258, own: GiB, member: false, total: 0, groupLimit: "none" }),
    );
    expect(await projectQuotaGroupInSync(opts)).toBe(false);
    // no history volume yet: just the home
    existing.delete(HISTORY);
    expect(await projectQuotaGroupInSync(opts)).toBe(true);
  });

  it("counts the history in the project's usage", async () => {
    existing.add(HISTORY);
    const quota = { size: 10 * GiB, used: 3 * GiB, warning: "x" };
    // not in a group yet: as before
    qgroupShow.set(
      HOME,
      show({ id: 256, own: 3 * GiB, member: false, total: 0, groupLimit: 0 }),
    );
    expect(
      await projectQuotaWithHistory({
        project_id: PROJECT,
        home: HOME,
        history: HISTORY,
        quota,
      }),
    ).toEqual(quota);
    qgroupShow.set(
      HOME,
      show({ id: 256, own: 3 * GiB, total: 11 * GiB, groupLimit: 11 * GiB }),
    );
    qgroupShow.set(
      HISTORY,
      show({ id: 257, own: 7 * GiB, total: 11 * GiB, groupLimit: 11 * GiB }),
    );
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
      files_used: 4 * GiB,
      history_used: 7 * GiB,
      history_reserve: GiB,
    });
  });
});

describe("deleteEmptyQuotaGroups", () => {
  it("destroys only project groups with no members and no usage", async () => {
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
