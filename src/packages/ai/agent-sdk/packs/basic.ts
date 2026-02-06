/*
Initial basic capability pack backed by hub/project adapters.
*/

import type { AgentCapabilityRegistry } from "../capabilities";
import {
  requireHubAdapter,
  requireProjectAdapter,
  type AgentSdkContext,
} from "../adapters";

type PingArgs = Record<string, never> | undefined;

type GetCustomizeArgs = {
  fields?: string[];
};

type CreateProjectArgs = {
  title?: string;
  description?: string;
  host_id?: string;
  image?: string;
  rootfs_image?: string;
  region?: string;
  start?: boolean;
  src_project_id?: string;
};

type ListingArgs = {
  path: string;
  hidden?: boolean;
};

type WriteTextFileArgs = {
  path: string;
  content: string;
};

type AppNameArgs = {
  name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function asString(
  value: unknown,
  field: string,
  opts: { optional?: boolean } = {},
): string {
  if (value == null && opts.optional) {
    return value as any;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function parsePingArgs(args: unknown): PingArgs {
  if (args == null) {
    return undefined;
  }
  if (isRecord(args) && Object.keys(args).length === 0) {
    return {};
  }
  throw new Error("ping does not accept arguments");
}

function parseGetCustomizeArgs(args: unknown): GetCustomizeArgs {
  if (args == null) {
    return {};
  }
  if (!isRecord(args)) {
    throw new Error("args must be an object");
  }
  const { fields } = args;
  if (fields != null) {
    if (!Array.isArray(fields) || fields.some((x) => typeof x !== "string")) {
      throw new Error("fields must be an array of strings");
    }
  }
  return { fields: fields as string[] | undefined };
}

function parseCreateProjectArgs(args: unknown): CreateProjectArgs {
  if (!isRecord(args)) {
    throw new Error("args must be an object");
  }
  const title = asString(args.title, "title", { optional: true });
  const description = asString(args.description, "description", {
    optional: true,
  });
  const host_id = asString(args.host_id, "host_id", { optional: true });
  const image = asString(args.image, "image", { optional: true });
  const rootfs_image = asString(args.rootfs_image, "rootfs_image", {
    optional: true,
  });
  const region = asString(args.region, "region", { optional: true });
  const src_project_id = asString(args.src_project_id, "src_project_id", {
    optional: true,
  });
  const start =
    args.start == null
      ? undefined
      : typeof args.start === "boolean"
        ? args.start
        : (() => {
            throw new Error("start must be a boolean");
          })();
  return {
    title,
    description,
    host_id,
    image,
    rootfs_image,
    region,
    start,
    src_project_id,
  };
}

function parseListingArgs(args: unknown): ListingArgs {
  if (!isRecord(args)) {
    throw new Error("args must be an object");
  }
  const path = asString(args.path, "path");
  const hidden =
    args.hidden == null
      ? undefined
      : typeof args.hidden === "boolean"
        ? args.hidden
        : (() => {
            throw new Error("hidden must be a boolean");
          })();
  return { path, hidden };
}

function parseWriteTextArgs(args: unknown): WriteTextFileArgs {
  if (!isRecord(args)) {
    throw new Error("args must be an object");
  }
  const path = asString(args.path, "path");
  const content = asString(args.content, "content");
  return { path, content };
}

function parseAppNameArgs(args: unknown): AppNameArgs {
  if (!isRecord(args)) {
    throw new Error("args must be an object");
  }
  return { name: asString(args.name, "name") };
}

export function registerBasicCapabilities(
  registry: AgentCapabilityRegistry<AgentSdkContext>,
): AgentCapabilityRegistry<AgentSdkContext> {
  registry.register({
    actionType: "hub.system.ping",
    namespace: "hub.system",
    summary: "Ping the hub and return current server time",
    riskLevel: "read",
    sideEffectScope: "system",
    validateArgs: parsePingArgs,
    handler: async (_args, { context }) => {
      const hub = requireHubAdapter(context);
      return await hub.ping();
    },
  });

  registry.register({
    actionType: "hub.system.get_customize",
    namespace: "hub.system",
    summary: "Read customize/site settings keys",
    riskLevel: "read",
    sideEffectScope: "system",
    validateArgs: parseGetCustomizeArgs,
    handler: async ({ fields }, { context }) => {
      const hub = requireHubAdapter(context);
      return await hub.getCustomize(fields);
    },
  });

  registry.register({
    actionType: "hub.projects.create",
    namespace: "hub.projects",
    summary: "Create a new project",
    riskLevel: "write",
    sideEffectScope: "workspace",
    validateArgs: parseCreateProjectArgs,
    handler: async (args, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, args };
      }
      const hub = requireHubAdapter(context);
      const project_id = await hub.createProject(args);
      return { project_id };
    },
  });

  registry.register({
    actionType: "project.system.listing",
    namespace: "project.system",
    summary: "List files in a project path",
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseListingArgs,
    handler: async ({ path, hidden }, { context }) => {
      const project = requireProjectAdapter(context);
      return await project.listing({ path, hidden });
    },
  });

  registry.register({
    actionType: "project.system.write_text_file",
    namespace: "project.system",
    summary: "Write text content to a project file",
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseWriteTextArgs,
    handler: async ({ path, content }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, path, bytes: Buffer.byteLength(content, "utf8") };
      }
      const project = requireProjectAdapter(context);
      await project.writeTextFileToProject({ path, content });
      return { path, bytes: Buffer.byteLength(content, "utf8") };
    },
  });

  registry.register({
    actionType: "project.apps.status",
    namespace: "project.apps",
    summary: "Get status of a named project app server",
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseAppNameArgs,
    handler: async ({ name }, { context }) => {
      const project = requireProjectAdapter(context);
      return await project.apps.status(name);
    },
  });

  registry.register({
    actionType: "project.apps.start",
    namespace: "project.apps",
    summary: "Start a named project app server",
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseAppNameArgs,
    handler: async ({ name }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, name };
      }
      const project = requireProjectAdapter(context);
      return await project.apps.start(name);
    },
  });

  registry.register({
    actionType: "project.apps.stop",
    namespace: "project.apps",
    summary: "Stop a named project app server",
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseAppNameArgs,
    handler: async ({ name }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, name };
      }
      const project = requireProjectAdapter(context);
      await project.apps.stop(name);
      return { stopped: true, name };
    },
  });

  return registry;
}

