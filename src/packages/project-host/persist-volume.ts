/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Each project's persist databases (edit history, chats, ...) live in a btrfs
subvolume of their own, project-<id>-persist, next to the project's home. It is
never mounted into the project, so the project can't change them (see
backend/conat/persist-volume-template.ts).

- The persist server creates a project's volume the first time it opens one of
  the project's databases. It imports the databases from the old directory in
  the home (.local/share/cocalc/persist), limits the volume's size (a share of
  the project's disk quota), marks the volume ready, and only then deletes the
  old directory.
  The import reads a read-only snapshot of the home, which only the host can
  reach, never follows a symlink, and copies only regular *.db and *.db-wal
  files. The server still treats their content as untrusted
  (conat/persist/storage.ts).
- Every snapshot of the home (local snapshots, and the temporary snapshot a
  backup is made from) gets a copy of the ready volume at ~/.cocalc-persist,
  with the volume's ready marker, which tells it from a directory of the
  project's own.  The history is captured before the home is snapshotted.
- A restore replaces the project's history together with its home: the new
  history is imported into a new volume first, from the restored home where
  only the host can reach it; then, while nothing has the project's history
  open (a persist fence, persist-fence.ts), the new volume and the new home
  are swapped in.  A backup restored over the home merges its history the
  same way.  A per-project lock keeps a snapshot's capture and a restore
  apart.
- Deleting, copying and archiving a project do the same to its volume.
*/

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import {
  PERSIST_VOLUME_READY_MARKER,
  projectPersistTemplates,
} from "@cocalc/backend/conat/persist-volume-template";
import { rmBeneathHome } from "@cocalc/backend/files/beneath-home";
import {
  getSubvolumeField,
  getSubvolumeId,
  isBtrfsSubvolume,
} from "@cocalc/file-server/btrfs/subvolume";
import { SubvolumeQuota } from "@cocalc/file-server/btrfs/subvolume-quota";
import { btrfsQuotasDisabled } from "@cocalc/file-server/btrfs/config";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  assertBtrfsBackgroundMutationAllowed,
  forgetSubvolumePaths,
} from "@cocalc/file-server/btrfs/operation-cache";
import { noteQgroupLimit } from "@cocalc/file-server/btrfs/qgroup-scan";
import { setPrepareProjectStore } from "@cocalc/conat/persist/context";
import { isValidUUID } from "@cocalc/util/misc";
import type { CapturedSnapshotData } from "@cocalc/file-server/btrfs/snapshot-preparer";
import { withProjectPersistFenced } from "./persist-fence";
import {
  assertPersistVolumesStayOn,
  commitToPersistVolumes,
} from "./persist-layout-guard";
import {
  joinProjectQuotaGroup,
  projectQuotaGroupLimit,
} from "./project-quota-group";

const logger = getLogger("project-host:persist-volume");

// Written once a volume holds the project's history; nothing opens a project
// database before.
export const READY_MARKER = PERSIST_VOLUME_READY_MARKER;
// Where snapshots and backups of a project's home hold its history: a name
// in the home's root only CoCalc uses, so adding it never changes the
// project's own files (older backups have it at the old directory instead).
// It holds READY_MARKER, which a directory of the project's own does not.
export const HISTORY_IN_SNAPSHOTS = ".cocalc-persist";

// Snapshots of homes to import from, next to the homes (same filesystem),
// e.g. /mnt/cocalc/.persist-import.
const IMPORT_STAGING_DIR = ".persist-import";

// what the import copies: databases and their write-ahead logs
const DATABASE_FILE = /\.db(-wal)?$/;
const MAX_IMPORT_ENTRIES = 100_000;
const MAX_IMPORT_DEPTH = 32;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// The most a persist volume's limit can be: the project's disk quota, which
// the history it imports fit in (the project controls those files, so their
// sizes are not trusted beyond that).
export function persistVolumeCeiling(
  homeQuota: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (homeQuota > 0) return homeQuota;
  const value = Number(env.COCALC_PERSIST_VOLUME_QUOTA_MAX_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : 20 * GiB;
}

// A persist volume's own size limit, only a safety net: what bounds the
// history is the project's quota group, over its files and history together
// (project-quota-group.ts), whose limit this is.  Without a disk quota, the
// most a volume can be.
export function persistVolumeQuota({
  homeQuota,
  env = process.env,
}: {
  // bytes; 0 if the home has no limit
  homeQuota: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const limit =
    homeQuota > 0
      ? projectQuotaGroupLimit(homeQuota, env)
      : persistVolumeCeiling(0, env);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`invalid persist volume quota: ${limit}`);
  }
  return limit;
}

// Where the persist server keeps the project's databases, if in a volume of
// their own.
export function persistVolumePath(
  project_id: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const { template, legacy } = projectPersistTemplates(env);
  if (legacy == null || !isValidUUID(project_id)) return;
  return template.split("[project_id]").join(project_id);
}

export async function isPersistVolumeReady(path: string): Promise<boolean> {
  return await exists(join(path, READY_MARKER));
}

function errorCode(err: unknown): string | undefined {
  return (
    (err as NodeJS.ErrnoException)?.code ??
    `${(err as Error)?.message ?? ""}`.match(/^(E[A-Z]+)\b/)?.[1]
  );
}

// ---------------------------------------------------------------------------
// In the persist server: make a project's volume ready before opening any of
// its databases.

// Call in a process that runs a persist server, before it serves.
// Whether projects keep their history in volumes of their own.
export function installProjectPersistVolumes(): boolean {
  const { legacy } = projectPersistTemplates();
  if (legacy == null) {
    // never back to the homes on a host whose histories left them
    assertPersistVolumesStayOn();
    return false;
  }
  // before any history moves (persist-layout-guard.ts)
  commitToPersistVolumes();
  setPrepareProjectStore(
    async (opts) => await prepareProjectPersistVolume(opts),
  );
  void deleteStaleStagingSnapshots(
    join(dirname(legacy.home), IMPORT_STAGING_DIR),
  );
  return true;
}

// Snapshots in IMPORT_STAGING_DIR are named for what made them and when, so
// a leftover can be told from one in use (by any process).
const STAGING_NAME =
  /^(import|snapshot|clone|restore|replaced)-([0-9a-f-]{36})-([0-9a-z]+)-[0-9a-f]{8}$/;
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

