/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectRehomeSqlSideTableDecisionStatus =
  | "portable"
  | "not-portable"
  | "projection"
  | "seed-global-cleanup"
  | "data-plane-excluded"
  | "account-home-excluded"
  | "legacy-unused"
  | "audit-local"
  | "operation-local";

export interface ProjectRehomeSqlSideTableDecision {
  table: string;
  status: ProjectRehomeSqlSideTableDecisionStatus;
  reason: string;
}

export interface ProjectRehomeSqlSideTablePreflight {
  portable_tables: string[];
  ignored_tables: string[];
  non_portable_tables: Array<ProjectRehomeSqlSideTableDecision>;
  summary: string;
}

export const PROJECT_REHOME_SQL_SIDE_TABLE_DECISIONS = {
  collaboration_memberships: {
    table: "collaboration_memberships",
    status: "portable",
    reason:
      "The fenced collaboration handoff preserves recipient epochs and notification cutovers without copying access leases.",
  },
  collaboration_notification_events: {
    table: "collaboration_notification_events",
    status: "portable",
    reason:
      "Immutable human-message facts and project-local delivery positions transfer before ownership changes through hash-checked pages.",
  },
  collaboration_notification_floors: {
    table: "collaboration_notification_floors",
    status: "portable",
    reason:
      "Notification replay floors transfer atomically with the owner's retained message events and recipient cutovers.",
  },
  collaboration_notification_cursors: {
    table: "collaboration_notification_cursors",
    status: "account-home-excluded",
    reason:
      "Recipient delivery cursors remain on the account home bay and revalidate the current project owner and membership generation.",
  },
  collaboration_relocations: {
    table: "collaboration_relocations",
    status: "portable",
    reason:
      "Stable relocation retry receipts transfer with catalog bindings; current writer epochs are renewed on activation.",
  },
  collaboration_artifact_bindings: {
    table: "collaboration_artifact_bindings",
    status: "account-home-excluded",
    reason:
      "Personal Library identity bindings remain on the account home bay; project relocation must not rewrite another account's aliases.",
  },
  collaboration_projects: {
    table: "collaboration_projects",
    status: "portable",
    reason:
      "The fenced handoff preserves catalog revision and rotates destination generation before rebuilding access projections.",
  },
  collaboration_sources: {
    table: "collaboration_sources",
    status: "portable",
    reason:
      "Source bindings transfer with renewed writer epochs and reset registration state; old source writers remain fenced.",
  },
  collaboration_source_requests: {
    table: "collaboration_source_requests",
    status: "portable",
    reason:
      "Pending opt-in indexing requests transfer with their authoritative source catalog.",
  },
  collaboration_catalog: {
    table: "collaboration_catalog",
    status: "portable",
    reason:
      "Stable resource identities, locator bindings, activity floors and tombstones are restored atomically from validated transfer pages.",
  },
  collaboration_rooms: {
    table: "collaboration_rooms",
    status: "portable",
    reason:
      "Canonical room identity, location and initialization lifecycle transfer unchanged; transfer never opens or creates a chat file.",
  },
  project_collaboration_rehome_pages: {
    table: "project_collaboration_rehome_pages",
    status: "operation-local",
    reason:
      "Immutable bounded transfer pages belong to their source or destination handoff receipt and are not recursively copied.",
  },
  project_collaboration_rehome_transfers: {
    table: "project_collaboration_rehome_transfers",
    status: "operation-local",
    reason:
      "Durable retry checkpoints and frozen/activated receipts remain on the bay that performed the handoff.",
  },
  collaboration_access: {
    table: "collaboration_access",
    status: "projection",
    reason:
      "Account-home access leases must be refreshed from the new project owner, never copied as grants.",
  },
  collaboration_index: {
    table: "collaboration_index",
    status: "projection",
    reason:
      "Account discovery summaries rebuild only under current owner-issued generations and membership leases.",
  },
  collaboration_personal: {
    table: "collaboration_personal",
    status: "account-home-excluded",
    reason:
      "Personal collection and attention belong to the account home bay, not the project owner.",
  },
  agent_identities: {
    table: "agent_identities",
    status: "not-portable",
    reason:
      "Registered identities require explicit project-owner migration and directory reconciliation before rehome can preserve them.",
  },
  agent_identity_runs: {
    table: "agent_identity_runs",
    status: "not-portable",
    reason:
      "Runtime credentials derive authority from project-owned identities and must not be copied to a new bay.",
  },
  agent_message_project_fences: {
    table: "agent_message_project_fences",
    status: "not-portable",
    reason:
      "Owner-issued messaging recovery fences require explicit destination reconciliation, not raw row copying.",
  },
  agent_rpc_admission_state: {
    table: "agent_rpc_admission_state",
    status: "operation-local",
    reason:
      "Short-lived permits and attachment preparations are local admission state and must not transfer across bays.",
  },
  artifact_catalog: {
    table: "artifact_catalog",
    status: "not-portable",
    reason:
      "Artifact metadata is derived from project chat files, but rehome needs an explicit rescan and reconciliation before the destination catalog can serve it.",
  },
  artifact_catalog_project_budget: {
    table: "artifact_catalog_project_budget",
    status: "not-portable",
    reason:
      "Owner-bay catalog mutation budgets are local admission state and reset after project rehome.",
  },
  artifact_catalog_sources: {
    table: "artifact_catalog_sources",
    status: "not-portable",
    reason:
      "Source sequence and writer epoch are owner-issued fences and require destination registration and rescan rather than raw row copying.",
  },
  project_collab_invites: {
    table: "project_collab_invites",
    status: "not-portable",
    reason:
      "Active collaborator invitations control access and need explicit source/destination copy, directory update, and invalidation semantics before project rehome can preserve them.",
  },
  project_collab_invite_inbox: {
    table: "project_collab_invite_inbox",
    status: "not-portable",
    reason:
      "Invite inbox rows are project-scoped directory/projection state and need explicit source/destination reconciliation before project rehome can preserve them.",
  },
  project_moves: {
    table: "project_moves",
    status: "operation-local",
    reason:
      "Project move operation history is tied to the bay/host operation that created it and should not be blindly copied during project rehome.",
  },
  project_rehome_operations: {
    table: "project_rehome_operations",
    status: "operation-local",
    reason:
      "Project rehome operation state is the control record for the rehome itself and remains local to the source operation controller.",
  },
  project_active_operations: {
    table: "project_active_operations",
    status: "not-portable",
    reason:
      "Active operations must be drained or failed before rehome; copying in-flight operation rows would duplicate work.",
  },
  project_runtime_slots: {
    table: "project_runtime_slots",
    status: "not-portable",
    reason:
      "Runtime slots represent current resource allocation and must be reacquired on the destination instead of copied.",
  },
  project_rootfs_states: {
    table: "project_rootfs_states",
    status: "not-portable",
    reason:
      "Rootfs state controls runtime image selection and needs explicit destination reconciliation with host/rootfs availability before it can be portable.",
  },
  project_host_route_invalidations: {
    table: "project_host_route_invalidations",
    status: "not-portable",
    reason:
      "Route invalidation state is host/control-plane operational state and should be regenerated by the routing layer.",
  },
  course_secret_audit_events: {
    table: "course_secret_audit_events",
    status: "not-portable",
    reason:
      "Course secret audit history is bound to a course policy on the course project's owning bay and requires explicit policy migration semantics.",
  },
  course_secret_grants: {
    table: "course_secret_grants",
    status: "not-portable",
    reason:
      "Course secret grants are authorization state and must not be copied without the complete policy and fresh source-secret validation.",
  },
  course_secret_policies: {
    table: "course_secret_policies",
    status: "not-portable",
    reason:
      "Course secret policies are security-sensitive authority bound to the course project's owning bay and need an explicit rehome protocol.",
  },
  course_secret_recipients: {
    table: "course_secret_recipients",
    status: "not-portable",
    reason:
      "Course secret recipient approvals are authorization state and need explicit cross-bay migration and revalidation.",
  },
  course_secret_sync_results: {
    table: "course_secret_sync_results",
    status: "operation-local",
    reason:
      "Course secret sync result rows are operation history tied to the source policy controller.",
  },
  course_secret_sync_runs: {
    table: "course_secret_sync_runs",
    status: "operation-local",
    reason:
      "Course secret sync runs must finish or fail before rehome and must not be replayed by copying rows.",
  },
  project_secret_managed_sources: {
    table: "project_secret_managed_sources",
    status: "not-portable",
    reason:
      "Managed-secret provenance must move atomically with encrypted project secrets and be revalidated against its remote course policy.",
  },
  project_secrets: {
    table: "project_secrets",
    status: "not-portable",
    reason:
      "Project secrets are encrypted control-plane state. Rehome portability requires an explicit decrypt/re-encrypt or shared-key design plus runtime cache invalidation.",
  },
  project_secrets_runtime_state: {
    table: "project_secrets_runtime_state",
    status: "not-portable",
    reason:
      "Project secret runtime generations move with encrypted secret state and require the same explicit rehome and host-cache invalidation design.",
  },
  project_backup_indexes: {
    table: "project_backup_indexes",
    status: "not-portable",
    reason:
      "Backup indexes reference host/bucket/object state and must be reconciled with backup storage before destination rehome can trust them.",
  },
  project_backup_repo_assignments: {
    table: "project_backup_repo_assignments",
    status: "not-portable",
    reason:
      "Backup repo assignment is project-attached backup placement state and needs seed/destination reconciliation before it can move with a project.",
  },
  mentions: {
    table: "mentions",
    status: "not-portable",
    reason:
      "Mentions are user notification metadata; rehome needs projection/event replay semantics rather than raw row copying.",
  },
  listings: {
    table: "listings",
    status: "not-portable",
    reason:
      "Listings are project-published metadata and need explicit public-share/index reconciliation before project rehome can preserve them.",
  },
  usage_info: {
    table: "usage_info",
    status: "not-portable",
    reason:
      "Usage info is project/account operational accounting state and should be recomputed or explicitly migrated, not generically copied.",
  },
  external_credentials: {
    table: "external_credentials",
    status: "not-portable",
    reason:
      "Project-scoped external credentials are row-scoped encrypted credential state and need explicit credential routing/copy semantics before rehome.",
  },
  bookmarks: {
    table: "bookmarks",
    status: "not-portable",
    reason:
      "Bookmarks are user/project UI metadata and need explicit account projection reconciliation before project rehome can preserve them.",
  },
  notification_events_outbox: {
    table: "notification_events_outbox",
    status: "not-portable",
    reason:
      "Outbox rows are delivery workflow state; they should drain or be regenerated rather than copied while in flight.",
  },
  project_events_outbox: {
    table: "project_events_outbox",
    status: "not-portable",
    reason:
      "Project event outbox rows are delivery workflow state; copying them risks duplicate or stale projection updates.",
  },
  project_labels: {
    table: "project_labels",
    status: "not-portable",
    reason:
      "Project labels are project-owned metadata and need explicit copy/reconcile semantics before project rehome can preserve them.",
  },
  project_rootfs_builds: {
    table: "project_rootfs_builds",
    status: "operation-local",
    reason:
      "RootFS build rows describe builder-project operations and project-host artifacts; they should not move with project ownership until build artifact migration is explicit.",
  },
  project_app_private_hostnames: {
    table: "project_app_private_hostnames",
    status: "not-portable",
    reason:
      "Private app hostnames contain owning-bay DNS lifecycle state. Release them before cross-bay rehome and reserve them again on the destination until an explicit DNS handoff protocol exists.",
  },
  account_project_index: {
    table: "account_project_index",
    status: "projection",
    reason:
      "Account project index rows are rebuilt from authoritative project/account state after rehome.",
  },
  account_notification_index: {
    table: "account_notification_index",
    status: "projection",
    reason:
      "Account notification index rows are projection rows and should be rebuilt or refreshed from notification source state.",
  },
  project_app_public_subdomains: {
    table: "project_app_public_subdomains",
    status: "seed-global-cleanup",
    reason:
      "Rows from the retired public-app experiment are cleanup-only seed data. Hard-delete removes them through seed authority; no active code creates or routes them.",
  },
  project_copies: {
    table: "project_copies",
    status: "operation-local",
    reason:
      "Project copy rows are operation records and should not move with project ownership.",
  },
  long_running_operations: {
    table: "long_running_operations",
    status: "operation-local",
    reason:
      "Project-scoped LRO rows are operation controller state and should be completed, failed, or inspected before rehome.",
  },
  notification_events: {
    table: "notification_events",
    status: "audit-local",
    reason:
      "Notification event history is audit/local delivery history and is not required for project rehome correctness.",
  },
  blobs: {
    table: "blobs",
    status: "data-plane-excluded",
    reason:
      "Blob rows are heavy project data-plane/TimeTravel content and must not be moved through hub project rehome.",
  },
  patches: {
    table: "patches",
    status: "legacy-unused",
    reason:
      "Legacy Postgres sync table. It is no longer used for live project state; current sync state lives in Conat on the project host, so project rehome can ignore it.",
  },
  cursors: {
    table: "cursors",
    status: "legacy-unused",
    reason:
      "Legacy Postgres sync table. It is no longer used for live project state; current cursor/sync state lives in Conat on the project host, so project rehome can ignore it.",
  },
  syncstrings: {
    table: "syncstrings",
    status: "legacy-unused",
    reason:
      "Legacy Postgres sync table. It is no longer used for live project state; current sync state lives in Conat on the project host, so project rehome can ignore it.",
  },
} as const satisfies Record<string, ProjectRehomeSqlSideTableDecision>;

