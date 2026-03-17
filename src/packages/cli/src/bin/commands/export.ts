import { mkdir, writeFile } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";

import { Command } from "commander";

import {
  bundleToZipBuffer,
  collectChatExport,
  collectTaskExport,
  collectWhiteboardExport,
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

type GenericFileExportCliOptions = {
  out?: string;
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
  const exportCommand = program
    .command("export")
    .description(
      "export structured CoCalc documents as portable archive bundles",
    )
    .addHelpText(
      "after",
      `
Export is intended to be both user-facing and agent-facing.

- Use it to produce self-contained archives with human-readable transcripts and machine-readable metadata.
- Prefer it when an agent needs to solve a problem outside the live CoCalc UI, e.g. analysis, conversion, reporting, or handing the document to other tools.
- Structured exports are better long-term inputs for automation than screen scraping or ad hoc markdown dumps.
- Export runs against local files in the current environment. It does not stream document contents through the CLI service; the main network use is optional blob fetching when requested by an exporter.
`,
    );

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
    .addHelpText(
      "after",
      `
Chat export bundles include:

- human-readable thread transcripts
- machine-readable thread/message metadata
- archived/offloaded chat messages for the selected threads
- optional copied blobs/assets when --include-blobs is used

Codex activity/thinking logs are intentionally excluded.

Implementation note:

- cocalc export chat reads the .chat file and archived SQLite store locally in the environment where the command runs.
- It does not copy the chat document over RPC/websocket first.
- Network access is only needed when the exporter fetches blob URLs for --include-blobs.

This command is designed for automation. Agents should prefer it when they need
to inspect, transform, summarize, migrate, or hand chat data to external tools.

Examples:

  cocalc export chat ./notes.chat --scope current-thread --thread-id <thread-id>
  cocalc export chat ./notes.chat --scope all-threads --include-blobs --out notes-export.zip
`,
    )
    .action(
      async (
        chatPath: string,
        opts: ChatExportCliOptions,
        command: Command,
      ) => {
        const globals = deps.globalsFrom(command);
        const commandName = "export chat";
        try {
          const scope = parseScope(opts.scope);
          const zipLevel = parseZipLevel(opts.zipLevel);
          const outputPath = resolve(
            opts.out ??
              defaultChatExportOutputPath(chatPath, scope, opts.threadId),
          );
          const blobBaseUrl = normalizeOptionalUrl(
            opts.blobBaseUrl ?? process.env.COCALC_API_URL ?? globals.api,
            deps.normalizeUrl,
          );
          const blobBearerToken = normalizeOptionalString(
            opts.blobBearerToken ??
              process.env.COCALC_BEARER_TOKEN ??
              globals.bearer,
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
            warning_count: (bundle.manifest as any)?.warning_count ?? 0,
            bytes: zip.byteLength,
          });
        } catch (error) {
          deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
          process.exitCode = 1;
        }
      },
    );

  exportCommand
    .command("tasks <taskPath>")
    .description("export a task list document as a CoCalc archive bundle")
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
    .addHelpText(
      "after",
      `
Task export bundles include:

- document.json with task counts and hashtags
- document.jsonl with the underlying task rows
- tasks.jsonl with normalized agent-friendly task records
- tasks.md as a human-readable markdown rendering
- optional copied blobs/assets when --include-blobs is used
`,
    )
    .action(
      async (
        taskPath: string,
        opts: GenericFileExportCliOptions,
        command: Command,
      ) => {
        await runBundleExport({
          command,
          commandName: "export tasks",
          out: opts.out,
          zipLevel: opts.zipLevel,
          buildBundle: async (globals) =>
            collectTaskExport({
              taskPath: resolve(taskPath),
              includeBlobs: opts.includeBlobs === true,
              blobBaseUrl: normalizeOptionalUrl(
                opts.blobBaseUrl ?? process.env.COCALC_API_URL ?? globals.api,
                deps.normalizeUrl,
              ),
              blobBearerToken: normalizeOptionalString(
                opts.blobBearerToken ??
                  process.env.COCALC_BEARER_TOKEN ??
                  globals.bearer,
              ),
            }),
          defaultOutputPath: () =>
            defaultDocumentExportOutputPath(taskPath, "tasks"),
          deps,
        });
      },
    );

  exportCommand
    .command("board <boardPath>")
    .description("export a whiteboard document as a CoCalc archive bundle")
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
    .addHelpText(
      "after",
      `
Board export bundles include:

- document.json and document.jsonl for reconstruction
- pages/index.json and per-page directories
- page content rendered as markdown in reading order
- optional copied blobs/assets when --include-blobs is used
`,
    )
    .action(
      async (
        boardPath: string,
        opts: GenericFileExportCliOptions,
        command: Command,
      ) => {
        await runBundleExport({
          command,
          commandName: "export board",
          out: opts.out,
          zipLevel: opts.zipLevel,
          buildBundle: async (globals) =>
            collectWhiteboardExport({
              documentPath: resolve(boardPath),
              kind: "board",
              includeBlobs: opts.includeBlobs === true,
              blobBaseUrl: normalizeOptionalUrl(
                opts.blobBaseUrl ?? process.env.COCALC_API_URL ?? globals.api,
                deps.normalizeUrl,
              ),
              blobBearerToken: normalizeOptionalString(
                opts.blobBearerToken ??
                  process.env.COCALC_BEARER_TOKEN ??
                  globals.bearer,
              ),
            }),
          defaultOutputPath: () =>
            defaultDocumentExportOutputPath(boardPath, "board"),
          deps,
        });
      },
    );

  exportCommand
    .command("slides <slidesPath>")
    .description("export a slides document as a CoCalc archive bundle")
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
    .addHelpText(
      "after",
      `
Slides export bundles include:

- document.json and document.jsonl for reconstruction
- pages/index.json and per-slide directories
- slide markdown content plus speaker-notes markdown
- optional copied blobs/assets when --include-blobs is used
`,
    )
    .action(
      async (
        slidesPath: string,
        opts: GenericFileExportCliOptions,
        command: Command,
      ) => {
        await runBundleExport({
          command,
          commandName: "export slides",
          out: opts.out,
          zipLevel: opts.zipLevel,
          buildBundle: async (globals) =>
            collectWhiteboardExport({
              documentPath: resolve(slidesPath),
              kind: "slides",
              includeBlobs: opts.includeBlobs === true,
              blobBaseUrl: normalizeOptionalUrl(
                opts.blobBaseUrl ?? process.env.COCALC_API_URL ?? globals.api,
                deps.normalizeUrl,
              ),
              blobBearerToken: normalizeOptionalString(
                opts.blobBearerToken ??
                  process.env.COCALC_BEARER_TOKEN ??
                  globals.bearer,
              ),
            }),
          defaultOutputPath: () =>
            defaultDocumentExportOutputPath(slidesPath, "slides"),
          deps,
        });
      },
    );

  return exportCommand;
}