function stagingName(
  kind: "import" | "snapshot" | "clone" | "restore" | "replaced",
  project_id: string,
): string {
  return `${kind}-${project_id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

// Deletes what a crash left in `staging`: only what is older than a day,
// since anything newer may be in use.
export async function deleteStaleStagingSnapshots(
  staging: string,
  {
    now = Date.now(),
    ops = btrfsOps,
  }: { now?: number; ops?: PersistVolumeOps } = {},
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(staging);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of names) {
    const match = name.match(STAGING_NAME);
    const created = parseInt(match?.[3] ?? "", 36);
    if (!Number.isSafeInteger(created) || now - created < STALE_STAGING_MS) {
      continue;
    }
    try {
      await ops.removeTree(join(staging, name));
      deleted.push(name);
    } catch (err) {
      logger.warn("unable to delete a stale persist staging snapshot", {
        name,
        err: `${err}`,
      });
    }
  }
  return deleted;
}

export interface PersistVolumeOps {
  createVolume: (path: string) => Promise<void>;
  isSubvolume: (path: string) => Promise<boolean>;
  // a read-only snapshot of a home at snapshot, a new path
  snapshotReadonly: (home: string, snapshot: string) => Promise<void>;
  deleteVolume: (path: string) => Promise<void>;
  // size limit of a volume in bytes; 0 if it has none
  getQuota: (path: string) => Promise<number>;
  setQuota: (path: string, bytes: number) => Promise<void>;
  // deletes `relative` in the project's home, never following a symlink
  removeFromHome: (home: string, relative: string) => Promise<void>;
  // the btrfs UUID of a subvolume
  subvolumeUuid: (path: string) => Promise<string>;
  // whether a subvolume is read-only (e.g., a home frozen to be archived)
  isReadonly: (path: string) => Promise<boolean>;
  // deletes a host-only staging directory
  removeTree: (path: string) => Promise<void>;
  // puts the volume at path in the project's quota group
  // (project-quota-group.ts; `required`: see joinProjectQuotaGroup)
  joinQuotaGroup: (
    project_id: string,
    path: string,
    opts?: { required?: boolean },
  ) => Promise<void>;
}

export const btrfsOps: PersistVolumeOps = {
  createVolume: async (path) => {
    await btrfs({ args: ["subvolume", "create", path] });
    await sudo({
      command: "chown",
      args: [`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, path],
    });
  },
  getQuota: async (path) => {
    if (btrfsQuotasDisabled()) return 0;
    const quota = new SubvolumeQuota({
      path,
      getSubvolumeId: async () => await getSubvolumeId(path),
    } as any);
    return Number((await quota.get()).size) || 0;
  },
  setQuota: async (path, bytes) => {
    if (btrfsQuotasDisabled()) {
      logger.warn(
        "btrfs quotas are disabled, so a persist volume has no limit",
        {
          path,
        },
      );
      return;
    }
    // As the quota queue does (quota-queue.ts), which only the file
    // server's process runs. A failure leaves the volume not ready, so the
    // next open tries again.
    await btrfs({
      args: ["qgroup", "limit", `${bytes}`, path, dirname(path)],
      verbose: false,
    });
    // what's read of the filesystem's quotas says so too (qgroup-scan.ts)
    await noteQgroupLimit({ mount: dirname(path), path, size: bytes });
  },
  removeFromHome: async (home, relative) => {
    await rmBeneathHome(home, relative);
  },
  subvolumeUuid: async (path) =>
    await getSubvolumeField(path, "UUID", { cache: false }),
  isReadonly: async (path) => {
    const { stdout } = await btrfs({
      args: ["property", "get", "-ts", path, "ro"],
      err_on_exit: true,
      verbose: false,
    });
    return /\bro\s*=\s*true\b/i.test(`${stdout}`);
  },
  removeTree: async (path) => {
    if (await isBtrfsSubvolume(path).catch(() => false)) {
      await btrfs({ args: ["subvolume", "delete", path] });
    } else {
      await sudo({ command: "rm", args: ["-rf", path] });
    }
  },
  isSubvolume: isBtrfsSubvolume,
  snapshotReadonly: async (home, snapshot) => {
    await sudo({ command: "mkdir", args: ["-p", dirname(snapshot)] });
    await btrfs({ args: ["subvolume", "snapshot", "-r", home, snapshot] });
  },
  deleteVolume: async (path) => {
    try {
      await btrfs({ args: ["subvolume", "delete", path] });
    } finally {
      // (another may be made at the path)
      forgetSubvolumePaths(path);
    }
  },
  joinQuotaGroup: async (project_id, path, opts) => {
    await joinProjectQuotaGroup({
      project_id,
      mount: dirname(path),
      path,
      required: opts?.required,
    });
  },
};

// The volume at `path` is the project's: it counts against the project's
// quota.  If that fails, its own limit still bounds it, and the project's next
// quota change or audit (file-server.ts) adds it.
async function joinQuotaGroup(
  ops: PersistVolumeOps,
  project_id: string,
  path: string,
): Promise<void> {
  try {
    await ops.joinQuotaGroup(project_id, path);
  } catch (err) {
    logger.warn("unable to add a persist volume to its project's quota", {
      project_id,
      path,
      err: `${err}`,
    });
  }
}

// The volume at `path`, which writes data that will be part of the project's
// history, counts against the project's quota from now on.  Required: btrfs
// simple quotas charge data to the subvolume that wrote it for as long as
// anything uses it, even after that subvolume is deleted, so one outside the
// project's group would leave that data uncounted for good.  So it is never
// skipped (e.g., while the host's root helper was refusing groups): it is
// in the group, or this throws.
async function requireQuotaGroup(
  ops: PersistVolumeOps,
  project_id: string,
  path: string,
): Promise<void> {
  await ops.joinQuotaGroup(project_id, path, { required: true });
}

const preparing = new Map<string, Promise<void>>();

// Right after an upgrade every active project imports at once; a few at a
// time keeps the snapshots and copies from stalling the filesystem.
const MAX_CONCURRENT_IMPORTS = 4;
let importsRunning = 0;
const importsWaiting: (() => void)[] = [];

async function withImportSlot<T>(run: () => Promise<T>): Promise<T> {
  while (importsRunning >= MAX_CONCURRENT_IMPORTS) {
    await new Promise<void>((resolve) => importsWaiting.push(resolve));
  }
  importsRunning += 1;
  try {
    return await run();
  } finally {
    importsRunning -= 1;
    importsWaiting.shift()?.();
  }
}

export async function prepareProjectPersistVolume(
  { project_id, root }: { project_id: string; root: string },
  ops: PersistVolumeOps = btrfsOps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await isPersistVolumeReady(root)) return;
  let task = preparing.get(project_id);
  if (task == null) {
    task = withImportSlot(
      async () => await prepare({ project_id, root, ops, env }),
    ).finally(() => preparing.delete(project_id));
    preparing.set(project_id, task);
  }
  await task;
}

