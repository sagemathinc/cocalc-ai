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

export interface BayOwnership {
  bay_id: string;
  epoch: number;
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
  epoch?: number;
}

export type ProjectControlMethod = "start";
export type DirectoryMethod = "resolve-project-bay" | "resolve-host-bay";

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

export function directorySubject({
  method,
}: {
  method: DirectoryMethod;
}): string {
  return `global.directory.rpc.${method}`;
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
  return createServiceClient<InterBayProjectControlApi>({
    ...serviceClientOptions({ client, timeout }),
    subject: projectControlSubject({ dest_bay, method: "start" }),
  });
}

export function createInterBayProjectControlHandler({
  bay_id,
  impl,
  ...options
}: ServiceHandlerOptions & {
  bay_id: string;
  impl: InterBayProjectControlApi;
}): ConatService {
  return createServiceHandler<InterBayProjectControlApi>({
    ...options,
    service: "inter-bay-project-control",
    subject: projectControlSubject({ dest_bay: bay_id, method: "start" }),
    impl,
  });
}
