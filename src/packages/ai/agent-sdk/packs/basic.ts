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

const fsMethodSchema = z.enum([
  "readFile",
  "writeFile",
  "readdir",
  "rename",
  "move",
  "realpath",
]);
type FsMethod = z.infer<typeof fsMethodSchema>;

const fsCallArgsSchema = z.object({
  method: fsMethodSchema,
  args: z.array(z.unknown()).default([]),
});
type FsCallArgs = z.infer<typeof fsCallArgsSchema>;

const fsReadTextArgsSchema = z.object({
  path: z.string(),
  encoding: z.string().optional(),
});
type FsReadTextArgs = z.infer<typeof fsReadTextArgsSchema>;

const fsWriteTextArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  saveLast: z.boolean().optional(),
});
type FsWriteTextArgs = z.infer<typeof fsWriteTextArgsSchema>;

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
const fsCallArgsManifestSchema = toArgsSchema(fsCallArgsSchema);
const fsReadTextArgsManifestSchema = toArgsSchema(fsReadTextArgsSchema);
const fsWriteTextArgsManifestSchema = toArgsSchema(fsWriteTextArgsSchema);
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

function parseFsCallArgs(args: unknown): FsCallArgs {
  return parseWithSchema(fsCallArgsSchema, args);
}

function parseFsReadTextArgs(args: unknown): FsReadTextArgs {
  return parseWithSchema(fsReadTextArgsSchema, args);
}

function parseFsWriteTextArgs(args: unknown): FsWriteTextArgs {
  return parseWithSchema(fsWriteTextArgsSchema, args);
}

function parseAppNameArgs(args: unknown): AppNameArgs {
  return parseWithSchema(appNameArgsSchema, args);
}

function isFsWriteMethod(method: FsMethod): boolean {
  return method === "writeFile" || method === "rename" || method === "move";
}

function asText(data: string | Buffer, encoding = "utf8"): string {
  if (typeof data === "string") {
    return data;
  }
  try {
    return data.toString(encoding as BufferEncoding);
  } catch {
    return data.toString("utf8");
  }
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
    actionType: "project.fs.call",
    namespace: "project.fs",
    summary:
      "Generic Node.js-style fs call over the project adapter (method + args)",
    argsSchema: fsCallArgsManifestSchema,
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseFsCallArgs,
    handler: async ({ method, args }, { context, dryRun }) => {
      const fs = requireFsAdapter(context);
      if (dryRun && isFsWriteMethod(method)) {
        return { dryRun: true, method, args };
      }
      switch (method) {
        case "readFile": {
          const [path, encoding] = parseWithSchema(
            z.tuple([z.string(), z.string().optional()]),
            args,
          );
          const result = await fs.readFile(path, encoding);
          return { method, args: [path, encoding], result };
        }
        case "writeFile": {
          const [path, data, saveLast] = parseWithSchema(
            z.tuple([z.string(), z.string(), z.boolean().optional()]),
            args,
          );
          await fs.writeFile(path, data, saveLast);
          return { method, args: [path, data, saveLast], result: undefined };
        }
        case "readdir": {
          const [path, options] = parseWithSchema(
            z.tuple([z.string(), z.unknown().optional()]),
            args,
          );
          const result = await fs.readdir(path, options);
          return { method, args: [path, options], result };
        }
        case "rename": {
          const [oldPath, newPath] = parseWithSchema(
            z.tuple([z.string(), z.string()]),
            args,
          );
          await fs.rename(oldPath, newPath);
          return { method, args: [oldPath, newPath], result: undefined };
        }
        case "move": {
          const [src, dest, options] = parseWithSchema(
            z.tuple([
              z.union([z.string(), z.array(z.string()).nonempty()]),
              z.string(),
              z.object({ overwrite: z.boolean().optional() }).optional(),
            ]),
            args,
          );
          await fs.move(src, dest, options);
          return { method, args: [src, dest, options], result: undefined };
        }
        case "realpath": {
          const [path] = parseWithSchema(z.tuple([z.string()]), args);
          const result = await fs.realpath(path);
          return { method, args: [path], result };
        }
      }
    },
  });

  registry.register({
    actionType: "project.fs.readText",
    namespace: "project.fs",
    summary: "Read a text file (UTF-8 by default)",
    argsSchema: fsReadTextArgsManifestSchema,
    riskLevel: "read",
    sideEffectScope: "project",
    validateArgs: parseFsReadTextArgs,
    handler: async ({ path, encoding }, { context }) => {
      const fs = requireFsAdapter(context);
      const resolvedEncoding = encoding ?? "utf8";
      const data = await fs.readFile(path, resolvedEncoding);
      return {
        path,
        encoding: resolvedEncoding,
        text: asText(data, resolvedEncoding),
      };
    },
  });

  registry.register({
    actionType: "project.fs.writeText",
    namespace: "project.fs",
    summary: "Write text file content (UTF-8)",
    argsSchema: fsWriteTextArgsManifestSchema,
    riskLevel: "write",
    sideEffectScope: "project",
    validateArgs: parseFsWriteTextArgs,
    handler: async ({ path, content, saveLast }, { context, dryRun }) => {
      if (dryRun) {
        return { dryRun: true, path, bytes: Buffer.byteLength(content, "utf8") };
      }
      const fs = requireFsAdapter(context);
      await fs.writeFile(path, content, saveLast);
      return { path, bytes: Buffer.byteLength(content, "utf8") };
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
