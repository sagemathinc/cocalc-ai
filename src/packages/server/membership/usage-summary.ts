/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An account's membership limits and usage, the numbers "Usage and limits"
// shows, for API keys and agents with usage:read: never which purchase,
// grant, license, organization or override provides them, and no per-event
// details (project titles, request paths). Only the fields listed here are
// included: a new field stays out until it is reviewed and added.

import type {
  MembershipDetails,
  MembershipUsage,
  MembershipUsageLimits,
  MembershipUsageStatus,
  MembershipUsageValue,
} from "@cocalc/conat/hub/api/purchases";

const LIMIT_FIELDS = [
  "shared_compute_priority",
  "browser_idle_timeout_seconds",
  "total_storage_soft_bytes",
  "total_storage_hard_bytes",
  "max_projects",
  "max_named_agents",
  "max_agent_network_members",
  "max_sponsored_running_projects",
  "max_snapshots_per_project",
  "max_backups_per_project",
  "egress_5h_bytes",
  "egress_7d_bytes",
  "control_plane_egress_5h_bytes",
  "control_plane_egress_7d_bytes",
  "cpu_5h_seconds",
  "cpu_7d_seconds",
  "egress_policy",
  "dedicated_host_egress_policy",
  "credit_spend_limit_5h_usd",
  "credit_spend_limit_7d_usd",
  "prepaid_host_usage_limit_5h_usd",
  "prepaid_host_usage_limit_7d_usd",
  "notification_email_send_limit_5h",
  "notification_email_send_limit_7d",
  "invite_email_send_enabled",
  "invite_email_daily_count",
  "invite_email_hourly_count",
  "invite_email_recipients_per_batch",
  "direct_message_requests_per_day",
  "direct_message_request_recipients_per_day",
  "invite_email_pending_per_project",
  "invite_email_pending_per_course",
  "invite_email_resend_cooldown_minutes",
  "invite_email_custom_message_max_chars",
  "invite_email_allow_project_title",
  "invite_email_allow_course_title",
  "invite_email_allow_urls",
  "invite_email_link_copy_enabled",
  "project_max_collaborators_and_pending_invites",
  "course_max_students_and_pending_invites",
  "acp_max_queued_per_account",
  "acp_max_queued_per_thread",
  "acp_max_running_per_account",
  "acp_max_running_per_project",
  "acp_max_active_automations_per_project",
  "sensor_min_interval_minutes",
  "sensor_max_wakes_per_day",
  "sensor_max_active_watchers",
  "sensor_max_active_watchers_per_agent",
  "blob_account_total_bytes",
  "blob_account_count",
  "blob_project_total_bytes",
  "blob_project_count",
  "public_directory_shares",
  "rootfs_count",
  "rootfs_total_storage_gb",
  "rootfs_max_storage_gb",
  "rootfs_oci_images",
  "sagebrush_storage_bytes",
  "sagebrush_max_file_bytes",
  "sagebrush_private_links",
  "sagebrush_sync_enabled",
  "sagebrush_sync_version_bytes",
  "sagebrush_sync_read_bytes_per_day",
  "sagebrush_sync_retention_days",
] as const satisfies readonly (keyof MembershipUsageLimits)[];

// Not the *_recent_events lists (project titles, request paths).
const USAGE_FIELDS = [
  "collected_at",
  "owned_project_count",
  "sampled_project_count",
  "unsampled_project_count",
  "measurement_error_count",
  "total_storage_bytes",
  "total_storage_soft_bytes",
  "total_storage_hard_bytes",
  "total_storage_soft_remaining_bytes",
  "total_storage_hard_remaining_bytes",
  "over_total_storage_soft",
  "over_total_storage_hard",
  "max_projects",
  "remaining_project_slots",
  "over_max_projects",
  "rootfs_count",
  "rootfs_count_limit",
  "rootfs_remaining_count",
  "over_rootfs_count",
  "rootfs_total_storage_bytes",
  "rootfs_total_storage_bytes_limit",
  "rootfs_total_storage_remaining_bytes",
  "over_rootfs_total_storage",
  "rootfs_max_storage_bytes_limit",
  "blob_count",
  "blob_count_limit",
  "blob_remaining_count",
  "over_blob_count",
  "blob_total_bytes",
  "blob_total_bytes_limit",
  "blob_total_remaining_bytes",
  "over_blob_total_storage",
  "blob_project_count_limit",
  "blob_project_total_bytes_limit",
  "managed_egress_5h_bytes",
  "managed_egress_7d_bytes",
  "managed_egress_5h_remaining_bytes",
  "managed_egress_7d_remaining_bytes",
  "managed_egress_5h_starts_at",
  "managed_egress_7d_starts_at",
  "managed_egress_5h_reset_at",
  "managed_egress_7d_reset_at",
  "managed_egress_5h_reset_in",
  "managed_egress_7d_reset_in",
  "over_managed_egress_5h",
  "over_managed_egress_7d",
  "managed_egress_categories_5h_bytes",
  "managed_egress_categories_7d_bytes",
  "managed_control_plane_egress_5h_bytes",
  "managed_control_plane_egress_7d_bytes",
  "managed_control_plane_egress_5h_limit_bytes",
  "managed_control_plane_egress_7d_limit_bytes",
  "managed_cpu_5h_seconds",
  "managed_cpu_7d_seconds",
  "managed_cpu_5h_remaining_seconds",
  "managed_cpu_7d_remaining_seconds",
  "managed_cpu_5h_starts_at",
  "managed_cpu_7d_starts_at",
  "managed_cpu_5h_reset_at",
  "managed_cpu_7d_reset_at",
  "managed_cpu_5h_reset_in",
  "managed_cpu_7d_reset_in",
  "over_managed_cpu_5h",
  "over_managed_cpu_7d",
] as const satisfies readonly (keyof MembershipUsageStatus)[];

function scalar(value: unknown): MembershipUsageValue | undefined {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 200);
  return undefined;
}

// The egress categories: bytes by category name.
function numbers(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (value instanceof Date) return;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, v]) => typeof v === "number" && Number.isFinite(v)))
    return;
  return Object.fromEntries(entries.slice(0, 50)) as Record<string, number>;
}

function pick(
  value: object | undefined,
  fields: readonly string[],
): Record<string, MembershipUsageValue | Record<string, number>> {
  const result: Record<string, MembershipUsageValue | Record<string, number>> =
    {};
  const source = (value ?? {}) as Record<string, unknown>;
  for (const key of fields) {
    const v = scalar(source[key]) ?? numbers(source[key]);
    if (v !== undefined) result[key] = v;
  }
  return result;
}

export function membershipUsageSummary(
  details: MembershipDetails,
): MembershipUsage {
  const { selected } = details;
  const expires = scalar(selected.expires);
  return {
    membership: {
      class: selected.class,
      source: selected.source,
      ...(typeof expires === "string" ? { expires } : {}),
    },
    limits: pick(
      selected.effective_limits ?? selected.entitlements?.usage_limits,
      LIMIT_FIELDS,
    ),
    usage: details.usage_status
      ? pick(details.usage_status, USAGE_FIELDS)
      : null,
  };
}
