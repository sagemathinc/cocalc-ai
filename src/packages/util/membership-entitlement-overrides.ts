/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS = {
  project_defaults: {
    disk_quota: {
      label: "Per-project disk quota",
      unit: "MB",
      adminDescription:
        "Maximum disk quota applied to each project owned by this account when the project is started or restarted. This does not increase the account's total storage cap.",
      userDescription:
        "Maximum disk quota for each project owned by this account.",
    },
    memory: {
      label: "Project RAM",
      unit: "MB",
      adminDescription:
        "Maximum memory available to each project owned by this account when the project is started or restarted.",
      userDescription: "Maximum memory available to each project.",
    },
    memory_request: {
      label: "Project requested RAM",
      unit: "MB",
      adminDescription:
        "Requested memory for project scheduling. This should usually be at or below the project RAM limit.",
      userDescription: "Requested memory used when scheduling each project.",
    },
  },
  ai_limits: {
    units_5h: {
      label: "AI units, 5-hour window",
      unit: "units",
      adminDescription:
        "Rolling 5-hour AI usage limit. One unit is the platform's normalized AI accounting unit.",
      userDescription: "AI usage limit over a rolling 5-hour window.",
    },
    units_7d: {
      label: "AI units, 7-day window",
      unit: "units",
      adminDescription:
        "Rolling 7-day AI usage limit. One unit is the platform's normalized AI accounting unit.",
      userDescription: "AI usage limit over a rolling 7-day window.",
    },
  },
  usage_limits: {
    total_storage_soft_bytes: {
      label: "Total storage soft cap",
      unit: "GB",
      adminDescription:
        "Account-wide storage cap across owned projects. When exceeded, storage-increasing operations are blocked.",
      userDescription:
        "Account-wide storage cap across projects owned by this account.",
    },
    total_storage_hard_bytes: {
      label: "Total storage hard cap",
      unit: "GB",
      adminDescription:
        "Account-wide hard storage cap across owned projects. This should normally be at or above the soft cap.",
      userDescription:
        "Account-wide hard storage cap across projects owned by this account.",
    },
    max_projects: {
      label: "Owned projects",
      unit: "projects",
      adminDescription:
        "Maximum number of projects this account can own. Collaborating on someone else's project does not count.",
      userDescription: "Maximum number of projects this account can own.",
    },
    max_snapshots_per_project: {
      label: "Snapshots per project",
      unit: "snapshots",
      adminDescription:
        "Maximum retained snapshots for each project owned by this account.",
      userDescription: "Maximum retained snapshots for each project.",
    },
    max_backups_per_project: {
      label: "Backups per project",
      unit: "backups",
      adminDescription:
        "Maximum retained backups for each project owned by this account.",
      userDescription: "Maximum retained backups for each project.",
    },
    egress_5h_bytes: {
      label: "Managed egress, 5-hour window",
      unit: "GB",
      adminDescription:
        "Rolling 5-hour managed data-transfer allowance for project file downloads, project network egress, and similar metered egress.",
      userDescription:
        "Managed data-transfer allowance over a rolling 5-hour window.",
    },
    egress_7d_bytes: {
      label: "Managed egress, 7-day window",
      unit: "GB",
      adminDescription:
        "Rolling 7-day managed data-transfer allowance for project file downloads, project network egress, and similar metered egress.",
      userDescription:
        "Managed data-transfer allowance over a rolling 7-day window.",
    },
    credit_spend_limit_5h_usd: {
      label: "Postpay host spend, 5-hour window",
      unit: "USD",
      adminDescription:
        "Rolling 5-hour postpaid dedicated-host spend limit for this account.",
      userDescription:
        "Postpaid dedicated-host spend limit over a rolling 5-hour window.",
    },
    credit_spend_limit_7d_usd: {
      label: "Postpay host spend, 7-day window",
      unit: "USD",
      adminDescription:
        "Rolling 7-day postpaid dedicated-host spend limit for this account.",
      userDescription:
        "Postpaid dedicated-host spend limit over a rolling 7-day window.",
    },
    prepaid_host_usage_limit_5h_usd: {
      label: "Prepay host spend, 5-hour window",
      unit: "USD",
      adminDescription:
        "Rolling 5-hour dedicated-host spend limit when spending from this account's prepaid balance.",
      userDescription:
        "Prepaid dedicated-host spend limit over a rolling 5-hour window.",
    },
    prepaid_host_usage_limit_7d_usd: {
      label: "Prepay host spend, 7-day window",
      unit: "USD",
      adminDescription:
        "Rolling 7-day dedicated-host spend limit when spending from this account's prepaid balance.",
      userDescription:
        "Prepaid dedicated-host spend limit over a rolling 7-day window.",
    },
  },
} as const;
