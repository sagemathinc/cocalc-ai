import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { ConatService } from "@cocalc/conat/service/typed";
import type {
  CreateProjectOptions,
  ProjectState,
} from "@cocalc/util/db-schema/projects";
import type { SnapshotSchedule } from "@cocalc/util/consts/snapshots";

export interface HostCreateProjectRequest extends CreateProjectOptions {
  project_id?: string;
  start?: boolean;
  users?: any;
  authorized_keys?: string;
  run_quota?: any;
}

export interface HostCreateProjectResponse {
  project_id: string;
  state?: ProjectState | string;
  phase_timings_ms?: Record<string, number>;
}

export interface HostRuntimeLogResponse {
  source: string;
  lines: number;
  text: string;
}

export interface HostProjectRuntimeLogResponse {
  project_id: string;
  container: string;
  lines: number;
  text: string;
  found: boolean;
  running: boolean;
}

export interface HostRootfsCacheEntry {
  image: string;
  cache_path: string;
  inspect_path?: string;
  digest?: string;
  size_bytes?: number;
  cached_at?: string;
  project_count: number;
  running_project_count: number;
  project_ids: string[];
  running_project_ids: string[];
}

export interface HostRootfsManifest {
  format: "rootfs-manifest-v1";
  source_kind: "project-rootfs" | "cached-image";
  image?: string;
  inspect_path?: string;
  project_id?: string;
  root_path: string;
  generated_at: string;
  manifest_sha256: string;
  hardlink_sha256: string;
  entry_count: number;
  regular_file_count: number;
  directory_count: number;
  symlink_count: number;
  other_count: number;
  hardlink_group_count: number;
  hardlink_member_count: number;
  total_regular_bytes: number;
}

export interface HostSshAuthorizedKeysResponse {
  user: string;
  home: string;
  path: string;
  keys: string[];
}

export interface HostBackupExecutionStatus {
  max_parallel: number;
  in_flight: number;
  queued: number;
  project_lock_count: number;
  config_source?: "env-legacy" | "db-override";
}

export type ManagedComponentKind =
  | "project-host"
  | "conat-router"
  | "conat-persist"
  | "acp-worker";

export type ManagedComponentArtifact = "project-host";

export type ManagedComponentUpgradePolicy =
  | "restart_now"
  | "drain_then_replace";

export type ManagedComponentRuntimeState =
  | "running"
  | "stopped"
  | "disabled"
  | "unknown";

export type ManagedComponentVersionState =
  | "aligned"
  | "drifted"
  | "mixed"
  | "unknown";

export interface HostManagedComponentStatus {
  component: ManagedComponentKind;
  artifact: ManagedComponentArtifact;
  upgrade_policy: ManagedComponentUpgradePolicy;
  enabled: boolean;
  managed: boolean;
  desired_version?: string;
  runtime_state: ManagedComponentRuntimeState;
  version_state: ManagedComponentVersionState;
  running_versions: string[];
  running_pids: number[];
}

export type HostManagedComponentRolloutAction =
  | "restart_scheduled"
  | "restarted"
  | "drain_requested"
  | "spawned"
  | "noop";

// Rollout acts on the software already installed on the host. It does not
// download or publish a new bundle; use host software upgrade first when
// changing versions.
export interface HostManagedComponentRolloutRequest {
  components: ManagedComponentKind[];
  reason?: string;
}

export interface HostManagedComponentRolloutResult {
  component: ManagedComponentKind;
  action: HostManagedComponentRolloutAction;
  message?: string;
}

export interface HostManagedComponentRolloutResponse {
  results: HostManagedComponentRolloutResult[];
}

