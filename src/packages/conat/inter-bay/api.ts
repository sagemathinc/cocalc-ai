/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { ConatService } from "@cocalc/conat/service/typed";
import type { Options, ServiceCall } from "@cocalc/conat/service/service";
import type {
  AccountFeedProjectRemoveEvent,
  AccountFeedProjectUpsertEvent,
} from "@cocalc/conat/hub/api/account-feed";
import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import type {
  ProjectActiveOperationSummary,
  ProjectBackupSchedule,
  ProjectCollabInviteAction,
  ProjectCollabInviteRow,
  ProjectCourseInfo,
  ProjectCreated,
  ProjectEnv,
  ProjectLauncherSettings,
  ProjectQuotaSettings,
  ProjectRegion,
  ProjectRootfsConfig,
  ProjectRunQuota,
  ProjectSnapshotSchedule,
} from "@cocalc/conat/hub/api/projects";
import type {
  HostControlApi,
  HostCreateProjectRequest,
  HostCreateProjectResponse,
  HostBackupExecutionStatus,
  HostProjectRuntimeLogResponse,
  HostRootfsCacheEntry,
  HostRootfsManifest,
  HostRuntimeLogResponse,
  HostSshAuthorizedKeysResponse,
  HostStaticAppPathInspection,
  UpgradeSoftwareRequest,
  UpgradeSoftwareResponse,
} from "@cocalc/conat/project-host/api";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import type { ProjectState } from "@cocalc/util/db-schema/projects";

export interface BayOwnership {
  bay_id: string;
  epoch: number;
}

export interface ProjectReference {
  project_id: string;
  title: string;
  host_id: string | null;
  owning_bay_id: string;
  users?: Record<string, any>;
}

export interface ProjectDetails {
  launcher: ProjectLauncherSettings;
  region: ProjectRegion;
  created: ProjectCreated;
  env: ProjectEnv;
  rootfs: ProjectRootfsConfig | null;
  snapshots: ProjectSnapshotSchedule;
  backups: ProjectBackupSchedule;
  run_quota: ProjectRunQuota;
  settings: ProjectQuotaSettings;
  course: ProjectCourseInfo;
}

export interface ResolveProjectBayRequest {
  project_id: string;
}

export interface ResolveHostBayRequest {
  host_id: string;
}

export interface ProjectControlStartRequest {
  project_id: string;
  account_id: string;
  lro_op_id?: string;
  source_bay_id?: string;
  epoch?: number;
}

export interface ProjectControlStopRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectControlRestartRequest {
  project_id: string;
  account_id: string;
  lro_op_id?: string;
  source_bay_id?: string;
  epoch?: number;
}

export interface ProjectControlStateRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectControlAddressRequest {
  project_id: string;
  account_id: string;
  epoch?: number;
}

export interface ProjectControlActiveOperationRequest {
  project_id: string;
  epoch?: number;
}

export interface ProjectAddress {
  host: string;
  port: number;
  secret_token: string;
}

export interface GetProjectReferenceRequest {
  project_id: string;
  account_id: string;
}

export interface GetProjectDetailsRequest {
  project_id: string;
  account_id: string;
}

export interface GetHostConnectionRequest {
  host_id: string;
  account_id: string;
}

export interface IssueProjectHostAuthTokenRequest {
  host_id: string;
  account_id: string;
  project_id?: string;
  ttl_seconds?: number;
}

export interface IssueProjectHostAuthTokenResponse {
  host_id: string;
  token: string;
  expires_at: number;
}

export interface ForwardProjectLroProgressRequest {
  project_id: string;
  op_id: string;
  event: Extract<LroEvent, { type: "progress" }>;
}

export interface AccountDirectoryGetRequest {
  account_id: string;
}

export interface AccountDirectoryGetByEmailRequest {
  email_address: string;
}

export interface AccountDirectoryGetManyRequest {
  account_ids: string[];
}

export interface AccountDirectorySearchRequest {
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}

export interface AccountDirectoryHomeBayCountsRequest {}

export interface AccountDirectoryEntry extends UserSearchResult {
  email_address?: string;
  home_bay_id?: string;
}

export interface AccountDirectoryCreateRequest {
  email_address: string;
  password: string;
  first_name: string;
  last_name: string;
  home_bay_id: string;
  account_id?: string;
  owner_id?: string;
  tags?: string[];
  signup_reason?: string;
  no_first_project?: boolean;
  ephemeral?: number;
  customize?: any;
}

export interface BayRegistryRegisterRequest {
  bay_id: string;
  label?: string;
  region?: string | null;
  role?: string;
  public_origin?: string | null;
  public_target?: string | null;
  public_target_kind?: string | null;
}

export interface BayRegistryListRequest {}

