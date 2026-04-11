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
export type ProjectReferenceMethod = "get";
export type ProjectDetailsMethod = "get";
export type HostConnectionMethod = "get";
export type ProjectHostAuthTokenMethod = "issue";
export type ProjectLroMethod = "publish-progress";
export type AccountDirectoryMethod =
  | "get"
  | "get-by-email"
  | "get-many"
  | "search"
  | "create";
export type AccountLocalMethod = "create";
export type AuthTokenMethod = "requires-token" | "redeem" | "disable";
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
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
}

export interface InterBayAccountLocalApi {
  create: (
    opts: AccountDirectoryCreateRequest,
  ) => Promise<AccountDirectoryEntry>;
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
