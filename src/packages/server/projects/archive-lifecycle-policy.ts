/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";
import type {
  ArchiveLifecycleAccountStatus,
  ArchiveLifecycleProjectSnapshot,
  ProjectArchiveEligibilityDecision,
  ProjectArchiveLifecycleConfig,
} from "./archive-lifecycle-types";

const DAY_MS = 24 * 60 * 60 * 1000;

function dateMs(value: Date | string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function archiveLifecycleCollaboratorIds(
  users: ArchiveLifecycleProjectSnapshot["users"],
): string[] {
  if (!users) return [];
  return Object.entries(users)
    .filter(
      ([accountId, user]) =>
        isValidUUID(accountId) &&
        (user?.group === "owner" || user?.group === "collaborator"),
    )
    .map(([accountId]) => accountId)
    .sort();
}

export function isProjectArchiveBackupCurrent(
  project: ArchiveLifecycleProjectSnapshot,
): boolean {
  const backupAt = dateMs(project.last_backup);
  if (!project.backup_repo_id || backupAt == null) return false;
  const changedAt = dateMs(project.last_changed);
  if (project.last_changed != null && changedAt == null) return false;
  if (changedAt != null && backupAt < changedAt) return false;
  // pg BIGINT values arrive as strings. Number() can round adjacent generations
  // into equality and turn stale evidence into permission to delete the source.
  const generation = (value: number | string | null | undefined) => {
    if (value == null) return null;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0
        ? BigInt(value)
        : undefined;
    }
    return /^(0|[1-9][0-9]{0,18})$/.test(value) ? BigInt(value) : undefined;
  };
  const changedGeneration = generation(project.last_changed_generation);
  const backupGeneration = generation(project.last_backup_generation);
  if (changedGeneration === undefined || backupGeneration === undefined)
    return false;
  if (
    changedGeneration != null &&
    (backupGeneration == null || backupGeneration < changedGeneration)
  ) {
    return false;
  }
  return true;
}

export function evaluateProjectArchiveEligibility({
  project,
  accounts,
  config,
  currentBayId,
  now = new Date(),
}: {
  project: ArchiveLifecycleProjectSnapshot;
  accounts: Map<string, ArchiveLifecycleAccountStatus>;
  config: ProjectArchiveLifecycleConfig;
  currentBayId: string;
  now?: Date;
}): ProjectArchiveEligibilityDecision {
  if (project.deleted != null) return { eligible: false, exclusion: "deleted" };
  const state = `${project.state?.state ?? ""}`.trim();
  if (state === "archived") {
    return { eligible: false, exclusion: "already-archived" };
  }
  if (project.provisioned !== true) {
    return { eligible: false, exclusion: "unprovisioned" };
  }
  if (project.deletion_protection === true) {
    return { eligible: false, exclusion: "protected" };
  }
  if (state !== "opened") {
    return { eligible: false, exclusion: "busy-or-unknown-state" };
  }
  const owningBayId = `${project.owning_bay_id ?? ""}`.trim();
  if (!owningBayId) {
    return { eligible: false, exclusion: "unknown-owning-bay" };
  }
  if (owningBayId !== currentBayId) {
    return { eligible: false, exclusion: "wrong-owning-bay" };
  }
  if (
    config.canaryBays.length > 0 &&
    !config.canaryBays.includes(owningBayId)
  ) {
    return { eligible: false, exclusion: "canary-excluded" };
  }
  if (
    config.canaryHosts.length > 0 &&
    (!project.host_id || !config.canaryHosts.includes(project.host_id))
  ) {
    return { eligible: false, exclusion: "canary-excluded" };
  }
  if (
    !project.host_id ||
    !["active", "running"].includes(
      `${project.host_status ?? ""}`.trim().toLowerCase(),
    )
  ) {
    return { eligible: false, exclusion: "host-unavailable" };
  }
  if (!isProjectArchiveBackupCurrent(project)) {
    return { eligible: false, exclusion: "backup-unsafe" };
  }

  const collaboratorIds = archiveLifecycleCollaboratorIds(project.users);
  if (collaboratorIds.length === 0) {
    return { eligible: false, exclusion: "unknown-collaborators" };
  }
  const statuses = collaboratorIds.map((accountId) => accounts.get(accountId));
  if (statuses.some((status) => status?.resolved !== true)) {
    return { eligible: false, exclusion: "unknown-account-authority" };
  }

  const resolved = statuses as ArchiveLifecycleAccountStatus[];
  if (resolved.every((status) => status.banned)) {
    const bannedAt = resolved.map((status) => dateMs(status.banned_at));
    if (bannedAt.some((value) => value == null)) {
      return { eligible: false, exclusion: "unknown-account-authority" };
    }
    const latestBannedAt = Math.max(...(bannedAt as number[]));
    if (latestBannedAt > now.getTime() - config.bannedAfterDays * DAY_MS) {
      return { eligible: false, exclusion: "ban-grace-period" };
    }
    const activityAt = dateMs(project.last_edited) ?? dateMs(project.created);
    if (activityAt == null) {
      return { eligible: false, exclusion: "unknown-account-authority" };
    }
    return {
      eligible: true,
      reason: "all-collaborators-banned",
      collaborator_ids: collaboratorIds,
      latest_banned_at: new Date(latestBannedAt).toISOString(),
      effective_activity_at: new Date(activityAt).toISOString(),
    };
  }

  if (project.active_published_path) {
    return { eligible: false, exclusion: "published" };
  }
  if (
    resolved.some(
      (status) =>
        !status.banned &&
        status.membership != null &&
        status.membership.class !== "free",
    )
  ) {
    return { eligible: false, exclusion: "paid-collaborator" };
  }
  if (resolved.some((status) => !status.banned && status.membership == null)) {
    return { eligible: false, exclusion: "unknown-account-authority" };
  }

  const activityAt = dateMs(project.last_edited) ?? dateMs(project.created);
  if (activityAt == null) {
    return { eligible: false, exclusion: "unknown-account-authority" };
  }
  if (activityAt > now.getTime() - config.freeAfterDays * DAY_MS) {
    return { eligible: false, exclusion: "recent-edit" };
  }
  return {
    eligible: true,
    reason: "free-inactive",
    collaborator_ids: collaboratorIds,
    latest_banned_at: null,
    effective_activity_at: new Date(activityAt).toISOString(),
  };
}

export const __test__ = { dateMs };
