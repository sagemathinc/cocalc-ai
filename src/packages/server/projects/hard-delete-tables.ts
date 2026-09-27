/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_HARD_DELETE_PROJECT_ID_TABLES = [
  "agent_identities",
  "agent_message_project_fences",
  "agent_rpc_admission_state",
  "artifact_catalog",
  "artifact_catalog_project_budget",
  "artifact_catalog_sources",
  "collaboration_access",
  "collaboration_artifact_bindings",
  "collaboration_catalog",
  "collaboration_index",
  "collaboration_memberships",
  "collaboration_notification_cursors",
  "collaboration_notification_events",
  "collaboration_notification_floors",
  "collaboration_personal",
  "collaboration_relocations",
  "collaboration_rooms",
  "collaboration_source_requests",
  "collaboration_sources",
  "collaboration_projects",
  "project_collab_invites",
  "project_collab_invite_inbox",
  "project_moves",
  "project_rehome_operations",
  "project_collaboration_rehome_pages",
  "project_collaboration_rehome_transfers",
  "project_active_operations",
  "project_runtime_slots",
  "project_rootfs_states",
  "project_host_route_invalidations",
  "course_secret_audit_events",
  "course_secret_grants",
  "course_secret_policies",
  "course_secret_recipients",
  "course_secret_sync_results",
  "course_secret_sync_runs",
  "project_secret_managed_sources",
  "project_secrets",
  "project_secrets_runtime_state",
  "project_backup_indexes",
  "project_backup_repo_assignments",
  "mentions",
  "listings",
  "usage_info",
  "external_credentials",
  "bookmarks",
  "notification_events_outbox",
  "project_events_outbox",
  "project_labels",
  "project_rootfs_builds",
  "project_app_private_hostnames",
  "account_project_index",
  "account_notification_index",
] as const;

export const PROJECT_HARD_DELETE_SEED_GLOBAL_TABLES = [
  "project_app_public_subdomains",
] as const;

export const PROJECT_HARD_DELETE_CUSTOM_TABLES = [
  "agent_identity_runs",
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