async function prepare({
  project_id,
  root,
  ops,
  env,
}: {
  project_id: string;
  root: string;
  ops: PersistVolumeOps;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id: ${project_id}`);
  }
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null || root !== persistVolumePath(project_id, env)) {
    throw new Error(`not a project persist volume: ${root}`);
  }
  // Without a home on this host, the project has no history here either.
  const home = legacy.home.split("[project_id]").join(project_id);
  if (!(await exists(home))) {
    throw new Error(`project root does not exist: ${home}`);
  }
  // A home frozen to be archived takes no edits, and neither does its history
  // (archive-volume-barrier.ts): checked again before the volume is ready.
  const assertNotFrozen = async () => {
    if (await ops.isReadonly(home)) {
      throw new Error(`project is being archived: ${home}`);
    }
  };
  await assertNotFrozen();
  if (!(await exists(root))) {
    await ops.createVolume(root);
  } else if (!(await ops.isSubvolume(root))) {
    throw new Error(`persist volume is not a btrfs subvolume: ${root}`);
  }
  await joinQuotaGroup(ops, project_id, root);
  // Nothing opened a database in a volume that is not ready (or it was
  // left by an import that failed): start over.
  for (const name of await readdir(root)) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  // While importing, the volume may hold at most what the history could:
  // the project controls those files (e.g., a huge sparse one).
  const homeQuota = await ops.getQuota(home);
  await ops.setQuota(root, persistVolumeCeiling(homeQuota, env));
  // The project's own history in its home, as of a snapshot: only the old
  // directory.  (Restores import a ~/.cocalc-persist themselves, so one here
  // is the project's own and is left alone.)
  const staging = join(dirname(home), IMPORT_STAGING_DIR);
  const snapshot = join(staging, stagingName("import", project_id));
  await ops.snapshotReadonly(home, snapshot);
  let imported: Awaited<ReturnType<typeof importPersistDatabases>>;
  try {
    imported = await importPersistDatabases({
      source: snapshot,
      relative: legacy.relative,
      dest: root,
    });
  } finally {
    await ops.deleteVolume(snapshot).catch((err) => {
      logger.warn("unable to delete persist import snapshot", {
        snapshot,
        err: `${err}`,
      });
    });
  }
  const quota = persistVolumeQuota({ homeQuota, env });
  await ops.setQuota(root, quota);
  await assertNotFrozen();
  await writeReadyMarker(root, { quota, ...imported });
  logger.info("persist volume ready", { project_id, quota, ...imported });
  // The volume holds the history now; the old copy in the home only takes
  // space (software from before volumes, which this host no longer runs,
  // persist-layout-guard.ts, would show no history).
  try {
    await ops.removeFromHome(home, legacy.relative);
  } catch (err) {
    logger.warn("unable to delete the imported persist directory", {
      project_id,
      err: `${err}`,
    });
  }
}

// Marks a volume ready, atomically and durably: its databases (synced
// first) are the project's history.  Anything that relies on the volume, like
// deleting the old directory, comes after this.
async function writeReadyMarker(
  root: string,
  info: { [key: string]: unknown },
): Promise<void> {
  await syncTree(root);
  const tmp = join(root, `.ready-${randomUUID()}`);
  await writeFile(
    tmp,
    JSON.stringify({ time: new Date().toISOString(), ...info }),
  );
  await syncPath(tmp, false);
  await rename(tmp, join(root, READY_MARKER));
  await syncPath(root, true);
}

async function syncPath(path: string, directory: boolean): Promise<void> {
  const handle = await open(
    path,
    directory ? constants.O_RDONLY | constants.O_DIRECTORY : constants.O_RDONLY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Every file and directory under root (a host-only volume) reaches the disk,
// or this throws.
export async function syncTree(root: string): Promise<void> {
  const walk = async (dir: string, depth: number) => {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_IMPORT_DEPTH) {
        await walk(path, depth + 1);
      } else if (entry.isFile()) {
        await syncPath(path, false);
      }
    }
    await syncPath(dir, true);
  };
  await walk(root, 0);
}

// After the project's disk quota changed: its persist volume's limit follows.
export async function syncPersistVolumeQuota(
  project_id: string,
  homeQuota: number,
  ops: PersistVolumeOps = btrfsOps,
): Promise<void> {
  const path = persistVolumePath(project_id);
  if (path == null || !(await isPersistVolumeReady(path))) return;
  const current = await ops.getQuota(path);
  const quota = persistVolumeQuota({ homeQuota });
  if (quota !== current) {
    await ops.setQuota(path, quota);
  }
}

// Copies the databases under `relative` in `source` to `dest`. `source` is a
// read-only snapshot of a home, which only the host can reach, so nothing
// changes while this walks it. Never follows a symlink; skips anything but
// directories and regular database files. Throws if something can't be read
// (e.g., a directory the project made unreadable), so nothing is marked ready
// with part of the history missing.
export async function importPersistDatabases({
  source,
  relative,
  dest,
  maxEntries = MAX_IMPORT_ENTRIES,
  merge = false,
}: {
  source: string;
  relative: string;
  dest: string;
  maxEntries?: number;
  // replace databases already in `dest` (with their write-ahead logs), keep
  // the others
  merge?: boolean;
}): Promise<{ files: number; bytes: number; skipped: number }> {
  const result = { files: 0, bytes: 0, skipped: 0 };
  // The old directory itself: a symlink or anything but a directory along
  // the way means there is no history to import.
  let from = source;
  for (const part of relative.split("/")) {
    from = join(from, part);
    let stat;
    try {
      stat = await lstat(from);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return result;
      throw err;
    }
    if (!stat.isDirectory()) return result;
  }
  let entries = 0;
  const copyDirectory = async (dir: string, to: string, depth: number) => {
    // one entry at a time: the project decides how many there are (leaving
    // the loop closes the directory)
    for await (const entry of await opendir(dir)) {
      entries += 1;
      if (entries > maxEntries) {
        throw new Error(`more than ${maxEntries} entries in ${from}`);
      }
      const path = join(dir, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory() && depth < MAX_IMPORT_DEPTH) {
        await mkdir(target, { recursive: merge });
        await copyDirectory(path, target, depth + 1);
      } else if (merge && entry.isFile() && DATABASE_FILE.test(entry.name)) {
        // a log goes with its database, never onto another one
        if (entry.name.endsWith(".db-wal")) continue;
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await rm(target + suffix, { force: true });
        }
        result.bytes += await replaceFile(path, target);
        result.files += 1;
        const wal = await lstat(path + "-wal").catch(() => undefined);
        if (wal?.isFile()) {
          result.bytes += await replaceFile(path + "-wal", target + "-wal");
          result.files += 1;
        }
      } else if (entry.isFile() && DATABASE_FILE.test(entry.name)) {
        // a reflink where possible; the volume's limit bounds a full copy
        await copyFile(
          path,
          target,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
        result.files += 1;
        result.bytes += (await lstat(target)).size;
      } else {
        result.skipped += 1;
      }
    }
  };
  await copyDirectory(from, dest, 0);
  return result;
}

// Copies `source` over `target` (atomically, by rename); the size copied.
async function replaceFile(source: string, target: string): Promise<number> {
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    await copyFile(
      source,
      tmp,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    const { size } = await lstat(tmp);
    await rename(tmp, target);
    return size;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// In the project-host: the volume follows its project.

const HOME_VOLUME = /^project-([0-9a-f-]{36})$/i;

export function snapshotNeedsPersistVolume(subvolume: string): boolean {
  const project_id = subvolume.match(HOME_VOLUME)?.[1];
  return project_id != null && persistVolumePath(project_id) != null;
}

// A read-only snapshot of the project's ready persist volume, taken BEFORE a
// snapshot of its home (snapshot-preparer.ts), and added to that one at
// HISTORY_IN_SNAPSHOTS while it is still writable. `stagingPath` is a free
// path for it.  Holds the project's persist lock until released, so a restore
// never swaps the history between this capture and the home's snapshot.
export async function capturePersistVolume({
  subvolume,
  stagingPath,
  env = process.env,
}: {
  subvolume: string;
  stagingPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CapturedSnapshotData | undefined> {
  const project_id = subvolume.match(HOME_VOLUME)?.[1];
  const { legacy } = projectPersistTemplates(env);
  const volume = project_id ? persistVolumePath(project_id, env) : undefined;
  if (project_id == null || volume == null || legacy == null) return;
  // Background work (a scheduled backup or snapshot) that the host would
  // defer under I/O pressure must not snapshot the history first: it would
  // be deleted again at once, and each try is a btrfs transaction commit,
  // which only adds to the pressure (operation-cache.ts).
  const assertAllowed = () =>
    assertBtrfsBackgroundMutationAllowed({
      mount: dirname(volume),
      operation: "persist-capture",
    });
  assertAllowed();
  const unlock = await acquirePersistLock(project_id);
  let captured: string;
  try {
    // Not imported yet: the old directory in the home is still the history.
    if (!(await isPersistVolumeReady(volume))) {
      unlock();
      return;
    }
    // (again: the lock may have taken a while)
    assertAllowed();
    // removed by the persist server when it starts, if left over
    captured =
      stagingPath ??
      join(
        dirname(volume),
        IMPORT_STAGING_DIR,
        stagingName("snapshot", project_id),
      );
    await sudo({ command: "mkdir", args: ["-p", dirname(captured)] });
    await btrfs({ args: ["subvolume", "snapshot", "-r", volume, captured] });
  } catch (err) {
    unlock();
    throw err;
  }
  return {
    addTo: async (snapshotPath) => {
      const target = join(snapshotPath, HISTORY_IN_SNAPSHOTS);
      const existing = await lstat(target).catch(() => undefined);
      if (existing != null) {
        // CoCalc's own copy, left in the home by a restore whose cleanup
        // didn't finish: replaced (in this host-only snapshot).  Never
        // anything of the project's: fail instead.
        const marker = existing.isDirectory()
          ? await lstat(join(target, READY_MARKER)).catch(() => undefined)
          : undefined;
        if (!marker?.isFile()) {
          throw new Error(
            `cannot save the edit history with the files: ~/${HISTORY_IN_SNAPSHOTS} already exists (it is reserved for CoCalc)`,
          );
        }
        await sudo({ command: "rm", args: ["-rf", target] });
      }
      // the root helper anchored at the mount, which never follows symlinks;
      // the copy keeps READY_MARKER, which marks it as CoCalc's
      await sudo({ command: "copy-tree-reflink", args: [captured, target] });
    },
    release: async () => {
      try {
        await btrfs({ args: ["subvolume", "delete", captured] }).catch(
          (err) => {
            logger.warn("unable to delete persist snapshot", {
              captured,
              err: `${err}`,
            });
          },
        );
      } finally {
        unlock();
      }
    },
  };
}

// capturePersistVolume and add it to `snapshotPath` at once (the history may
// then be newer than the snapshot: only for tests).
export async function copyPersistVolumeIntoSnapshot(opts: {
  subvolume: string;
  snapshotPath: string;
  stagingPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const captured = await capturePersistVolume(opts);
  if (captured == null) return;
  try {
    await captured.addTo(opts.snapshotPath);
  } finally {
    await captured.release();
  }
}

// A read-only snapshot at `dest` in the project's ~/.snapshots of `source`,
// its home or a snapshot of it, with its edit history as in every snapshot
// there (subvolume-snapshots.ts does the same for the usual ones).  The
// project can write its home, and the history must never be writable there:
// the snapshot is completed in host-only staging first.
export async function snapshotWithHistory({
  project_id,
  source,
  dest,
  env = process.env,
}: {
  project_id: string;
  source: string;
  dest: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const subvolume = `project-${project_id}`;
  let captured = await capturePersistVolume({ subvolume, env });
  try {
    if (captured == null) {
      await btrfs({ args: ["subvolume", "snapshot", "-r", source, dest] });
      // There was nothing to add, but there may be now (the history just
      // moved out of the home): then take the snapshot again with it.
      captured = await capturePersistVolume({ subvolume, env });
      if (captured == null) return;
      await btrfs({ args: ["subvolume", "delete", dest] });
    }
    const staged = join(
      dirname(persistVolumePath(project_id, env)!),
      IMPORT_STAGING_DIR,
      stagingName("snapshot", project_id),
    );
    await btrfs({ args: ["subvolume", "snapshot", source, staged] });
    try {
      await captured.addTo(staged);
      await btrfs({ args: ["property", "set", "-ts", staged, "ro", "true"] });
      await btrfs({ args: ["subvolume", "snapshot", "-r", staged, dest] });
    } finally {
      await btrfs({ args: ["subvolume", "delete", staged] }).catch((err) => {
        logger.warn("unable to delete a staged snapshot", {
          staged,
          err: `${err}`,
        });
      });
    }
  } finally {
    await captured?.release();
  }
}

// Where restoring `path` of a backup to `dest` in the project's home puts
// the backup's history back, if it does, in the order to look for it in the
// backup: HISTORY_IN_SNAPSHOTS (newer backups) and the old directory (older
// backups), as far as the restore covers them.
export function restoredHistoryCandidates({
  path,
  dest,
  env = process.env,
}: {
  path: string;
  dest: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null) return [];
  const normalize = (x: string) =>
    posix
      .normalize(`/${x ?? ""}`)
      .replace(/\/+$/, "")
      .slice(1);
  const from = normalize(path);
  if (from !== normalize(dest)) return [];
  if (from === "") return [HISTORY_IN_SNAPSHOTS, legacy.relative];
  if (from === HISTORY_IN_SNAPSHOTS) return [HISTORY_IN_SNAPSHOTS];
  if (legacy.relative === from || legacy.relative.startsWith(`${from}/`)) {
    return [legacy.relative];
  }
  return [];
}

// A backup restored over the home, by restoreFiles.  If the backup has
// history where the restore covers it (restoredHistoryCandidates), that is
// first restored where only the host can write (restoreInto); then the files
// are restored and the history merged into the project's (mergeRestoredHistory)
// as one step, under the persist lock and a fence, so no edit, capture or copy
// falls between them.  A HISTORY_IN_SNAPSHOTS without READY_MARKER is the
// project's own directory, and so is the old directory in a backup that has
// CoCalc's.  Whether the backup had history; any error is thrown: never a
// partial history.
export async function restoreBackupWithHistory({
  project_id,
  candidates,
  listDirectory,
  restoreInto,
  restoreFiles,
  withRoom,
  env = process.env,
  ops = btrfsOps,
}: {
  project_id: string;
  candidates: string[];
  // entries of an existing directory in the backup ("" is its root)
  listDirectory: (path: string) => Promise<{ name: string; isDir: boolean }[]>;
  // restores `path` of the backup into the existing directory `dest`
  restoreInto: (path: string, dest: string) => Promise<void>;
  // the restore itself, of files into the home
  restoreFiles: () => Promise<void>;
  // Runs fn with room for `bytes` more in the project's quota (a temporary
  // override, file-server.ts): the restored history passes through the home
  // with the files (until cleanRestoredHome), and is in the old and the new
  // history at once until the old is deleted.
  withRoom?: <T>(bytes: number, fn: () => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  ops?: PersistVolumeOps;
}): Promise<boolean> {
  const from = await backupHistory({ candidates, listDirectory });
  const source =
    from == null ? undefined : await newRestoreDirectory(project_id, env, ops);
  if (from == null || source == null) {
    await restoreFiles();
    return false;
  }
  try {
    // the project's limits as they are, before any room for the restore
    const homeQuota = await homeQuotaOf(project_id, env, ops);
    await restoreInto(from, source);
    const restored = await databaseBytes(source);
    const room = withRoom ?? (async (_bytes, fn) => await fn());
    await room(restoreRoom(restored), async () => {
      // what the backup's history was restored into is where its data is
      // charged, also once it is merged and this is deleted
      await requireQuotaGroup(ops, project_id, source);
      let previous: string | undefined;
      await withPersistLock(project_id, async () => {
        await withProjectPersistFenced(
          { project_id, reason: "restore-backup", requires: "persist-volume" },
          async () => {
            // all of the merge that can fail first, so it never fails after
            // the files changed
            const merged = await prepareMergedVolume({
              project_id,
              source,
              homeQuota,
              env,
              ops,
            });
            try {
              await restoreFiles();
            } catch (err) {
              if (merged != null) await ops.removeTree(merged).catch(() => {});
              throw err;
            }
            if (merged != null) {
              previous = await swapInVolume(project_id, merged, env, ops);
            }
          },
        );
        // still holding the lock (see replaceProjectHome)
        await cleanRestoredHome({ project_id, from, env, ops });
      });
      // what the restore staged goes before its room does
      await ops.removeTree(source).catch(() => {});
      if (previous != null) {
        await ops.removeTree(previous).catch(() => {});
      }
    });
  } finally {
    await ops.removeTree(source).catch(() => {});
  }
  return true;
}

// The room a restore of `bytes` of history needs in the project's quota
// beyond what it has (see restoreBackupWithHistory's withRoom), with some to
// spare for the databases' write-ahead logs and metadata.
export function restoreRoom(bytes: number): number {
  // the copy restored into the home, and the staged history (charged to the
  // project's group from when it joins), both until the restore is done
  return 2 * Math.max(0, bytes) + 64 * MiB;
}

// The databases in `root` (a host-only volume or staging directory), with
// their write-ahead logs, in bytes.
export async function databaseBytes(root: string): Promise<number> {
  let bytes = 0;
  const walk = async (dir: string, depth: number) => {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_IMPORT_DEPTH) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && DATABASE_FILE.test(entry.name)) {
        bytes += (await lstat(path)).size;
      }
    }
  };
  await walk(root, 0);
  return bytes;
}

// Where the backup holds the history a restore covers, if it does.
async function backupHistory({
  candidates,
  listDirectory,
}: {
  candidates: string[];
  listDirectory: (path: string) => Promise<{ name: string; isDir: boolean }[]>;
}): Promise<string | undefined> {
  const hasDirectory = async (path: string) => {
    let dir = "";
    // only directories known to exist are listed, so an error is an error
    for (const part of path.split("/")) {
      const entries = await listDirectory(dir);
      if (!entries.some((entry) => entry.name === part && entry.isDir)) {
        return false;
      }
      dir = dir ? `${dir}/${part}` : part;
    }
    return true;
  };
  // CoCalc's history in the backup: HISTORY_IN_SNAPSHOTS with READY_MARKER
  const hasMarkedHistory = async () =>
    (await hasDirectory(HISTORY_IN_SNAPSHOTS)) &&
    (await listDirectory(HISTORY_IN_SNAPSHOTS)).some(
      (entry) => entry.name === READY_MARKER && !entry.isDir,
    );
  let marked: boolean | undefined;
  for (const candidate of candidates) {
    if (!(await hasDirectory(candidate))) continue;
    marked ??= await hasMarkedHistory();
    if (candidate === HISTORY_IN_SNAPSHOTS && !marked) continue;
    // A backup with CoCalc's history (taken after the import) has the
    // project's own files at the old directory, whatever the restore covers.
    if (candidate !== HISTORY_IN_SNAPSHOTS && marked) continue;
    return candidate;
  }
  return undefined;
}

// A new host-only volume for restored history, limited like the project's
// persist volume: what a restore puts there is bounded.  With `join`, it is
// in the project's quota group from the start (requireQuotaGroup); else the
// caller adds it before anything it wrote is kept.
async function newRestoreDirectory(
  project_id: string,
  env: NodeJS.ProcessEnv,
  ops: PersistVolumeOps,
  { join: joinGroup = false }: { join?: boolean } = {},
): Promise<string | undefined> {
  const kind = "restore";
  const { legacy } = projectPersistTemplates(env);
  const volume = persistVolumePath(project_id, env);
  if (volume == null || legacy == null) return;
  const staging = join(dirname(volume), IMPORT_STAGING_DIR);
  // leftovers never pile up, however long the host runs
  await deleteStaleStagingSnapshots(staging, { ops }).catch(() => []);
  const path = join(staging, stagingName(kind, project_id));
  await sudo({ command: "mkdir", args: ["-p", staging] });
  await ops.createVolume(path);
  try {
    // as much as the history may take (Q + R)
    await ops.setQuota(
      path,
      persistVolumeQuota({
        homeQuota: await homeQuotaOf(project_id, env, ops),
        env,
      }),
    );
    if (joinGroup) await requireQuotaGroup(ops, project_id, path);
  } catch (err) {
    await ops.removeTree(path).catch(() => {});
    throw err;
  }
  return path;
}

async function homeQuotaOf(
  project_id: string,
  env: NodeJS.ProcessEnv,
  ops: PersistVolumeOps,
): Promise<number> {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null) return 0;
  const home = legacy.home.split("[project_id]").join(project_id);
  return (await exists(home)) ? await ops.getQuota(home) : 0;
}

// Where `home` (one only the host can reach, e.g., a restore's replacement)
// holds the project's history: HISTORY_IN_SNAPSHOTS if it is CoCalc's (it has
// READY_MARKER), else the old directory; undefined if neither.  Never follows
// a symlink.
export async function historyInHome(
  home: string,
  legacyRelative: string,
): Promise<string | undefined> {
  const isDirectory = async (relative: string) => {
    let path = home;
    for (const part of relative.split("/")) {
      path = join(path, part);
      if (!(await lstat(path).catch(() => undefined))?.isDirectory()) {
        return false;
      }
    }
    return true;
  };
  if (
    (await isDirectory(HISTORY_IN_SNAPSHOTS)) &&
    (
      await lstat(join(home, HISTORY_IN_SNAPSHOTS, READY_MARKER)).catch(
        () => undefined,
      )
    )?.isFile()
  ) {
    return HISTORY_IN_SNAPSHOTS;
  }
  if (await isDirectory(legacyRelative)) return legacyRelative;
  return undefined;
}

// A new ready volume with the history in `replacement`, a home the project
// can't reach yet (restore staging, or a snapshot's clone); undefined if
// projects keep their history in their home, or `replacement` has none.
export async function stageRestoredVolume({
  project_id,
  replacement,
  env = process.env,
  ops = btrfsOps,
}: {
  project_id: string;
  replacement: string;
  env?: NodeJS.ProcessEnv;
  ops?: PersistVolumeOps;
}): Promise<{ path: string; from?: string } | undefined> {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null || persistVolumePath(project_id, env) == null) return;
  const from = await historyInHome(replacement, legacy.relative);
  if (from == null) {
    // No history at all (e.g., a snapshot made without it): the project's
    // history is kept, never replaced by an empty one.
    logger.warn("restored home has no history; keeping the project's", {
      project_id,
    });
    return;
  }
  // (in the project's group from the start: they hold reflinks of the
  // restored home, which is charged where it was written, unless the copy
  // has to write data of its own)
  const staged = await newRestoreDirectory(project_id, env, ops, {
    join: true,
  });
  if (staged == null) return;
  try {
    let imported = { files: 0, bytes: 0, skipped: 0 };
    if (from != null) {
      // Copied by the root helper first (it never follows symlinks, and can
      // read whatever the restore put there), then imported: only regular
      // database files.
      const copy = await newRestoreDirectory(project_id, env, ops, {
        join: true,
      });
      try {
        await sudo({
          command: "copy-tree-reflink",
          args: [join(replacement, from), copy!],
        });
        imported = await importPersistDatabases({
          source: copy!,
          relative: "",
          dest: staged,
        });
      } finally {
        await ops.removeTree(copy!).catch(() => {});
      }
    }
    const homeQuota = await homeQuotaOf(project_id, env, ops);
    const quota = persistVolumeQuota({ homeQuota, env });
    await ops.setQuota(staged, quota);
    await writeReadyMarker(staged, { quota, restored: true, ...imported });
    return { path: staged, from };
  } catch (err) {
    await ops.removeTree(staged).catch(() => {});
    throw err;
  }
}

// One holder at a time per project, in this process: a restore and the
// capture of its history for a snapshot (capturePersistVolume).
const persistLocks = new Map<string, Promise<void>>();

export async function acquirePersistLock(
  project_id: string,
): Promise<() => void> {
  const previous = persistLocks.get(project_id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const chained = previous.then(() => current);
  persistLocks.set(project_id, chained);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (persistLocks.get(project_id) === chained) {
      persistLocks.delete(project_id);
    }
  };
}

async function withPersistLock<T>(
  project_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const unlock = await acquirePersistLock(project_id);
  try {
    return await fn();
  } finally {
    unlock();
  }
}

// Runs fn with the project's persist lock held and its streams fenced, for
// anything that removes its storage (its home, its persist volume).
export async function withProjectStorageFenced<T>(
  {
    project_id,
    reason,
    waitMs,
    timeoutMs,
    env = process.env,
  }: {
    project_id: string;
    reason: string;
    // (withProjectPersistFenced)
    waitMs?: number;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
  fn: () => Promise<T>,
): Promise<T> {
  return await withPersistLock(project_id, async () =>
    withProjectPersistFenced(
      {
        project_id,
        reason,
        requires:
          persistVolumePath(project_id, env) == null
            ? undefined
            : "persist-volume",
      },
      fn,
      { waitMs, timeoutMs },
    ),
  );
}

// Moves a volume: what was read about the paths (subvolume ids, the quota
// scan) no longer holds (file-server qgroup-scan.ts).
async function moveVolume(source: string, destination: string) {
  try {
    await sudo({ command: "mv", args: [source, destination] });
  } finally {
    forgetSubvolumePaths(source, destination);
  }
}

// Puts the volume at `staged` in place of the project's persist volume; the
// path the replaced one is now at (to delete), if there was one.
async function swapInVolume(
  project_id: string,
  staged: string,
  env: NodeJS.ProcessEnv,
  ops: PersistVolumeOps,
): Promise<string | undefined> {
  const volume = persistVolumePath(project_id, env)!;
  let previous: string | undefined;
  if (await exists(volume)) {
    previous = join(
      dirname(volume),
      IMPORT_STAGING_DIR,
      stagingName("replaced", project_id),
    );
    await moveVolume(volume, previous);
  }
  try {
    await moveVolume(staged, volume);
  } catch (err) {
    if (previous != null) {
      await moveVolume(previous, volume);
    }
    throw err;
  }
  // staged outside the home, so in no group
  await joinQuotaGroup(ops, project_id, volume);
  return previous;
}

// Removes from the project's home the history a restore imported from it:
// `from` (HISTORY_IN_SNAPSHOTS, only while it is CoCalc's, or the old
// directory of a backup or snapshot from before the import).  Anything else
// there, e.g., files of the project's own at the old path in a newer backup,
// is kept.
async function cleanRestoredHome({
  project_id,
  from,
  env,
  ops,
}: {
  project_id: string;
  from?: string;
  env: NodeJS.ProcessEnv;
  ops: PersistVolumeOps;
}): Promise<void> {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null || from == null) return;
  const home = legacy.home.split("[project_id]").join(project_id);
  if (from === HISTORY_IN_SNAPSHOTS) {
    // removeFromHome never follows a symlink
    const marker = await lstat(
      join(home, HISTORY_IN_SNAPSHOTS, READY_MARKER),
    ).catch(() => undefined);
    const reserved = await lstat(join(home, HISTORY_IN_SNAPSHOTS)).catch(
      () => undefined,
    );
    if (!reserved?.isDirectory() || !marker?.isFile()) return;
  } else if (from !== legacy.relative) {
    return;
  }
  await ops.removeFromHome(home, from).catch((err) => {
    logger.warn("unable to remove restored history from the home", {
      project_id,
      relative: from,
      err: `${err}`,
    });
  });
}

// Replaces the project's home with `replacement` (by `swap`) and its history
// with the one in `replacement`, as one step: the new history is staged
// first, then both are swapped in while nothing has the project's history
// open (a persist fence) and no snapshot captures it (the persist lock).  If
// the home can't be swapped in, the history stays as it was.  Clients load
// the history again only if it was replaced: one staged from `replacement`,
// or, without volumes, the files in the home (historyInHome).
export async function replaceProjectHome<T>({
  project_id,
  replacement,
  reason,
  swap,
  historyInHome = true,
  env = process.env,
  ops = btrfsOps,
}: {
  project_id: string;
  replacement: string;
  reason: string;
  swap: () => Promise<T>;
  // without volumes: whether the home holds the project's persist files
  historyInHome?: boolean;
  env?: NodeJS.ProcessEnv;
  ops?: PersistVolumeOps;
}): Promise<T> {
  const staged = await stageRestoredVolume({
    project_id,
    replacement,
    env,
    ops,
  });
  let swappedIn = false;
  let previous: string | undefined;
  let result: T;
  try {
    result = await withPersistLock(project_id, async () => {
      const volume = persistVolumePath(project_id, env);
      const replacesHistory =
        staged != null || (volume == null && historyInHome);
      const fenced = <S>(fn: () => Promise<S>): Promise<S> =>
        // With volumes, always: the persist server must have them (requires)
        // even when the history stays.  Without, only if the home holds it.
        volume != null || replacesHistory
          ? withProjectPersistFenced(
              {
                project_id,
                reason,
                ...(volume != null ? { requires: "persist-volume" } : {}),
                ...(replacesHistory ? {} : { replaces: false }),
              },
              fn,
            )
          : fn();
      // (with the history in the home, the fence covers just the home swap)
      const swapped = await fenced(async () => {
        if (staged != null) {
          previous = await swapInVolume(project_id, staged.path, env, ops);
          swappedIn = true;
        }
        try {
          return await swap();
        } catch (err) {
          if (staged != null) {
            // the history goes back with the home
            // (moveVolume: what was read about the paths no longer holds)
            await moveVolume(volume!, staged.path);
            swappedIn = false;
            if (previous != null) {
              await moveVolume(previous, volume!);
              previous = undefined;
            }
          }
          throw err;
        }
      });
      // Still holding the lock, so no capture or copy sees the history's
      // copy in the new home.
      if (staged != null) {
        await cleanRestoredHome({ project_id, from: staged.from, env, ops });
      }
      return swapped;
    });
  } finally {
    if (staged != null && !swappedIn) {
      await ops.removeTree(staged.path).catch(() => {});
    }
  }
  if (previous != null) {
    await ops.removeTree(previous).catch((err) => {
      logger.warn("unable to delete a replaced persist volume", {
        previous,
        err: `${err}`,
      });
    });
  }
  return result;
}

// A backup restored over the home (which keeps files the backup doesn't
// have): the restored databases in `source` replace the project's, with
// their write-ahead logs, and its other databases are kept.  Under the
// persist lock and a fence (see restoreBackupWithHistory for the whole
// restore).
export async function mergeRestoredHistory({
  project_id,
  source,
  from,
  env = process.env,
  ops = btrfsOps,
}: {
  project_id: string;
  source: string;
  // where in the backup the history came from, restored into the home too
  from?: string;
  env?: NodeJS.ProcessEnv;
  ops?: PersistVolumeOps;
}): Promise<void> {
  let previous: string | undefined;
  await withPersistLock(project_id, async () => {
    await withProjectPersistFenced(
      { project_id, reason: "restore-backup", requires: "persist-volume" },
      async () => {
        previous = await mergeIntoVolume({ project_id, source, env, ops });
      },
    );
    // still holding the lock (see replaceProjectHome)
    await cleanRestoredHome({ project_id, from, env, ops });
  });
  if (previous != null) {
    await ops.removeTree(previous).catch(() => {});
  }
}

// mergeRestoredHistory's merge, with the lock and a fence held: the
// replaced volume's path (to delete), if there was one.
async function mergeIntoVolume(opts: {
  project_id: string;
  source: string;
  env: NodeJS.ProcessEnv;
  ops: PersistVolumeOps;
}): Promise<string | undefined> {
  const merged = await prepareMergedVolume(opts);
  if (merged == null) return;
  return await swapInVolume(opts.project_id, merged, opts.env, opts.ops);
}

// A ready copy of the project's volume, with the databases in `source`
// merged in (on disk), for swapInVolume; with the lock and a fence held.
async function prepareMergedVolume({
  project_id,
  source,
  homeQuota: steadyHomeQuota,
  env,
  ops,
}: {
  project_id: string;
  source: string;
  // the project's disk quota without any room for the restore (undefined:
  // as it is now)
  homeQuota?: number;
  env: NodeJS.ProcessEnv;
  ops: PersistVolumeOps;
}): Promise<string | undefined> {
  const volume = persistVolumePath(project_id, env);
  if (volume == null) return;
  // the history from the home first, if it is still there
  if (!(await isPersistVolumeReady(volume))) {
    await prepareProjectPersistVolume({ project_id, root: volume }, ops, env);
  }
  const staged = join(
    dirname(volume),
    IMPORT_STAGING_DIR,
    stagingName("restore", project_id),
  );
  await btrfs({ args: ["subvolume", "snapshot", volume, staged] });
  try {
    // what the merge writes counts against the project's quota
    await requireQuotaGroup(ops, project_id, staged);
    const homeQuota = await homeQuotaOf(project_id, env, ops);
    // a snapshot doesn't keep the limit
    await ops.setQuota(staged, persistVolumeQuota({ homeQuota, env }));
    await importPersistDatabases({
      source,
      relative: "",
      dest: staged,
      merge: true,
    });
    // The merged history is what the volume keeps and what it restored: it
    // must fit, after the restore, within the history's limit (the project's
    // quota group's, Q + R), and the volume's limit is never below what it
    // already holds.
    const total = await databaseBytes(staged);
    const ceiling = persistVolumeQuota({
      homeQuota: steadyHomeQuota ?? homeQuota,
      env,
    });
    if (total > ceiling) {
      throw new Error(
        `the restored edit history (${total} bytes) does not fit in this project's limit for it (${ceiling} bytes)`,
      );
    }
    await ops.setQuota(
      staged,
      Math.max(persistVolumeQuota({ homeQuota, env }), total),
    );
    // on disk before it is the project's history
    await syncTree(staged);
    return staged;
  } catch (err) {
    await ops.removeTree(staged).catch(() => {});
    throw err;
  }
}

