import { type Subvolume } from "./subvolume";
import { btrfs, sudo } from "./util";
import getLogger from "@cocalc/backend/logger";
import { dirname, join } from "path";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { type SnapshotCounts, updateRollingSnapshots } from "./snapshots";
import { ConatError } from "@cocalc/conat/core/client";
import { type SnapshotUsage } from "@cocalc/conat/files/file-server";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { getSubvolumeField, invalidateSubvolumeMetadata } from "./subvolume";
import { parsePlainQgroupShow } from "./subvolume-quota";
import { btrfsQuotasDisabled } from "./config";
import {
  captureSnapshotData,
  type CapturedSnapshotData,
} from "./snapshot-preparer";
import { tempSnapshotStagingPath } from "./subvolume-rustic";
import { assertValidSnapshotName } from "@cocalc/util/snapshot-name";
import { isISODate } from "@cocalc/util/misc";
import {
  invalidateBtrfsQgroupShowRaw,
  withBtrfsMutationLock,
} from "./operation-cache";

const logger = getLogger("file-server:btrfs:subvolume-snapshots");

const DEFAULT_CLEANUP_QUOTA_RELIEF_BYTES = 1024 ** 3;
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const cleanupChains = new Map<string, Promise<void>>();

async function withCleanupChain<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = cleanupChains.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  cleanupChains.set(path, chain);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (cleanupChains.get(path) === chain) {
      cleanupChains.delete(path);
    }
  }
}

