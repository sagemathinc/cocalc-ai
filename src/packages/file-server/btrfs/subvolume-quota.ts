import { type Subvolume } from "./subvolume";
import { btrfs } from "./util";
import { queueSetSubvolumeQuota } from "./quota-queue";
import getLogger from "@cocalc/backend/logger";
import { btrfsQuotasDisabled } from "./config";
import { type BtrfsMutationPriority } from "./operation-cache";
import { lookupQgroup } from "./qgroup-scan";
import { dirname } from "node:path";

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
  scope?: "subvolume";
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

// The filesystem the subvolume is on, as mounted (its parent directory if
// not known: CoCalc's volumes are at the top of the filesystem).
export function subvolumeMount(subvolume: {
  path: string;
  filesystem?: { opts?: { mount?: string } };
}): string {
  return subvolume.filesystem?.opts?.mount ?? dirname(subvolume.path);
}

export class SubvolumeQuota {
  constructor(public subvolume: Subvolume) {}

  // (CoCalc intentionally uses only simple quotas, so this is the
  // subvolume's own row, never a tracking qgroup.)
  private qgroup = async () => {
    const found = await lookupQgroup({
      mount: subvolumeMount(this.subvolume),
      path: this.subvolume.path,
      getSubvolumeId: async () => await this.subvolume.getSubvolumeId(),
    });
    if (!found) {
      throw Error(`no qgroup info for ${this.subvolume.path}`);
    }
    return { match: found.row, warning: found.warning };
  };

  get = async (): Promise<SubvolumeQuotaInfo> => {
    if (btrfsQuotasDisabled()) {
      return {
        used: 0,
        size: 0,
        warning:
          "Btrfs quota operations are disabled by configuration on this host.",
      };
    }
    const {
      match: { max_referenced: rawSize, referenced: used, qgroupid },
      warning,
    } = await this.qgroup();
    let size = rawSize;
    const warnings: string[] = [];
    if (warning) {
      warnings.push(warning);
    }
    if (size == "none") {
      size = 0;
      warnings.push(
        "No btrfs quota limit is currently enforced on this subvolume.",
      );
    }
    return {
      used,
      size,
      qgroupid,
      scope: "subvolume",
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    };
  };

  set = async (
    size: string | number,
    opts?: {
      project_id?: string;
      volume_kind?: string;
      operation_id?: string;
      operation_class?: string;
      priority?: BtrfsMutationPriority;
    },
  ) => {
    if (btrfsQuotasDisabled()) {
      logger.debug("setQuota skipped because btrfs quotas are disabled", {
        path: this.subvolume.path,
        size,
      });
      return;
    }
    if (!size) {
      throw Error("size must be specified");
    }
    logger.debug("setQuota ", this.subvolume.path, size);
    await queueSetSubvolumeQuota({
      mount: this.subvolume.filesystem.opts.mount,
      path: this.subvolume.path,
      size,
      wait: true,
      ...opts,
    });
    // (the quota queue updates the cached quota tree, qgroup-scan.ts)
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
