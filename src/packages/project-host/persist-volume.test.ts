import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  readlink,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  HISTORY_IN_SNAPSHOTS,
  READY_MARKER,
  capturePersistVolume,
  cloneProjectWithPersistVolume,
  clonePersistVolume,
  copyPersistVolumeIntoSnapshot,
  deleteOrphanedPersistVolumes,
  deleteStaleStagingSnapshots,
  deletePersistVolume,
  importPersistDatabases,
  isPersistVolumeReady,
  mergeRestoredHistory,
  persistVolumePath,
  persistVolumeQuota,
  prepareProjectPersistVolume,
  replaceProjectHome,
  restoreHistoryFromBackup,
  restoredHistoryCandidates,
  syncPersistVolumeQuota,
  type PersistVolumeOps,
} from "./persist-volume";

// whether a persist fence is held (persist-fence.ts), as the code under test
// sees it
let fenced = false;
jest.mock("./persist-fence", () => ({
  withProjectPersistFenced: jest.fn(async (_opts, fn) => {
    fenced = true;
    try {
      return await fn();
    } finally {
      fenced = false;
    }
  }),
}));

// btrfs subvolumes and the root helpers, as plain directory operations
jest.mock("@cocalc/file-server/btrfs/util", () => {
  const fs = jest.requireActual("node:fs/promises");
  const copy = (src: string, dest: string) =>
    fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
  return {
    btrfs: jest.fn(async ({ args }: { args: string[] }) => {
      const [, op, ...rest] = args;
      if (op === "snapshot") {
        const [src, dest] = rest.filter((x) => x !== "-r");
        await copy(src, dest);
      } else if (op === "delete") {
        await fs.rm(rest[0], { recursive: true, force: true });
      } else if (op === "create") {
        await fs.mkdir(rest[0]);
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    }),
    sudo: jest.fn(
      async ({ command, args }: { command: string; args: string[] }) => {
        if (command === "rm") {
          await fs.rm(args[1], { recursive: args[0] === "-rf", force: true });
        } else if (command === "copy-tree-reflink") {
          await copy(args[0], args[1]);
        } else if (command === "mkdir") {
          await fs.mkdir(args[1], { recursive: true });
        } else if (command === "mv") {
          await fs.rename(args[0], args[1]);
        }
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    ),
  };
});
jest.mock("@cocalc/file-server/btrfs/subvolume", () => ({
  isBtrfsSubvolume: jest.fn(async () => true),
}));

const PROJECT = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const LEGACY = ".local/share/cocalc/persist";

let mount: string;
let env: NodeJS.ProcessEnv;
// what fakeOps reports as the home's btrfs UUID
let homeUuid = "home-1";
let home: string;
let root: string;

beforeEach(async () => {
  mount = await mkdtemp(join(tmpdir(), "persist-volume-"));
  env = {
    COCALC_SYNC_PROJECTS: `${mount}/project-[project_id]/${LEGACY}`,
  };
  process.env.COCALC_SYNC_PROJECTS = env.COCALC_SYNC_PROJECTS;
  home = join(mount, `project-${PROJECT}`);
  homeUuid = "home-1";
  root = join(mount, `project-${PROJECT}-persist`);
  await mkdir(join(home, LEGACY, "patchflow"), { recursive: true });
  await writeFile(join(home, LEGACY, "a.db"), "a");
  await writeFile(join(home, LEGACY, "a.db-wal"), "a-wal");
  await writeFile(join(home, LEGACY, "patchflow", "b.db"), "b");
  jest.clearAllMocks();
});

afterEach(async () => {
  delete process.env.COCALC_SYNC_PROJECTS;
  await rm(mount, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(path, "utf8");

const GiB = 1024 ** 3;

function fakeOps(): PersistVolumeOps & {
  calls: string[];
  quotas: Map<string, number>;
} {
  const calls: string[] = [];
  const quotas = new Map<string, number>();
  return {
    calls,
    quotas,
    getQuota: async (path) => quotas.get(path) ?? 0,
    setQuota: async (path, bytes) => {
      quotas.set(path, bytes);
    },
    removeFromHome: async (from, relative) => {
      await rm(join(from, relative), { recursive: true });
    },
    subvolumeUuid: async () => homeUuid,
    isReadonly: async () => false,
    removeTree: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    createVolume: async (path) => {
      calls.push("create");
      await mkdir(path);
    },
    isSubvolume: async () => true,
    snapshotReadonly: async (from, snapshot) => {
      calls.push("snapshot");
      await mkdir(join(snapshot, ".."), { recursive: true });
      await cp(from, snapshot, { recursive: true, verbatimSymlinks: true });
    },
    deleteVolume: async (path) => {
      calls.push("delete");
      await rm(path, { recursive: true, force: true });
    },
  };
}

describe("importPersistDatabases", () => {
  it("copies only regular database files, never following a symlink", async () => {
    const dir = join(home, LEGACY);
    const outside = join(mount, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.db"), "secret");
    await writeFile(join(dir, "a.db-shm"), "shm");
    await writeFile(join(dir, "notes.txt"), "notes");
    await symlink(join(outside, "secret.db"), join(dir, "link.db"));
    await symlink(outside, join(dir, "linkdir"));
    execFileSync("mkfifo", [join(dir, "fifo.db")]);
    const dest = join(mount, "dest");
    await mkdir(dest);
    expect(
      await importPersistDatabases({ source: home, relative: LEGACY, dest }),
    ).toEqual({ files: 3, bytes: expect.any(Number), skipped: 5 });
    expect(readdirSync(dest).sort()).toEqual(["a.db", "a.db-wal", "patchflow"]);
    expect(read(join(dest, "patchflow", "b.db"))).toBe("b");
  });

  it("bounds the limit a sparse file made to look big can get", async () => {
    const big = join(home, LEGACY, "big.db");
    await writeFile(big, "");
    await truncate(big, 64 * 1024 ** 2);
    const ops = fakeOps();
    const limits: number[] = [];
    ops.setQuota = async (path, bytes) => {
      limits.push(bytes);
      ops.quotas.set(path, bytes);
    };
    ops.quotas.set(home, 40 * 1024 ** 2);
    env.COCALC_PERSIST_VOLUME_QUOTA_MIN_BYTES = `${1024 ** 2}`;
    await prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env);
    // imported, like every database: its size is not trusted
    expect(existsSync(join(root, "big.db"))).toBe(true);
    // never more than the disk quota, during and after the import
    expect(limits).toEqual([40 * 1024 ** 2, 40 * 1024 ** 2]);
  });

  it("stops reading a directory at its limit", async () => {
    const wide = join(home, LEGACY, "wide");
    await mkdir(wide);
    for (let i = 0; i < 50; i++) {
      await writeFile(join(wide, `${i}.txt`), "");
    }
    const fsp = require("node:fs/promises");
    const opendir = fsp.opendir;
    let read = 0;
    const spy = jest
      .spyOn(fsp, "opendir")
      .mockImplementation(async (...args: any[]) => {
        const dir = await opendir(...args);
        return (async function* () {
          for await (const entry of dir) {
            read += 1;
            yield entry;
          }
        })();
      });
    try {
      const dest = join(mount, "dest");
      await mkdir(dest);
      await expect(
        importPersistDatabases({
          source: home,
          relative: join(LEGACY, "wide"),
          dest,
          maxEntries: 10,
        }),
      ).rejects.toThrow("more than 10 entries");
      expect(read).toBe(11);
    } finally {
      spy.mockRestore();
    }
  });

  it("imports nothing through a symlinked parent or a missing directory", async () => {
    const elsewhere = join(home, "elsewhere");
    await rm(join(home, ".local"), { recursive: true });
    await mkdir(join(elsewhere, "share/cocalc/persist"), { recursive: true });
    await writeFile(join(elsewhere, "share/cocalc/persist/x.db"), "x");
    await symlink(elsewhere, join(home, ".local"));
    const dest = join(mount, "dest");
    await mkdir(dest);
    const none = { files: 0, bytes: 0, skipped: 0 };
    expect(
      await importPersistDatabases({ source: home, relative: LEGACY, dest }),
    ).toEqual(none);
    expect(
      await importPersistDatabases({ source: home, relative: "missing", dest }),
    ).toEqual(none);
    expect(readdirSync(dest)).toEqual([]);
  });
});

describe("prepareProjectPersistVolume", () => {
  it("creates the volume, imports the history from a snapshot of the home, then marks it ready", async () => {
    const ops = fakeOps();
    ops.quotas.set(home, 10 * GiB);
    await prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env);
    expect(ops.calls).toEqual(["create", "snapshot", "delete"]);
    // a fifth of the disk quota (at most the disk quota while importing)
    expect(ops.quotas.get(root)).toBe(2 * GiB);
    // the old directory is gone from the home
    expect(existsSync(join(home, LEGACY))).toBe(false);
    expect(existsSync(join(home, ".local/share/cocalc"))).toBe(true);
    expect(read(join(root, "a.db"))).toBe("a");
    expect(read(join(root, "a.db-wal"))).toBe("a-wal");
    expect(read(join(root, "patchflow", "b.db"))).toBe("b");
    expect(JSON.parse(read(join(root, READY_MARKER)))).toMatchObject({
      files: 3,
    });
    // the import snapshot is gone
    expect(readdirSync(join(mount, ".persist-import"))).toEqual([]);
    // ready: nothing more to do
    await prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env);
    expect(ops.calls).toHaveLength(3);
  });

  it("imports once for concurrent opens", async () => {
    const ops = fakeOps();
    await Promise.all(
      [1, 2, 3].map(() =>
        prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env),
      ),
    );
    expect(ops.calls).toEqual(["create", "snapshot", "delete"]);
  });

  it("imports a few projects at a time", async () => {
    const projects = Array.from(
      { length: 6 },
      (_, i) => `11111111-2222-4333-8444-00000000000${i}`,
    );
    for (const id of projects) {
      await mkdir(join(mount, `project-${id}`, LEGACY), { recursive: true });
    }
    let running = 0;
    let most = 0;
    const ops = fakeOps();
    const snapshotReadonly = ops.snapshotReadonly;
    ops.snapshotReadonly = async (from, snapshot) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await snapshotReadonly(from, snapshot);
      running -= 1;
    };
    await Promise.all(
      projects.map((id) =>
        prepareProjectPersistVolume(
          { project_id: id, root: join(mount, `project-${id}-persist`) },
          ops,
          env,
        ),
      ),
    );
    expect(most).toBe(4);
    for (const id of projects) {
      expect(
        existsSync(join(mount, `project-${id}-persist`, READY_MARKER)),
      ).toBe(true);
    }
  });

  it("starts over in a volume that is not ready", async () => {
    await mkdir(join(root, "patchflow"), { recursive: true });
    await writeFile(join(root, "patchflow", "b.db"), "partial");
    await writeFile(join(root, "junk.db"), "junk");
    const ops = fakeOps();
    await prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env);
    expect(ops.calls).toEqual(["snapshot", "delete"]);
    expect(existsSync(join(root, "junk.db"))).toBe(false);
    expect(read(join(root, "patchflow", "b.db"))).toBe("b");
  });

  it("refuses a project without a home here, and paths that are not its volume", async () => {
    const ops = fakeOps();
    const other = join(mount, `project-${OTHER}-persist`);
    await expect(
      prepareProjectPersistVolume({ project_id: OTHER, root: other }, ops, env),
    ).rejects.toThrow(/project root does not exist/);
    await expect(
      prepareProjectPersistVolume(
        { project_id: PROJECT, root: home },
        ops,
        env,
      ),
    ).rejects.toThrow(/not a project persist volume/);
    await expect(
      prepareProjectPersistVolume(
        { project_id: "../x", root: join(mount, "project-../x-persist") },
        ops,
        env,
      ),
    ).rejects.toThrow(/invalid project id/);
    expect(ops.calls).toEqual([]);
    expect(existsSync(other)).toBe(false);
  });

  it("makes no volume ready while the home is frozen to be archived", async () => {
    const ops = fakeOps();
    ops.isReadonly = async () => true;
    await expect(
      prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env),
    ).rejects.toThrow(/being archived/);
    expect(existsSync(root)).toBe(false);
    // frozen while importing
    let checks = 0;
    ops.isReadonly = async () => ++checks > 1;
    await expect(
      prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env),
    ).rejects.toThrow(/being archived/);
    expect(existsSync(join(root, READY_MARKER))).toBe(false);
    // the history stays in the home
    expect(read(join(home, LEGACY, "a.db"))).toBe("a");
  });

  it("keeps the volume ready when the old directory can't be deleted", async () => {
    const ops = fakeOps();
    ops.removeFromHome = async () => {
      throw new Error("EROFS");
    };
    await prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env);
    expect(existsSync(join(root, READY_MARKER))).toBe(true);
    expect(existsSync(join(home, LEGACY, "a.db"))).toBe(true);
  });

  it("marks nothing ready when part of the history can't be read", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const ops = fakeOps();
    // the project made a directory unreadable (a real snapshot keeps that)
    const snapshotReadonly = ops.snapshotReadonly;
    ops.snapshotReadonly = async (from, snapshot) => {
      await snapshotReadonly(from, snapshot);
      await chmod(join(snapshot, LEGACY, "patchflow"), 0o000);
    };
    const deleteVolume = ops.deleteVolume;
    ops.deleteVolume = async (path) => {
      await chmod(join(path, LEGACY, "patchflow"), 0o755);
      await deleteVolume(path);
    };
    await expect(
      prepareProjectPersistVolume({ project_id: PROJECT, root }, ops, env),
    ).rejects.toThrow(/EACCES/);
    expect(existsSync(join(root, READY_MARKER))).toBe(false);
    expect(ops.calls).toEqual(["create", "snapshot", "delete"]);
    // the home is untouched
    expect(existsSync(join(home, LEGACY, "a.db"))).toBe(true);
  });
});

