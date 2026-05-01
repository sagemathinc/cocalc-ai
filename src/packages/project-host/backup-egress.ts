/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { ManagedBackupEgressOverride } from "@cocalc/conat/files/file-server";
import type { ManagedProjectEgressCategory } from "@cocalc/conat/hub/api/system";
import { hubApi } from "@cocalc/lite/hub/api";
import { capitalize, humanSize } from "@cocalc/util/misc";

import {
  isProjectHostManagedEgressEnforced,
  isProjectHostManagedEgressTrackingEnabled,
} from "./managed-egress-runtime";

const logger = getLogger("project-host:backup-egress");

export const MANAGED_BACKUP_EGRESS_CATEGORY: ManagedProjectEgressCategory =
  "backup-upload";

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  if (category === "http-proxy") return "App server HTTP traffic";
  if (category === "ws-proxy") return "App server WebSocket traffic";
  if (category === "ssh") return "SSH traffic";
  if (category === "interactive-conat") return "Interactive session traffic";
  if (category === "raw-network") return "Project outbound network traffic";
  if (category === MANAGED_BACKUP_EGRESS_CATEGORY)
    return "Project backup uploads";
  return capitalize(category.replace(/[-_]/g, " "));
}

function formatByteCount(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  return humanSize(bytes);
}

function numericSummaryValue(
  summary: Record<string, string | number> | undefined,
  key: string,
): number | undefined {
  const value = Number(summary?.[key]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function getManagedBackupEgressBytes(
  summary: Record<string, string | number> | undefined,
): number {
  return (
    numericSummaryValue(summary, "data_added_packed") ??
    numericSummaryValue(summary, "data_added") ??
    numericSummaryValue(summary, "total_bytes_processed") ??
    0
  );
}

export async function checkManagedBackupAllowedBestEffort({
  project_id,
  managed_egress_override,
}: {
  project_id: string;
  managed_egress_override?: ManagedBackupEgressOverride;
}): Promise<
  | {
      allowed: true;
    }
  | {
      allowed: false;
      message: string;
    }
> {
  if (managed_egress_override === "admin-host-drain") {
    return { allowed: true };
  }
  if (!isProjectHostManagedEgressEnforced()) {
    return { allowed: true };
  }
  try {
    const policy = await hubApi.system.getManagedProjectEgressPolicy({
      project_id,
      category: MANAGED_BACKUP_EGRESS_CATEGORY,
    });
    if (policy.allowed) {
      return { allowed: true };
    }
    const breakdown = Object.entries(
      policy.managed_egress_categories_5h_bytes ?? {},
    )
      .filter(
        ([, bytes]) =>
          typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0,
      )
      .map(
        ([category, bytes]) =>
          `${formatManagedEgressCategory(category)}: ${formatByteCount(bytes)}`,
      );
    const lines = [
      "Managed backup upload limit reached for this account.",
      "New backups, including scheduled backups and moves that require a backup, are temporarily blocked until the egress usage window resets.",
    ];
    if (policy.egress_5h_bytes != null) {
      lines.push(
        `5-hour usage: ${formatByteCount(policy.managed_egress_5h_bytes)} / ${formatByteCount(policy.egress_5h_bytes)}.`,
      );
    }
    if (policy.egress_7d_bytes != null) {
      lines.push(
        `7-day usage: ${formatByteCount(policy.managed_egress_7d_bytes)} / ${formatByteCount(policy.egress_7d_bytes)}.`,
      );
    }
    if (breakdown.length > 0) {
      lines.push(
        `Current managed egress categories (5 hours): ${breakdown.join(", ")}.`,
      );
    }
    return {
      allowed: false,
      message: lines.join("\n"),
    };
  } catch (err) {
    logger.warn("unable to evaluate managed backup egress policy", {
      project_id,
      err: `${err}`,
    });
    return { allowed: true };
  }
}

export async function recordManagedBackupEgressBestEffort({
  project_id,
  backup_id,
  tags,
  summary,
}: {
  project_id: string;
  backup_id: string;
  tags?: string[];
  summary: Record<string, string | number> | undefined;
}): Promise<void> {
  const bytes = getManagedBackupEgressBytes(summary);
  if (!(bytes > 0) || !isProjectHostManagedEgressTrackingEnabled()) {
    return;
  }
  const metadata: Record<string, unknown> = {
    backup_id,
  };
  const normalizedTags = (tags ?? [])
    .map((tag) => `${tag}`.trim())
    .filter(Boolean);
  if (normalizedTags.length > 0) {
    metadata.tags = normalizedTags;
  }
  for (const key of [
    "data_added_packed",
    "data_added",
    "total_bytes_processed",
    "files_new",
    "files_changed",
    "files_unmodified",
    "files_processed",
  ]) {
    const value = numericSummaryValue(summary, key);
    if (value != null) {
      metadata[key] = value;
    }
  }
  try {
    await hubApi.system.recordManagedProjectEgress({
      project_id,
      category: MANAGED_BACKUP_EGRESS_CATEGORY,
      bytes,
      metadata,
    });
  } catch (err) {
    logger.warn("unable to record managed backup upload egress", {
      project_id,
      backup_id,
      bytes,
      err: `${err}`,
    });
  }
}
