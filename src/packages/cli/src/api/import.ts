import { resolve as resolvePath } from "node:path";

import { importTaskBundle, type TaskImportResult } from "@cocalc/export";

export type ImportPathOptions = {
  cwd?: string;
};

export type BackendTaskImportOptions = ImportPathOptions & {
  sourcePath: string;
  targetPath?: string;
  dryRun?: boolean;
};

export interface ImportApi<Ctx> {
  tasks(ctx: Ctx, options: BackendTaskImportOptions): Promise<TaskImportResult>;
}

function resolveFsPath(input: string, cwd?: string): string {
  const trimmed = `${input ?? ""}`.trim();
  if (!trimmed) throw new Error("path is required");
  return resolvePath(cwd ?? process.cwd(), trimmed);
}

export function createImportApi<Ctx>(): ImportApi<Ctx> {
  return {
    async tasks(_ctx: Ctx, options: BackendTaskImportOptions): Promise<TaskImportResult> {
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
