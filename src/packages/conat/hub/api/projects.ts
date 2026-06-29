import {
  authFirst,
  authFirstRequireAccount,
  authFirstRequireHost,
  authFirstRequireProject,
} from "./util";
import {
  type CourseInfo,
  type CreateProjectOptions,
  type ProjectTheme,
} from "@cocalc/util/db-schema/projects";
import { type SnapshotSchedule } from "@cocalc/util/consts/snapshots";
import { type CopyOptions } from "@cocalc/conat/files/fs";
import {
  type FileTextPreview,
  type SnapshotUsage,
  type RestoreMode,
  type RestoreStagingHandle,
  type SnapshotRestoreMode,
} from "@cocalc/conat/files/file-server";
import type { ProjectState } from "@cocalc/util/db-schema/projects";
import type {
  ProjectRootfsPublishLroRef,
  RootfsConfigExport,
} from "@cocalc/util/rootfs-images";
import type { CodexUsageStatusInfo } from "./system";
import type {
  ProjectUserRole,
  ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import type {
  ExecuteCodeOptions,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import type { LroStatus } from "./lro";
import type { ProjectSecretSshKeySetupResult } from "@cocalc/util/project-secrets";
import type {
  HostRootfsBuildCancelResponse,
  HostRootfsBuildLogResponse,
  HostRootfsBuildStartRequest,
  HostRootfsBuildStatusResponse,
} from "@cocalc/conat/project-host/api";

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

export interface ProjectCopyDestination {
  project_id: string;
  path: string;
  metadata?: {
    student_id?: string;
    course_item_id?: string;
    [key: string]: string | undefined;
  };
}

export interface ProjectCopySource {
  project_id: string;
  path: string | string[];
  base_path?: string;
}

export interface ProjectDirectorySummaryEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number | null;
  mtime?: string | null;
}

export interface ProjectDirectorySummary {
  project_id: string;
  root: string;
  max_depth: number;
  limit: number;
  truncated: boolean;
  entries: ProjectDirectorySummaryEntry[];
}

export interface CourseCollectAssignmentItem {
  student_id: string;
  student_project_id: string;
  src_path: string;
  dest_path: string;
  student_account_id?: string;
  student_name?: string;
  assignment_title?: string;
}

export interface CourseCollectAssignmentResult {
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}

export interface CourseAssignmentPatchDestination {
  student_id: string;
  student_project_id: string;
}

export type CourseAssignmentPatchResult = CourseCollectAssignmentResult;

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

export interface ProjectHiddenResult {
  project_id: string;
  success: boolean;
  error?: string;
}

export interface ProjectRuntimeSponsorActiveProject {
  project_id: string;
  title?: string;
  state: "starting" | "running";
  visible: boolean;
  can_stop: boolean;
}

export interface ProjectRuntimeSponsorStatus {
  sponsor_account_id: string;
  sponsor_display_name?: string;
  limit?: number | null;
  current: number;
  active_projects: ProjectRuntimeSponsorActiveProject[];
  allow_collaborator_starts_using_sponsor: boolean;
  autostart_enabled: boolean;
}

export interface AccountRuntimeSponsorStatus {
  sponsor_account_id: string;
  sponsor_display_name?: string;
  limit?: number | null;
  current: number;
  active_projects: ProjectRuntimeSponsorActiveProject[];
  can_upgrade: boolean;
  can_change_sponsor: false;
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

export type ProjectCourseInfo = CourseInfo | null;
export type CourseStudentAccessStatus =
  | { status: "not-required"; course?: ProjectCourseInfo }
  | {
      status: "active";
      source:
        | "membership"
        | "course-seat"
        | "student-course-purchase"
        | "site-license";
      required_membership_class: string;
      required_label?: string;
      current_membership_class: string;
      current_expires?: Date | string | null;
      course?: ProjectCourseInfo;
    }
  | {
      status: "site-license-claimable";
      required_membership_class: string;
      required_label?: string;
      package_id: string;
      membership_class: string;
      matched_email_address: string;
      expires_at?: Date | string | null;
      course?: ProjectCourseInfo;
    }
  | {
      status: "grace";
      required_membership_class: string;
      required_label?: string;
      deadline: Date | string;
      course?: ProjectCourseInfo;
    }
  | {
      status: "blocked";
      required_membership_class: string;
      required_label?: string;
      deadline?: Date | string | null;
      course?: ProjectCourseInfo;
    };

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

export interface ProjectAddress {
  host: string;
  port: number;
  secret_token: string;
}

export interface ProjectActiveOperationSummary {
  project_id: string;
  op_id: string | null;
  kind: string;
  action: "start" | "restart" | "stop";
  status: LroStatus;
  started_by_account_id: string | null;
  source_bay_id: string | null;
  phase: string | null;
  message: string | null;
  progress: number | null;
  detail: any;
  started_at: Date;
  updated_at: Date;
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
export type ProjectCollabInviteSource = "account" | "email" | "course_email";
export type ProjectInviteEmailBlockedReason =
  | "email_not_configured"
  | "tier_disallows_email"
  | "cooldown"
  | "send_disabled_by_request";

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
  invite_source?: ProjectCollabInviteSource | null;
  accepted_account_id?: string | null;
  target_email?: string | null;
  token_hint?: string | null;
  last_sent?: Date | null;
  resend_count?: number | null;
  scope?: string | null;
  context?: Record<string, unknown> | null;
  invite_role?: Exclude<ProjectUserRole, "owner"> | null;
  read_policy?: ProjectViewerReadPolicy | null;
  invite_url?: string | null;
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

export interface CourseStudentInviteAccountRepairInput {
  student_id: string;
  student_project_id: string;
}

export interface CourseStudentInviteAccountRepairRow extends CourseStudentInviteAccountRepairInput {
  accepted_account_id: string;
  invite_id: string;
}

export interface CourseManagerAccessResult {
  project_id: string;
  added_account_ids: string[];
  error?: string;
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

export type ProjectAccessRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "blocked"
  | "canceled";

export type ProjectAccessRequestAction =
  | "approve"
  | "deny"
  | "block"
  | "cancel";

export type ProjectAccessRequestSource =
  | "project-url"
  | "viewer-read-only"
  | "rail-menu"
  | "api";

export interface ProjectAccessRequester {
  account_id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  profile?: Record<string, any> | null;
}

export interface ProjectAccessRequestRow {
  request_id: string;
  project_id: string;
  project_title?: string | null;
  requester_account_id: string;
  requester_name?: string | null;
  requester_first_name?: string | null;
  requester_last_name?: string | null;
  requester_profile?: Record<string, any> | null;
  requested_role: Exclude<ProjectUserRole, "owner">;
  read_policy?: ProjectViewerReadPolicy | null;
  message?: string | null;
  status: ProjectAccessRequestStatus;
  source: ProjectAccessRequestSource | string;
  created: Date;
  updated: Date;
  decided?: Date | null;
  decided_by_account_id?: string | null;
  decision_message?: string | null;
}

export interface ProjectAccessRequestBlockRow {
  project_id: string;
  blocker_account_id: string;
  blocker_name?: string | null;
  blocked_account_id: string;
  blocked_name?: string | null;
  blocked_first_name?: string | null;
  blocked_last_name?: string | null;
  blocked_profile?: Record<string, any> | null;
  created: Date;
  updated: Date;
}

export interface ProjectAccessLandingInfo {
  project_id: string;
  title: string | null;
  owner?: {
    account_id: string;
    name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    profile?: Record<string, any> | null;
  };
  relationship: "none" | "viewer" | "collaborator" | "owner" | "admin";
  pending_invite?: {
    invite_id: string;
    invite_role: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
  } | null;
  pending_request?: {
    request_id: string;
    requested_role: Exclude<ProjectUserRole, "owner">;
    status: "pending";
  } | null;
  blocked?: boolean;
}

export interface ProjectCollaboratorInviteUsage {
  current: number;
  limit: number | null;
  remaining: number | null;
}

export interface ProjectCollaboratorRow {
  account_id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email_address?: string | null;
  last_active?: Date | null;
  group: ProjectUserRole;
  read_policy?: ProjectViewerReadPolicy | null;
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
  account_id: string | null;
  time: Date | null;
  event: Record<string, any> | string | null;
}

export interface ProjectLogPage {
  entries: ProjectLogRow[];
  has_more: boolean;
}

export const PROJECT_LOG_STREAM_NAME = "project-log";

export type ProjectRehomeOperationStage =
  | "requested"
  | "destination_accepted"
  | "source_flipped"
  | "portable_state_copied"
  | "projected"
  | "complete";

export type ProjectRehomeOperationStatus = "running" | "succeeded" | "failed";

export interface ProjectRehomeOperationSummary {
  op_id: string;
  project_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by: string | null;
  reason: string | null;
  campaign_id: string | null;
  status: ProjectRehomeOperationStatus;
  stage: ProjectRehomeOperationStage;
  attempt: number;
  last_error: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  finished_at?: Date | string | null;
}

export interface ProjectRehomeResponse {
  op_id?: string;
  project_id: string;
  previous_bay_id: string;
  owning_bay_id: string;
  operation_stage?: ProjectRehomeOperationStage;
  operation_status?: ProjectRehomeOperationStatus;
  status: "rehomed" | "already-home";
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

export type ProjectRegion = string | null;
export type ProjectCreated = Date | string | null;
export type ProjectEnv = Record<string, string> | null;
export type AccountProjectListWindowSort = "last_edited" | "title" | "state";
export interface AccountProjectListWindowRow {
  project_id: string;
  title: string;
  description: string;
  theme: Record<string, any> | null;
  labels: Record<string, string>;
  host_id: string | null;
  rootfs_image_id: string | null;
  owning_bay_id: string;
  is_hidden: boolean;
  deletion_protection: boolean;
  state_summary: Record<string, any>;
  users_summary: Record<string, any>;
  last_activity_at: Date | string | null;
  last_edited: Date | string | null;
  last_backup: Date | string | null;
  sort_key: Date | string | null;
  updated_at: Date | string | null;
}
export interface ProjectSecretMetadata {
  project_id: string;
  name: string;
  value_bytes: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
export interface CopyProjectSecretsResult {
  copied: string[];
  conflicts: string[];
  missing: string[];
}
export interface GenerateProjectSshKeySecretResult {
  secret: ProjectSecretMetadata;
  secret_name: string;
  public_key: string;
  setup:
    | (ProjectSecretSshKeySetupResult & { ok: true })
    | (ProjectSecretSshKeySetupResult & {
        ok: false;
        error: string;
      });
  restart_required: boolean;
}
export interface ProjectRootfsConfig {
  image: string;
  image_id?: string | null;
}
export interface ProjectRootfsPublishConfig {
  kind: "cocalc-project-rootfs-publish-config";
  version: 1;
  updated_at: Date | string;
  recipe?: {
    name?: string;
    recipe_path?: string;
  };
  config: RootfsConfigExport;
}
export type ProjectRootfsBuildStatusResponse = HostRootfsBuildStatusResponse & {
  host_id: string;
  op_id?: string | null;
  publish_op_id?: string | null;
  publish_status?: string | null;
  publish_image_id?: string | null;
  publish_error?: string | null;
  publish_started_at?: string;
  publish_finished_at?: string;
};
export type ProjectRootfsBuildLogResponse = HostRootfsBuildLogResponse & {
  host_id: string;
};
export type ProjectRootfsBuildCancelResponse = HostRootfsBuildCancelResponse & {
  host_id: string;
  op_id?: string | null;
};
export type ProjectRootfsBuildStartRequest = Omit<
  HostRootfsBuildStartRequest,
  "project_id"
> & {
  account_id?: string;
  project_id: string;
};
export interface ProjectRootfsBuildStatusRequest {
  account_id?: string;
  project_id: string;
  build_id: string;
}
export interface ProjectRootfsBuildLogRequest extends ProjectRootfsBuildStatusRequest {
  lines?: number;
  byte_offset?: number;
  max_bytes?: number;
}
export type ProjectRootfsBuildCancelRequest = ProjectRootfsBuildStatusRequest;
export type ProjectRootfsBuildRecord = Omit<
  ProjectRootfsBuildStatusResponse,
  "paths"
> & {
  paths?: HostRootfsBuildStatusResponse["paths"];
  account_id?: string | null;
  publish_op_id?: string | null;
  publish_status?: string | null;
  publish_image_id?: string | null;
  publish_error?: string | null;
  publish_started_at?: string;
  publish_finished_at?: string;
  updated?: string;
};
export interface ProjectRootfsBuildListRequest {
  account_id?: string;
  project_id: string;
  limit?: number;
}
export interface ProjectRootfsBuildPublishRecordRequest {
  account_id?: string;
  project_id: string;
  build_id: string;
  publish_op_id: string;
}
export interface ProjectRootfsBuildPublishRecordResponse {
  build: ProjectRootfsBuildRecord;
  publish: ProjectRootfsPublishLroRef;
}
export type ProjectSnapshotSchedule = SnapshotSchedule | null;
export type ProjectBackupSchedule = SnapshotSchedule | null;
export type ProjectRunQuota = Record<string, any> | null;
export type ProjectLabels = Record<string, string>;
export type ProjectLabelPatch = Record<string, string | null | undefined>;
export interface ProjectMetadataPatch {
  title?: string;
  description?: string;
  theme?: ProjectTheme | null;
}

export const projects = {
  createProject: authFirstRequireAccount,
  copyPathBetweenProjects: authFirstRequireAccount,
  collectAssignment: authFirstRequireAccount,
  sendCourseAssignmentPatch: authFirstRequireAccount,
  inspectPublicPath: authFirstRequireAccount,
  importPublicUrl: authFirstRequireAccount,
  importPublicPath: authFirstRequireAccount,
  listPendingCopies: authFirstRequireAccount,
  listCopyRowsByOpId: authFirstRequireAccount,
  cancelPendingCopy: authFirstRequireAccount,
  removeCollaborator: authFirstRequireAccount,
  setProjectUserRole: authFirstRequireAccount,
  addCollaborator: authFirstRequireAccount,
  createCollabInvite: authFirstRequireAccount,
  listCollabInvites: authFirstRequireAccount,
  repairAcceptedCourseStudentInviteAccounts: authFirstRequireAccount,
  ensureCourseManagerAccess: authFirstRequireAccount,
  respondCollabInvite: authFirstRequireAccount,
  getProjectAccessLandingInfo: authFirstRequireAccount,
  requestProjectAccess: authFirstRequireAccount,
  listProjectAccessRequests: authFirstRequireAccount,
  respondProjectAccessRequest: authFirstRequireAccount,
  listProjectAccessRequestBlocks: authFirstRequireAccount,
  unblockProjectAccessRequester: authFirstRequireAccount,
  listCollabInviteBlocks: authFirstRequireAccount,
  unblockCollabInviteSender: authFirstRequireAccount,
  listCollaborators: authFirstRequireAccount,
  getProjectCollaboratorInviteUsage: authFirstRequireAccount,
  listMyCollaborators: authFirstRequireAccount,
  listAccountProjectWindow: authFirstRequireAccount,
  getProjectRegion: authFirstRequireAccount,
  getProjectCreated: authFirstRequireAccount,
  getProjectEnv: authFirstRequireAccount,
  getAdminProjectDirectorySummary: authFirstRequireAccount,
  setProjectEnv: authFirstRequireAccount,
  setProjectMetadata: authFirstRequireAccount,
  setProjectManageUsersOwnerOnly: authFirstRequireAccount,
  listProjectSecrets: authFirstRequireAccount,
  setProjectSecret: authFirstRequireAccount,
  deleteProjectSecret: authFirstRequireAccount,
  copyProjectSecrets: authFirstRequireAccount,
  generateProjectSshKeySecret: authFirstRequireAccount,
  getProjectRootfs: authFirstRequireAccount,
  getProjectRootfsPublishConfig: authFirstRequireAccount,
  setProjectRootfsPublishConfig: authFirstRequireAccount,
  getProjectLabels: authFirstRequireAccount,
  setProjectLabels: authFirstRequireAccount,
  startProjectRootfsBuild: authFirstRequireAccount,
  getProjectRootfsBuildStatus: authFirstRequireAccount,
  getProjectRootfsBuildLog: authFirstRequireAccount,
  listProjectRootfsBuilds: authFirstRequireAccount,
  recordProjectRootfsBuildPublish: authFirstRequireAccount,
  cancelProjectRootfsBuild: authFirstRequireAccount,
  getProjectCourseInfo: authFirstRequireAccount,
  getProjectRuntimeSponsorStatus: authFirstRequireAccount,
  getAccountRuntimeSponsorStatus: authFirstRequireAccount,
  getCourseStudentAccess: authFirstRequireAccount,
  getProjectSnapshotSchedule: authFirstRequireAccount,
  getProjectBackupSchedule: authFirstRequireAccount,
  getProjectRunQuota: authFirstRequireAccount,
  setProjectDeletionProtection: authFirstRequireAccount,
  inviteCollaborator: authFirstRequireAccount,
  inviteCollaboratorWithoutAccount: authFirstRequireAccount,
  copyEmailProjectInviteLink: authFirstRequireAccount,
  redeemEmailProjectInvite: authFirstRequireAccount,
  previewEmailProjectInvite: authFirst,
  respondEmailProjectInvite: authFirstRequireAccount,

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
  getBackups: authFirstRequireAccount,
  getBackupFiles: authFirstRequireAccount,
  findBackupFiles: authFirstRequireAccount,
  getBackupFileText: authFirstRequireAccount,
  getBackupQuota: authFirstRequireAccount,

  createSnapshot: authFirstRequireAccount,
  deleteSnapshot: authFirstRequireAccount,
  pruneSnapshotPath: authFirstRequireAccount,
  restoreSnapshot: authFirstRequireAccount,
  getSnapshotQuota: authFirstRequireAccount,
  allSnapshotUsage: authFirstRequireAccount,
  getSnapshotFileText: authFirstRequireAccount,

  start: authFirstRequireAccount,
  startFromHost: authFirstRequireHost,
  stop: authFirstRequireAccount,
  restart: authFirstRequireAccount,
  archiveProject: authFirstRequireAccount,
  getProjectState: authFirstRequireAccount,
  getProjectAddress: authFirstRequireAccount,
  ensureProjectScratchVolume: authFirstRequireAccount,
  getProjectActiveOperation: authFirstRequireAccount,
  updateAuthorizedKeysOnHost: authFirstRequireAccount,
  hardDeleteProject: authFirstRequireAccount,
  leaveOrDeleteProjects: authFirstRequireAccount,
  setProjectHidden: authFirstRequireAccount,
  setProjectsHidden: authFirstRequireAccount,
  setProjectSshKey: authFirstRequireAccount,
  deleteProjectSshKey: authFirstRequireAccount,

  getSshKeys: authFirstRequireProject,

  moveProject: authFirstRequireAccount,
  assignProjectHost: authFirstRequireAccount,
  rehomeProject: authFirstRequireAccount,
  getProjectRehomeOperation: authFirstRequireAccount,
  reconcileProjectRehome: authFirstRequireAccount,
  drainProjectRehome: authFirstRequireAccount,
  codexDeviceAuthStart: authFirstRequireAccount,
  codexDeviceAuthStatus: authFirstRequireAccount,
  codexDeviceAuthCancel: authFirstRequireAccount,
  codexUploadAuthFile: authFirstRequireAccount,
  getCodexUsageStatus: authFirstRequireAccount,
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
    }
  | { project_id: string[]; account_id: string[] }; // for adding more than one at once

export interface Projects {
  // request to have conat permissions to project subjects.
  createProject: (opts: CreateProjectOptions) => Promise<string>;

  copyPathBetweenProjects: (opts: {
    src: ProjectCopySource;
    src_home?: string;
    dest?: ProjectCopyDestination;
    dests?: ProjectCopyDestination[];
    options?: CopyOptions;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;

  collectAssignment: (opts: {
    account_id?: string;
    course_project_id: string;
    assignment_id: string;
    items: CourseCollectAssignmentItem[];
    options?: CopyOptions;
    run_at?: string;
  }) => Promise<CourseCollectAssignmentResult>;

  sendCourseAssignmentPatch: (opts: {
    account_id?: string;
    course_project_id: string;
    assignment_id: string;
    src_base_path: string;
    dest_base_path: string;
    relative_paths: string[];
    dests: CourseAssignmentPatchDestination[];
    options?: CopyOptions;
  }) => Promise<CourseAssignmentPatchResult>;

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

  listCopyRowsByOpId: (opts: {
    account_id?: string;
    op_id: string;
  }) => Promise<ProjectCopyRow[]>;

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

  setProjectMetadata: (opts: {
    account_id?: string;
    project_id: string;
    patch: ProjectMetadataPatch;
  }) => Promise<void>;

  setProjectManageUsersOwnerOnly: (opts: {
    account_id?: string;
    project_id: string;
    manage_users_owner_only: boolean;
  }) => Promise<void>;

  listProjectSecrets: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectSecretMetadata[]>;

  setProjectSecret: (opts: {
    account_id?: string;
    project_id: string;
    name: string;
    value: string;
  }) => Promise<ProjectSecretMetadata>;

  deleteProjectSecret: (opts: {
    account_id?: string;
    project_id: string;
    name: string;
  }) => Promise<{ deleted: boolean }>;

  copyProjectSecrets: (opts: {
    account_id?: string;
    source_project_id: string;
    target_project_id: string;
    names?: string[];
    overwrite?: boolean;
  }) => Promise<CopyProjectSecretsResult>;

  generateProjectSshKeySecret: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    secret_name?: string;
  }) => Promise<GenerateProjectSshKeySecretResult>;

  getProjectRootfs: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRootfsConfig | null>;

  getAdminProjectDirectorySummary: (opts: {
    account_id?: string;
    project_id: string;
    path?: string;
    max_depth?: number;
    limit?: number;
  }) => Promise<ProjectDirectorySummary>;

  getProjectRootfsPublishConfig: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRootfsPublishConfig | null>;

  setProjectRootfsPublishConfig: (opts: {
    account_id?: string;
    project_id: string;
    config: ProjectRootfsPublishConfig | null;
  }) => Promise<void>;

  getProjectLabels: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectLabels>;

  setProjectLabels: (opts: {
    account_id?: string;
    project_id: string;
    labels: ProjectLabelPatch;
  }) => Promise<ProjectLabels>;

  startProjectRootfsBuild: (
    opts: ProjectRootfsBuildStartRequest,
  ) => Promise<ProjectRootfsBuildStatusResponse>;

  getProjectRootfsBuildStatus: (
    opts: ProjectRootfsBuildStatusRequest,
  ) => Promise<ProjectRootfsBuildStatusResponse>;

  getProjectRootfsBuildLog: (
    opts: ProjectRootfsBuildLogRequest,
  ) => Promise<ProjectRootfsBuildLogResponse>;

  listProjectRootfsBuilds: (
    opts: ProjectRootfsBuildListRequest,
  ) => Promise<ProjectRootfsBuildRecord[]>;

  recordProjectRootfsBuildPublish: (
    opts: ProjectRootfsBuildPublishRecordRequest,
  ) => Promise<ProjectRootfsBuildPublishRecordResponse>;

  cancelProjectRootfsBuild: (
    opts: ProjectRootfsBuildCancelRequest,
  ) => Promise<ProjectRootfsBuildCancelResponse>;

  getProjectCourseInfo: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectCourseInfo>;

  getProjectRuntimeSponsorStatus: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectRuntimeSponsorStatus>;

  getAccountRuntimeSponsorStatus: (opts: {
    account_id?: string;
  }) => Promise<AccountRuntimeSponsorStatus>;

  getCourseStudentAccess: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<CourseStudentAccessStatus>;

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

  setProjectUserRole: ({
    account_id,
    opts,
  }: {
    account_id?: string;
    opts: {
      project_id: string;
      target_account_id: string;
      role: Exclude<ProjectUserRole, "owner">;
      read_policy?: ProjectViewerReadPolicy | null;
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
    projectWide?: boolean;
  }) => Promise<ProjectCollabInviteRow[]>;

  repairAcceptedCourseStudentInviteAccounts: (opts: {
    account_id?: string;
    course_project_id: string;
    students: CourseStudentInviteAccountRepairInput[];
  }) => Promise<CourseStudentInviteAccountRepairRow[]>;

  ensureCourseManagerAccess: (opts: {
    account_id?: string;
    course_project_id: string;
    course_path?: string;
    project_ids: string[];
  }) => Promise<CourseManagerAccessResult[]>;

  respondCollabInvite: (opts: {
    account_id?: string;
    invite_id: string;
    project_id?: string;
    action: ProjectCollabInviteAction;
  }) => Promise<ProjectCollabInviteRow>;

  getProjectAccessLandingInfo: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectAccessLandingInfo>;

  requestProjectAccess: (opts: {
    account_id?: string;
    project_id: string;
    requested_role: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
    message?: string;
    source?: ProjectAccessRequestSource | string;
  }) => Promise<ProjectAccessRequestRow>;

  listProjectAccessRequests: (opts: {
    account_id?: string;
    project_id: string;
    status?: ProjectAccessRequestStatus;
    limit?: number;
  }) => Promise<ProjectAccessRequestRow[]>;

  respondProjectAccessRequest: (opts: {
    account_id?: string;
    project_id: string;
    request_id: string;
    action: ProjectAccessRequestAction;
    role?: Exclude<ProjectUserRole, "owner">;
    read_policy?: ProjectViewerReadPolicy | null;
    message?: string;
  }) => Promise<ProjectAccessRequestRow>;

  listProjectAccessRequestBlocks: (opts: {
    account_id?: string;
    project_id: string;
    limit?: number;
  }) => Promise<ProjectAccessRequestBlockRow[]>;

  unblockProjectAccessRequester: (opts: {
    account_id?: string;
    project_id: string;
    blocked_account_id: string;
  }) => Promise<{
    unblocked: boolean;
    project_id: string;
    blocked_account_id: string;
  }>;

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

  getProjectCollaboratorInviteUsage: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectCollaboratorInviteUsage>;

  listMyCollaborators: (opts: {
    account_id?: string;
    limit?: number;
  }) => Promise<MyCollaboratorRow[]>;

  listAccountProjectWindow: (opts: {
    account_id?: string;
    limit?: number;
    offset?: number;
    hidden?: boolean;
    search?: string;
    sort?: AccountProjectListWindowSort;
  }) => Promise<AccountProjectListWindowRow[]>;

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
      invite_role?: Exclude<ProjectUserRole, "owner">;
      read_policy?: ProjectViewerReadPolicy | null;
    };
  }) => Promise<{
    email_sent: boolean;
    email_available: boolean;
    manual_delivery_required: boolean;
    email_blocked_reason?: ProjectInviteEmailBlockedReason | null;
    in_app_notification_sent: boolean;
  }>;

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
      send_email?: boolean;
      invite_context?: Record<string, unknown>;
      invite_scope?: string;
      invite_role?: Exclude<ProjectUserRole, "owner">;
      invite_base_url?: string;
      read_policy?: ProjectViewerReadPolicy | null;
    };
  }) => Promise<{
    invites: ProjectCollabInviteRow[];
    email_sent: boolean;
    email_available: boolean;
    manual_delivery_required: boolean;
    email_blocked_reason?: ProjectInviteEmailBlockedReason | null;
  }>;

  copyEmailProjectInviteLink: (opts: {
    account_id?: string;
    invite_id: string;
    project_id?: string;
    invite_base_url?: string;
  }) => Promise<{
    invite_id: string;
    invite_url: string;
    expires?: Date | null;
  }>;

  redeemEmailProjectInvite: (opts: {
    account_id?: string;
    invite_id?: string;
    token: string;
    project_id?: string;
  }) => Promise<ProjectCollabInviteRow>;

  previewEmailProjectInvite: (opts: {
    account_id?: string;
    invite_id?: string;
    token: string;
    project_id?: string;
  }) => Promise<ProjectCollabInviteRow>;

  respondEmailProjectInvite: (opts: {
    account_id?: string;
    action: ProjectCollabInviteAction;
    invite_id?: string;
    token: string;
    project_id?: string;
  }) => Promise<ProjectCollabInviteRow>;

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
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    id: string;
  }) => Promise<void>;

  restoreBackup: (opts: {
    account_id?: string;
    session_hash?: string | null;
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
    session_hash?: string | null;
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
    browser_id?: string | null;
    session_hash?: string | null;
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
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    name: string;
  }) => Promise<void>;

  pruneSnapshotPath: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    path: string;
    snapshots?: string[];
    timeout?: number;
  }) => Promise<{ path: string; snapshots: string[] }>;

  getProjectSnapshotSchedule: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectSnapshotSchedule>;

  getSnapshotQuota: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<{
    limit: number;
    manual?: {
      limit: number;
      current: number;
      rolling_reserved: number;
    };
  }>;

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
    restore_backup_id?: string;
    lro_op_id?: string;
    autostart?: boolean;
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
  startFromHost: (opts: {
    host_id?: string;
    account_id: string;
    project_id: string;
    autostart?: boolean;
    wait?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;
  stop: (opts: { account_id?: string; project_id: string }) => Promise<void>;
  status?: (opts: { account_id?: string; project_id: string }) => Promise<{
    state?: string;
    http_port?: number;
    ssh_port?: number;
    project_bundle_version?: string;
    tools_version?: string;
    phase_timings_ms?: Record<string, number>;
  }>;
  restart: (opts: {
    account_id?: string;
    project_id: string;
    wait?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;
  archiveProject: (opts: {
    account_id?: string;
    project_id: string;
    timeout?: number;
  }) => Promise<void>;
  getProjectState: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectState>;
  getProjectAddress: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectAddress>;
  ensureProjectScratchVolume: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<void>;
  getProjectActiveOperation: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<ProjectActiveOperationSummary | null>;
  updateAuthorizedKeysOnHost: (opts: {
    project_id: string;
    account_id?: string;
  }) => Promise<void>;
  hardDeleteProject: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
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
  setProjectDeletionProtection: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    enabled: boolean;
  }) => Promise<{ project_id: string; deletion_protection: boolean }>;
  leaveOrDeleteProjects: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_ids: string[];
  }) => Promise<
    {
      project_id: string;
      action:
        | "removed_self"
        | "transferred"
        | "hard_deleted"
        | "hard_delete_queued"
        | "error";
      new_owner_account_id?: string;
      op_id?: string;
      error?: string;
    }[]
  >;
  setProjectHidden: (opts: {
    account_id?: string;
    project_id: string;
    hide: boolean;
  }) => Promise<void>;
  setProjectsHidden: (opts: {
    account_id?: string;
    project_ids: string[];
    hide: boolean;
  }) => Promise<ProjectHiddenResult[]>;
  setProjectSshKey: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    fingerprint: string;
    title: string;
    value: string;
    creation_date?: number;
    last_use_date?: number;
  }) => Promise<void>;
  deleteProjectSshKey: (opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
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
    browser_id?: string | null;
    session_hash?: string | null;
    project_id: string;
    dest_host_id?: string;
    allow_offline?: boolean;
    backup_region_cutover?: boolean;
  }) => Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }>;
  assignProjectHost: (opts: {
    account_id?: string;
    project_id: string;
    dest_host_id: string;
  }) => Promise<void>;

  rehomeProject: (opts: {
    account_id?: string;
    session_hash?: string | null;
    project_id: string;
    dest_bay_id: string;
    reason?: string | null;
    campaign_id?: string | null;
  }) => Promise<ProjectRehomeResponse>;

  getProjectRehomeOperation: (opts: {
    account_id?: string;
    op_id: string;
  }) => Promise<ProjectRehomeOperationSummary | null>;

  reconcileProjectRehome: (opts: {
    account_id?: string;
    session_hash?: string | null;
    op_id: string;
  }) => Promise<ProjectRehomeResponse>;

  drainProjectRehome: (opts: {
    account_id?: string;
    session_hash?: string | null;
    source_bay_id?: string;
    dest_bay_id: string;
    limit?: number;
    dry_run?: boolean;
    campaign_id?: string | null;
    reason?: string | null;
  }) => Promise<{
    source_bay_id: string;
    dest_bay_id: string;
    dry_run: boolean;
    limit: number;
    campaign_id: string | null;
    candidate_count: number;
    candidates: string[];
    side_table_preflight: {
      portable_tables: string[];
      ignored_tables: string[];
      non_portable_tables: Array<{
        table: string;
        status: string;
        reason: string;
      }>;
      summary: string;
    };
    rehomed: ProjectRehomeResponse[];
    errors: Array<{ project_id: string; error: string }>;
  }>;

  codexDeviceAuthStart: (opts: {
    account_id?: string;
    project_id: string;
  }) => Promise<{
    id: string;
    accountId: string;
    state: "pending" | "syncing" | "completed" | "failed" | "canceled";
    verificationUrl?: string;
    userCode?: string;
    output: string;
    startedAt: number;
    updatedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    syncedToRegistry?: boolean;
    syncError?: string;
  }>;

  codexDeviceAuthStatus: (opts: {
    account_id?: string;
    project_id: string;
    id: string;
  }) => Promise<{
    id: string;
    accountId: string;
    state: "pending" | "syncing" | "completed" | "failed" | "canceled";
    verificationUrl?: string;
    userCode?: string;
    output: string;
    startedAt: number;
    updatedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    error?: string;
    syncedToRegistry?: boolean;
    syncError?: string;
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

  getCodexUsageStatus: (opts: {
    account_id?: string;
    project_id: string;
    timeout?: number;
  }) => Promise<CodexUsageStatusInfo>;

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
