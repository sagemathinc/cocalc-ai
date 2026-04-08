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
import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import type { ProjectActiveOperationSummary } from "@cocalc/conat/hub/api/projects";
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

export type ProjectControlMethod =
  | "start"
  | "stop"
  | "restart"
  | "state"
  | "address"
  | "active-op";
export type DirectoryMethod = "resolve-project-bay" | "resolve-host-bay";
export type ProjectReferenceMethod = "get";
export type ProjectLroMethod = "publish-progress";
export type AccountDirectoryMethod =
  | "get"
  | "get-by-email"
  | "get-many"
  | "search"
  | "create";
export type AccountLocalMethod = "create";
export type AuthTokenMethod = "requires-token" | "redeem" | "disable";

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