export interface BayRegistryEntry {
  bay_id: string;
  label: string;
  region?: string | null;
  role: string;
  public_origin?: string | null;
  public_target?: string | null;
  public_target_kind?: string | null;
  dns_hostname?: string | null;
  dns_record_id?: string | null;
  last_seen: string;
}

export interface BayRegistryManagedTunnel {
  id: string;
  name: string;
  hostname: string;
  tunnel_secret: string;
  account_id: string;
  record_id?: string;
  token?: string;
}

export interface BayRegistryRegisterResult extends BayRegistryEntry {
  managed_tunnel?: BayRegistryManagedTunnel | null;
}

export interface AuthTokenRequiresRequest {}

export interface AuthTokenRedeemRequest {
  token: string;
}

export interface AuthTokenDisableRequest {
  token: string;
}

export interface RegistrationTokenInfoWire {
  token: string;
  ephemeral?: number;
  customize?: any;
}

export interface ProjectCollabInviteWire extends Omit<
  ProjectCollabInviteRow,
  "created" | "updated" | "responded" | "expires"
> {
  created: string;
  updated: string;
  responded?: string | null;
  expires?: string | null;
}

export interface ProjectCollabInviteInboxUpsertRequest {
  source_bay_id: string;
  invite: ProjectCollabInviteWire;
}

export interface ProjectCollabInviteInboxDeleteRequest {
  invite_id: string;
}

export interface ProjectCollabInviteRespondRequest {
  invite_id: string;
  account_id: string;
  action: ProjectCollabInviteAction;
  include_email?: boolean;
}

export type ProjectControlMethod =
  | "start"
  | "stop"
  | "restart"
  | "state"
  | "address"
  | "active-op";
export type DirectoryMethod = "resolve-project-bay" | "resolve-host-bay";
export type BayDirectoryMethod = DirectoryMethod;
export type ProjectReferenceMethod = "get";
export type ProjectDetailsMethod = "get";
export type HostConnectionMethod = "get";
export type HostControlMethod =
  | "create-project"
  | "start-project"
  | "stop-project"
  | "update-authorized-keys"
  | "update-project-users"
  | "apply-pending-copies"
  | "delete-project-data"
  | "upgrade-software"
  | "grow-btrfs"
  | "get-runtime-log"
  | "get-project-runtime-log"
  | "list-rootfs-images"
  | "pull-rootfs-image"
  | "delete-rootfs-image"
  | "list-host-ssh-authorized-keys"
  | "add-host-ssh-authorized-key"
  | "remove-host-ssh-authorized-key"
  | "get-backup-execution-status"
  | "inspect-static-app-path"
  | "build-rootfs-image-manifest"
  | "build-project-rootfs-manifest";
export type ProjectHostAuthTokenMethod = "issue";
export type ProjectLroMethod = "publish-progress";
export type AccountDirectoryMethod =
  | "get"
  | "get-by-email"
  | "get-many"
  | "search"
  | "home-bay-counts"
  | "create";
export type AccountLocalMethod = "create";
export type AuthTokenMethod = "requires-token" | "redeem" | "disable";
export type BayRegistryMethod = "register" | "list";
export type ProjectCollabInviteMethod =
  | "upsert-inbox"
  | "delete-inbox"
  | "respond";
export type AccountProjectFeedMethod = "upsert" | "remove";

interface ResolveProjectBayApi {
  resolveProjectBay: (
    opts: ResolveProjectBayRequest,
  ) => Promise<BayOwnership | null>;
}

interface ResolveHostBayApi {
  resolveHostBay: (opts: ResolveHostBayRequest) => Promise<BayOwnership | null>;
}

export interface InterBayDirectoryApi {
  resolveProjectBay: (
    opts: ResolveProjectBayRequest,
  ) => Promise<BayOwnership | null>;
  resolveHostBay: (opts: ResolveHostBayRequest) => Promise<BayOwnership | null>;
}

export interface InterBayProjectControlApi {
  start: (opts: ProjectControlStartRequest) => Promise<void>;
  stop: (opts: ProjectControlStopRequest) => Promise<void>;
  restart: (opts: ProjectControlRestartRequest) => Promise<void>;
  state: (opts: ProjectControlStateRequest) => Promise<ProjectState>;
  address: (opts: ProjectControlAddressRequest) => Promise<ProjectAddress>;
  activeOp: (
    opts: ProjectControlActiveOperationRequest,
  ) => Promise<ProjectActiveOperationSummary | null>;
}

export interface InterBayProjectReferenceApi {
  get: (opts: GetProjectReferenceRequest) => Promise<ProjectReference | null>;
}

export interface InterBayProjectDetailsApi {
  get: (opts: GetProjectDetailsRequest) => Promise<ProjectDetails>;
}