async function removeSnapshotPathInProjectCgroup({
  projectRoot,
  relativePath,
}: {
  projectRoot: string;
  relativePath: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "sudo",
      [
        "-n",
        STORAGE_WRAPPER,
        "sandbox-rm",
        projectRoot,
        relativePath,
        "--recursive",
        "--force",
      ],
      { cwd: "/", stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `snapshot prune worker failed code=${code ?? "none"} signal=${signal ?? "none"}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

function cleanupQuotaReliefBytes(): number {
  const value = Number.parseInt(
    `${process.env.COCALC_BTRFS_SNAPSHOT_CLEANUP_QUOTA_RELIEF_BYTES ?? ""}`,
    10,
  );
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_CLEANUP_QUOTA_RELIEF_BYTES;
}

/**
 * Run a Btrfs mutation of a subvolume's own tree, such as deleting or creating
 * a snapshot inside it, with the subvolume's quota limit temporarily raised.
 * Btrfs charges the metadata to the subvolume's qgroup, so at or over its limit
 * the mutation fails with EDQUOT ("Disk quota exceeded"). Callers on the same
 * subvolume run one at a time; the caller takes any Btrfs mutation lock inside
 * `run`.
 */
export async function withSubvolumeQuotaRelief<T>({
  subvolume,
  operation,
  run,
}: {
  subvolume: Subvolume;
  operation: string;
  run: () => Promise<T>;
}): Promise<T> {
  return await withCleanupChain(subvolume.path, async () => {
    if (btrfsQuotasDisabled()) {
      return await run();
    }
    const quota = await subvolume.quota.get();
    if (!quota.size || quota.size <= 0) {
      return await run();
    }
    const reliefSize =
      Math.max(quota.size, quota.used) + cleanupQuotaReliefBytes();
    const managedOverride =
      subvolume.filesystem.opts.withTemporaryQuotaOverride?.({
        subvolume_name: subvolume.name,
        operation,
        minimum_bytes: reliefSize,
        current_size: quota.size,
        current_used: quota.used,
        run,
      });
    if (managedOverride != null) {
      return await managedOverride;
    }
    let result: T;
    let actionError: unknown;
    logger.info("temporarily increasing quota for a snapshot change", {
      operation,
      subvolume: subvolume.name,
      path: subvolume.path,
      quotaSize: quota.size,
      quotaUsed: quota.used,
      reliefSize,
    });
    await subvolume.quota.set(reliefSize);
    try {
      result = await run();
    } catch (err) {
      actionError = err;
    }
    try {
      await subvolume.quota.set(quota.size);
    } catch (restoreError) {
      logger.error("failed to restore quota after a snapshot change", {
        operation,
        subvolume: subvolume.name,
        path: subvolume.path,
        quotaSize: quota.size,
        reliefSize,
        restoreError,
      });
      if (actionError == null) {
        throw restoreError;
      }
    }
    if (actionError != null) {
      throw actionError;
    }
    return result!;
  });
}

export class SubvolumeSnapshots {
  public readonly snapshotsDir: string;

  constructor(public readonly subvolume: Subvolume) {
    this.snapshotsDir = join(this.subvolume.path, SNAPSHOTS);
  }

  path = (snapshot?: string, ...segments) => {
    if (snapshot == null) {
      return SNAPSHOTS;
    }
    return join(SNAPSHOTS, assertValidSnapshotName(snapshot), ...segments);
  };

  private snapshotAbsolutePath = (name: string): string =>
    join(this.snapshotsDir, assertValidSnapshotName(name));

  private lockPath = (name: string): string =>
    join(SNAPSHOTS, `.${assertValidSnapshotName(name)}.lock`);

  private makeSnapshotsDir = async () => {
    if (await this.subvolume.fs.exists(SNAPSHOTS)) {
      return;
    }
    await this.subvolume.fs.mkdir(SNAPSHOTS);
    await this.subvolume.fs.chmod(SNAPSHOTS, "0700");
  };

  create = async (
    name?: string,
    {
      limit,
      quotaMode = "sync",
      existingSnapshotNames,
      includePreparedData = true,
    }: {
      limit?: number;
      quotaMode?: "sync" | "async" | "skip";
      existingSnapshotNames?: string[];
      // false for a snapshot that is only read from and deleted at once: it
      // needs no data a restore of it would (snapshot-preparer.ts)
      includePreparedData?: boolean;
    } = {},
  ) => {
    name ??= new Date().toISOString();
    name = assertValidSnapshotName(name);
    logger.debug("create", { name, subvolume: this.subvolume.name });
    await this.makeSnapshotsDir();

    if (limit != null) {
      const existing = (existingSnapshotNames ?? (await this.readdir())).filter(
        // lock files are named ".<snap>.lock" — exclude those from the limit
        // (NOTE: we do NOT allow any real snapshot to start with '.' -- see above)
        (x) => !x.endsWith(".lock"),
      );
      if (existing.length >= limit) {
        // 507 = "insufficient storage" for http
        throw new ConatError(`there is a limit of ${limit} snapshots`, {
          code: 507,
        });
      }
    }

    // e.g., a project's edit history, captured before the snapshot is taken
    // (snapshot-preparer.ts)
    let captured = includePreparedData
      ? await captureSnapshotData({ subvolume: this.subvolume.name })
      : undefined;
    try {
      const snapshotPath = this.snapshotAbsolutePath(name);
      if (captured == null) {
        await withBtrfsMutationLock({
          mount: this.subvolume.filesystem.opts.mount,
          operation: "snapshot-create",
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
            invalidateSubvolumeMetadata(snapshotPath);
            invalidateBtrfsQgroupShowRaw(this.subvolume.filesystem.opts.mount);
          },
        });
        // There was nothing to add, but there may be now (e.g., the history
        // just moved out of the home): then take the snapshot again with it.
        captured = includePreparedData
          ? await captureSnapshotData({ subvolume: this.subvolume.name })
          : undefined;
        if (captured != null) {
          await btrfs({ args: ["subvolume", "delete", snapshotPath] });
          invalidateSubvolumeMetadata(snapshotPath);
          await this.createWithCaptured({ snapshotPath, captured });
        }
      } else {
        await this.createWithCaptured({ snapshotPath, captured });
      }
    } finally {
      await captured?.release();
    }

    if (quotaMode === "skip") {
      return;
    }
    // Intentionally do nothing here. CoCalc uses btrfs simple quotas only, so
    // there is no tracking-qgroup assignment step after creating snapshots.
    logger.debug("snapshot created without tracking qgroup assignment", {
      subvolume: this.subvolume.name,
      snapshot: name,
      quotaMode,
    });
  };

  // The snapshot is in the home, which the project can write: it must never
  // be writable there. Complete it in host-only staging, then snapshot that
  // read-only into place.
  private createWithCaptured = async ({
    snapshotPath,
    captured,
  }: {
    snapshotPath: string;
    captured: CapturedSnapshotData;
  }): Promise<void> => {
    const mount = this.subvolume.filesystem.opts.mount;
    const staged = tempSnapshotStagingPath(this.subvolume);
    await sudo({ command: "mkdir", args: ["-p", dirname(staged)] });
    await withBtrfsMutationLock({
      mount,
      operation: "snapshot-create",
      run: async () => {
        await btrfs({
          args: ["subvolume", "snapshot", this.subvolume.path, staged],
        });
      },
    });
    try {
      await captured.addTo(staged);
      await btrfs({ args: ["property", "set", "-ts", staged, "ro", "true"] });
      await withBtrfsMutationLock({
        mount,
        operation: "snapshot-create",
        run: async () => {
          await btrfs({
            args: ["subvolume", "snapshot", "-r", staged, snapshotPath],
          });
          invalidateSubvolumeMetadata(snapshotPath);
          invalidateBtrfsQgroupShowRaw(mount);
        },
      });
    } finally {
      await btrfs({ args: ["subvolume", "delete", staged] }).catch((err) => {
        logger.warn("unable to delete staged snapshot", {
          staged,
          err: `${err}`,
        });
      });
    }
  };

  readdir = async (): Promise<string[]> => {
    await this.makeSnapshotsDir();
    const entries = await this.subvolume.fs.readdir(SNAPSHOTS);
    const snapshots: string[] = [];
    for (const name of entries) {
      // Skip lock/hidden files up front.
      if (name.startsWith(".")) continue;
      let path: string;
      try {
        path = this.snapshotAbsolutePath(name);
      } catch (err) {
        logger.warn("readdir: skipping snapshot with unsafe name", {
          name,
          err: `${err}`,
        });
        continue;
      }
      try {
        // Only keep readonly btrfs subvolumes (actual snapshots).
        let flags: string | undefined;
        try {
          flags = await getSubvolumeField(path, "Flags");
        } catch {
          // Some versions expose a Read-only field instead.
          flags = await getSubvolumeField(path, "Read-only");
        }
        const ro = flags?.toLowerCase() ?? "";
        if (ro.includes("readonly") || ro.startsWith("yes") || ro === "true") {
          snapshots.push(name);
        }
      } catch (err) {
        if (process.env.DEBUG_SNAPTEST) {
          console.log("readdir skip", name, err);
        }
        logger.debug("readdir: skipping non-snapshot entry", {
          path,
          err: `${err}`,
        });
      }
    }
    snapshots.sort();
    return snapshots;
  };

  lock = async (name: string) => {
    if (await this.subvolume.fs.exists(this.path(name))) {
      await this.subvolume.fs.writeFile(this.lockPath(name), "");
    } else {
      throw Error(`snapshot ${name} does not exist`);
    }
  };

  unlock = async (name: string) => {
    await this.subvolume.fs.rm(this.lockPath(name));
  };

  exists = async (name: string) => {
    return await this.subvolume.fs.exists(this.path(name));
  };

  delete = async (name: string) => {
    name = assertValidSnapshotName(name);
    if (await this.subvolume.fs.exists(this.lockPath(name))) {
      throw Error(`snapshot ${name} is locked`);
    }
    await this.withCleanupQuotaRelief({
      operation: "delete-snapshot",
      run: async () => {
        const snapshotPath = this.snapshotAbsolutePath(name);
        await btrfs({
          args: ["subvolume", "delete", snapshotPath],
        });
        invalidateSubvolumeMetadata(snapshotPath);
        invalidateBtrfsQgroupShowRaw(this.subvolume.filesystem.opts.mount);
      },
    });
  };

  private withCleanupQuotaRelief = async <T>({
    operation,
    run,
  }: {
    operation: string;
    run: () => Promise<T>;
  }): Promise<T> => {
    return await withSubvolumeQuotaRelief({
      subvolume: this.subvolume,
      operation,
      run: async () =>
        await withBtrfsMutationLock({
          mount: this.subvolume.filesystem.opts.mount,
          operation,
          run,
        }),
    });
  };

  private setReadOnly = async (name: string, readOnly: boolean) => {
    const snapshotPath = this.snapshotAbsolutePath(name);
    await btrfs({
      args: [
        "property",
        "set",
        "-ts",
        snapshotPath,
        "ro",
        readOnly ? "true" : "false",
      ],
    });
    invalidateSubvolumeMetadata(snapshotPath);
  };

  private safePruneTargetPath = async (name: string, path: string) => {
    const snapshotRoot = this.snapshotAbsolutePath(name);
    const target = join(snapshotRoot, path);
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        return target;
      }
      throw err;
    }
    const realRoot = await realpath(snapshotRoot);
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
      throw new Error(`snapshot prune path resolves outside snapshot: ${path}`);
    }
    return target;
  };

  prunePath = async ({
    path,
    snapshots,
  }: {
    path: string;
    snapshots?: string[];
  }): Promise<{ path: string; snapshots: string[] }> => {
    if (
      !path ||
      path === "." ||
      path.startsWith("..") ||
      path.includes("/..")
    ) {
      throw new Error(`invalid snapshot prune path: ${path}`);
    }
    if (path === SNAPSHOTS || path.startsWith(`${SNAPSHOTS}/`)) {
      throw new Error("cannot prune the snapshots directory from snapshots");
    }
    const names = snapshots?.length ? snapshots : await this.readdir();
    for (const name of names) {
      if (!(await this.exists(name))) {
        throw new Error(`snapshot ${name} does not exist`);
      }
      if (await this.subvolume.fs.exists(this.lockPath(name))) {
        throw Error(`snapshot ${name} is locked`);
      }
    }
    await this.withCleanupQuotaRelief({
      operation: "prune-snapshot-path",
      run: async () => {
        for (const name of names) {
          await this.safePruneTargetPath(name, path);
          await this.setReadOnly(name, false);
          try {
            await removeSnapshotPathInProjectCgroup({
              projectRoot: this.subvolume.path,
              relativePath: join(SNAPSHOTS, name, path),
            });
          } finally {
            await this.setReadOnly(name, true);
          }
        }
        invalidateBtrfsQgroupShowRaw(this.subvolume.filesystem.opts.mount);
      },
    });
    return { path, snapshots: names };
  };

  // update the rolling snapshots scheduleGener
  update = async (counts?: Partial<SnapshotCounts>, opts?) => {
    const timed = async <T>(stage: string, run: () => Promise<T>) => {
      const started = Date.now();
      try {
        return await run();
      } finally {
        try {
          opts?.onStage?.(stage, Math.max(0, Date.now() - started));
        } catch (err) {
          logger.warn("snapshot stage observer failed", { stage, err });
        }
      }
    };
    const limit = opts?.limit;
    if (limit == null) {
      return await updateRollingSnapshots({ snapshots: this, counts, opts });
    }
    const normalizedLimit = Math.max(0, Math.floor(Number(limit)));
    if (!Number.isFinite(normalizedLimit) || normalizedLimit === 0) {
      throw new ConatError(`there is a limit of ${limit} snapshots`, {
        code: 507,
      });
    }
    const namedCount = (await timed("inventory", () => this.readdir())).filter(
      (name) => !isISODate(name),
    ).length;
    if (namedCount >= normalizedLimit) {
      throw new ConatError(`there is a limit of ${limit} snapshots`, {
        code: 507,
      });
    }
    const pruneToLimit = async () => {
      await timed("prune", async () => {
        const names = await this.readdir();
        const automatic = names.filter(isISODate).sort();
        let excess = names.length - normalizedLimit;
        // The newest automatic recovery point and named/manual snapshots survive
        // even when they prevent us from meeting a reduced entitlement.
        for (const name of automatic.slice(0, -1)) {
          if (excess <= 0) break;
          await this.delete(name);
          excess--;
        }
        if (excess > 0) {
          throw new ConatError(`there is a limit of ${limit} snapshots`, {
            code: 507,
          });
        }
      });
    };
    await pruneToLimit();
    const result = await updateRollingSnapshots({
      snapshots: this,
      counts,
      opts: { ...opts, limit: normalizedLimit + 1 },
    });
    await pruneToLimit();
    return result;
  };

  // has newly written changes since last snapshot
  hasUnsavedChanges = async (snapshotNames?: string[]): Promise<boolean> => {
    const s = snapshotNames ?? (await this.readdir());
    if (s.length == 0) {
      // more than just the SNAPSHOTS directory?
      const v = await this.subvolume.fs.readdir("");
      if (v.length == 0 || (v.length == 1 && v[0] == SNAPSHOTS)) {
        return false;
      }
      return true;
    }
    const pathGen = await getGeneration(this.subvolume.path, {
      cache: false,
    });
    const snapGen = await getGeneration(
      this.snapshotAbsolutePath(s[s.length - 1]),
    );
    return snapGen < pathGen;
  };

  usage = async (name: string): Promise<SnapshotUsage> => {
    name = assertValidSnapshotName(name);
    if (btrfsQuotasDisabled()) {
      return { name, used: 0, quota: 0, exclusive: 0 };
    }
    const snapshotPath = this.snapshotAbsolutePath(name);
    let row;
    try {
      const { stdout } = await btrfs({
        args: [
          "--format=json",
          "qgroup",
          "show",
          "-ref",
          "--raw",
          snapshotPath,
        ],
      });
      const x = JSON.parse(stdout);
      row = x["qgroup-show"]?.[0];
    } catch (err: any) {
      const stderr =
        typeof err?.stderr === "string" ? err.stderr : `${err?.message ?? err}`;
      if (!stderr.includes("unrecognized option '--format=json'")) {
        throw err;
      }
      const { stdout } = await btrfs({
        args: ["qgroup", "show", "-ref", "--raw", snapshotPath],
      });
      row = parsePlainQgroupShow(stdout)[0];
    }
    if (!row) {
      throw new Error(`no qgroup info for snapshot ${snapshotPath}`);
    }
    const { referenced, max_referenced, exclusive } = row;
    return { name, used: referenced, quota: max_referenced, exclusive };
  };

  allUsage = async (): Promise<SnapshotUsage[]> => {
    // get quota/usage information about all snapshots
    const snaps = await this.readdir();
    return Promise.all(snaps.map(this.usage));
  };
}

export const __test__ = { removeSnapshotPathInProjectCgroup };

export async function getGeneration(
  path: string,
  opts?: { cache?: boolean },
): Promise<number> {
  return parseInt(await getSubvolumeField(path, "Generation", opts));
}
