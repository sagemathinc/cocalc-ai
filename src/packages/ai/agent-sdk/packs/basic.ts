/*
Initial basic capability pack backed by hub/project adapters.
*/

import type { AgentCapabilityRegistry } from "../capabilities";
import {
  requireFsAdapter,
  requireHubAdapter,
  requireProjectAdapter,
  type AgentSdkContext,
} from "../adapters";
import { z } from "zod";

const pingArgsSchema = z
  .union([z.null(), z.undefined(), z.object({}).strict()])
  .transform((value) => (value == null ? undefined : value));
type PingArgs = z.infer<typeof pingArgsSchema>;

const getCustomizeArgsSchema = z.object({
  fields: z.array(z.string()).optional(),
});
type GetCustomizeArgs = z.infer<typeof getCustomizeArgsSchema>;

const createProjectArgsSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  host_id: z.string().optional(),
  image: z.string().optional(),
  rootfs_image: z.string().optional(),
  region: z.string().optional(),
  start: z.boolean().optional(),
  src_project_id: z.string().optional(),
});
type CreateProjectArgs = z.infer<typeof createProjectArgsSchema>;

const listingArgsSchema = z.object({
  path: z.string(),
  hidden: z.boolean().optional(),
});
type ListingArgs = z.infer<typeof listingArgsSchema>;

const fsReadFileArgsSchema = z.object({
  path: z.string(),
  encoding: z.string().optional(),
});
type FsReadFileArgs = z.infer<typeof fsReadFileArgsSchema>;

const fsWriteFileArgsSchema = z.object({
  path: z.string(),
  data: z.string(),
  saveLast: z.boolean().optional(),
});
type FsWriteFileArgs = z.infer<typeof fsWriteFileArgsSchema>;

const fsReaddirArgsSchema = z.object({
  path: z.string(),
});
type FsReaddirArgs = z.infer<typeof fsReaddirArgsSchema>;

const fsMoveArgsSchema = z.object({
  src: z.union([z.string(), z.array(z.string()).nonempty()]),
  dest: z.string(),
  overwrite: z.boolean().optional(),
});
type FsMoveArgs = z.infer<typeof fsMoveArgsSchema>;

const fsRenameArgsSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
});
type FsRenameArgs = z.infer<typeof fsRenameArgsSchema>;

const fsRealpathArgsSchema = z.object({
  path: z.string(),
});
type FsRealpathArgs = z.infer<typeof fsRealpathArgsSchema>;

const writeTextFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});
type WriteTextFileArgs = z.infer<typeof writeTextFileArgsSchema>;

const appNameArgsSchema = z.object({
  name: z.string(),
});
type AppNameArgs = z.infer<typeof appNameArgsSchema>;

function toArgsSchema(schema: z.ZodTypeAny): unknown | undefined {
  try {
    return z.toJSONSchema(schema, { io: "input" });
  } catch {
    return undefined;
  }
}

const getCustomizeArgsManifestSchema = toArgsSchema(getCustomizeArgsSchema);
const createProjectArgsManifestSchema = toArgsSchema(createProjectArgsSchema);
const listingArgsManifestSchema = toArgsSchema(listingArgsSchema);
const writeTextFileArgsManifestSchema = toArgsSchema(writeTextFileArgsSchema);
const fsReadFileArgsManifestSchema = toArgsSchema(fsReadFileArgsSchema);
const fsWriteFileArgsManifestSchema = toArgsSchema(fsWriteFileArgsSchema);
const fsReaddirArgsManifestSchema = toArgsSchema(fsReaddirArgsSchema);
const fsRenameArgsManifestSchema = toArgsSchema(fsRenameArgsSchema);
const fsMoveArgsManifestSchema = toArgsSchema(fsMoveArgsSchema);
const fsRealpathArgsManifestSchema = toArgsSchema(fsRealpathArgsSchema);
const appNameArgsManifestSchema = toArgsSchema(appNameArgsSchema);

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.path.length === 0) {
        return issue.message;
      }
      return `${issue.path.join(".")}: ${issue.message}`;
    })
    .join("; ");
}

function parseWithSchema<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (result.success) {
    return result.data;
  }
  throw new Error(formatZodError(result.error));
}

function parsePingArgs(args: unknown): PingArgs {
  return parseWithSchema(pingArgsSchema, args);
}

function parseGetCustomizeArgs(args: unknown): GetCustomizeArgs {
  if (args == null) {
    return {};
  }
  return parseWithSchema(getCustomizeArgsSchema, args);
}

function parseCreateProjectArgs(args: unknown): CreateProjectArgs {
  return parseWithSchema(createProjectArgsSchema, args);
}

function parseListingArgs(args: unknown): ListingArgs {
  return parseWithSchema(listingArgsSchema, args);
}

