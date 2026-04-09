import { resolve as resolvePath } from "node:path";

import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { forkAcpSession } from "@cocalc/conat/ai/acp/client";
import {
  importChatBundle,
  importTaskBundle,
  type ChatImportResult,
  type TaskImportResult,
} from "@cocalc/export";

export type ImportProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type ImportPathOptions = {
  cwd?: string;
};

type ResolveProjectConatClient<Ctx, Project extends ImportProjectIdentity> = (
  ctx: Ctx,
  projectIdentifier?: string,
  cwd?: string,
) => Promise<{ project: Project; client: ConatClient }>;

type ImportDefaults = {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  accountId?: string;
};

export type BackendTaskImportOptions = ImportPathOptions & {
  sourcePath: string;
  targetPath?: string;
  dryRun?: boolean;
};

export type BackendChatImportOptions = ImportPathOptions & {
  sourcePath: string;
  targetPath?: string;
  projectId?: string;
  apiBaseUrl?: string;
  blobBearerToken?: string;
};

export interface ImportApi<Ctx> {
  chat(ctx: Ctx, options: BackendChatImportOptions): Promise<ChatImportResult>;
  tasks(ctx: Ctx, options: BackendTaskImportOptions): Promise<TaskImportResult>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveFsPath(input: string, cwd?: string): string {
  const trimmed = `${input ?? ""}`.trim();
  if (!trimmed) throw new Error("path is required");
  return resolvePath(cwd ?? process.cwd(), trimmed);
}

export function createImportApi<
  Ctx,
  Project extends ImportProjectIdentity = ImportProjectIdentity,
>({
  getDefaults,
  resolveProjectConatClient,
}: {
  getDefaults?: (ctx: Ctx) => ImportDefaults;
  resolveProjectConatClient?: ResolveProjectConatClient<Ctx, Project>;
} = {}): ImportApi<Ctx> {
  return {
    async chat(
      ctx: Ctx,
      options: BackendChatImportOptions,
    ): Promise<ChatImportResult> {
      const defaults = getDefaults?.(ctx) ?? {};
      const sourcePath = resolveFsPath(options.sourcePath, options.cwd);
      const targetPath = options.targetPath
        ? resolveFsPath(options.targetPath, options.cwd)
        : undefined;
      const requestedProject = normalizeOptionalString(options.projectId);
      const defaultProject = normalizeOptionalString(defaults.projectId);
      const projectIdentifier = requestedProject ?? defaultProject;

      let resolvedProject: Project | undefined;
      let projectClient: ConatClient | undefined;
      if (resolveProjectConatClient && projectIdentifier) {
        const resolved = await resolveProjectConatClient(
          ctx,
          projectIdentifier,
          options.cwd,
        );
        resolvedProject = resolved.project;
        projectClient = resolved.client;
      }

      const accountId = normalizeOptionalString(defaults.accountId);
      return await importChatBundle({
        sourcePath,
        targetPath,
        projectId:
          normalizeOptionalString(resolvedProject?.project_id) ??
          projectIdentifier,
        accountId,
        apiBaseUrl:
          normalizeOptionalString(options.apiBaseUrl) ??
          normalizeOptionalString(defaults.apiBaseUrl),
        blobBearerToken:
          normalizeOptionalString(options.blobBearerToken) ??
          normalizeOptionalString(defaults.bearer),
        forkCodexSession:
          resolvedProject && projectClient
            ? async ({ seedSessionId, accountId: callbackAccountId }) => {
                const nextAccountId =
                  normalizeOptionalString(callbackAccountId) ?? accountId;
                if (!nextAccountId) {
                  throw new Error(
                    "account id is required to fork imported Codex context",
                  );
                }
                return await forkAcpSession(
                  {
                    project_id: resolvedProject.project_id,
                    account_id: nextAccountId,
                    sessionId: seedSessionId,
                  },
                  projectClient,
                );
              }
            : undefined,
      });
    },
    async tasks(
      _ctx: Ctx,
      options: BackendTaskImportOptions,
    ): Promise<TaskImportResult> {
      return await importTaskBundle({
        sourcePath: resolveFsPath(options.sourcePath, options.cwd),
        targetPath: options.targetPath
          ? resolveFsPath(options.targetPath, options.cwd)
          : undefined,
        dryRun: options.dryRun === true,
      });
    },
  };
}
