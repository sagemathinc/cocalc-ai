/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";

export const PROJECT_ARCHIVE_POLICY_VERSION = 1;

export type ProjectArchiveReason =
  | "manual"
  | "free-inactive"
  | "all-collaborators-banned";

export type ProjectArchiveLifecycleJobStatus =
  | "report-only"
  | "queued"
  | "running"
  | "completed"
  | "stale"
  | "canceled"
  | "failed";

export type ProjectArchiveLifecycleConfig = {
  enabled: boolean;
  reportOnly: boolean;
  freeAfterDays: number;
  bannedAfterDays: number;
  batchLimit: number;
  globalPerHour: number;
  perHostConcurrency: number;
  canaryBays: string[];
  canaryHosts: string[];
};

export type ArchiveLifecycleAccountStatus = {
  account_id: string;
  resolved: boolean;
  banned: boolean;
  banned_at: string | null;
  membership: MembershipResolution | null;
};

export type ArchiveLifecycleProjectSnapshot = {
  project_id: string;
  owning_bay_id: string | null;
  host_id: string | null;
  host_status: string | null;
  deleted: Date | string | null;
  provisioned: boolean | null;
  deletion_protection: boolean | null;
  state: { state?: string; time?: string } | null;
  users: Record<string, { group?: string }> | null;
  created: Date | string | null;
  last_edited: Date | string | null;
  last_changed: Date | string | null;
  last_changed_generation: number | string | null;
  last_backup: Date | string | null;
  last_backup_generation: number | string | null;
  backup_repo_id: string | null;
  archive_lifecycle_job_id: string | null;
  active_published_path: boolean;
  ownership_epoch?: number;
};

export type ProjectArchiveEligibilityExclusion =
  | "deleted"
  | "already-archived"
  | "unprovisioned"
  | "protected"
  | "busy-or-unknown-state"
  | "unknown-owning-bay"
  | "wrong-owning-bay"
  | "unknown-collaborators"
  | "unknown-account-authority"
  | "ban-grace-period"
  | "published"
  | "paid-collaborator"
  | "recent-edit"
  | "backup-unsafe"
  | "host-unavailable"
  | "canary-excluded";

export type ProjectArchiveEligibilityDecision =
  | {
      eligible: true;
      reason: Exclude<ProjectArchiveReason, "manual">;
      collaborator_ids: string[];
      latest_banned_at: string | null;
      effective_activity_at: string;
    }
  | {
      eligible: false;
      exclusion: ProjectArchiveEligibilityExclusion;
      detail?: string;
    };

export type ProjectArchiveLifecycleRunSummary = {
  checked_at: string;
  enabled: boolean;
  report_only: boolean;
  selected: number;
  eligible: number;
  recorded: number;
  completed: number;
  stale: number;
  failed: number;
  rate_limited: number;
  /** Final backups still running after the bounded wait; resumed next pass. */
  pending: number;
  exclusions: Partial<Record<ProjectArchiveEligibilityExclusion, number>>;
  job_ids: string[];
};

export type ProjectArchiveLifecycleMaintenanceStatus = {
  running: boolean;
  started: boolean;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_error: string | null;
  last_result: ProjectArchiveLifecycleRunSummary | null;
};
