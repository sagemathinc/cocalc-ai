import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath } from "node:path";

import {
  bundleToZipBuffer,
  collectChatExport,
  collectTaskExport,
  collectWhiteboardExport,
  type ChatExportOptions,
} from "@cocalc/export";

export type ExportProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type ExportSummary = {
  kind: string;
  outputPath: string;
  bytes: number;
  assetCount: number;
  rootDir?: string;
  manifest: Record<string, unknown>;
};

export type ChatExportSummary = ExportSummary & {
  kind: "chat";
  threadCount?: number;
  messageCount?: number;
};

export type TasksExportSummary = ExportSummary & {
  kind: "tasks";
  taskCount?: number;
};

export type WhiteboardExportSummary = ExportSummary & {
  kind: "board" | "slides";
  pageCount?: number;
};

export type ExportPathOptions = {
  cwd?: string;
};

export type BackendChatExportOptions = ExportPathOptions & {
  path: string;
  out?: string;
  scope?: "current-thread" | "all-non-archived-threads" | "all-threads";
  threadId?: string;
  projectId?: string;
  offloadDbPath?: string;
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
};

export type BackendDocumentExportOptions = ExportPathOptions & {
  path: string;
  out?: string;
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  zipLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
};

export interface ExportApi<Ctx> {
  chat(ctx: Ctx, options: BackendChatExportOptions): Promise<ChatExportSummary>;
  tasks(
    ctx: Ctx,
    options: BackendDocumentExportOptions,
  ): Promise<TasksExportSummary>;
  board(
    ctx: Ctx,
    options: BackendDocumentExportOptions,
  ): Promise<WhiteboardExportSummary>;
  slides(
    ctx: Ctx,
    options: BackendDocumentExportOptions,
  ): Promise<WhiteboardExportSummary>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeFilename(value: string, fallback: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-") || fallback;
}

function resolveFsPath(input: string, cwd?: string): string {
  const trimmed = `${input ?? ""}`.trim();
  if (!trimmed) throw new Error("path is required");
  return resolvePath(cwd ?? process.cwd(), trimmed);
}

function parseZipLevel(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const parsed = Number(value ?? 6);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9) {
    throw new Error("zipLevel must be an integer from 0 to 9");
  }
  return parsed as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

function defaultChatExportOutputPath(
  chatPath: string,
  scope: "current-thread" | "all-non-archived-threads" | "all-threads",
  threadId?: string,
): string {
  const name = basename(chatPath) || "chat.chat";
  const scopeSuffix =
    scope === "current-thread"
      ? `.${sanitizeFilename(threadId || "thread", "thread")}`
      : scope === "all-threads"
        ? ".all-threads"
        : ".threads";
  return resolvePath(
    dirname(chatPath),
    `${name}${scopeSuffix}.cocalc-export.zip`,
  );
}

function defaultDocumentExportOutputPath(documentPath: string): string {
  const name = basename(documentPath) || "document";
  return resolvePath(dirname(documentPath), `${name}.cocalc-export.zip`);
}

export function createExportApi<Ctx>({
  getDefaults,
}: {
  getDefaults: (ctx: Ctx) => {
    apiBaseUrl?: string;
    bearer?: string;
    projectId?: string;
  };
}): ExportApi<Ctx> {
  async function finalizeBundle(args: {
    kind: string;
    out?: string;
    sourcePath: string;
    zipLevel?: unknown;
    bundle: Awaited<ReturnType<typeof collectTaskExport>>;
  }): Promise<ExportSummary> {
    const outputPath = resolveFsPath(
      args.out ?? defaultDocumentExportOutputPath(args.sourcePath),
    );
    const zip = bundleToZipBuffer(args.bundle, {
      level: parseZipLevel(args.zipLevel),
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, zip);
    return {
      kind: args.kind,
      outputPath,
      bytes: zip.byteLength,
      assetCount: Number((args.bundle.manifest as any)?.asset_count ?? 0),
      rootDir: args.bundle.rootDir,
      manifest: args.bundle.manifest as Record<string, unknown>,
    };
  }

  return {
    async chat(
      ctx: Ctx,
      options: BackendChatExportOptions,
    ): Promise<ChatExportSummary> {
      const defaults = getDefaults(ctx);
      const scope = (options.scope ??
        "all-non-archived-threads") as ChatExportOptions["scope"];
      const chatPath = resolveFsPath(options.path, options.cwd);
      const outputPath = resolveFsPath(
        options.out ??
          defaultChatExportOutputPath(chatPath, scope, options.threadId),
        options.cwd,
      );
      const bundle = await collectChatExport({
        chatPath,
        scope,
        threadId: normalizeOptionalString(options.threadId),
        projectId:
          normalizeOptionalString(options.projectId) ??
          normalizeOptionalString(defaults.projectId),
        offloadDbPath: normalizeOptionalString(options.offloadDbPath),
        includeBlobs: options.includeBlobs === true,
        blobBaseUrl:
          normalizeOptionalString(options.blobBaseUrl) ??
          normalizeOptionalString(defaults.apiBaseUrl),
        blobBearerToken:
          normalizeOptionalString(options.blobBearerToken) ??
          normalizeOptionalString(defaults.bearer),
      });
      const zip = bundleToZipBuffer(bundle, {
        level: parseZipLevel(options.zipLevel),
      });
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, zip);
      return {
        kind: "chat",
        outputPath,
        bytes: zip.byteLength,
        assetCount: Number((bundle.manifest as any)?.asset_count ?? 0),
        rootDir: bundle.rootDir,
        manifest: bundle.manifest as Record<string, unknown>,
        threadCount: Number((bundle.manifest as any)?.thread_count ?? 0),
        messageCount: Number((bundle.manifest as any)?.message_count ?? 0),
      };
    },
    async tasks(
      ctx: Ctx,
      options: BackendDocumentExportOptions,
    ): Promise<TasksExportSummary> {
      const defaults = getDefaults(ctx);
      const taskPath = resolveFsPath(options.path, options.cwd);
      const bundle = await collectTaskExport({
        taskPath,
        includeBlobs: options.includeBlobs === true,
        blobBaseUrl:
          normalizeOptionalString(options.blobBaseUrl) ??
          normalizeOptionalString(defaults.apiBaseUrl),
        blobBearerToken:
          normalizeOptionalString(options.blobBearerToken) ??
          normalizeOptionalString(defaults.bearer),
      });
      const result = await finalizeBundle({
        kind: "tasks",
        sourcePath: taskPath,
        out: options.out,
        zipLevel: options.zipLevel,
        bundle,
      });
      return {
        ...result,
        kind: "tasks",
        taskCount: Number((bundle.manifest as any)?.task_count ?? 0),
      };
    },
    async board(
      ctx: Ctx,
      options: BackendDocumentExportOptions,
    ): Promise<WhiteboardExportSummary> {
      const defaults = getDefaults(ctx);
      const documentPath = resolveFsPath(options.path, options.cwd);
      const bundle = await collectWhiteboardExport({
        documentPath,
        kind: "board",
        includeBlobs: options.includeBlobs === true,
        blobBaseUrl:
          normalizeOptionalString(options.blobBaseUrl) ??
          normalizeOptionalString(defaults.apiBaseUrl),
        blobBearerToken:
          normalizeOptionalString(options.blobBearerToken) ??
          normalizeOptionalString(defaults.bearer),
      });
      const result = await finalizeBundle({
        kind: "board",
        sourcePath: documentPath,
        out: options.out,
        zipLevel: options.zipLevel,
        bundle,
      });
      return {
        ...result,
        kind: "board",
        pageCount: Number((bundle.manifest as any)?.page_count ?? 0),
      };
    },
    async slides(
      ctx: Ctx,
      options: BackendDocumentExportOptions,
    ): Promise<WhiteboardExportSummary> {
      const defaults = getDefaults(ctx);
      const documentPath = resolveFsPath(options.path, options.cwd);
      const bundle = await collectWhiteboardExport({
        documentPath,
        kind: "slides",
        includeBlobs: options.includeBlobs === true,
        blobBaseUrl:
          normalizeOptionalString(options.blobBaseUrl) ??
          normalizeOptionalString(defaults.apiBaseUrl),
        blobBearerToken:
          normalizeOptionalString(options.blobBearerToken) ??
          normalizeOptionalString(defaults.bearer),
      });
      const result = await finalizeBundle({
        kind: "slides",
        sourcePath: documentPath,
        out: options.out,
        zipLevel: options.zipLevel,
        bundle,
      });
      return {
        ...result,
        kind: "slides",
        pageCount: Number((bundle.manifest as any)?.page_count ?? 0),
      };
    },
  };
}
