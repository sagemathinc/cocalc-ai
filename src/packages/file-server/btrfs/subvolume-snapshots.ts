import { type Subvolume } from "./subvolume";
import { btrfs } from "./util";
import getLogger from "@cocalc/backend/logger";
import { join } from "path";
import { type SnapshotCounts, updateRollingSnapshots } from "./snapshots";
import { ConatError } from "@cocalc/conat/core/client";
import { type SnapshotUsage } from "@cocalc/conat/files/file-server";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { getSubvolumeField } from "./subvolume";
import { parsePlainQgroupShow } from "./subvolume-quota";
import { queueAssignSnapshotQgroup } from "./quota-queue";
import { btrfsQuotasDisabled } from "./config";

const logger = getLogger("file-server:btrfs:subvolume-snapshots");
const SNAPSHOT_QGROUP_ASSIGN_ENV = "COCALC_BTRFS_ENABLE_SNAPSHOT_QGROUP_ASSIGN";

function snapshotQgroupAssignmentEnabled(): boolean {
  const raw = `${process.env[SNAPSHOT_QGROUP_ASSIGN_ENV] ?? ""}`
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export class SubvolumeSnapshots {
  public readonly snapshotsDir: string;

  constructor(public readonly subvolume: Subvolume) {
    this.snapshotsDir = join(this.subvolume.path, SNAPSHOTS);
  }

  path = (snapshot?: string, ...segments) => {
    if (!snapshot) {
      return SNAPSHOTS;
    }
    return join(SNAPSHOTS, snapshot, ...segments);
  };

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
    }: {
      limit?: number;
      quotaMode?: "sync" | "async" | "skip";
    } = {},
  ) => {
    if (name?.startsWith(".")) {
      throw Error("snapshot name must not start with '.'");
    }
    name ??= new Date().toISOString();
    logger.debug("create", { name, subvolume: this.subvolume.name });
    await this.makeSnapshotsDir();

    if (limit != null) {
      const existing = (await this.readdir()).filter(
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

    const args = ["subvolume", "snapshot", "-r"];
    const snapshotPath = join(this.snapshotsDir, name);
    args.push(this.subvolume.path, snapshotPath);

    await btrfs({ args });

    if (quotaMode === "skip") {
      return;
    }

    if (!snapshotQgroupAssignmentEnabled()) {
      logger.debug("skipping snapshot qgroup assignment", {
        subvolume: this.subvolume.name,
        snapshot: name,
        env: SNAPSHOT_QGROUP_ASSIGN_ENV,
      });
      return;
    }

    const wait = quotaMode === "sync";
    await queueAssignSnapshotQgroup({
      mount: this.subvolume.filesystem.opts.mount,
      snapshotPath,
      subvolumePath: this.subvolume.path,
      wait,
    });
  };

  readdir = async (): Promise<string[]> => {
    await this.makeSnapshotsDir();
    const entries = await this.subvolume.fs.readdir(SNAPSHOTS);
    const snapshots: string[] = [];
    for (const name of entries) {
      // Skip lock/hidden files up front.
      if (name.startsWith(".")) continue;
      const path = join(this.snapshotsDir, name);
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
      await this.subvolume.fs.writeFile(this.path(`.${name}.lock`), "");
    } else {
      throw Error(`snapshot ${name} does not exist`);
    }
  };

  unlock = async (name: string) => {
    await this.subvolume.fs.rm(this.path(`.${name}.lock`));
  };

  exists = async (name: string) => {
    return await this.subvolume.fs.exists(this.path(name));
  };

  delete = async (name) => {
    if (await this.subvolume.fs.exists(this.path(`.${name}.lock`))) {
      throw Error(`snapshot ${name} is locked`);
    }
    await btrfs({
      args: ["subvolume", "delete", join(this.snapshotsDir, name)],
    });
  };

  // update the rolling snapshots scheduleGener
  update = async (counts?: Partial<SnapshotCounts>, opts?) => {
    return await updateRollingSnapshots({ snapshots: this, counts, opts });
  };

  // has newly written changes since last snapshot
  hasUnsavedChanges = async (): Promise<boolean> => {
    const s = await this.readdir();
    if (s.length == 0) {
      // more than just the SNAPSHOTS directory?
      const v = await this.subvolume.fs.readdir("");
      if (v.length == 0 || (v.length == 1 && v[0] == SNAPSHOTS)) {
        return false;
      }
      return true;
    }
    const pathGen = await getGeneration(this.subvolume.path);
    const snapGen = await getGeneration(
      join(this.snapshotsDir, s[s.length - 1]),
    );
    return snapGen < pathGen;
  };

  usage = async (name: string): Promise<SnapshotUsage> => {
    if (btrfsQuotasDisabled()) {
      return { name, used: 0, quota: 0, exclusive: 0 };
    }
    const snapshotPath = join(this.snapshotsDir, name);
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

export async function getGeneration(path: string): Promise<number> {
  return parseInt(await getSubvolumeField(path, "Generation"));
}