export interface InterBayHostConnectionApi {
  get: (opts: GetHostConnectionRequest) => Promise<HostConnectionInfo>;
}

type HostControlArg<K extends keyof HostControlApi> = Parameters<
  HostControlApi[K]
>[0];

export interface InterBayHostControlApi {
  createProject: (opts: {
    account_id: string;
    host_id: string;
    create: HostCreateProjectRequest;
  }) => Promise<HostCreateProjectResponse>;
  startProject: (opts: {
    host_id: string;
    start: HostControlArg<"startProject">;
  }) => Promise<HostCreateProjectResponse>;
  stopProject: (opts: {
    host_id: string;
    stop: HostControlArg<"stopProject">;
  }) => Promise<HostCreateProjectResponse>;
  updateAuthorizedKeys: (opts: {
    host_id: string;
    update: HostControlArg<"updateAuthorizedKeys">;
  }) => Promise<void>;
  updateProjectUsers: (opts: {
    host_id: string;
    update: HostControlArg<"updateProjectUsers">;
  }) => Promise<void>;
  applyPendingCopies: (opts: {
    host_id: string;
    apply: HostControlArg<"applyPendingCopies">;
  }) => Promise<{ claimed: number }>;
  deleteProjectData: (opts: {
    host_id: string;
    del: HostControlArg<"deleteProjectData">;
  }) => Promise<void>;
  upgradeSoftware: (opts: {
    host_id: string;
    upgrade: UpgradeSoftwareRequest;
  }) => Promise<UpgradeSoftwareResponse>;
  growBtrfs: (opts: {
    host_id: string;
    grow: HostControlArg<"growBtrfs">;
  }) => Promise<{ ok: boolean }>;
  getRuntimeLog: (opts: {
    host_id: string;
    get: HostControlArg<"getRuntimeLog">;
  }) => Promise<HostRuntimeLogResponse>;
  getProjectRuntimeLog: (opts: {
    host_id: string;
    get: HostControlArg<"getProjectRuntimeLog">;
  }) => Promise<HostProjectRuntimeLogResponse>;
  listRootfsImages: (opts: {
    host_id: string;
  }) => Promise<HostRootfsCacheEntry[]>;
  pullRootfsImage: (opts: {
    host_id: string;
    pull: HostControlArg<"pullRootfsImage">;
  }) => Promise<HostRootfsCacheEntry>;
  deleteRootfsImage: (opts: {
    host_id: string;
    del: HostControlArg<"deleteRootfsImage">;
  }) => Promise<{ removed: boolean }>;
  listHostSshAuthorizedKeys: (opts: {
    host_id: string;
  }) => Promise<HostSshAuthorizedKeysResponse>;
  addHostSshAuthorizedKey: (opts: {
    host_id: string;
    add: HostControlArg<"addHostSshAuthorizedKey">;
  }) => Promise<HostSshAuthorizedKeysResponse & { added: boolean }>;
  removeHostSshAuthorizedKey: (opts: {
    host_id: string;
    remove: HostControlArg<"removeHostSshAuthorizedKey">;
  }) => Promise<HostSshAuthorizedKeysResponse & { removed: boolean }>;
  getBackupExecutionStatus: (opts: {
    host_id: string;
  }) => Promise<HostBackupExecutionStatus>;
  inspectStaticAppPath: (opts: {
    host_id: string;
    inspect: HostControlArg<"inspectStaticAppPath">;
  }) => Promise<HostStaticAppPathInspection>;
  buildRootfsImageManifest: (opts: {
    host_id: string;
    build: HostControlArg<"buildRootfsImageManifest">;
  }) => Promise<HostRootfsManifest>;
  buildProjectRootfsManifest: (opts: {
    host_id: string;
    build: HostControlArg<"buildProjectRootfsManifest">;
  }) => Promise<HostRootfsManifest>;
}

export interface InterBayProjectHostAuthTokenApi {
  issue: (
    opts: IssueProjectHostAuthTokenRequest,
  ) => Promise<IssueProjectHostAuthTokenResponse>;
}

export interface InterBayProjectLroApi {
  publishProgress: (opts: ForwardProjectLroProgressRequest) => Promise<void>;
}

export interface InterBayAccountDirectoryApi {
  get: (
    opts: AccountDirectoryGetRequest,
  ) => Promise<AccountDirectoryEntry | null>;
  getByEmail: (
    opts: AccountDirectoryGetByEmailRequest,
  ) => Promise<AccountDirectoryEntry | null>;
  getMany: (
    opts: AccountDirectoryGetManyRequest,
  ) => Promise<AccountDirectoryEntry[]>;
  search: (
    opts: AccountDirectorySearchRequest,
  ) => Promise<AccountDirectoryEntry[]>;
  getHomeBayCounts: (
    opts: AccountDirectoryHomeBayCountsRequest,
  ) => Promise<Record<string, number>>;
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
}

