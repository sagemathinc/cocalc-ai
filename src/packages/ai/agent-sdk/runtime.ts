/*
Runtime bridge for wiring agent-sdk to real hub/project clients.
*/

import type { AgentCapabilityRegistry } from "./capabilities";
import { AgentCapabilityRegistry as Registry } from "./capabilities";
import { AgentExecutor, type AgentExecutorOptions } from "./executor";
import { buildCapabilityManifest } from "./manifest";
import { registerBasicCapabilities } from "./packs";
import type { AgentActionEnvelope, AgentActionResult, AgentActor } from "./types";
import type {
  AgentHubAdapter,
  AgentProjectAdapter,
  AgentSdkContext,
} from "./adapters";

type Awaitable<T> = T | Promise<T>;

type HubClientLike = {
  system: {
    ping: () => Awaitable<{ now: number }>;
    getCustomize: (fields?: string[]) => Awaitable<any>;
  };
  projects: {
    createProject: (opts: any) => Awaitable<string>;
  };
};

type ProjectClientLike = {
  system: {
    listing: (opts: { path: string; hidden?: boolean }) => Awaitable<any[]>;
    moveFiles: (opts: { paths: string[]; dest: string }) => Awaitable<void>;
    renameFile: (opts: { src: string; dest: string }) => Awaitable<void>;
    realpath: (path: string) => Awaitable<string>;
    canonicalPaths: (paths: string[]) => Awaitable<string[]>;
    writeTextFileToProject: (opts: {
      path: string;
      content: string;
    }) => Awaitable<void>;
    readTextFileFromProject: (opts: { path: string }) => Awaitable<string>;
  };
  apps: {
    start: (name: string) => Awaitable<any>;
    stop: (name: string) => Awaitable<void>;
    status: (name: string) => Awaitable<any>;
  };
};

export type AgentSdkProjectResolver = (
  projectId: string,
) => Promise<ProjectClientLike> | ProjectClientLike;

export type CreateAgentSdkBridgeOptions = {
  hub: HubClientLike;
  project?: ProjectClientLike;
  projectResolver?: AgentSdkProjectResolver;
  defaults?: AgentSdkContext["defaults"];
  executor?: Omit<
    AgentExecutorOptions<AgentSdkContext>,
    "registry" | "requestIdFactory"
  > & {
    requestIdFactory?: AgentExecutorOptions<AgentSdkContext>["requestIdFactory"];
  };
};

export type AgentSdkBridgeExecuteInput = {
  action: AgentActionEnvelope;
  actor?: AgentActor;
  confirmationToken?: string;
  signal?: AbortSignal;
  now?: Date;
  // Optional direct override for advanced callers/tests.
  context?: AgentSdkContext;
};

export type AgentSdkBridge = {
  registry: AgentCapabilityRegistry<AgentSdkContext>;
  executor: AgentExecutor<AgentSdkContext>;
  buildContext: (action?: AgentActionEnvelope) => Promise<AgentSdkContext>;
  execute: (input: AgentSdkBridgeExecuteInput) => Promise<AgentActionResult>;
  manifest: () => ReturnType<typeof buildCapabilityManifest<AgentSdkContext>>;
};

function hubAdapterFromClient(client: HubClientLike): AgentHubAdapter {
  return {
    ping: () => client.system.ping(),
    getCustomize: (fields?: string[]) => client.system.getCustomize(fields),
    createProject: (opts) => client.projects.createProject(opts),
  };
}

function projectAdapterFromClient(client: ProjectClientLike): AgentProjectAdapter {
  return {
    listing: (opts) => client.system.listing(opts),
    moveFiles: (opts) => client.system.moveFiles(opts),
    renameFile: (opts) => client.system.renameFile(opts),
    realpath: (path) => client.system.realpath(path),
    canonicalPaths: (paths) => client.system.canonicalPaths(paths),
    writeTextFileToProject: (opts) => client.system.writeTextFileToProject(opts),
    readTextFileFromProject: (opts) => client.system.readTextFileFromProject(opts),
    apps: {
      start: (name: string) => client.apps.start(name),
      stop: (name: string) => client.apps.stop(name),
      status: (name: string) => client.apps.status(name),
    },
  };
}

function projectIdFromAction(
  action: AgentActionEnvelope | undefined,
  defaults?: AgentSdkContext["defaults"],
): string | undefined {
  return (
    action?.target?.project_id ??
    action?.target?.projectId ??
    defaults?.projectId
  );
}

export function createAgentSdkBridge(
  options: CreateAgentSdkBridgeOptions,
): AgentSdkBridge {
  const registry = new Registry<AgentSdkContext>();
  registerBasicCapabilities(registry);

  const executor = new AgentExecutor<AgentSdkContext>({
    registry,
    policy: options.executor?.policy,
    idempotencyStore: options.executor?.idempotencyStore,
    audit: options.executor?.audit,
    requestIdFactory: options.executor?.requestIdFactory,
  });

  const hubAdapter = hubAdapterFromClient(options.hub);

  async function buildContext(
    action?: AgentActionEnvelope,
  ): Promise<AgentSdkContext> {
    let projectAdapter: AgentProjectAdapter | undefined;
    if (options.project) {
      projectAdapter = projectAdapterFromClient(options.project);
    } else if (options.projectResolver) {
      const projectId = projectIdFromAction(action, options.defaults);
      if (projectId) {
        const projectClient = await options.projectResolver(projectId);
        projectAdapter = projectAdapterFromClient(projectClient);
      }
    }

    return {
      adapters: {
        hub: hubAdapter,
        project: projectAdapter,
      },
      defaults: options.defaults,
    };
  }

  async function execute({
    action,
    actor,
    confirmationToken,
    signal,
    now,
    context,
  }: AgentSdkBridgeExecuteInput): Promise<AgentActionResult> {
    const resolvedContext = context ?? (await buildContext(action));
    return await executor.execute({
      action,
      actor,
      context: resolvedContext,
      confirmationToken,
      signal,
      now,
    });
  }

  function manifest() {
    return buildCapabilityManifest(registry);
  }

  return {
    registry,
    executor,
    buildContext,
    execute,
    manifest,
  };
}

export function createPlusAgentSdkBridge(options: {
  hub: HubClientLike;
  project: ProjectClientLike;
  defaults?: AgentSdkContext["defaults"];
  executor?: CreateAgentSdkBridgeOptions["executor"];
}): AgentSdkBridge {
  return createAgentSdkBridge({
    hub: options.hub,
    project: options.project,
    defaults: options.defaults,
    executor: options.executor,
  });
}

export function createLaunchpadAgentSdkBridge(options: {
  hub: HubClientLike;
  projectResolver: AgentSdkProjectResolver;
  defaults?: AgentSdkContext["defaults"];
  executor?: CreateAgentSdkBridgeOptions["executor"];
}): AgentSdkBridge {
  return createAgentSdkBridge({
    hub: options.hub,
    projectResolver: options.projectResolver,
    defaults: options.defaults,
    executor: options.executor,
  });
}