describe("persistVolumeQuota", () => {
  it("is a fifth of the disk quota, but at least 256 MiB", () => {
    expect(persistVolumeQuota({ homeQuota: 10 * GiB, env: {} })).toBe(2 * GiB);
    expect(persistVolumeQuota({ homeQuota: GiB / 2, env: {} })).toBe(
      256 * 1024 ** 2,
    );
  });

  it("is always a limit, even when the home has none", () => {
    expect(persistVolumeQuota({ homeQuota: 0, env: {} })).toBe(2 * GiB);
  });

  it("leaves room for history imported beyond it, and is never lowered", () => {
    expect(
      persistVolumeQuota({ homeQuota: 10 * GiB, imported: 4 * GiB, env: {} }),
    ).toBe(5 * GiB);
    // the history fit in the disk quota, so it never earns more than that
    expect(
      persistVolumeQuota({ homeQuota: 10 * GiB, imported: 100 * GiB, env: {} }),
    ).toBe(10 * GiB);
    expect(
      persistVolumeQuota({ homeQuota: 0, imported: 100 * GiB, env: {} }),
    ).toBe(20 * GiB);
    expect(
      persistVolumeQuota({ homeQuota: 5 * GiB, current: 3 * GiB, env: {} }),
    ).toBe(3 * GiB);
  });

  it("can be configured", () => {
    expect(
      persistVolumeQuota({
        homeQuota: 10 * GiB,
        env: {
          COCALC_PERSIST_VOLUME_QUOTA_PERCENT: "50",
          COCALC_PERSIST_VOLUME_QUOTA_MIN_BYTES: "nonsense",
        },
      }),
    ).toBe(5 * GiB);
  });
});