export interface InterBayAccountLocalApi {
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
}

export interface InterBayBayRegistryApi {
  register: (
    opts: BayRegistryRegisterRequest,
  ) => Promise<BayRegistryRegisterResult>;
  list: (opts: BayRegistryListRequest) => Promise<BayRegistryEntry[]>;
}

export interface InterBayAuthTokenApi {
  requiresToken: (opts: AuthTokenRequiresRequest) => Promise<boolean>;
  redeem: (
    opts: AuthTokenRedeemRequest,
  ) => Promise<RegistrationTokenInfoWire | null>;
  disable: (opts: AuthTokenDisableRequest) => Promise<void>;
}

export interface InterBayProjectCollabInviteApi {
  upsertInbox: (opts: ProjectCollabInviteInboxUpsertRequest) => Promise<void>;
  deleteInbox: (opts: ProjectCollabInviteInboxDeleteRequest) => Promise<void>;
  respond: (
    opts: ProjectCollabInviteRespondRequest,
  ) => Promise<ProjectCollabInviteWire>;
}

export interface InterBayAccountProjectFeedApi {
  upsert: (opts: AccountFeedProjectUpsertEvent) => Promise<void>;
  remove: (opts: AccountFeedProjectRemoveEvent) => Promise<void>;
}

function serviceClientOptions({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): Omit<ServiceCall, "mesg"> {
  return {
    service: "inter-bay",
    client,
    timeout,
  };
}

export function projectControlSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectControlMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-control.${method}`;
}

export function projectReferenceSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectReferenceMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-reference.${method}`;
}

export function projectDetailsSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectDetailsMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-details.${method}`;
}

export function hostConnectionSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: HostConnectionMethod;
}): string {
  return `bay.${dest_bay}.rpc.host-connection.${method}`;
}

export function hostControlSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: HostControlMethod;
}): string {
  return `bay.${dest_bay}.rpc.host-control.${method}`;
}

type HostControlName = keyof InterBayHostControlApi;

const HOST_CONTROL_METHOD_SPECS = [
  { name: "createProject", method: "create-project" },
  { name: "startProject", method: "start-project" },
  { name: "stopProject", method: "stop-project" },
  { name: "updateAuthorizedKeys", method: "update-authorized-keys" },
  { name: "updateProjectUsers", method: "update-project-users" },
  { name: "applyPendingCopies", method: "apply-pending-copies" },
  { name: "deleteProjectData", method: "delete-project-data" },
  { name: "upgradeSoftware", method: "upgrade-software" },
  { name: "growBtrfs", method: "grow-btrfs" },
  { name: "getRuntimeLog", method: "get-runtime-log" },
  { name: "getProjectRuntimeLog", method: "get-project-runtime-log" },
  { name: "listRootfsImages", method: "list-rootfs-images" },
  { name: "pullRootfsImage", method: "pull-rootfs-image" },
  { name: "deleteRootfsImage", method: "delete-rootfs-image" },
  {
    name: "listHostSshAuthorizedKeys",
    method: "list-host-ssh-authorized-keys",
  },
  { name: "addHostSshAuthorizedKey", method: "add-host-ssh-authorized-key" },
  {
    name: "removeHostSshAuthorizedKey",
    method: "remove-host-ssh-authorized-key",
  },
  {
    name: "getBackupExecutionStatus",
    method: "get-backup-execution-status",
  },
  { name: "inspectStaticAppPath", method: "inspect-static-app-path" },
  {
    name: "buildRootfsImageManifest",
    method: "build-rootfs-image-manifest",
  },
  {
    name: "buildProjectRootfsManifest",
    method: "build-project-rootfs-manifest",
  },
] as const satisfies ReadonlyArray<{
  name: HostControlName;
  method: HostControlMethod;
}>;

function createInterBayHostControlMethodClient<K extends HostControlName>({
  client,
  dest_bay,
  timeout,
  name,
  method,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
  name: K;
  method: HostControlMethod;
}): InterBayHostControlApi[K] {
  const methodClient = createServiceClient<Pick<InterBayHostControlApi, K>>({
    ...serviceClientOptions({ client, timeout }),
    subject: hostControlSubject({ dest_bay, method }),
  });
  return (async (...args: Parameters<InterBayHostControlApi[K]>) =>
    await (methodClient[name] as any)(...args)) as InterBayHostControlApi[K];
}

function createInterBayHostControlMethodHandler<K extends HostControlName>({
  bay_id,
  impl,
  name,
  method,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostControlApi;
  name: K;
  method: HostControlMethod;
}): ConatService {
  return createServiceHandler<Pick<InterBayHostControlApi, K>>({
    ...options,
    service: "inter-bay-host-control",
    subject: hostControlSubject({
      dest_bay: bay_id,
      method,
    }),
    impl: {
      [name]: async (...args: Parameters<InterBayHostControlApi[K]>) =>
        await (impl[name] as any)(...args),
    } as Pick<InterBayHostControlApi, K>,
  });
}

export function projectHostAuthTokenSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectHostAuthTokenMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-host-auth-token.${method}`;
}

