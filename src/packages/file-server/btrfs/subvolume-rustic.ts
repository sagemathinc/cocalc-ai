/*
Rustic Architecture:

The minimal option is a single global repo stored in the btrfs filesystem.
Obviously, admins should rsync this regularly to a separate location as a
genuine backup strategy.  It's better to configure repo on separate
storage.  Rustic has a very wide range of options.

Instead of using btrfs send/recv for backups, we use Rustic because:
 - much easier to check backups are valid
 - globally compressed and dedup'd!  btrfs send/recv is NOT globally dedupd
 - decoupled from any btrfs issues
 - rustic has full support for using cloud buckets as hot/cold storage
 - not tied to any specific filesystem at all
 - easier to offsite via incremental rsync
 - much more space efficient with *global* dedup and compression
 - rustic "is" restic, which is very mature and proven
 - rustic is VERY fast, being parallel and in rust.
*/

import { type Subvolume } from "./subvolume";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "path";
import getLogger from "@cocalc/backend/logger";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
import rustic from "@cocalc/backend/sandbox/rustic";
import { ConatError } from "@cocalc/conat/core/client";
import { DEFAULT_BACKUP_COUNTS } from "@cocalc/util/consts/snapshots";
import { field_cmp } from "@cocalc/util/misc";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  TEMP_RUSTIC_SNAPSHOT_PREFIX,
  type SnapshotCounts,
  updateRollingSnapshots,
} from "./snapshots";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "./rustic-progress";
import { btrfs, sudo } from "./util";
import {
  invalidateBtrfsQgroupShowRaw,
  invalidateBtrfsSubvolumeShow,
  withBtrfsMutationLock,
} from "./operation-cache";

export const RUSTIC = "rustic";

const logger = getLogger("file-server:btrfs:subvolume-rustic");
const DEFAULT_SNAPSHOTS_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.COCALC_RUSTIC_SNAPSHOTS_TIMEOUT_MS ?? 60_000),
);
const DEFAULT_SNAPSHOTS_MAX_SIZE = Math.max(
  10_000_000,
  Number(process.env.COCALC_RUSTIC_SNAPSHOTS_MAX_SIZE ?? 100_000_000),
);
const BACKUP_EXCLUDE_GLOBS = ["!.snapshots", "!.snapshots/**"] as const;
const RUSTIC_BACKUP_STAGING_DIR = ".rustic-backup-staging";
const STALE_TEMP_RUSTIC_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_TEMP_RUSTIC_SNAPSHOTS_PER_BACKUP = 32;