// Deletes persist volumes of projects without a home on this host: left by a
// crash between deleting a project's home and its volume, or by older
// software deleting a project. Run when the file server starts, before it
// serves: a restore or copy (which can briefly leave a volume without a home)
// is never running then.  So it takes at most about budgetMs (each volume up
// to fenceMs to fence): what is left is deleted at the next start.
//
// A volume is kept while anything else under the mount names its project
// (projectsNamedUnder): e.g., a crash in the middle of a restore can leave
// its home moved aside, and its history is needed to recover it.
export async function deleteOrphanedPersistVolumes({
  limit = 1000,
  budgetMs = 60_000,
  fenceMs = 5000,
  env = process.env,
}: {
  limit?: number;
  budgetMs?: number;
  fenceMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string[]> {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null) return [];
  const mount = dirname(legacy.home);
  const deleted: string[] = [];
  const deadline = Date.now() + budgetMs;
  const entries = await readdir(mount);
  const named = await projectsNamedUnder(mount, entries);
  for (const name of entries) {
    if (deleted.length >= limit) break;
    const project_id = name.match(/^project-([0-9a-f-]{36})-persist$/i)?.[1];
    if (project_id == null || !isValidUUID(project_id)) continue;
    if (persistVolumePath(project_id, env) !== join(mount, name)) continue;
    if (await exists(legacy.home.split("[project_id]").join(project_id))) {
      continue;
    }
    if (named.has(project_id.toLowerCase())) {
      logger.warn("keeping a persist volume a restore may still need", {
        project_id,
      });
      continue;
    }
    if (Date.now() >= deadline) {
      logger.warn("orphaned persist volumes left for the next start", {
        budgetMs,
      });
      break;
    }
    try {
      // a persist daemon may still have its streams open
      await withProjectStorageFenced(
        {
          project_id,
          reason: "delete-orphan",
          waitMs: fenceMs,
          timeoutMs: fenceMs,
          env,
        },
        async () => await deletePersistVolume(project_id),
      );
      deleted.push(project_id);
    } catch (err) {
      logger.warn("unable to delete orphaned persist volume", {
        project_id,
        err: `${err}`,
      });
    }
  }
  if (deleted.length > 0) {
    logger.info("deleted orphaned persist volumes", { deleted });
  }
  return deleted;
}

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The projects named by `entries` of `mount` other than persist volumes, or
// by what is in its hidden directories (staging of restores and copies, e.g.,
// a home moved aside, file-server.ts swapProjectHome).  Fails if one of those
// can't be read: then nothing is known to be an orphan.
async function projectsNamedUnder(
  mount: string,
  entries: string[],
): Promise<Set<string>> {
  const named = new Set<string>();
  const note = (name: string) => {
    for (const id of name.match(UUIDS) ?? []) named.add(id.toLowerCase());
  };
  for (const name of entries) {
    if (/^project-[0-9a-f-]{36}-persist$/i.test(name)) continue;
    if (!name.startsWith(".")) {
      note(name);
      continue;
    }
    let inner: string[];
    try {
      inner = await readdir(join(mount, name));
    } catch (err) {
      // gone since, or not a directory
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    inner.forEach(note);
  }
  return named;
}

export async function deletePersistVolume(project_id: string): Promise<void> {
  const path = persistVolumePath(project_id);
  if (path == null || !(await exists(path))) return;
  try {
    await btrfs({ args: ["subvolume", "delete", path] });
  } finally {
    // (another may be made at the path)
    forgetSubvolumePaths(path);
  }
}

// A copy of a project gets a copy of its history. If the source volume is
// not ready, the copy's history is imported from its (copied) home instead.
// A copy only ever exists complete, and a retry keeps it: the source's home
// no longer holds the history once its volume is ready.
// Copies a project: its home (with cloneHome) and its edit history.
export async function cloneProjectWithPersistVolume({
  src_project_id,
  project_id,
  cloneHome,
  ops = btrfsOps,
}: {
  src_project_id: string;
  project_id: string;
  cloneHome: () => Promise<void>;
  ops?: PersistVolumeOps;
}): Promise<void> {
  // Holding the source's persist lock, so a restore never swaps its history
  // or home between the two copies (cloneHome takes no lock of its own).
  await withPersistLock(src_project_id, async () =>
    cloneProjectWithPersistVolumeLocked({
      src_project_id,
      project_id,
      cloneHome,
      ops,
    }),
  );
}

async function cloneProjectWithPersistVolumeLocked({
  src_project_id,
  project_id,
  cloneHome,
  ops,
}: {
  src_project_id: string;
  project_id: string;
  cloneHome: () => Promise<void>;
  ops: PersistVolumeOps;
}): Promise<void> {
  // The history first, before anything can open the copy's databases.
  const copied = await clonePersistVolume({ src_project_id, project_id }, ops);
  await cloneHome();
  if (copied) return;
  // The source's history was still in its home, so the copied home holds it,
  // unless the persist server imported it meanwhile: the import marks the
  // volume ready BEFORE it deletes the old directory, so if the volume is
  // still not ready now, the home was copied with that directory.
  if (await clonePersistVolume({ src_project_id, project_id }, ops)) {
    // the copied home may hold a stale old directory
    const { legacy } = projectPersistTemplates();
    if (legacy != null) {
      await ops
        .removeFromHome(
          legacy.home.split("[project_id]").join(project_id),
          legacy.relative,
        )
        .catch(() => {});
    }
  }
}

// Whether the copy now has the source's history in a volume.
export async function clonePersistVolume(
  {
    src_project_id,
    project_id,
  }: {
    src_project_id: string;
    project_id: string;
  },
  ops: PersistVolumeOps = btrfsOps,
): Promise<boolean> {
  const source = persistVolumePath(src_project_id);
  const dest = persistVolumePath(project_id);
  if (source == null || dest == null) return false;
  if (!(await isPersistVolumeReady(source))) return false;
  // an earlier attempt of this copy finished it
  if (await isPersistVolumeReady(dest)) return true;
  await deletePersistVolume(project_id);
  // Complete it where nothing looks for it, then publish it: a half-made copy
  // must never be ready.
  const staged = join(
    dirname(dest),
    IMPORT_STAGING_DIR,
    stagingName("clone", project_id),
  );
  await sudo({ command: "mkdir", args: ["-p", dirname(staged)] });
  await btrfs({ args: ["subvolume", "snapshot", source, staged] });
  try {
    // a snapshot doesn't keep the limit
    const limit = await ops.getQuota(source);
    await ops.setQuota(
      staged,
      limit > 0 ? limit : persistVolumeQuota({ homeQuota: 0 }),
    );
    await moveVolume(staged, dest);
  } catch (err) {
    await btrfs({ args: ["subvolume", "delete", staged] }).catch(() => {});
    throw err;
  }
  await joinQuotaGroup(ops, project_id, dest);
  return true;
}