export interface HostStaticAppPathInspection {
  project_id: string;
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

export interface HostControlApi {
  createProject: (
    opts: HostCreateProjectRequest,
  ) => Promise<HostCreateProjectResponse>;
  startProject: (opts: {
    project_id: string;
    authorized_keys?: string;
    run_quota?: any;
    image?: string;
    restore?: "none" | "auto" | "required";
    lro_op_id?: string;
  }) => Promise<HostCreateProjectResponse>;
  stopProject: (opts: {
    project_id: string;
  }) => Promise<HostCreateProjectResponse>;
  updateAuthorizedKeys: (opts: {
    project_id: string;
    authorized_keys?: string;
  }) => Promise<void>;
  updateProjectUsers: (opts: {
    project_id: string;
    users?: any;
  }) => Promise<void>;
  applyPendingCopies: (opts: {
    project_id?: string;
    limit?: number;
  }) => Promise<{ claimed: number }>;
  deleteProjectData: (opts: { project_id: string }) => Promise<void>;
  upgradeSoftware: (
    opts: UpgradeSoftwareRequest,
  ) => Promise<UpgradeSoftwareResponse>;
  growBtrfs: (opts: { disk_gb?: number }) => Promise<{ ok: boolean }>;
  getRuntimeLog: (opts: { lines?: number }) => Promise<HostRuntimeLogResponse>;
  getProjectRuntimeLog: (opts: {
    project_id: string;
    lines?: number;
  }) => Promise<HostProjectRuntimeLogResponse>;
  listRootfsImages: () => Promise<HostRootfsCacheEntry[]>;
  pullRootfsImage: (opts: { image: string }) => Promise<HostRootfsCacheEntry>;
  deleteRootfsImage: (opts: { image: string }) => Promise<{ removed: boolean }>;
  listHostSshAuthorizedKeys: () => Promise<HostSshAuthorizedKeysResponse>;
  addHostSshAuthorizedKey: (opts: {
    public_key: string;
  }) => Promise<HostSshAuthorizedKeysResponse & { added: boolean }>;
  removeHostSshAuthorizedKey: (opts: {
    public_key: string;
  }) => Promise<HostSshAuthorizedKeysResponse & { removed: boolean }>;
  getBackupExecutionStatus: () => Promise<HostBackupExecutionStatus>;
  getManagedComponentStatus: () => Promise<HostManagedComponentStatus[]>;
  rolloutManagedComponents: (
    opts: HostManagedComponentRolloutRequest,
  ) => Promise<HostManagedComponentRolloutResponse>;
  inspectStaticAppPath: (opts: {
    project_id: string;
    url: string;
  }) => Promise<HostStaticAppPathInspection>;
  buildRootfsImageManifest: (opts: {
    image: string;
  }) => Promise<HostRootfsManifest>;
  buildProjectRootfsManifest: (opts: {
    project_id: string;
  }) => Promise<HostRootfsManifest>;
  // Later: updateProject to adjust title/users/etc.
}

function subjectForHost(host_id: string): string {
  return `project-host.${host_id}.api`;
}

const STATUS_SUBJECT = "project-hosts.status";
export const ONPREM_REST_TUNNEL_LOCAL_PORT = 9345;

export function createHostControlClient({
  host_id,
  client,
  timeout,
}: {
  host_id: string;
  client: Client;
  timeout?;
}): HostControlApi {
  return createServiceClient<HostControlApi>({
    service: "project-host",
    subject: subjectForHost(host_id),
    client,
    timeout,
  });
}

export interface HostProjectStatus {
  host_id: string;
  project_id: string;
  state: ProjectState | string;
  host?: {
    public_url?: string;
    internal_url?: string;
    ssh_server?: string;
  };
}

export interface HostProjectProvisioned {
  host_id: string;
  project_id: string;
  provisioned: boolean;
  checked_at?: number;
}

export interface HostProvisionedInventory {
  host_id: string;
  project_ids: string[];
  checked_at?: number;
}

export interface HostRegisterOnPremTunnelRequest {
  host_id: string;
  public_key: string;
}

export interface HostRegisterOnPremTunnelResponse {
  sshd_host: string;
  sshd_port: number;
  ssh_user: string;
  http_tunnel_port: number;
  ssh_tunnel_port: number;
  rest_port: number;
}

export interface HostProjectMaintenanceSchedule {
  project_id: string;
  last_edited: string | null;
  snapshots: SnapshotSchedule | null;
  backups: SnapshotSchedule | null;
}

export type SoftwareArtifact =
  | "project-host"
  | "project"
  | "project-bundle"
  | "tools";

export type SoftwareChannel = "latest" | "staging";

export interface SoftwareUpgradeTarget {
  artifact: SoftwareArtifact;
  channel?: SoftwareChannel;
  version?: string;
}

export interface UpgradeSoftwareRequest {
  targets: SoftwareUpgradeTarget[];
  base_url?: string;
  restart_project_host?: boolean;
}

export interface UpgradeSoftwareResult {
  artifact: SoftwareArtifact;
  version: string;
  status: "updated" | "noop";
}

export interface UpgradeSoftwareResponse {
  results: UpgradeSoftwareResult[];
}

export interface HostStatusApi {
  reportProjectState: (
    opts: HostProjectStatus,
  ) => Promise<{ action?: "delete" } | void>;
  reportProjectProvisioned: (
    opts: HostProjectProvisioned,
  ) => Promise<{ action?: "delete" } | void>;
  reportHostProvisionedInventory: (
    opts: HostProvisionedInventory,
  ) => Promise<{ delete_project_ids?: string[] } | void>;
  syncAccountRevocations: (opts: {
    host_id: string;
    cursor_updated_ms?: number;
    cursor_account_id?: string;
    limit?: number;
  }) => Promise<{
    rows: Array<{
      account_id: string;
      revoked_before_ms: number;
      updated_ms: number;
    }>;
    next_cursor_updated_ms?: number;
    next_cursor_account_id?: string;
  }>;
  listProjectMaintenanceSchedules: (opts: {
    host_id: string;
    active_days?: number;
  }) => Promise<HostProjectMaintenanceSchedule[]>;
  registerOnPremTunnel: (
    opts: HostRegisterOnPremTunnelRequest,
  ) => Promise<HostRegisterOnPremTunnelResponse>;
}

export function createHostStatusClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?;
}): HostStatusApi {
  return createServiceClient<HostStatusApi>({
    service: "project-host",
    subject: STATUS_SUBJECT,
    client,
    timeout,
  });
}

export function createHostStatusService({
  client,
  impl,
}: {
  client: Client;
  impl: HostStatusApi;
}): ConatService {
  return createServiceHandler<HostStatusApi>({
    service: "project-host",
    subject: STATUS_SUBJECT,
    description: "Project-host -> master status updates",
    client,
    impl,
  });
}

export function createHostControlService({
  host_id,
  client,
  impl,
}: {
  host_id: string;
  client: Client;
  impl: HostControlApi;
}): ConatService {
  return createServiceHandler<HostControlApi>({
    service: "project-host",
    subject: subjectForHost(host_id),
    description: "Control plane for project-host instance",
    client,
    impl,
  });
}
