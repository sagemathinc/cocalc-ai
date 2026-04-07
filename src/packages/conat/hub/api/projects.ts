import { authFirstRequireAccount, authFirstRequireProject } from "./util";
import { type CreateProjectOptions } from "@cocalc/util/db-schema/projects";
import {
  type SnapshotCounts,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { type CopyOptions } from "@cocalc/conat/files/fs";
import {
  type FileTextPreview,
  type SnapshotUsage,
  type RestoreMode,
  type RestoreStagingHandle,
  type SnapshotRestoreMode,
} from "@cocalc/conat/files/file-server";
import type {
  ExecuteCodeOptions,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";

export type ProjectCopyState =
  | "queued"
  | "applying"
  | "done"
  | "failed"
  | "canceled"
  | "expired";

export interface ProjectCopyRow {
  copy_id: string;
  src_project_id: string;
  src_path: string;
  dest_project_id: string;
  dest_path: string;
  op_id: string | null;
  snapshot_id: string;
  options: CopyOptions | null;
  status: ProjectCopyState;
  last_error: string | null;
  attempt: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  last_attempt_at: Date | null;
}

export interface BackupFindResult {
  id: string;
  time: Date;
  path: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

export interface ProjectRuntimeLog {
  project_id: string;
  host_id: string | null;
  container: string;
  lines: number;
  text: string;
  found: boolean;
  running: boolean;
  available: boolean;
  reason?: string;
}

export interface ImportPublicUrlResult {
  project_id: string;
  path: string;
  bytes: number;
  source_url: string;
}

export interface PublicPathInspectionResult {
  source_project_id: string;
  host_id: string;
  app_id: string;
  static_root: string;
  exposure_mode: "private" | "public";
  auth_front?: "none" | "token";
  public_access_granted: boolean;
  requested: {
    kind: "file" | "directory";
    relative_path: string;
    container_path: string;
    bytes?: number;
    truncated?: boolean;
  };
  containing_directory: {
    relative_path: string;
    container_path: string;
    bytes?: number;
    truncated?: boolean;
  };
}

export interface ImportPublicPathResult {
  project_id: string;
  path: string;
  source_project_id: string;
  source_path: string;
  mode: "file" | "directory";
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}

export interface ProjectStorageBreakdown {
  path: string;
  bytes: number;
  children: { bytes: number; path: string }[];
  collected_at: string;
}

export interface ProjectStorageQuotaSummary {
  key: "project";
  label: string;
  used: number;
  size: number;
  qgroupid?: string;
  scope?: "tracking" | "subvolume";
  warning?: string;
}

export interface ProjectStorageVisibleSummary {
  key: "home" | "scratch" | "environment";
  label: string;
  summaryLabel: string;
  path: string;
  summaryBytes: number;
  usage: ProjectStorageBreakdown;
}

export interface ProjectStorageCountedSummary {
  key: "snapshots";
  label: string;
  bytes: number;
  detail?: string;
  compactLabel?: string;
}

export interface ProjectStorageOverview {
  collected_at: string;
  quotas: ProjectStorageQuotaSummary[];
  visible: ProjectStorageVisibleSummary[];
  counted: ProjectStorageCountedSummary[];
}

export interface ProjectStorageHistoryPoint {
  collected_at: string;
  quota_used_bytes?: number;
  quota_size_bytes?: number;
  quota_used_percent?: number;
  home_visible_bytes?: number;
  scratch_visible_bytes?: number;
  environment_visible_bytes?: number;
  snapshot_counted_bytes?: number;
}

export interface ProjectStorageHistoryGrowth {
  window_minutes: number;
  quota_used_bytes_per_hour?: number;
}

export interface ProjectStorageHistory {
  window_minutes: number;
  point_count: number;
  points: ProjectStorageHistoryPoint[];
  growth?: ProjectStorageHistoryGrowth;
}

export interface RecentDocumentActivityRow {
  id: string;
  project_id: string;
  path: string;
  last_accessed?: Date | null;
  recent_account_ids?: string[];
  last_edited?: Date | null;
  users?: Record<
    string,
    Record<string, Date | string | null | undefined> | undefined
  >;
}

// "cloudflare-access-tcp" is kept temporarily for compatibility with older
// servers/clients. The route is a Cloudflare-published SSH/TCP endpoint; it
// may still use the `cloudflared access ssh` client shim, but it is not
// modeled as an interactive Access login flow in CoCalc anymore.
export type WorkspaceSshTransport =
  | "cloudflare-tcp"
  | "cloudflare-access-tcp"
  | "direct";

export interface WorkspaceSshConnectionInfo {
  workspace_id: string;
  host_id: string;
  transport: WorkspaceSshTransport;
  ssh_username: string;
  ssh_server: string | null;
  cloudflare_hostname: string | null;
}

export type ProjectCollabInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "blocked"
  | "expired"
  | "canceled";

export type ProjectCollabInviteAction =
  | "accept"
  | "decline"
  | "block"
  | "revoke";

export type ProjectCollabInviteDirection = "inbound" | "outbound" | "all";

export interface ProjectCollabInviteRow {
  invite_id: string;
  project_id: string;
  project_title?: string | null;
  project_description?: string | null;
  inviter_account_id: string;
  inviter_name?: string | null;
  inviter_first_name?: string | null;
  inviter_last_name?: string | null;
  inviter_email_address?: string | null;
  invitee_account_id?: string | null;
  invitee_name?: string | null;
  invitee_first_name?: string | null;
  invitee_last_name?: string | null;
  invitee_email_address?: string | null;
  invite_source?: "account" | "email";
  status: ProjectCollabInviteStatus;
  message?: string | null;
  responder_action?: ProjectCollabInviteAction | null;
  created: Date;
  updated: Date;
  responded?: Date | null;
  expires?: Date | null;
  shared_projects_count?: number;
  shared_projects_sample?: string[] | null;
  prior_invites_accepted?: number;
  prior_invites_declined?: number;
}

export interface ProjectCollabInviteBlockRow {
  blocker_account_id: string;
  blocker_name?: string | null;
  blocked_account_id: string;
  blocked_name?: string | null;
  blocked_first_name?: string | null;
  blocked_last_name?: string | null;
  blocked_email_address?: string | null;
  created: Date;
  updated: Date;
}

export interface ProjectCollaboratorRow {
  account_id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email_address?: string | null;
  last_active?: Date | null;
  group: "owner" | "collaborator";
}

export interface MyCollaboratorRow {
  account_id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email_address?: string | null;
  last_active?: Date | null;
  shared_projects: number;
}

export interface ProjectLogCursor {
  id: string;
  time: Date | null;
}

export interface ProjectLogRow {
  id: string;
  project_id: string;
  account_id: string;
  time: Date | null;
  event: Record<string, any> | string | null;
}

export interface ProjectLogPage {
  entries: ProjectLogRow[];
  has_more: boolean;
}

export type ChatStoreScope = "chat" | "before_date" | "thread" | "messages";

export interface ChatStoreStats {
  chat_id: string;
  chat_path: string;
  db_path: string;
  head_bytes: number;
  head_rows: number;
  head_chat_rows: number;
  archived_rows: number;
  archived_bytes: number;
  segments: number;
  keep_recent_messages: number;
  max_head_bytes: number;
  max_head_messages: number;
  last_rotated_at_ms?: number;
  pending_rotate_op_id?: string;
  pending_rotate_status?: string;
  pending_rotate_error?: string;
}

export interface ChatStoreRotateResult {
  rotated: boolean;
  reason?: string;
  dry_run?: boolean;
  chat_id: string;
  maintenance_op_id?: string;
  maintenance_status?: string;
  segment_id?: string;
  segment_seq?: number;
  archived_rows?: number;
  archived_bytes?: number;
  kept_chat_rows?: number;
  head_bytes_before?: number;
  head_bytes_after?: number;
  head_rows_before?: number;
  head_rows_after?: number;
  generating_rows?: number;
  rewrite_warning?: string;
}

export interface ChatStoreSegment {
  segment_id: string;
  seq: number;
  created_at_ms: number;
  from_date_ms?: number;
  to_date_ms?: number;
  from_message_id?: string;
  to_message_id?: string;
  row_count: number;
  payload_sha256: string;
  payload_codec: string;
  payload_bytes: number;
}

export interface ChatStoreArchivedRow {
  row_id: number;
  segment_id: string;
  message_id?: string;
  thread_id?: string;
  sender_id?: string;
  event?: string;
  date_ms?: number;
  excerpt?: string;
  row: Record<string, any>;
}

export interface ChatStoreSearchHit {
  row_id: number;
  segment_id: string;
  message_id?: string;
  thread_id?: string;
  date_ms?: number;
  excerpt?: string;
  snippet?: string;
}

export interface ChatStoreDeleteResult {
  chat_id: string;
  scope: ChatStoreScope;
  deleted_rows: number;
  deleted_segments: number;
}

export type ProjectLauncherSettings = Record<string, any> | null;
export type ProjectRegion = string | null;
export type ProjectCreated = Date | string | null;
export type ProjectEnv = Record<string, string> | null;
export interface ProjectRootfsConfig {
  image: string;
  image_id?: string | null;
}
export type ProjectSnapshotSchedule = SnapshotSchedule | null;
export type ProjectBackupSchedule = SnapshotSchedule | null;
export type ProjectRunQuota = Record<string, any> | null;

export const projects = {
  createProject: authFirstRequireAccount,
  copyPathBetweenProjects: authFirstRequireAccount,
  inspectPublicPath: authFirstRequireAccount,
  importPublicUrl: authFirstRequireAccount,
  importPublicPath: authFirstRequireAccount,
  listPendingCopies: authFirstRequireAccount,
  cancelPendingCopy: authFirstRequireAccount,
  removeCollaborator: authFirstRequireAccount,
  addCollaborator: authFirstRequireAccount,
  createCollabInvite: authFirstRequireAccount,
  listCollabInvites: authFirstRequireAccount,
  respondCollabInvite: authFirstRequireAccount,
  listCollabInviteBlocks: authFirstRequireAccount,
  unblockCollabInviteSender: authFirstRequireAccount,
  listCollaborators: authFirstRequireAccount,
  listMyCollaborators: authFirstRequireAccount,
  listProjectLog: authFirstRequireAccount,
  listRecentDocumentActivity: authFirstRequireAccount,
  getProjectLauncher: authFirstRequireAccount,
  setProjectLauncher: authFirstRequireAccount,
  getProjectRegion: authFirstRequireAccount,
  getProjectCreated: authFirstRequireAccount,
  getProjectEnv: authFirstRequireAccount,
  setProjectEnv: authFirstRequireAccount,
  getProjectRootfs: authFirstRequireAccount,
  getProjectSnapshotSchedule: authFirstRequireAccount,
  getProjectBackupSchedule: authFirstRequireAccount,
  getProjectRunQuota: authFirstRequireAccount,
  inviteCollaborator: authFirstRequireAccount,
  inviteCollaboratorWithoutAccount: authFirstRequireAccount,
  setQuotas: authFirstRequireAccount,

  getDiskQuota: authFirstRequireAccount,
  getStorageOverview: authFirstRequireAccount,
  getStorageBreakdown: authFirstRequireAccount,
  getStorageHistory: authFirstRequireAccount,
  exec: authFirstRequireAccount,
  getRuntimeLog: authFirstRequireAccount,
  resolveWorkspaceSshConnection: authFirstRequireAccount,
  resolveProjectSshConnection: authFirstRequireAccount,

  createBackup: authFirstRequireAccount,
  deleteBackup: authFirstRequireAccount,
  restoreBackup: authFirstRequireAccount,
  beginRestoreStaging: authFirstRequireAccount,
  ensureRestoreStaging: authFirstRequireAccount,
  finalizeRestoreStaging: authFirstRequireAccount,
  releaseRestoreStaging: authFirstRequireAccount,
  cleanupRestoreStaging: authFirstRequireAccount,
  updateBackups: authFirstRequireAccount,
  getBackups: authFirstRequireAccount,
  getBackupFiles: authFirstRequireAccount,
  findBackupFiles: authFirstRequireAccount,
  getBackupFileText: authFirstRequireAccount,
  getBackupQuota: authFirstRequireAccount,

  createSnapshot: authFirstRequireAccount,
  deleteSnapshot: authFirstRequireAccount,
  restoreSnapshot: authFirstRequireAccount,
  updateSnapshots: authFirstRequireAccount,
  getSnapshotQuota: authFirstRequireAccount,
  allSnapshotUsage: authFirstRequireAccount,
  getSnapshotFileText: authFirstRequireAccount,

  start: authFirstRequireAccount,
  stop: authFirstRequireAccount,
  deleteProject: authFirstRequireAccount,
  setProjectDeleted: authFirstRequireAccount,
  updateAuthorizedKeysOnHost: authFirstRequireAccount,
  hardDeleteProject: authFirstRequireAccount,
  setProjectHidden: authFirstRequireAccount,
  setProjectSshKey: authFirstRequireAccount,
  deleteProjectSshKey: authFirstRequireAccount,

  getSshKeys: authFirstRequireProject,

  moveProject: authFirstRequireAccount,
  codexDeviceAuthStart: authFirstRequireAccount,
  codexDeviceAuthStatus: authFirstRequireAccount,
  codexDeviceAuthCancel: authFirstRequireAccount,
  codexUploadAuthFile: authFirstRequireAccount,
  chatStoreStats: authFirstRequireAccount,
  chatStoreRotate: authFirstRequireAccount,
  chatStoreListSegments: authFirstRequireAccount,
  chatStoreReadArchived: authFirstRequireAccount,
  chatStoreReadArchivedHit: authFirstRequireAccount,
  chatStoreSearch: authFirstRequireAccount,
  chatStoreDelete: authFirstRequireAccount,
  chatStoreVacuum: authFirstRequireAccount,
};

export type AddCollaborator =
  | {
      project_id: string;
      account_id: string;
      token_id?: undefined;
    }
  | {
      token_id: string;
      account_id: string;
      project_id?: undefined;
    }
  | { project_id: string[]; account_id: string[]; token_id?: undefined } // for adding more than one at once
  | { account_id: string[]; token_id: string[]; project_id?: undefined };

export interface Projects {
  // request to have conat permissions to project subjects.
  createProject: (opts: CreateProjectOptions) => Promise<string>;

  copyPathBetweenProjects: (opts: {
    src: { project_id: string; path: string | string[] };
    src_home?: string;
    dest: { project_id: string; path: string };
    options?: CopyOptions;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  inspectPublicPath: (opts: {
    account_id?: string;
    public_url: string;
  }) => Promise<PublicPathInspectionResult>;

  importPublicUrl: (opts: {
    account_id?: string;
    project_id: string;
    public_url: string;
    path?: string;
  }) => Promise<ImportPublicUrlResult>;

  importPublicPath: (opts: {
    account_id?: string;
    project_id: string;
    public_url: string;
    mode: "file" | "directory";
    path?: string;
  }) => Promise<ImportPublicPathResult>;

  listPendingCopies: (opts: {
    account_id?: string;
    project_id: string;
    include_completed?: boolean;
  }) => Promise<ProjectCopyRow[]>;

  listProjectLog: (opts: {
    account_id?: string;
    project_id: string;
    limit?: number;
    newer_than?: ProjectLogCursor;
    older_than?: ProjectLogCursor;
  }) => Promise<ProjectLogPage>;

  listRecentDocumentActivity: (opts: {
    account_id?: string;
    limit?: number;
    max_age_s?: number;
  }) => Promise<RecentDocumentActivityRow[]>;

  getProjectLauncher: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectLauncherSettings>;

  setProjectLauncher: (opts: {
    account_id?: string;
    project_id: string;
    launcher: ProjectLauncherSettings;
  }) => Promise<void>;

  getProjectRegion: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRegion>;

  getProjectCreated: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectCreated>;

  getProjectEnv: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectEnv>;

  setProjectEnv: (opts: {
    account_id?: string;
    project_id: string;
    env: ProjectEnv;
  }) => Promise<void>;

  getProjectRootfs: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRootfsConfig | null>;

  getProjectRunQuota: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRunQuota>;

  cancelPendingCopy: (opts: {
    account_id?: string;
    src_project_id: string;
    src_path: string;
    dest_project_id: string;
    dest_path: string;
  }) => Promise<void>;

  removeCollaborator: ({
    account_id,
    opts,
  }: {
    account_id?: string;
    opts: {
      account_id;
      project_id;
    };
  }) => Promise<void>;

  addCollaborator: ({
    account_id,
    opts,
  }: {
    account_id?: string;
    opts: AddCollaborator;
  }) => Promise<{ project_id?: string | string[] }>;

  createCollabInvite: (opts: {
    account_id?: string;
    project_id: string;
    invitee_account_id: string;
    message?: string;
    direct?: boolean;
  }) => Promise<{
    created: boolean;
    invite: ProjectCollabInviteRow;
  }>;

  listCollabInvites: (opts: {
    account_id?: string;
    project_id?: string;
    direction?: ProjectCollabInviteDirection;
    status?: ProjectCollabInviteStatus;
    limit?: number;
  }) => Promise<ProjectCollabInviteRow[]>;

  respondCollabInvite: (opts: {
    account_id?: string;
    invite_id: string;
    action: ProjectCollabInviteAction;
  }) => Promise<ProjectCollabInviteRow>;

  listCollabInviteBlocks: (opts: {
    account_id?: string;
    limit?: number;
  }) => Promise<ProjectCollabInviteBlockRow[]>;

  unblockCollabInviteSender: (opts: {
    account_id?: string;
    blocked_account_id: string;
  }) => Promise<{
    unblocked: boolean;
    blocker_account_id: string;
    blocked_account_id: string;
  }>;

  listCollaborators: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectCollaboratorRow[]>;

  listMyCollaborators: (opts: {
    account_id?: string;
    limit?: number;
  }) => Promise<MyCollaboratorRow[]>;

  inviteCollaborator: ({
    account_id,
    opts,
  }: {
    account_id?: string;
    opts: {
      project_id: string;
      account_id: string;
      title?: string;
      link2proj?: string;
      replyto?: string;
      replyto_name?: string;
      email?: string;
      subject?: string;
      message?: string;
    };
  }) => Promise<void>;

  inviteCollaboratorWithoutAccount: ({
    account_id,
    opts,
  }: {
    account_id?: string;
    opts: {
      project_id: string;
      title: string;
      link2proj: string;
      replyto?: string;
      replyto_name?: string;
      to: string;
      email: string; // body in HTML format
      subject?: string;
      message?: string;
    };
  }) => Promise<void>;

  // for admins only!
  setQuotas: (opts: {
    account_id?: string;
    project_id: string;
    memory?: number;
    memory_request?: number;
    cpu_shares?: number;
    cores?: number;
    disk_quota?: number;
    mintime?: number;
    network?: number;
    member_host?: number;
    always_running?: number;
  }) => Promise<void>;

  getDiskQuota: (opts: { account_id?: string; project_id: string }) => Promise<{
    used: number;
    size: number;
    qgroupid?: string;
    scope?: "tracking" | "subvolume";
    warning?: string;
  }>;

  getStorageOverview: (opts: {
    account_id?: string;
    project_id: string;
    home?: string;
    force_sample?: boolean;
  }) => Promise<ProjectStorageOverview>;

  getStorageBreakdown: (opts: {
    account_id?: string;
    project_id: string;
    path: string;
  }) => Promise<ProjectStorageBreakdown>;

  getStorageHistory: (opts: {
    account_id?: string;
    project_id: string;
    window_minutes?: number;
    max_points?: number;
  }) => Promise<ProjectStorageHistory>;

  exec: (opts: {
    account_id?: string;
    project_id: string;
    execOpts: ExecuteCodeOptions;
  }) => Promise<ExecuteCodeOutput>;

  getRuntimeLog: (opts: {
    account_id?: string;
    project_id: string;
    lines?: number;
  }) => Promise<ProjectRuntimeLog>;

  resolveWorkspaceSshConnection: (opts: {
    account_id?: string;
    project_id: string;
    direct?: boolean;
  }) => Promise<WorkspaceSshConnectionInfo>;

  resolveProjectSshConnection: (opts: {
    account_id?: string;
    project_id: string;
    direct?: boolean;
  }) => Promise<WorkspaceSshConnectionInfo>;

  /////////////
  // BACKUPS
  /////////////
  createBackup: (opts: { account_id?: string; project_id: string }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  deleteBackup: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
  }) => Promise<void>;

  restoreBackup: (opts: {
    account_id?: string;
    project_id: string;
    path?: string;
    dest?: string;
    id: string;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  beginRestoreStaging: (opts: {
    account_id?: string;
    project_id: string;
    home?: string;
    restore?: RestoreMode;
  }) => Promise<RestoreStagingHandle | null>;

  ensureRestoreStaging: (opts: {
    account_id?: string;
    handle: RestoreStagingHandle;
  }) => Promise<void>;

  finalizeRestoreStaging: (opts: {
    account_id?: string;
    handle: RestoreStagingHandle;
  }) => Promise<void>;

  releaseRestoreStaging: (opts: {
    account_id?: string;
    handle: RestoreStagingHandle;
    cleanupStaging?: boolean;
  }) => Promise<void>;

  cleanupRestoreStaging: (opts: {
    account_id?: string;
    project_id: string;
    root?: string;
  }) => Promise<void>;

  updateBackups: (opts: {
    account_id?: string;
    project_id: string;
    counts?: Partial<SnapshotCounts>;
  }) => Promise<void>;

  getProjectBackupSchedule: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectBackupSchedule>;

  getBackups: (opts: {
    account_id?: string;
    project_id: string;
    indexed_only?: boolean;
  }) => Promise<
    {
      id: string;
      time: Date;
      summary: { [key: string]: string | number };
    }[]
  >;

  getBackupFiles: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
    path?: string;
  }) => Promise<
    { name: string; isDir: boolean; mtime: number; size: number }[]
  >;

  findBackupFiles: (opts: {
    account_id?: string;
    project_id: string;
    glob?: string[];
    iglob?: string[];
    path?: string;
    ids?: string[];
  }) => Promise<BackupFindResult[]>;

  getBackupFileText: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;

  getBackupQuota: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<{ limit: number }>;

  /////////////
  // SNAPSHOTS
  /////////////

  createSnapshot: (opts: {
    account_id?: string;
    project_id: string;
    name?: string;
  }) => Promise<void>;

  restoreSnapshot: (opts: {
    account_id?: string;
    project_id: string;
    snapshot: string;
    mode?: SnapshotRestoreMode;
    safety_snapshot_name?: string;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  deleteSnapshot: (opts: {
    account_id?: string;
    project_id: string;
    name: string;
  }) => Promise<void>;

  updateSnapshots: (opts: {
    account_id?: string;
    project_id: string;
    counts?: Partial<SnapshotCounts>;
  }) => Promise<void>;

  getProjectSnapshotSchedule: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectSnapshotSchedule>;

  getSnapshotQuota: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<{ limit: number }>;

  allSnapshotUsage: (opts: { project_id: string }) => Promise<SnapshotUsage[]>;

  getSnapshotFileText: (opts: {
    account_id?: string;
    project_id: string;
    snapshot: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;

  /////////////
  // Project Control
  /////////////
  start: (opts: {
    account_id?: string;
    project_id: string;
    authorized_keys?: string;
    run_quota?: any;
    image?: string;
    restore?: "none" | "auto" | "required";
    lro_op_id?: string;
    // When false, enqueue start and return immediately; callers can watch
    // LRO/changefeed for progress.
    wait?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;
  stop: (opts: { account_id?: string; project_id: string }) => Promise<void>;
  deleteProject: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<void>;
  setProjectDeleted: (opts: {
    account_id?: string;
    project_id: string;
    deleted: boolean;
  }) => Promise<void>;
  updateAuthorizedKeysOnHost: (opts: {
    project_id: string;
    account_id?: string;
  }) => Promise<void>;
  hardDeleteProject: (opts: {
    account_id?: string;
    project_id: string;
    backup_retention_days?: number;
    purge_backups_now?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "account";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;
  setProjectHidden: (opts: {
    account_id?: string;
    project_id: string;
    hide: boolean;
  }) => Promise<void>;
  setProjectSshKey: (opts: {
    account_id?: string;
    project_id: string;
    fingerprint: string;
    title: string;
    value: string;
    creation_date?: number;
    last_use_date?: number;
  }) => Promise<void>;
  deleteProjectSshKey: (opts: {
    account_id?: string;
    project_id: string;
    fingerprint: string;
  }) => Promise<void>;

  // get a list if all public ssh authorized keys that apply to
  // the given project.
  // this is ALL global public keys for all collabs on the project,
  // along with all project specific keys. This is called by the project
  // on startup to configure itself.
  getSshKeys: (opts?: { project_id?: string }) => Promise<string[]>;

  moveProject: (opts: {
    account_id?: string;
    project_id: string;
    dest_host_id?: string;
    allow_offline?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  codexDeviceAuthStart: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<{
    id: string;
    accountId: string;
    state: "pending" | "completed" | "failed" | "canceled";
    verificationUrl?: string;
    userCode?: string;
    output: string;
    startedAt: number;
    updatedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
  }>;

  codexDeviceAuthStatus: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
  }) => Promise<{
    id: string;
    accountId: string;
    state: "pending" | "completed" | "failed" | "canceled";
    verificationUrl?: string;
    userCode?: string;
    output: string;
    startedAt: number;
    updatedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
  }>;

  codexDeviceAuthCancel: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
  }) => Promise<{ id: string; canceled: boolean }>;

  codexUploadAuthFile: (opts: {
    account_id?: string;
    project_id: string;
    filename?: string;
    content: string;
  }) => Promise<{ ok: true; codexHome: string; bytes: number }>;

  chatStoreStats: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
  }) => Promise<ChatStoreStats>;

  chatStoreRotate: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    keep_recent_messages?: number;
    max_head_bytes?: number;
    max_head_messages?: number;
    require_idle?: boolean;
    force?: boolean;
    dry_run?: boolean;
  }) => Promise<ChatStoreRotateResult>;

  chatStoreListSegments: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{ chat_id: string; segments: ChatStoreSegment[] }>;

  chatStoreReadArchived: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    before_date_ms?: number;
    thread_id?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    chat_id: string;
    rows: ChatStoreArchivedRow[];
    offset: number;
    next_offset?: number;
  }>;

  chatStoreReadArchivedHit: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    row_id?: number;
    message_id?: string;
    thread_id?: string;
  }) => Promise<{ chat_id: string; row?: ChatStoreArchivedRow }>;

  chatStoreSearch: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    query: string;
    db_path?: string;
    thread_id?: string;
    exclude_thread_ids?: string[];
    limit?: number;
    offset?: number;
  }) => Promise<{
    chat_id: string;
    hits: ChatStoreSearchHit[];
    offset: number;
    total_hits: number;
    next_offset?: number;
  }>;

  chatStoreDelete: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    scope: ChatStoreScope;
    before_date_ms?: number;
    thread_id?: string;
    message_ids?: string[];
  }) => Promise<ChatStoreDeleteResult>;

  chatStoreVacuum: (opts: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
  }) => Promise<{
    chat_id: string;
    db_path: string;
    before_bytes: number;
    after_bytes: number;
  }>;
}
