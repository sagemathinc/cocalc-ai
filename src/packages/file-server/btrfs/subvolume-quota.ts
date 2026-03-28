import { type Subvolume } from "./subvolume";
import { btrfs } from "./util";
import { queueSetSubvolumeQuota } from "./quota-queue";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("file-server:btrfs:subvolume-quota");

type QgroupShowRow = {
  qgroupid: string;
  referenced: number;
  exclusive: number;
  max_referenced: number | "none";
  max_exclusive: number | "none";
  path?: string;
};

function parseRawQgroupValue(value: string): number | "none" {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") {
    return "none";
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`failed to parse qgroup value '${value}'`);
  }
  return parsed;
}

export function parsePlainQgroupShow(stdout: string): QgroupShowRow[] {
  const rows: QgroupShowRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("WARNING:") ||
      trimmed.startsWith("Qgroupid") ||
      trimmed.startsWith("--------")
    ) {
      continue;
    }
    const match = trimmed.match(
      /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/,
    );
    if (!match) continue;
    const [
      ,
      qgroupid,
      referenced,
      exclusive,
      maxReferenced,
      maxExclusive,
      path,
    ] = match;
    rows.push({
      qgroupid,
      referenced: Number.parseInt(referenced, 10),
      exclusive: Number.parseInt(exclusive, 10),
      max_referenced: parseRawQgroupValue(maxReferenced),
      max_exclusive: parseRawQgroupValue(maxExclusive),
      path: path?.trim() || undefined,
    });
  }
  return rows;
}

export class SubvolumeQuota {
  constructor(public subvolume: Subvolume) {}

  private qgroup = async () => {
    const id = await this.subvolume.getSubvolumeId();
    let groups: QgroupShowRow[];
    try {
      const { stdout } = await btrfs({
        verbose: false,
        args: ["--format=json", "qgroup", "show", "-reF", this.subvolume.path],
      });
      const x = JSON.parse(stdout);
      groups = x["qgroup-show"] ?? [];
    } catch (err: any) {
      const stderr =
        typeof err?.stderr === "string" ? err.stderr : `${err?.message ?? err}`;
      if (!stderr.includes("unrecognized option '--format=json'")) {
        throw err;
      }
      const { stdout } = await btrfs({
        verbose: false,
        args: ["qgroup", "show", "-reF", "--raw", this.subvolume.path],
      });
      groups = parsePlainQgroupShow(stdout);
    }
    // Prefer the subvolume's own qgroups (0/id or 1/id); fall back to first entry.
    const match =
      groups.find((g) => g.qgroupid === `0/${id}`) ??
      groups.find((g) => g.qgroupid === `1/${id}`) ??
      groups[0];
    if (!match) {
      throw Error(`no qgroup info for ${this.subvolume.path}`);
    }
    return match;
  };

  get = async (): Promise<{
    size: number;
    used: number;
  }> => {
    let { max_referenced: size, referenced: used } = await this.qgroup();
    if (size == "none") {
      size = 0;
    }
    return {
      used,
      size,
    };
  };

  set = async (size: string | number) => {
    if (!size) {
      throw Error("size must be specified");
    }
    logger.debug("setQuota ", this.subvolume.path, size);
    await queueSetSubvolumeQuota({
      mount: this.subvolume.filesystem.opts.mount,
      path: this.subvolume.path,
      size,
      wait: true,
    });
  };

  du = async () => {
    return await btrfs({
      args: ["filesystem", "du", "-s", this.subvolume.path],
    });
  };

  usage = async (): Promise<{
    // used and free in bytes
    used: number;
    free: number;
    size: number;
  }> => {
    const { stdout } = await btrfs({
      args: ["filesystem", "usage", "-b", this.subvolume.path],
    });
    let used: number = -1;
    let free: number = -1;
    let size: number = -1;
    for (const x of stdout.split("\n")) {
      if (used == -1) {
        const i = x.indexOf("Used:");
        if (i != -1) {
          used = parseInt(x.split(":")[1].trim());
          continue;
        }
      }
      if (free == -1) {
        const i = x.indexOf("Free (statfs, df):");
        if (i != -1) {
          free = parseInt(x.split(":")[1].trim());
          continue;
        }
      }
      if (size == -1) {
        const i = x.indexOf("Device size:");
        if (i != -1) {
          size = parseInt(x.split(":")[1].trim());
          continue;
        }
      }
    }
    return { used, free, size };
  };
}
