/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_HARD_DELETE_PROJECT_ID_TABLES = [
  "project_collab_invites",
  "project_collab_invite_inbox",
  "project_moves",
  "project_rehome_operations",
  "project_active_operations",
  "project_runtime_slots",
  "project_rootfs_states",
  "project_host_route_invalidations",
  "project_secrets",
  "project_backup_indexes",
  "project_backup_repo_assignments",
  "mentions",
  "listings",
  "usage_info",
  "external_credentials",
  "bookmarks",
  "notification_events_outbox",
  "project_events_outbox",
  "account_project_index",
  "account_notification_index",
] as const;

export const PROJECT_HARD_DELETE_SEED_GLOBAL_TABLES = [
  "project_app_public_subdomains",
] as const;

export const PROJECT_HARD_DELETE_CUSTOM_TABLES = [
  "project_copies",
  "long_running_operations",
  "notification_events",
  "blobs",
  "patches",
  "cursors",
  "syncstrings",
] as const;

export const PROJECT_HARD_DELETE_SIDE_TABLES = [
  ...PROJECT_HARD_DELETE_PROJECT_ID_TABLES,
  ...PROJECT_HARD_DELETE_SEED_GLOBAL_TABLES,
  ...PROJECT_HARD_DELETE_CUSTOM_TABLES,
] as const;