async function runBundleExport({
  command,
  commandName,
  out,
  zipLevel,
  buildBundle,
  defaultOutputPath,
  deps,
}: {
  command: Command;
  commandName: string;
  out?: string;
  zipLevel?: string;
  buildBundle: (globals: any) => Promise<any>;
  defaultOutputPath: () => string;
  deps: ExportCommandDeps;
}): Promise<void> {
  const globals = deps.globalsFrom(command);
  try {
    const parsedZipLevel = parseZipLevel(zipLevel);
    const outputPath = resolve(out ?? defaultOutputPath());
    const bundle = await buildBundle(globals);
    const zip = bundleToZipBuffer(bundle, { level: parsedZipLevel });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, zip);
    deps.emitSuccess({ globals }, commandName, {
      output_path: outputPath,
      kind: bundle.manifest.kind,
      bytes: zip.byteLength,
      asset_count: (bundle.manifest as any)?.asset_count ?? 0,
      task_count: (bundle.manifest as any)?.task_count,
      page_count: (bundle.manifest as any)?.page_count,
    });
  } catch (error) {
    deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
    process.exitCode = 1;
  }
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

function parseZipLevel(
  value: string | undefined,
): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
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

function normalizeOptionalUrl(
  value: unknown,
  normalizeUrl: any,
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return undefined;
  return normalizeUrl(trimmed);
}

function defaultChatExportOutputPath(
  chatPath: string,
  scope: ChatExportScope,
  threadId?: string,
): string {
  const name = basename(chatPath) || "chat.chat";
  const scopeSuffix =
    scope === "current-thread"
      ? `.${sanitizeFilename(threadId || "thread")}`
      : scope === "all-threads"
        ? ".all-threads"
        : ".threads";
  return resolve(dirname(chatPath), `${name}${scopeSuffix}.cocalc-export.zip`);
}

function defaultDocumentExportOutputPath(
  documentPath: string,
  kind: string,
): string {
  const name = basename(documentPath) || kind;
  return resolve(dirname(documentPath), `${name}.cocalc-export.zip`);
}

function sanitizeFilename(value: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return "thread";
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
}