describe("in the project-host", () => {
  async function readyVolume() {
    await prepareProjectPersistVolume(
      { project_id: PROJECT, root },
      fakeOps(),
      env,
    );
    await writeFile(join(root, "a.db"), "live");
  }

  // a backup's temporary snapshot of the home
  async function backupSnapshot() {
    const staging = join(mount, ".rustic-backup-staging");
    const snapshotPath = join(staging, "snap");
    await mkdir(staging);
    await cp(home, snapshotPath, { recursive: true, verbatimSymlinks: true });
    return {
      subvolume: `project-${PROJECT}`,
      snapshotPath,
      stagingPath: join(staging, "snap-persist"),
    };
  }

  it("puts the live history in a backup, next to the project's files", async () => {
    await readyVolume();
    // the project's own files at the old path are its files now: kept
    await mkdir(join(home, LEGACY), { recursive: true });
    await writeFile(join(home, LEGACY, "a.db"), "forged");
    await writeFile(join(home, "work.txt"), "work");
    const backup = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot(backup);
    const copy = join(backup.snapshotPath, HISTORY_IN_SNAPSHOTS);
    expect(read(join(copy, "a.db"))).toBe("live");
    // which marks it as CoCalc's, not a directory of the project's own
    expect(existsSync(join(copy, READY_MARKER))).toBe(true);
    expect(read(join(backup.snapshotPath, LEGACY, "a.db"))).toBe("forged");
    expect(read(join(backup.snapshotPath, "work.txt"))).toBe("work");
    expect(existsSync(backup.stagingPath)).toBe(false);
  });

  it("never changes the project's files in a backup", async () => {
    await readyVolume();
    await rm(join(home, ".local"), { recursive: true });
    await symlink("work", join(home, ".local"));
    const backup = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot(backup);
    expect(
      (await lstat(join(backup.snapshotPath, ".local"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(backup.snapshotPath, ".local"))).toBe("work");
    expect(read(join(backup.snapshotPath, HISTORY_IN_SNAPSHOTS, "a.db"))).toBe(
      "live",
    );
  });

  it("fails rather than replace a project's own .cocalc-persist", async () => {
    await readyVolume();
    await writeFile(join(home, HISTORY_IN_SNAPSHOTS), "mine");
    const backup = await backupSnapshot();
    await expect(copyPersistVolumeIntoSnapshot(backup)).rejects.toThrow(
      /reserved for CoCalc/,
    );
    expect(read(join(backup.snapshotPath, HISTORY_IN_SNAPSHOTS))).toBe("mine");
  });

  it("leaves a backup alone until the history was imported", async () => {
    const backup = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot(backup);
    expect(read(join(backup.snapshotPath, LEGACY, "a.db"))).toBe("a");
    expect(sudo).not.toHaveBeenCalled();
    await copyPersistVolumeIntoSnapshot({ ...backup, subvolume: "other" });
    expect(sudo).not.toHaveBeenCalled();
  });

  it("uses its own staging path for a local snapshot", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    expect(read(join(snapshotPath, HISTORY_IN_SNAPSHOTS, "a.db"))).toBe("live");
    expect(readdirSync(join(mount, ".persist-import"))).toEqual([]);
  });

  const leftovers = () =>
    readdirSync(join(mount, ".persist-import")).filter(
      (x) => x.startsWith("restore-") || x.startsWith("replaced-"),
    );

  // A restore that replaces the home with `replacement` (a snapshot's clone
  // or restore staging, which the project can't reach).
  async function restoreHome(
    replacement: string,
    { ops = fakeOps() }: { ops?: ReturnType<typeof fakeOps> } = {},
  ) {
    let swappedWhileFenced = false;
    const result = await replaceProjectHome({
      project_id: PROJECT,
      replacement,
      reason: "test",
      env,
      ops,
      swap: async () => {
        swappedWhileFenced = fenced && (await isPersistVolumeReady(root));
        await rm(home, { recursive: true });
        await cp(replacement, home, {
          recursive: true,
          verbatimSymlinks: true,
        });
        return "swapped";
      },
    });
    expect(result).toBe("swapped");
    // the history was in place, and nothing had it open, as the home was
    expect(swappedWhileFenced).toBe(true);
    expect(fenced).toBe(false);
    expect(await isPersistVolumeReady(root)).toBe(true);
    expect(leftovers()).toEqual([]);
  }

  it("restores the history of a snapshot taken after the import, with its home", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    // edits after the snapshot
    await writeFile(join(root, "a.db"), "after the snapshot");
    await writeFile(join(root, "new.db"), "after the snapshot");
    await restoreHome(snapshotPath);
    expect(read(join(root, "a.db"))).toBe("live");
    expect(existsSync(join(root, "new.db"))).toBe(false);
    // the copy in the restored home is gone
    expect(existsSync(join(home, HISTORY_IN_SNAPSHOTS))).toBe(false);
  });

  it("restores the history of a snapshot taken before the import", async () => {
    // the old directory in the home is the history
    const { snapshotPath } = await backupSnapshot();
    await readyVolume();
    await restoreHome(snapshotPath);
    expect(read(join(root, "a.db"))).toBe("a");
    expect(read(join(root, "patchflow", "b.db"))).toBe("b");
    expect(existsSync(join(home, LEGACY))).toBe(false);
  });

  it("prefers the history CoCalc put in a snapshot to the old directory", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    // the project's own files at the old path in that snapshot
    await mkdir(join(snapshotPath, LEGACY), { recursive: true });
    await writeFile(join(snapshotPath, LEGACY, "a.db"), "forged");
    await writeFile(join(snapshotPath, LEGACY, "note.txt"), "mine");
    await restoreHome(snapshotPath);
    expect(read(join(root, "a.db"))).toBe("live");
    // which stay the project's files in its restored home
    expect(read(join(home, LEGACY, "a.db"))).toBe("forged");
    expect(read(join(home, LEGACY, "note.txt"))).toBe("mine");
    expect(existsSync(join(home, HISTORY_IN_SNAPSHOTS))).toBe(false);
  });

  it("never takes a .cocalc-persist of the project's own for its history, nor deletes it", async () => {
    // a snapshot from before the import, with the old directory
    const { snapshotPath } = await backupSnapshot();
    await readyVolume();
    // no ready marker: the project's own directory
    await mkdir(join(snapshotPath, HISTORY_IN_SNAPSHOTS));
    await writeFile(join(snapshotPath, HISTORY_IN_SNAPSHOTS, "a.db"), "mine");
    await restoreHome(snapshotPath);
    // the history is the old directory in that snapshot
    expect(read(join(root, "a.db"))).toBe("a");
    expect(read(join(home, HISTORY_IN_SNAPSHOTS, "a.db"))).toBe("mine");
  });

  it("restores the history of a project that had no volume (e.g., archived)", async () => {
    const replacement = join(mount, "replacement");
    await mkdir(join(replacement, HISTORY_IN_SNAPSHOTS, "patchflow"), {
      recursive: true,
    });
    await writeFile(
      join(replacement, HISTORY_IN_SNAPSHOTS, "patchflow", "x.db"),
      "restored",
    );
    await writeFile(
      join(replacement, HISTORY_IN_SNAPSHOTS, READY_MARKER),
      "{}",
    );
    expect(existsSync(root)).toBe(false);
    await restoreHome(replacement);
    expect(read(join(root, "patchflow", "x.db"))).toBe("restored");
    expect(existsSync(join(home, HISTORY_IN_SNAPSHOTS))).toBe(false);
  });

  it("keeps the history and the home when the home can't be swapped in", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    await writeFile(join(root, "a.db"), "after the snapshot");
    await expect(
      replaceProjectHome({
        project_id: PROJECT,
        replacement: snapshotPath,
        reason: "test",
        env,
        ops: fakeOps(),
        swap: async () => {
          throw new Error("swap failed");
        },
      }),
    ).rejects.toThrow("swap failed");
    expect(read(join(root, "a.db"))).toBe("after the snapshot");
    expect(await isPersistVolumeReady(root)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("swaps in nothing when the restored history can't be staged", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    const ops = fakeOps();
    ops.setQuota = async () => {
      throw new Error("quota failed");
    };
    const swap = jest.fn();
    await expect(
      replaceProjectHome({
        project_id: PROJECT,
        replacement: snapshotPath,
        reason: "test",
        env,
        ops,
        swap,
      }),
    ).rejects.toThrow("quota failed");
    expect(swap).not.toHaveBeenCalled();
    expect(read(join(root, "a.db"))).toBe("live");
    expect(leftovers()).toEqual([]);
  });

  it("the first import ignores a .cocalc-persist in the home", async () => {
    await mkdir(join(home, HISTORY_IN_SNAPSHOTS));
    await writeFile(join(home, HISTORY_IN_SNAPSHOTS, "x.db"), "x");
    await writeFile(join(home, HISTORY_IN_SNAPSHOTS, READY_MARKER), "{}");
    await prepareProjectPersistVolume(
      { project_id: PROJECT, root },
      fakeOps(),
      env,
    );
    expect(read(join(root, "a.db"))).toBe("a");
    expect(existsSync(join(root, "x.db"))).toBe(false);
    expect(read(join(home, HISTORY_IN_SNAPSHOTS, "x.db"))).toBe("x");
  });

  it("a capture for a snapshot and a restore wait for each other", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    const captured = await capturePersistVolume({
      subvolume,
      stagingPath: join(mount, ".persist-import", "capture"),
      env,
    });
    let restored = false;
    const restoring = restoreHome(snapshotPath).then(() => {
      restored = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restored).toBe(false);
    await captured!.release();
    await restoring;
    expect(restored).toBe(true);
  });

  it("merges a backup restored over the home, keeping newer history", async () => {
    await readyVolume();
    // the live volume: a.db with its log, and a stream made after the backup
    await writeFile(join(root, "a.db-wal"), "live log");
    await writeFile(join(root, "new.db"), "after the backup");
    // the backup's history, restored where only the host can write
    const source = join(mount, "source");
    await mkdir(join(source, "patchflow"), { recursive: true });
    await writeFile(join(source, "a.db"), "backup");
    await writeFile(join(source, "patchflow", "c.db"), "backup c");
    await writeFile(join(source, "patchflow", "c.db-wal"), "backup c log");
    let mergedWhileFenced = false;
    const ops = fakeOps();
    const getQuota = ops.getQuota;
    ops.getQuota = async (path) => {
      mergedWhileFenced ||= fenced;
      return await getQuota(path);
    };
    await mergeRestoredHistory({ project_id: PROJECT, source, env, ops });
    expect(mergedWhileFenced).toBe(true);
    expect(read(join(root, "a.db"))).toBe("backup");
    // never an old log on a restored database
    expect(existsSync(join(root, "a.db-wal"))).toBe(false);
    expect(read(join(root, "new.db"))).toBe("after the backup");
    expect(read(join(root, "patchflow", "c.db"))).toBe("backup c");
    expect(read(join(root, "patchflow", "c.db-wal"))).toBe("backup c log");
    expect(await isPersistVolumeReady(root)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("merges a backup into a project whose history is still in its home", async () => {
    const source = join(mount, "source");
    await mkdir(source);
    await writeFile(join(source, "x.db"), "backup x");
    await mergeRestoredHistory({
      project_id: PROJECT,
      source,
      env,
      ops: fakeOps(),
    });
    expect(read(join(root, "a.db"))).toBe("a");
    expect(read(join(root, "x.db"))).toBe("backup x");
    expect(existsSync(join(home, LEGACY))).toBe(false);
  });

  it("knows which history a restore puts back", () => {
    for (const [path, dest, expected] of [
      ["", "", [HISTORY_IN_SNAPSHOTS, LEGACY]],
      [".cocalc-persist", ".cocalc-persist", [HISTORY_IN_SNAPSHOTS]],
      // only the old directory, never the history next to it
      [".local", ".local", [LEGACY]],
      [LEGACY, `${LEGACY}/`, [LEGACY]],
      ["", "restored", []],
      [".local", "x/.local", []],
      [`${LEGACY}/patchflow`, `${LEGACY}/patchflow`, []],
      ["work", "work", []],
    ] as const) {
      expect(restoredHistoryCandidates({ path, dest, env })).toEqual(expected);
    }
  });

  // a backup, as restoreHistoryFromBackup sees it
  function backupWith(tree: Record<string, string>) {
    const listDirectory = async (dir: string) => {
      const names = new Map<string, boolean>();
      for (const path of Object.keys(tree)) {
        const prefix = dir ? `${dir}/` : "";
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        names.set(name, (names.get(name) ?? false) || rest.length > 0);
      }
      return [...names].map(([name, isDir]) => ({ name, isDir }));
    };
    const restored: string[] = [];
    const restoreInto = async (path: string, dest: string) => {
      restored.push(path);
      for (const [file, content] of Object.entries(tree)) {
        if (!file.startsWith(`${path}/`)) continue;
        const target = join(dest, file.slice(path.length + 1));
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, content);
      }
    };
    return { listDirectory, restoreInto, restored };
  }

  it("restores only the history a restore of the backup covers", async () => {
    await readyVolume();
    // a newer backup: its history is next to .local, not in it
    const backup = backupWith({
      [`${HISTORY_IN_SNAPSHOTS}/a.db`]: "backup",
      [`${HISTORY_IN_SNAPSHOTS}/${READY_MARKER}`]: "{}",
      ".local/bin/tool": "tool",
    });
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({
          path: ".local",
          dest: ".local",
          env,
        }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(false);
    expect(backup.restored).toEqual([]);
    expect(read(join(root, "a.db"))).toBe("live");
    // the whole backup: its history
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({ path: "", dest: "", env }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(true);
    expect(backup.restored).toEqual([HISTORY_IN_SNAPSHOTS]);
    expect(read(join(root, "a.db"))).toBe("backup");
    expect(leftovers()).toEqual([]);
  });

  it("a .cocalc-persist in a backup without the marker is the project's own", async () => {
    await readyVolume();
    const backup = backupWith({
      [`${HISTORY_IN_SNAPSHOTS}/a.db`]: "mine",
      [`${LEGACY}/a.db`]: "backup",
    });
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: [HISTORY_IN_SNAPSHOTS, LEGACY],
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(true);
    expect(backup.restored).toEqual([LEGACY]);
    expect(read(join(root, "a.db"))).toBe("backup");
  });

  it("never takes the old directory from a backup that has CoCalc's history", async () => {
    await readyVolume();
    // a backup taken after the import: CoCalc's history, and the project's
    // own files at the old path
    const backup = backupWith({
      [`${HISTORY_IN_SNAPSHOTS}/a.db`]: "backup",
      [`${HISTORY_IN_SNAPSHOTS}/${READY_MARKER}`]: "{}",
      [`${LEGACY}/a.db`]: "forged",
    });
    // restoring only .local covers just the old path
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({
          path: ".local",
          dest: ".local",
          env,
        }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(false);
    expect(backup.restored).toEqual([]);
    expect(read(join(root, "a.db"))).toBe("live");
    // the whole backup: CoCalc's history, never the old path
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({ path: "", dest: "", env }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(true);
    expect(backup.restored).toEqual([HISTORY_IN_SNAPSHOTS]);
    expect(read(join(root, "a.db"))).toBe("backup");
  });

  it("after restoring a newer backup over the home, keeps the project's own files at the old path", async () => {
    await readyVolume();
    const backup = backupWith({
      [`${HISTORY_IN_SNAPSHOTS}/a.db`]: "backup",
      [`${HISTORY_IN_SNAPSHOTS}/${READY_MARKER}`]: "{}",
      [`${LEGACY}/note.txt`]: "mine",
    });
    // what the restore of the whole backup put in the home
    await mkdir(join(home, HISTORY_IN_SNAPSHOTS), { recursive: true });
    await writeFile(join(home, HISTORY_IN_SNAPSHOTS, "a.db"), "backup");
    await writeFile(join(home, HISTORY_IN_SNAPSHOTS, READY_MARKER), "{}");
    await mkdir(join(home, LEGACY), { recursive: true });
    await writeFile(join(home, LEGACY, "note.txt"), "mine");
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({ path: "", dest: "", env }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(true);
    expect(read(join(root, "a.db"))).toBe("backup");
    expect(existsSync(join(home, HISTORY_IN_SNAPSHOTS))).toBe(false);
    expect(read(join(home, LEGACY, "note.txt"))).toBe("mine");
  });

  it("after restoring an older backup over the home, removes its history from the old path", async () => {
    await readyVolume();
    const backup = backupWith({ [`${LEGACY}/a.db`]: "old backup" });
    await mkdir(join(home, LEGACY), { recursive: true });
    await writeFile(join(home, LEGACY, "a.db"), "old backup");
    expect(
      await restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: restoredHistoryCandidates({ path: "", dest: "", env }),
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).toBe(true);
    expect(backup.restored).toEqual([LEGACY]);
    expect(read(join(root, "a.db"))).toBe("old backup");
    expect(existsSync(join(home, LEGACY))).toBe(false);
  });

  it("restores no partial history from a backup", async () => {
    await readyVolume();
    const backup = backupWith({
      [`${HISTORY_IN_SNAPSHOTS}/a.db`]: "backup",
      [`${HISTORY_IN_SNAPSHOTS}/${READY_MARKER}`]: "{}",
    });
    const restoreInto = backup.restoreInto;
    backup.restoreInto = async (path, dest) => {
      await restoreInto(path, dest);
      throw new Error("repository read error");
    };
    await expect(
      restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: [HISTORY_IN_SNAPSHOTS, LEGACY],
        ...backup,
        env,
        ops: fakeOps(),
      }),
    ).rejects.toThrow("repository read error");
    // never the next candidate, nothing left, the history unchanged
    expect(backup.restored).toEqual([HISTORY_IN_SNAPSHOTS]);
    expect(leftovers()).toEqual([]);
    expect(read(join(root, "a.db"))).toBe("live");
    // listing errors too
    await expect(
      restoreHistoryFromBackup({
        project_id: PROJECT,
        candidates: [HISTORY_IN_SNAPSHOTS],
        listDirectory: async () => {
          throw new Error("timeout");
        },
        restoreInto,
        env,
        ops: fakeOps(),
      }),
    ).rejects.toThrow("timeout");
  });

  it("bounds what a restore stages like the volume", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    const ops = fakeOps();
    ops.quotas.set(home, 10 * GiB);
    const limits: [string, number][] = [];
    const setQuota = ops.setQuota;
    ops.setQuota = async (path, bytes) => {
      limits.push([basename(path).split("-")[0], bytes]);
      await setQuota(path, bytes);
    };
    await restoreHome(snapshotPath, { ops });
    // every staged volume is limited to the disk quota from the start
    expect(limits.filter(([kind]) => kind === "restore")[0]).toEqual([
      "restore",
      10 * GiB,
    ]);
  });

  it("raises the volume's limit with the disk quota", async () => {
    await readyVolume();
    const ops = fakeOps();
    ops.quotas.set(root, 3 * GiB);
    await syncPersistVolumeQuota(PROJECT, 20 * GiB, ops);
    expect(ops.quotas.get(root)).toBe(4 * GiB);
    await syncPersistVolumeQuota(PROJECT, 5 * GiB, ops);
    expect(ops.quotas.get(root)).toBe(4 * GiB);
    await syncPersistVolumeQuota(OTHER, 20 * GiB, ops);
    expect(ops.quotas.size).toBe(1);
  });

  // the limit set on a copy (before it is renamed into place; a btrfs limit
  // stays with its subvolume)
  const cloneLimit = (ops: ReturnType<typeof fakeOps>) =>
    [...ops.quotas].find(([path]) => path.includes("/clone-"))?.[1];

  it("a copy and a restore of the same project wait for each other", async () => {
    await readyVolume();
    const { subvolume, snapshotPath } = await backupSnapshot();
    await copyPersistVolumeIntoSnapshot({ subvolume, snapshotPath });
    // the snapshot's files and history, then newer ones
    await writeFile(join(snapshotPath, "work.txt"), "restored");
    await writeFile(join(home, "work.txt"), "newer");
    await writeFile(join(root, "a.db"), "newer");
    let swapping!: () => void;
    const swapped = new Promise<void>((resolve) => (swapping = resolve));
    let releaseSwap!: () => void;
    const gate = new Promise<void>((resolve) => (releaseSwap = resolve));
    const restoring = replaceProjectHome({
      project_id: PROJECT,
      replacement: snapshotPath,
      reason: "test",
      env,
      ops: fakeOps(),
      swap: async () => {
        swapping();
        // the new history is in place, the home not yet
        await gate;
        await rm(home, { recursive: true });
        await cp(snapshotPath, home, { recursive: true });
      },
    });
    await swapped;
    const otherHome = join(mount, `project-${OTHER}`);
    let copied = false;
    const copying = cloneProjectWithPersistVolume({
      src_project_id: PROJECT,
      project_id: OTHER,
      ops: fakeOps(),
      cloneHome: async () => {
        await cp(home, otherHome, { recursive: true });
      },
    }).then(() => (copied = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(copied).toBe(false);
    releaseSwap();
    await restoring;
    await copying;
    // the copy has the restored files with the restored history
    expect(read(join(otherHome, "work.txt"))).toBe("restored");
    expect(read(join(persistVolumePath(OTHER)!, "a.db"))).toBe("live");
  });

  it("copies and deletes the volume with its project", async () => {
    await readyVolume();
    const ops = fakeOps();
    ops.quotas.set(root, 3 * GiB);
    await clonePersistVolume(
      { src_project_id: PROJECT, project_id: OTHER },
      ops,
    );
    const copy = persistVolumePath(OTHER)!;
    expect(read(join(copy, "a.db"))).toBe("live");
    expect(existsSync(join(copy, READY_MARKER))).toBe(true);
    expect(cloneLimit(ops)).toBe(3 * GiB);
    // nothing left where copies are made
    expect(readdirSync(join(mount, ".persist-import"))).toEqual([]);
    await deletePersistVolume(OTHER);
    expect(existsSync(copy)).toBe(false);
    await deletePersistVolume(OTHER);
    expect(btrfs).toHaveBeenCalledTimes(2);
  });

  it("copies a limit below the fallback exactly", async () => {
    await readyVolume();
    const ops = fakeOps();
    ops.quotas.set(root, GiB);
    await clonePersistVolume(
      { src_project_id: PROJECT, project_id: OTHER },
      ops,
    );
    expect(cloneLimit(ops)).toBe(GiB);
  });

  it("keeps a copy an earlier attempt made", async () => {
    await readyVolume();
    const ops = fakeOps();
    await clonePersistVolume(
      { src_project_id: PROJECT, project_id: OTHER },
      ops,
    );
    const copy = persistVolumePath(OTHER)!;
    await writeFile(join(copy, "a.db"), "edited in the copy");
    (btrfs as jest.Mock).mockClear();
    // e.g., the reply was lost, or cloning the home failed afterwards
    await clonePersistVolume(
      { src_project_id: PROJECT, project_id: OTHER },
      ops,
    );
    expect(read(join(copy, "a.db"))).toBe("edited in the copy");
    expect(btrfs).not.toHaveBeenCalled();
  });

  // copying a home: as fs.subvolumes.clone does
  const otherHome = () => join(mount, `project-${OTHER}`);
  const copyHome = async () => {
    await cp(home, otherHome(), { recursive: true, verbatimSymlinks: true });
  };

  it("copies a project whose history is still in its home", async () => {
    await cloneProjectWithPersistVolume({
      src_project_id: PROJECT,
      project_id: OTHER,
      cloneHome: copyHome,
      ops: fakeOps(),
    });
    expect(existsSync(persistVolumePath(OTHER)!)).toBe(false);
    expect(read(join(otherHome(), LEGACY, "a.db"))).toBe("a");
  });

  it("copies the history when it is imported while the home is copied", async () => {
    await cloneProjectWithPersistVolume({
      src_project_id: PROJECT,
      project_id: OTHER,
      // the persist server imports the source's history (and deletes the old
      // directory) between the first look and copying the home
      cloneHome: async () => {
        await prepareProjectPersistVolume(
          { project_id: PROJECT, root },
          fakeOps(),
          env,
        );
        await copyHome();
      },
      ops: fakeOps(),
    });
    const copy = persistVolumePath(OTHER)!;
    expect(read(join(copy, "a.db"))).toBe("a");
    expect(read(join(copy, "patchflow", "b.db"))).toBe("b");
    expect(existsSync(join(copy, READY_MARKER))).toBe(true);
    expect(existsSync(join(otherHome(), LEGACY))).toBe(false);
  });

  it("leaves no copy when it can't be completed", async () => {
    await readyVolume();
    const ops = fakeOps();
    ops.setQuota = async () => {
      throw new Error("qgroup limit failed");
    };
    await expect(
      clonePersistVolume({ src_project_id: PROJECT, project_id: OTHER }, ops),
    ).rejects.toThrow("qgroup limit failed");
    expect(existsSync(persistVolumePath(OTHER)!)).toBe(false);
    expect(readdirSync(join(mount, ".persist-import"))).toEqual([]);
  });

  it("imports the copy's history from its home when the source wasn't imported", async () => {
    await clonePersistVolume(
      { src_project_id: PROJECT, project_id: OTHER },
      fakeOps(),
    );
    expect(existsSync(persistVolumePath(OTHER)!)).toBe(false);
  });

  it("is off when the databases stay in the home", async () => {
    process.env.COCALC_PERSIST_PROJECT_VOLUME = "0";
    try {
      expect(persistVolumePath(PROJECT)).toBeUndefined();
      await deletePersistVolume(PROJECT);
      expect(btrfs).not.toHaveBeenCalled();
    } finally {
      delete process.env.COCALC_PERSIST_PROJECT_VOLUME;
    }
  });
});