function parseWriteTextArgs(args: unknown): WriteTextFileArgs {
  return parseWithSchema(writeTextFileArgsSchema, args);
}

function parseFsReadFileArgs(args: unknown): FsReadFileArgs {
  return parseWithSchema(fsReadFileArgsSchema, args);
}

function parseFsWriteFileArgs(args: unknown): FsWriteFileArgs {
  return parseWithSchema(fsWriteFileArgsSchema, args);
}

function parseFsReaddirArgs(args: unknown): FsReaddirArgs {
  return parseWithSchema(fsReaddirArgsSchema, args);
}

function parseFsMoveArgs(args: unknown): FsMoveArgs {
  return parseWithSchema(fsMoveArgsSchema, args);
}

function parseFsRenameArgs(args: unknown): FsRenameArgs {
  return parseWithSchema(fsRenameArgsSchema, args);
}

function parseFsRealpathArgs(args: unknown): FsRealpathArgs {
  return parseWithSchema(fsRealpathArgsSchema, args);
}

function parseAppNameArgs(args: unknown): AppNameArgs {
  return parseWithSchema(appNameArgsSchema, args);
}

export function registerBasicCapabilities(
  registry: AgentCapabilityRegistry<AgentSdkContext>,
): AgentCapabilityRegistry<AgentSdkContext> {
  registry.register({
    actionType: "hub.system.ping",
    namespace: "hub.system",
    summary: "Ping the hub and return current server time",
    argsSchema: {
      description: "No arguments required",
      oneOf: [{ type: "null" }, { type: "object", additionalProperties: false }],
    },
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
    argsSchema: getCustomizeArgsManifestSchema,
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
    argsSchema: createProjectArgsManifestSchema,
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
    argsSchema: listingArgsManifestSchema,
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
    argsSchema: writeTextFileArgsManifestSchema,
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
    actionType: "project.fs.readFile",
    namespace: "project.fs",
    summary: "Read a file using the project fs API",
    argsSchema: fsReadFileArgsManifestSchema,
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseFsReadFileArgs,
    handler: async ({ path, encoding }, { context }) => {
      const fs = requireFsAdapter(context);
      const data = await fs.readFile(path, encoding);
      return { path, data };
    },
  });

  registry.register({
    actionType: "project.fs.writeFile",
    namespace: "project.fs",
    summary: "Write a file using the project fs API",
    argsSchema: fsWriteFileArgsManifestSchema,
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseFsWriteFileArgs,
    handler: async ({ path, data, saveLast }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, path, bytes: Buffer.byteLength(data, "utf8") };
      }
      const fs = requireFsAdapter(context);
      await fs.writeFile(path, data, saveLast);
      return { path, bytes: Buffer.byteLength(data, "utf8") };
    },
  });

  registry.register({
    actionType: "project.fs.readdir",
    namespace: "project.fs",
    summary: "Read directory entries using the project fs API",
    argsSchema: fsReaddirArgsManifestSchema,
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseFsReaddirArgs,
    handler: async ({ path }, { context }) => {
      const fs = requireFsAdapter(context);
      const entries = await fs.readdir(path);
      return { path, entries };
    },
  });

  registry.register({
    actionType: "project.fs.rename",
    namespace: "project.fs",
    summary: "Rename or move a file using the project fs API",
    argsSchema: fsRenameArgsManifestSchema,
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseFsRenameArgs,
    handler: async ({ oldPath, newPath }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, oldPath, newPath };
      }
      const fs = requireFsAdapter(context);
      await fs.rename(oldPath, newPath);
      return { renamed: true, oldPath, newPath };
    },
  });

  registry.register({
    actionType: "project.fs.move",
    namespace: "project.fs",
    summary: "Move files using the project fs API",
    argsSchema: fsMoveArgsManifestSchema,
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseFsMoveArgs,
    handler: async ({ src, dest, overwrite }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, src, dest, overwrite };
      }
      const fs = requireFsAdapter(context);
      await fs.move(src, dest, { overwrite });
      return { moved: true, src, dest, overwrite };
    },
  });

  registry.register({
    actionType: "project.fs.realpath",
    namespace: "project.fs",
    summary: "Resolve real path using the project fs API",
    argsSchema: fsRealpathArgsManifestSchema,
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseFsRealpathArgs,
    handler: async ({ path }, { context }) => {
      const fs = requireFsAdapter(context);
      const resolved = await fs.realpath(path);
      return { path, resolved };
    },
  });

  registry.register({
    actionType: "project.apps.status",
    namespace: "project.apps",
    summary: "Get status of a named project app server",
    argsSchema: appNameArgsManifestSchema,
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
    argsSchema: appNameArgsManifestSchema,
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
    argsSchema: appNameArgsManifestSchema,
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