const PROJECT_REHOME_SQL_SIDE_TABLE_DECISION_VALUES: Record<
  string,
  ProjectRehomeSqlSideTableDecision
> = PROJECT_REHOME_SQL_SIDE_TABLE_DECISIONS;

export const PROJECT_REHOME_PORTABLE_SQL_TABLES = Object.entries(
  PROJECT_REHOME_SQL_SIDE_TABLE_DECISION_VALUES,
)
  .filter(([, decision]) => decision.status === "portable")
  .map(([table]) => table);

const IGNORED_REHOME_STATUSES =
  new Set<ProjectRehomeSqlSideTableDecisionStatus>([
    "projection",
    "seed-global-cleanup",
    "legacy-unused",
    "audit-local",
    "account-home-excluded",
  ]);

export function getProjectRehomeSqlSideTablePreflight(): ProjectRehomeSqlSideTablePreflight {
  const decisions = Object.values(
    PROJECT_REHOME_SQL_SIDE_TABLE_DECISION_VALUES,
  );
  const portable_tables = decisions
    .filter((decision) => decision.status === "portable")
    .map((decision) => decision.table)
    .sort();
  const ignored_tables = decisions
    .filter((decision) => IGNORED_REHOME_STATUSES.has(decision.status))
    .map((decision) => decision.table)
    .sort();
  const non_portable_tables = decisions
    .filter(
      (decision) =>
        decision.status !== "portable" &&
        !IGNORED_REHOME_STATUSES.has(decision.status),
    )
    .sort((a, b) => a.table.localeCompare(b.table));
  return {
    portable_tables,
    ignored_tables,
    non_portable_tables,
    summary:
      non_portable_tables.length === 0
        ? "No non-portable SQL side tables are currently declared."
        : `Project rehome does not preserve ${non_portable_tables.length} SQL side table(s); this remains an unsafe operator operation.`,
  };
}