function makeTempRusticSnapshotName(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${TEMP_RUSTIC_SNAPSHOT_PREFIX}-${Date.now().toString(36)}-${rand}`;
}

function tempRusticSnapshotCreatedAt(name: string): number | undefined {
  const match = name.match(
    new RegExp(`^${TEMP_RUSTIC_SNAPSHOT_PREFIX}-([0-9a-z]+)-[0-9a-z]+$`),
  );
  if (!match?.[1]) return;
  const time = Number.parseInt(match[1], 36);
  return Number.isFinite(time) ? time : undefined;
}

interface Snapshot {
  id: string;
  time: Date;
  summary: { [key: string]: string | number };
}

interface CreatedSnapshot extends Snapshot {
  snapshotGeneration: number;
}

function flattenSnapshotGroups(groups: any): any[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  const snapshots: any[] = [];
  for (const group of groups) {
    if (Array.isArray(group?.snapshots)) {
      snapshots.push(...group.snapshots);
      continue;
    }
    if (Array.isArray(group) && Array.isArray(group[1])) {
      snapshots.push(...group[1]);
    }
  }
  return snapshots;
}

export function parseRusticSnapshotsOutput({
  stdout,
  truncated,
  host,
}: {
  stdout: string;
  truncated?: boolean;
  host?: string;
}): Snapshot[] {
  const trimmed = `${stdout ?? ""}`.trim();
  if (truncated) {
    throw new Error(
      `rustic snapshots output truncated while listing backups${host ? ` for ${host}` : ""}`,
    );
  }
  if (!trimmed) {
    throw new Error(
      `rustic snapshots returned empty output${host ? ` for ${host}` : ""}`,
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `failed to parse rustic snapshots JSON${host ? ` for ${host}` : ""}: ${err}`,
    );
  }
  const result = flattenSnapshotGroups(parsed)
    .map(({ time, id, summary }) => {
      if (!time || !id) return null;
      return { time: new Date(time), id, summary: summary ?? {} };
    })
    .filter((snapshot): snapshot is Snapshot => snapshot != null);
  result.sort(field_cmp("time"));
  return result;
}

export type RusticBackupRunner = (opts: {
  src: string;
  host: string;
  timeout: number;
  tags?: string[];
  parent?: string;
  progress?: (update: RusticProgressUpdate) => void;
}) => Promise<{
  time: string | Date;
  id: string;
  summary: { [key: string]: string | number };
}>;

export type RusticRestoreRunner = (opts: {
  snapshot: string;
  dest: string;
  timeout: number;
  progress?: (update: RusticProgressUpdate) => void;
}) => Promise<void>;

type RusticBackupOptions = {
  timeout?: number;
  limit?: number;
  tags?: string[];
  parent?: string;
  progress?: (update: RusticProgressUpdate) => void;
  runner?: RusticBackupRunner;
};

export class SubvolumeRustic {
  constructor(public readonly subvolume: Subvolume) {}

  private backupSnapshotFs(snapshotPath: string): SandboxedFilesystem {
    return new SandboxedFilesystem(snapshotPath, {
      host: this.subvolume.name,
      rusticRepo: this.subvolume.fs.rusticRepo,
    });
  }

  private backupStagingRoot(): string {
    return join(
      this.subvolume.filesystem.opts.mount,
      RUSTIC_BACKUP_STAGING_DIR,
      this.subvolume.name,
    );
  }

  private async createTempBackupSnapshot(
    name: string,
  ): Promise<{ snapshotPath: string; generation: number }> {
    const stagingRoot = this.backupStagingRoot();
    await sudo({ command: "mkdir", args: ["-p", stagingRoot] });
    const snapshotPath = join(stagingRoot, name);
    await withBtrfsMutationLock({
      mount: this.subvolume.filesystem.opts.mount,
      operation: "rustic-backup-snapshot-create",
      run: async () => {
        await btrfs({
          args: [
            "subvolume",
            "snapshot",
            "-r",
            this.subvolume.path,
            snapshotPath,
          ],
        });
        invalidateBtrfsSubvolumeShow(snapshotPath);
        invalidateBtrfsQgroupShowRaw(this.subvolume.filesystem.opts.mount);
      },
    });
    try {
      const { stdout } = await btrfs({
        args: ["subvolume", "show", snapshotPath],
        err_on_exit: true,
        verbose: false,
      });
      const match = `${stdout}`.match(/^\s*Generation\s*:\s*(\d+)\s*$/im);
      const snapshotGeneration = Number.parseInt(match?.[1] ?? "", 10);
      if (
        !Number.isSafeInteger(snapshotGeneration) ||
        snapshotGeneration <= 0
      ) {
        throw new Error(
          `unable to read temporary backup snapshot generation: ${snapshotPath}`,
        );
      }
      return { snapshotPath, generation: snapshotGeneration };
    } catch (err) {
      await this.deleteTempBackupSnapshot(snapshotPath, {
        mandatory: true,
      }).catch(() => undefined);
      throw err;
    }
  }

  private async deleteTempBackupSnapshot(
    snapshotPath: string,
    { mandatory = false }: { mandatory?: boolean } = {},
  ): Promise<void> {
    await withBtrfsMutationLock({
      mount: this.subvolume.filesystem.opts.mount,
      operation: "rustic-backup-snapshot-delete",
      // Cleanup of the snapshot created by this backup is mandatory. Stale
      // scavenging retains the caller's background mutation context.
      context: mandatory
        ? {
            priority: "interactive",
            operation_class: "rustic_backup_snapshot_cleanup",
            checkpointable: false,
          }
        : undefined,
      run: async () => {
        await btrfs({
          args: ["subvolume", "delete", snapshotPath],
          verbose: false,
        });
        invalidateBtrfsSubvolumeShow(snapshotPath);
        invalidateBtrfsQgroupShowRaw(this.subvolume.filesystem.opts.mount);
      },
    });
  }

  private async cleanupStaleTempBackupSnapshots(
    now = Date.now(),
  ): Promise<void> {
    const stagingRoot = this.backupStagingRoot();
    let entries: Dirent[];
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      logger.warn("backup: unable to inspect temporary snapshot staging", {
        stagingRoot,
        err: `${err}`,
      });
      return;
    }
    const stale = entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const createdAt = tempRusticSnapshotCreatedAt(entry.name);
        return createdAt != null &&
          now - createdAt > STALE_TEMP_RUSTIC_SNAPSHOT_MS
          ? [{ entry, createdAt }]
          : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, MAX_STALE_TEMP_RUSTIC_SNAPSHOTS_PER_BACKUP);
    for (const { entry, createdAt } of stale) {
      const snapshotPath = join(stagingRoot, entry.name);
      try {
        await this.deleteTempBackupSnapshot(snapshotPath);
        logger.info("backup: removed stale temporary snapshot", {
          snapshotPath,
          age_ms: now - createdAt,
        });
      } catch (err) {
        logger.warn("backup: unable to remove stale temporary snapshot", {
          snapshotPath,
          err: `${err}`,
        });
      }
    }
  }

  private rusticHost = async (
    args: string[],
    opts?: { timeout?: number; maxSize?: number },
  ) => {
    return await rustic(args, {
      repo: this.subvolume.fs.rusticRepo,
      host: this.subvolume.name,
      timeout: opts?.timeout,
      maxSize: opts?.maxSize,
    });
  };

  private backupUnlocked = async ({
    limit,
    timeout = 30 * 60 * 1000,
    tags,
    parent,
    progress,
    runner,
  }: RusticBackupOptions = {}): Promise<CreatedSnapshot> => {
    await this.cleanupStaleTempBackupSnapshots();
    if (limit != null && (await this.snapshots()).length >= limit) {
      // 507 = "insufficient storage" for http
      throw new ConatError(`there is a limit of ${limit} backups`, {
        code: 507,
      });
    }
    const tagArgs = (tags ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .flatMap((tag) => ["--tag", tag]);
    const parentArgs = parent ? ["--parent", parent] : [];
    const excludeArgs = BACKUP_EXCLUDE_GLOBS.flatMap((glob) => [
      "--glob",
      glob,
    ]);
    const tempSnapshot = makeTempRusticSnapshotName();
    const { snapshotPath, generation: snapshotGeneration } =
      await this.createTempBackupSnapshot(tempSnapshot);
    try {
      logger.debug(
        `backup: created ${tempSnapshot} at ${snapshotPath} to get a consistent backup`,
      );
      // Backup the snapshot path directly (no bind mounts). The project tree
      // already includes persistent metadata under ~/.local/share/cocalc/persist.
      logger.debug(`backup: backing up ${tempSnapshot} using rustic`);
      const backupFs = this.backupSnapshotFs(snapshotPath);
      const backupResult = runner
        ? await runner({
            src: snapshotPath,
            host: this.subvolume.name,
            timeout,
            tags,
            parent,
            progress,
          })
        : JSON.parse(
            parseOutput(
              await backupFs.rustic(
                [
                  "backup",
                  "-x",
                  "--json",
                  ...tagArgs,
                  ...parentArgs,
                  ...excludeArgs,
                  ".",
                ],
                {
                  timeout,
                  cwd: ".",
                  env: progress
                    ? { RUSTIC_PROGRESS_INTERVAL: "1s" }
                    : undefined,
                  onStderrLine: progress
                    ? createRusticProgressHandler({ onProgress: progress })
                    : undefined,
                },
              ),
            ).stdout,
          );
      const { time, id, summary } = backupResult;
      const backupTime = time instanceof Date ? time : new Date(time);
      return {
        time: backupTime,
        id,
        summary,
        snapshotGeneration,
      };
    } finally {
      this.snapshotsCache = null;
      logger.debug(`backup: deleting temporary ${tempSnapshot}`);
      try {
        await this.deleteTempBackupSnapshot(snapshotPath, { mandatory: true });
      } catch (err) {
        logger.warn("backup: unable to delete temporary snapshot", {
          snapshotPath,
          err: `${err}`,
        });
      }
    }
  };

  // create a new rustic backup
  backup = async (opts: RusticBackupOptions = {}): Promise<CreatedSnapshot> => {
    return await this.backupUnlocked(opts);
  };

  restore = async ({
    id,
    path = "",
    dest,
    timeout = 30 * 60 * 1000,
    progress,
    runner,
  }: {
    id: string;
    path?: string;
    dest?: string;
    timeout?: number;
    progress?: (update: RusticProgressUpdate) => void;
    runner?: RusticRestoreRunner;
  }) => {
    logger.debug("restore", { id, path, dest });
    dest ??= path;
    const snapshot = `${id}${path ? ":" + path : ""}`;
    if (runner) {
      await runner({ snapshot, dest, timeout, progress });
      return "";
    }
    const { stdout } = parseOutput(
      await this.subvolume.fs.rustic(["restore", snapshot, dest], {
        timeout,
        env: progress ? { RUSTIC_PROGRESS_INTERVAL: "1s" } : undefined,
        onStderrLine: progress
          ? createRusticProgressHandler({ onProgress: progress })
          : undefined,
      }),
    );
    return stdout;
  };

  // returns list of backups, sorted from oldest to newest
  private snapshotsCache: Snapshot[] | null = null;
  private listSnapshotsFresh = async (): Promise<Snapshot[]> => {
    const { stdout, truncated } = parseOutput(
      await this.rusticHost(["snapshots", "--json"], {
        timeout: DEFAULT_SNAPSHOTS_TIMEOUT_MS,
        maxSize: DEFAULT_SNAPSHOTS_MAX_SIZE,
      }),
    );
    /* stdout = [
  {
    "group_key": {
      "hostname": "project-f9296958-84f2-4965-947b-78cd4a92f49a",
      "label": "",
      "paths": [
        "."
      ]
    },
    "snapshots": [
      {
        "time": "2025-12-08T16:19:25.736493671-08:00",
        "program_version": "rustic v0.10.2-1-g189b17c",
        "tree": "ab76d793af77aad8459244a3ebc9673a45ad7eb00d247aaf572c7e95d0fb8582",
        "paths": [
          "."
        ],
        "hostname": "project-f9296958-84f2-4965-947b-78cd4a92f49a",
        "username": "",
        "uid": 0,
        "gid": 0,
        "tags": [],
        "original": "94623bd2d76a2512763325330fc27a00ac9f79f2d5bb883c3efa99ec0e99f42e",
        "summary": {
          "files_new": 10,
          "files_changed": 0,
          "files_unmodified": 0,
          "total_files_processed": 10,
          "total_bytes_processed": 2622,
          "dirs_new": 27,
          "dirs_changed": 0,
          "dirs_unmodified": 0,
          "total_dirs_processed": 27,
          "total_dirsize_processed": 13908,
          "data_blobs": 6,
          "tree_blobs": 23,
          "data_added": 16478,
          "data_added_packed": 8435,
          "data_added_files": 2622,
          "data_added_files_packed": 1598,
          "data_added_trees": 13856,
          "data_added_trees_packed": 6837,
          "command": "/home/wstein/build/cocalc-lite/src/packages/backend/node_modules/.bin/rustic --password  -r /home/wstein/build/cocalc-lite/src/packages/project-host/data-0/rustic backup -x --json --no-scan --host project-f9296958-84f2-4965-947b-78cd4a92f49a -- .",
          "backup_start": "2025-12-08T16:19:25.738333528-08:00",
          "backup_end": "2025-12-08T16:19:25.767040553-08:00",
          "backup_duration": 0.028707025,
          "total_duration": 0.030546882
        },
        "id": "94623bd2d76a2512763325330fc27a00ac9f79f2d5bb883c3efa99ec0e99f42e"
      }
    ]
  }
]
*/
    const v = parseRusticSnapshotsOutput({
      stdout,
      truncated,
      host: this.subvolume.name,
    });
    this.snapshotsCache = v;
    return v;
  };

  snapshots = reuseInFlight(async (): Promise<Snapshot[]> => {
    if (this.snapshotsCache) {
      // potentially very expensive to get list -- we clear this on delete or create
      return this.snapshotsCache;
    }
    return await this.listSnapshotsFresh();
  });

  // Archive deletion must not trust a cache that may predate a concurrent
  // forget operation for the only durable copy of the project.
  snapshotExists = async ({ id }: { id: string }): Promise<boolean> => {
    return (await this.listSnapshotsFresh()).some(
      (snapshot) => snapshot.id === id,
    );
  };

  // Delete this backup.  It's genuinely not accessible anymore, though
  // this doesn't actually clean up disk space -- purge must be done separately
  // later.  Rustic likes the purge to happen maybe a day later, so it
  // can better support concurrent writes.
  forget = async ({ id }: { id: string }) => {
    const { stdout } = parseOutput(await this.rusticHost(["forget", id]));
    this.snapshotsCache = null;
    return stdout;
  };

  update = async (counts?: Partial<SnapshotCounts>, opts?) => {
    return await updateRollingSnapshots({
      snapshots: this,
      counts: { ...DEFAULT_BACKUP_COUNTS, ...counts },
      opts,
    });
  };

  // Snapshot compat api, which is useful for rolling backups.

  create = async (
    _name?: string,
    {
      limit,
      timeout,
      tags,
      progress,
      existingSnapshotNames: _existingSnapshotNames,
    }: {
      timeout?: number;
      limit?: number;
      tags?: string[];
      progress?: (update: RusticProgressUpdate) => void;
      existingSnapshotNames?: string[];
    } = {},
  ) => {
    return await this.backup({ limit, timeout, tags, progress });
  };

  readdir = async (): Promise<string[]> => {
    return (await this.snapshots()).map(({ time }) => time.toISOString());
  };

  // TODO -- for now just always assume we do...
  hasUnsavedChanges = async (_snapshotNames?: string[]) => {
    return true;
  };

  delete = async (name) => {
    const v = await this.snapshots();
    for (const { id, time } of v) {
      if (time.toISOString() == name) {
        await this.forget({ id });
        return;
      }
    }
    throw Error(`backup ${name} not found`);
  };
}