export function directorySubject({
  method,
}: {
  method: DirectoryMethod;
}): string {
  return `global.directory.rpc.${method}`;
}

export function bayDirectorySubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: BayDirectoryMethod;
}): string {
  return `bay.${dest_bay}.rpc.directory.${method}`;
}

export function projectLroSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectLroMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-lro.${method}`;
}

export function accountDirectorySubject({
  method,
}: {
  method: AccountDirectoryMethod;
}): string {
  return `global.account-directory.rpc.${method}`;
}

export function accountLocalSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: AccountLocalMethod;
}): string {
  return `bay.${dest_bay}.rpc.account-local.${method}`;
}

export function bayRegistrySubject({
  method,
}: {
  method: BayRegistryMethod;
}): string {
  return `global.bay-registry.rpc.${method}`;
}

export function authTokenSubject({
  method,
}: {
  method: AuthTokenMethod;
}): string {
  return `global.auth-token.rpc.${method}`;
}

export function projectCollabInviteSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: ProjectCollabInviteMethod;
}): string {
  return `bay.${dest_bay}.rpc.project-collab-invite.${method}`;
}

export function accountProjectFeedSubject({
  dest_bay,
  method,
}: {
  dest_bay: string;
  method: AccountProjectFeedMethod;
}): string {
  return `bay.${dest_bay}.rpc.account-project-feed.${method}`;
}

export function createInterBayDirectoryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayDirectoryApi {
  const resolveProjectBayClient = createServiceClient<ResolveProjectBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: directorySubject({ method: "resolve-project-bay" }),
  });
  const resolveHostBayClient = createServiceClient<ResolveHostBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: directorySubject({ method: "resolve-host-bay" }),
  });
  return {
    resolveProjectBay: async (opts) =>
      await resolveProjectBayClient.resolveProjectBay(opts),
    resolveHostBay: async (opts) =>
      await resolveHostBayClient.resolveHostBay(opts),
  };
}

type ServiceHandlerOptions = Omit<Options, "handler" | "service" | "subject">;

export function createInterBayDirectoryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & { impl: InterBayDirectoryApi }): ConatService[] {
  return [
    createServiceHandler<ResolveProjectBayApi>({
      ...options,
      service: "inter-bay-directory",
      subject: directorySubject({ method: "resolve-project-bay" }),
      impl: {
        resolveProjectBay: async (opts) => await impl.resolveProjectBay(opts),
      },
    }),
    createServiceHandler<ResolveHostBayApi>({
      ...options,
      service: "inter-bay-directory",
      subject: directorySubject({ method: "resolve-host-bay" }),
      impl: {
        resolveHostBay: async (opts) => await impl.resolveHostBay(opts),
      },
    }),
  ];
}

export function createInterBayBayDirectoryClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayDirectoryApi {
  const resolveProjectBayClient = createServiceClient<ResolveProjectBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayDirectorySubject({
      dest_bay,
      method: "resolve-project-bay",
    }),
  });
  const resolveHostBayClient = createServiceClient<ResolveHostBayApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayDirectorySubject({
      dest_bay,
      method: "resolve-host-bay",
    }),
  });
  return {
    resolveProjectBay: async (opts) =>
      await resolveProjectBayClient.resolveProjectBay(opts),
    resolveHostBay: async (opts) =>
      await resolveHostBayClient.resolveHostBay(opts),
  };
}

export function createInterBayBayDirectoryHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayDirectoryApi;
}): ConatService[] {
  return [
    createServiceHandler<ResolveProjectBayApi>({
      ...options,
      service: "inter-bay-bay-directory",
      subject: bayDirectorySubject({
        dest_bay: bay_id,
        method: "resolve-project-bay",
      }),
      impl: {
        resolveProjectBay: async (opts) => await impl.resolveProjectBay(opts),
      },
    }),
    createServiceHandler<ResolveHostBayApi>({
      ...options,
      service: "inter-bay-bay-directory",
      subject: bayDirectorySubject({
        dest_bay: bay_id,
        method: "resolve-host-bay",
      }),
      impl: {
        resolveHostBay: async (opts) => await impl.resolveHostBay(opts),
      },
    }),
  ];
}

export function createInterBayProjectControlClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectControlApi {
  const startClient = createServiceClient<
    Pick<InterBayProjectControlApi, "start">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "start" }),
  });
  const stopClient = createServiceClient<
    Pick<InterBayProjectControlApi, "stop">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "stop" }),
  });
  const restartClient = createServiceClient<
    Pick<InterBayProjectControlApi, "restart">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "restart" }),
  });
  const stateClient = createServiceClient<
    Pick<InterBayProjectControlApi, "state">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "state" }),
  });
  const addressClient = createServiceClient<
    Pick<InterBayProjectControlApi, "address">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "address" }),
  });
  const activeOpClient = createServiceClient<
    Pick<InterBayProjectControlApi, "activeOp">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "active-op" }),
  });
  return {
    start: async (opts) => await startClient.start(opts),
    stop: async (opts) => await stopClient.stop(opts),
    restart: async (opts) => await restartClient.restart(opts),
    state: async (opts) => await stateClient.state(opts),
    address: async (opts) => await addressClient.address(opts),
    activeOp: async (opts) => await activeOpClient.activeOp(opts),
  };
}

export function createInterBayProjectControlHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "start">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "start" }),
    impl: {
      start: async (opts) => await impl.start(opts),
    },
  });
}

export function createInterBayProjectReferenceClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectReferenceApi {
  const refClient = createServiceClient<
    Pick<InterBayProjectReferenceApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectReferenceSubject({ dest_bay, method: "get" }),
  });
  return {
    get: async (opts) => await refClient.get(opts),
  };
}

export function createInterBayProjectDetailsClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectDetailsApi {
  const detailsClient = createServiceClient<
    Pick<InterBayProjectDetailsApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectDetailsSubject({ dest_bay, method: "get" }),
  });
  return {
    get: async (opts) => await detailsClient.get(opts),
  };
}

export function createInterBayHostConnectionClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayHostConnectionApi {
  const hostConnectionClient = createServiceClient<
    Pick<InterBayHostConnectionApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: hostConnectionSubject({ dest_bay, method: "get" }),
  });
  return {
    get: async (opts) => await hostConnectionClient.get(opts),
  };
}

export function createInterBayHostControlClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayHostControlApi {
  const api = {} as InterBayHostControlApi;
  for (const { name, method } of HOST_CONTROL_METHOD_SPECS) {
    (api as any)[name] = createInterBayHostControlMethodClient({
      client,
      dest_bay,
      timeout,
      name,
      method,
    });
  }
  return api;
}

export function createInterBayProjectHostAuthTokenClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectHostAuthTokenApi {
  const tokenClient = createServiceClient<
    Pick<InterBayProjectHostAuthTokenApi, "issue">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectHostAuthTokenSubject({ dest_bay, method: "issue" }),
  });
  return {
    issue: async (opts) => await tokenClient.issue(opts),
  };
}

export function createInterBayProjectReferenceHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectReferenceApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectReferenceApi, "get">>({
    ...options,
    service: "inter-bay-project-reference",
    subject: projectReferenceSubject({ dest_bay: bay_id, method: "get" }),
    impl: {
      get: async (opts) => await impl.get(opts),
    },
  });
}

export function createInterBayProjectDetailsHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectDetailsApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectDetailsApi, "get">>({
    ...options,
    service: "inter-bay-project-details",
    subject: projectDetailsSubject({ dest_bay: bay_id, method: "get" }),
    impl: {
      get: async (opts) => await impl.get(opts),
    },
  });
}

export function createInterBayHostConnectionHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostConnectionApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayHostConnectionApi, "get">>({
    ...options,
    service: "inter-bay-host-connection",
    subject: hostConnectionSubject({ dest_bay: bay_id, method: "get" }),
    impl: {
      get: async (opts) => await impl.get(opts),
    },
  });
}

export function createInterBayHostControlHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayHostControlApi;
}): ConatService[] {
  return HOST_CONTROL_METHOD_SPECS.map(({ name, method }) =>
    createInterBayHostControlMethodHandler({
      bay_id,
      impl,
      name,
      method,
      ...options,
    }),
  );
}

export function createInterBayProjectHostAuthTokenHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectHostAuthTokenApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectHostAuthTokenApi, "issue">>({
    ...options,
    service: "inter-bay-project-host-auth-token",
    subject: projectHostAuthTokenSubject({ dest_bay: bay_id, method: "issue" }),
    impl: {
      issue: async (opts) => await impl.issue(opts),
    },
  });
}

export function createInterBayProjectLroClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectLroApi {
  const progressClient = createServiceClient<
    Pick<InterBayProjectLroApi, "publishProgress">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectLroSubject({
      dest_bay,
      method: "publish-progress",
    }),
  });
  return {
    publishProgress: async (opts) => await progressClient.publishProgress(opts),
  };
}

export function createInterBayAccountDirectoryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayAccountDirectoryApi {
  const getClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "get">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get" }),
  });
  const getByEmailClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getByEmail">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get-by-email" }),
  });
  const getManyClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getMany">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "get-many" }),
  });
  const searchClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "search">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "search" }),
  });
  const homeBayCountsClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "getHomeBayCounts">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "home-bay-counts" }),
  });
  const createClient = createServiceClient<
    Pick<InterBayAccountDirectoryApi, "create">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountDirectorySubject({ method: "create" }),
  });
  return {
    get: async (opts) => await getClient.get(opts),
    getByEmail: async (opts) => await getByEmailClient.getByEmail(opts),
    getMany: async (opts) => await getManyClient.getMany(opts),
    search: async (opts) => await searchClient.search(opts),
    getHomeBayCounts: async (opts) =>
      await homeBayCountsClient.getHomeBayCounts(opts),
    create: async (opts) => await createClient.create(opts),
  };
}

export function createInterBayAccountDirectoryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & {
  impl: InterBayAccountDirectoryApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "get">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get" }),
      impl: {
        get: async (opts) => await impl.get(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getByEmail">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get-by-email" }),
      impl: {
        getByEmail: async (opts) => await impl.getByEmail(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getMany">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "get-many" }),
      impl: {
        getMany: async (opts) => await impl.getMany(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "search">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "search" }),
      impl: {
        search: async (opts) => await impl.search(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "getHomeBayCounts">>(
      {
        ...options,
        service: "inter-bay-account-directory",
        subject: accountDirectorySubject({ method: "home-bay-counts" }),
        impl: {
          getHomeBayCounts: async (opts) => await impl.getHomeBayCounts(opts),
        },
      },
    ),
    createServiceHandler<Pick<InterBayAccountDirectoryApi, "create">>({
      ...options,
      service: "inter-bay-account-directory",
      subject: accountDirectorySubject({ method: "create" }),
      impl: {
        create: async (opts) => await impl.create(opts),
      },
    }),
  ];
}

export function createInterBayAccountLocalClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayAccountLocalApi {
  const createClient = createServiceClient<
    Pick<InterBayAccountLocalApi, "create">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountLocalSubject({ dest_bay, method: "create" }),
  });
  return {
    create: async (opts) => await createClient.create(opts),
  };
}

export function createInterBayAccountLocalHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayAccountLocalApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayAccountLocalApi, "create">>({
    ...options,
    service: "inter-bay-account-local",
    subject: accountLocalSubject({ dest_bay: bay_id, method: "create" }),
    impl: {
      create: async (opts) => await impl.create(opts),
    },
  });
}

export function createInterBayBayRegistryClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayBayRegistryApi {
  const registerClient = createServiceClient<
    Pick<InterBayBayRegistryApi, "register">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: bayRegistrySubject({ method: "register" }),
  });
  const listClient = createServiceClient<Pick<InterBayBayRegistryApi, "list">>({
    ...serviceClientOptions({ client, timeout }),
    subject: bayRegistrySubject({ method: "list" }),
  });
  return {
    register: async (opts) => await registerClient.register(opts),
    list: async (opts) => await listClient.list(opts),
  };
}

export function createInterBayBayRegistryHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & {
  impl: InterBayBayRegistryApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayBayRegistryApi, "register">>({
      ...options,
      service: "inter-bay-bay-registry",
      subject: bayRegistrySubject({ method: "register" }),
      impl: {
        register: async (opts) => await impl.register(opts),
      },
    }),
    createServiceHandler<Pick<InterBayBayRegistryApi, "list">>({
      ...options,
      service: "inter-bay-bay-registry",
      subject: bayRegistrySubject({ method: "list" }),
      impl: {
        list: async (opts) => await impl.list(opts),
      },
    }),
  ];
}

export function createInterBayAuthTokenClient({
  client,
  timeout,
}: {
  client: Client;
  timeout?: number;
}): InterBayAuthTokenApi {
  const requiresTokenClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "requiresToken">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "requires-token" }),
  });
  const redeemClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "redeem">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "redeem" }),
  });
  const disableClient = createServiceClient<
    Pick<InterBayAuthTokenApi, "disable">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: authTokenSubject({ method: "disable" }),
  });
  return {
    requiresToken: async (opts) =>
      await requiresTokenClient.requiresToken(opts),
    redeem: async (opts) => await redeemClient.redeem(opts),
    disable: async (opts) => await disableClient.disable(opts),
  };
}

export function createInterBayAuthTokenHandlers({
  impl,
  ...options
}: ServiceHandlerOptions & { impl: InterBayAuthTokenApi }): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAuthTokenApi, "requiresToken">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "requires-token" }),
      impl: {
        requiresToken: async (opts) => await impl.requiresToken(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAuthTokenApi, "redeem">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "redeem" }),
      impl: {
        redeem: async (opts) => await impl.redeem(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAuthTokenApi, "disable">>({
      ...options,
      service: "inter-bay-auth-token",
      subject: authTokenSubject({ method: "disable" }),
      impl: {
        disable: async (opts) => await impl.disable(opts),
      },
    }),
  ];
}

export function createInterBayProjectCollabInviteClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayProjectCollabInviteApi {
  const upsertInboxClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "upsertInbox">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "upsert-inbox" }),
  });
  const deleteInboxClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "deleteInbox">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "delete-inbox" }),
  });
  const respondClient = createServiceClient<
    Pick<InterBayProjectCollabInviteApi, "respond">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: projectCollabInviteSubject({ dest_bay, method: "respond" }),
  });
  return {
    upsertInbox: async (opts) => await upsertInboxClient.upsertInbox(opts),
    deleteInbox: async (opts) => await deleteInboxClient.deleteInbox(opts),
    respond: async (opts) => await respondClient.respond(opts),
  };
}

export function createInterBayAccountProjectFeedClient({
  client,
  dest_bay,
  timeout,
}: {
  client: Client;
  dest_bay: string;
  timeout?: number;
}): InterBayAccountProjectFeedApi {
  const upsertClient = createServiceClient<
    Pick<InterBayAccountProjectFeedApi, "upsert">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountProjectFeedSubject({ dest_bay, method: "upsert" }),
  });
  const removeClient = createServiceClient<
    Pick<InterBayAccountProjectFeedApi, "remove">
  >({
    ...serviceClientOptions({ client, timeout }),
    subject: accountProjectFeedSubject({ dest_bay, method: "remove" }),
  });
  return {
    upsert: async (opts) => await upsertClient.upsert(opts),
    remove: async (opts) => await removeClient.remove(opts),
  };
}

export function createInterBayProjectCollabInviteHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectCollabInviteApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "upsertInbox">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "upsert-inbox",
      }),
      impl: {
        upsertInbox: async (opts) => await impl.upsertInbox(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "deleteInbox">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "delete-inbox",
      }),
      impl: {
        deleteInbox: async (opts) => await impl.deleteInbox(opts),
      },
    }),
    createServiceHandler<Pick<InterBayProjectCollabInviteApi, "respond">>({
      ...options,
      service: "inter-bay-project-collab-invite",
      subject: projectCollabInviteSubject({
        dest_bay: bay_id,
        method: "respond",
      }),
      impl: {
        respond: async (opts) => await impl.respond(opts),
      },
    }),
  ];
}

export function createInterBayAccountProjectFeedHandlers({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayAccountProjectFeedApi;
}): ConatService[] {
  return [
    createServiceHandler<Pick<InterBayAccountProjectFeedApi, "upsert">>({
      ...options,
      service: "inter-bay-account-project-feed",
      subject: accountProjectFeedSubject({
        dest_bay: bay_id,
        method: "upsert",
      }),
      impl: {
        upsert: async (opts) => await impl.upsert(opts),
      },
    }),
    createServiceHandler<Pick<InterBayAccountProjectFeedApi, "remove">>({
      ...options,
      service: "inter-bay-account-project-feed",
      subject: accountProjectFeedSubject({
        dest_bay: bay_id,
        method: "remove",
      }),
      impl: {
        remove: async (opts) => await impl.remove(opts),
      },
    }),
  ];
}

export function createInterBayProjectLroHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectLroApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectLroApi, "publishProgress">>({
    ...options,
    service: "inter-bay-project-lro",
    subject: projectLroSubject({
      dest_bay: bay_id,
      method: "publish-progress",
    }),
    impl: {
      publishProgress: async (opts) => await impl.publishProgress(opts),
    },
  });
}

export function createInterBayProjectControlStopHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "stop">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "stop" }),
    impl: {
      stop: async (opts) => await impl.stop(opts),
    },
  });
}

export function createInterBayProjectControlRestartHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "restart">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "restart" }),
    impl: {
      restart: async (opts) => await impl.restart(opts),
    },
  });
}

export function createInterBayProjectControlStateHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "state">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "state" }),
    impl: {
      state: async (opts) => await impl.state(opts),
    },
  });
}

export function createInterBayProjectControlAddressHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "address">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "address" }),
    impl: {
      address: async (opts) => await impl.address(opts),
    },
  });
}

export function createInterBayProjectControlActiveOpHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<Pick<InterBayProjectControlApi, "activeOp">>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "active-op" }),
    impl: {
      activeOp: async (opts) => await impl.activeOp(opts),
    },
  });
}
