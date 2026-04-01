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

export type SubvolumeQuotaInfo = {
  size: number;
  used: number;
  qgroupid?: string;
  scope?: "tracking" | "subvolume";
  warning?: string;
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
    const parentChildMatch = trimmed.match(
      /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/,
    );
    if (parentChildMatch) {
      const [, qgroupid, referenced, exclusive, maxReferenced, , , path] =
        parentChildMatch;
      rows.push({
        qgroupid,
        referenced: Number.parseInt(referenced, 10),
        exclusive: Number.parseInt(exclusive, 10),
        max_referenced: parseRawQgroupValue(maxReferenced),
        max_exclusive: "none",
        path: path?.trim() || undefined,
      });
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

function quotaWarning(stderr?: string): string | undefined {
  const text = `${stderr ?? ""}`.trim();
  if (!text) return;
  if (text.toLowerCase().includes("qgroup data inconsistent")) {
    return "Btrfs quota accounting is currently inconsistent on this host, so counted quota usage may be inaccurate until it is repaired.";
  }
  return text;
}

function selectQgroup(
  groups: QgroupShowRow[],
  id: number,
): {
  match?: QgroupShowRow;
  scope?: "tracking" | "subvolume";
} {
  const tracking = groups.find((g) => g.qgroupid === `1/${id}`);
  if (tracking) {
    return { match: tracking, scope: "tracking" };
  }
  const leaf = groups.find((g) => g.qgroupid === `0/${id}`);
  if (leaf) {
    return { match: leaf, scope: "subvolume" };
  }
  if (groups[0] != null) {
    return { match: groups[0], scope: "subvolume" };
  }
  return {};
}

export class SubvolumeQuota {
  constructor(public subvolume: Subvolume) {}

  private qgroup = async () => {
    const id = await this.subvolume.getSubvolumeId();
    let groups: QgroupShowRow[];
    const path = this.subvolume.filesystem.opts.mount;
    const result = await btrfs({
      verbose: false,
      args: ["qgroup", "show", "-prc", "--raw", path],
    });
    groups = parsePlainQgroupShow(result.stdout);
    const warning = quotaWarning(result.stderr);
    const { match, scope } = selectQgroup(groups, id);
    if (!match) {
      throw Error(`no qgroup info for ${this.subvolume.path}`);
    }
    return { match, scope, warning };
  };

  get = async (): Promise<SubvolumeQuotaInfo> => {
    const {
      match: { max_referenced: rawSize, referenced: used, qgroupid },
      scope,
      warning,
    } = await this.qgroup();
    let size = rawSize;
    if (size == "none") {
      size = 0;
    }
    return {
      used,
      size,
      qgroupid,
      scope,
      warning,
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
