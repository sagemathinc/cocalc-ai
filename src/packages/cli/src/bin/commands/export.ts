import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, basename, resolve } from "node:path";

import { Command } from "commander";

import {
  bundleToZipBuffer,
  collectChatExport,
  type ChatExportOptions,
  type ChatExportScope,
} from "@cocalc/export";

export type ExportCommandDeps = {
  globalsFrom: any;
  emitSuccess: any;
  emitError: any;
  normalizeUrl: any;
};

type ChatExportCliOptions = {
  out?: string;
  scope?: string;
  threadId?: string;
  projectId?: string;
  offloadDb?: string;
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  zipLevel?: string;
};

const CHAT_EXPORT_SCOPES: ChatExportScope[] = [
  "current-thread",
  "all-non-archived-threads",
  "all-threads",
];

export function registerExportCommand(
  program: Command,
  deps: ExportCommandDeps,
): Command {
  const exportCommand = program.command("export").description("export documents");

  exportCommand
    .command("chat <chatPath>")
    .description("export a chat document as a CoCalc archive bundle")
    .option(
      "--scope <scope>",
      "thread scope (current-thread|all-non-archived-threads|all-threads)",
      "all-non-archived-threads",
    )
    .option("--thread-id <threadId>", "thread id for --scope current-thread")
    .option("--project-id <projectId>", "project id to record in the manifest")
    .option("--offload-db <path>", "path to the archived chat sqlite database")
    .option("--include-blobs", "fetch blob references into assets/")
    .option(
      "--blob-base-url <url>",
      "base URL used to resolve relative /blobs/ references (defaults to --api / COCALC_API_URL)",
    )
    .option(
      "--blob-bearer-token <token>",
      "bearer token used when fetching blobs (defaults to --bearer / COCALC_BEARER_TOKEN)",
    )
    .option("--out <path>", "output zip path")
    .option("--zip-level <n>", "zip compression level 0-9", "6")
    .action(async (chatPath: string, opts: ChatExportCliOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "export chat";
      try {
        const scope = parseScope(opts.scope);
        const zipLevel = parseZipLevel(opts.zipLevel);
        const outputPath = resolve(
          opts.out ?? defaultChatExportOutputPath(chatPath, scope, opts.threadId),
        );
        const blobBaseUrl = normalizeOptionalUrl(
          opts.blobBaseUrl ?? process.env.COCALC_API_URL ?? globals.api,
          deps.normalizeUrl,
        );
        const blobBearerToken = normalizeOptionalString(
          opts.blobBearerToken ?? process.env.COCALC_BEARER_TOKEN ?? globals.bearer,
        );
        const projectId = normalizeOptionalString(
          opts.projectId ?? process.env.COCALC_PROJECT_ID,
        );
        const exportOptions: ChatExportOptions = {
          chatPath: resolve(chatPath),
          scope,
          threadId: normalizeOptionalString(opts.threadId),
          projectId,
          offloadDbPath: normalizeOptionalString(opts.offloadDb),
          includeBlobs: opts.includeBlobs === true,
          blobBaseUrl,
          blobBearerToken,
        };
        const bundle = await collectChatExport(exportOptions);
        const zip = bundleToZipBuffer(bundle, { level: zipLevel });
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, zip);
        deps.emitSuccess({ globals }, commandName, {
          output_path: outputPath,
          scope,
          thread_ids: (bundle.manifest as any)?.scope?.thread_ids ?? [],
          thread_count: (bundle.manifest as any)?.thread_count ?? 0,
          message_count: (bundle.manifest as any)?.message_count ?? 0,
          asset_count: (bundle.manifest as any)?.asset_count ?? 0,
          bytes: zip.byteLength,
        });
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

  return exportCommand;
}

function parseScope(value: string | undefined): ChatExportScope {
  const scope = `${value ?? ""}`.trim() as ChatExportScope;
  if (CHAT_EXPORT_SCOPES.includes(scope)) {
    return scope;
  }
  throw new Error(
    `invalid --scope ${JSON.stringify(value)}; expected one of ${CHAT_EXPORT_SCOPES.join(", ")}`,
  );
}

function parseZipLevel(value: string | undefined): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const parsed = Number(value ?? "6");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9) {
    throw new Error("--zip-level must be an integer from 0 to 9");
  }
  return parsed as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalUrl(value: unknown, normalizeUrl: any): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  return normalizeUrl(trimmed);
}

function defaultChatExportOutputPath(
  chatPath: string,
  scope: ChatExportScope,
  threadId?: string,
): string {
  const extension = extname(chatPath);
  const stem = basename(chatPath, extension || undefined) || "chat";
  const scopeSuffix =
    scope === "current-thread"
      ? `.${sanitizeFilename(threadId || "thread")}`
      : scope === "all-threads"
        ? ".all-threads"
        : ".threads";
  return resolve(dirname(chatPath), `${stem}${scopeSuffix}.cocalc-export.zip`);
}

function sanitizeFilename(value: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return "thread";
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
}
