import { spawn } from "node:child_process";

import { Command } from "commander";

import {
  getDocsAction,
  getDocsEntry,
  listDocsActions,
  listDocsEntries,
  searchDocsEntries,
  type DocsActionSummary,
  type DocsActionId,
  type DocsAccess,
  type DocsAudience,
  type DocsEntry,
  type DocsEntryStatus,
  type DocsSearchResult,
} from "@cocalc/docs";
import {
  formatDocsVerificationReport,
  listDocsLiveVerificationScenarios,
  verifyDocsLive,
  verifyDocsStatic,
} from "@cocalc/docs/verification";
import { buildCookieHeader } from "../../core/auth-cookies";

export type DocsCommandDeps = {
  emitError: any;
  emitSuccess: any;
  globalsFrom: any;
  normalizeUrl: any;
};

type DocsListOptions = {
  audience?: string;
  category?: string;
  includeAdmin?: boolean;
  status?: string;
};

type DocsSearchOptions = {
  includeAdmin?: boolean;
  limit?: string;
};

type DocsVerifyOptions = {
  action?: string[];
  browser?: string;
  cocalcBin?: string;
  chromium?: string;
  headed?: boolean;
  hostId?: string;
  keepBrowser?: boolean;
  listLive?: boolean;
  live?: boolean;
  projectId?: string;
  spawnBrowser?: boolean;
  spawnReadyTimeout?: string;
  spawnTimeout?: string;
  targetUrl?: string;
  timeout?: string;
};

type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function compactDocsEntry(entry: DocsEntry): Record<string, unknown> {
  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    category: entry.category,
    status: entry.status,
    visibility: entry.visibility ?? "public",
    audiences: entry.audiences,
    summary: entry.summary,
    actions: entry.actions?.map((action) => action.id) ?? [],
  };
}

function compactDocsAction(action: DocsActionSummary): Record<string, unknown> {
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    executable: action.executable === true,
    entry_id: action.entryId,
    entry_slug: action.entrySlug,
    entry_title: action.entryTitle,
  };
}

function compactSearchResult(entry: DocsSearchResult): Record<string, unknown> {
  return {
    ...compactDocsEntry(entry),
    score: entry.score,
  };
}

function parseLimit(value?: string): number {
  const limit = Number(value ?? 8);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("--limit must be a positive number");
  }
  return Math.min(Math.floor(limit), 100);
}

const DOCS_AUDIENCES: DocsAudience[] = [
  "agents",
  "instructors",
  "researchers",
  "students",
  "teams",
];
const DOCS_STATUSES: DocsEntryStatus[] = ["draft", "ready"];

function parseAudience(value?: string): DocsAudience | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (DOCS_AUDIENCES.includes(normalized as DocsAudience)) {
    return normalized as DocsAudience;
  }
  throw new Error(
    `invalid --audience '${value}'; expected one of ${DOCS_AUDIENCES.join(", ")}`,
  );
}

function parseStatus(value?: string): DocsEntryStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (DOCS_STATUSES.includes(normalized as DocsEntryStatus)) {
    return normalized as DocsEntryStatus;
  }
  throw new Error(
    `invalid --status '${value}'; expected one of ${DOCS_STATUSES.join(", ")}`,
  );
}

function filterDocsEntries(options: DocsListOptions): DocsEntry[] {
  const audience = parseAudience(options.audience);
  const category = options.category?.trim().toLowerCase();
  const status = parseStatus(options.status);
  return listDocsEntries(docsAccessFromOptions(options)).filter((entry) => {
    if (audience && !entry.audiences.includes(audience)) {
      return false;
    }
    if (category && entry.category.toLowerCase() !== category) {
      return false;
    }
    if (status && entry.status !== status) {
      return false;
    }
    return true;
  });
}

function docsAccessFromOptions(options: {
  includeAdmin?: boolean;
}): DocsAccess {
  return {
    includeAdmin: options.includeAdmin === true,
    includeSignedIn: options.includeAdmin === true,
  };
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function runCliCommand({
  args,
  command,
}: {
  args: string[];
  command: string;
}): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(stdout: string): any {
  const text = stdout.trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

function normalizeOrigin(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function projectHomeUrl(origin: string, projectId: string): string {
  return `${origin}/projects/${projectId}/project-home`;
}

async function resolveDocsSpawnTargetUrl({
  explicitTargetUrl,
  globals,
  normalizeUrl,
  projectId,
}: {
  explicitTargetUrl?: string;
  globals: any;
  normalizeUrl: (value: string) => string;
  projectId: string;
}): Promise<string | undefined> {
  const explicit = `${explicitTargetUrl ?? ""}`.trim();
  if (explicit) return explicit;

  const rawApiUrl = `${globals.api ?? process.env.COCALC_API_URL ?? ""}`.trim();
  if (!rawApiUrl) return undefined;
  let apiUrl: string;
  try {
    apiUrl = normalizeUrl(rawApiUrl);
  } catch {
    return undefined;
  }
  const apiOrigin = normalizeOrigin(apiUrl);
  if (!apiOrigin) return undefined;
  const cookie = buildCookieHeader(apiUrl, globals);
  if (!cookie) return undefined;
  try {
    const response = await fetch(`${apiUrl}/api/v2/auth/bootstrap`, {
      headers: { Cookie: cookie },
    });
    if (!response.ok) return undefined;
    const bootstrap = (await response.json()) as {
      signed_in?: boolean;
      home_bay_url?: string;
    };
    const homeOrigin = normalizeOrigin(bootstrap.home_bay_url);
    if (!homeOrigin || homeOrigin === apiOrigin) return undefined;
    return projectHomeUrl(homeOrigin, projectId);
  } catch {
    return undefined;
  }
}

async function spawnDocsVerificationBrowser({
  cocalcArgs,
  cocalcCommand,
  globals,
  normalizeUrl,
  options,
  projectId,
}: {
  cocalcArgs: string[];
  cocalcCommand: string;
  globals: any;
  normalizeUrl: (value: string) => string;
  options: DocsVerifyOptions;
  projectId: string;
}): Promise<{
  browserId: string;
  spawnId: string;
  output: unknown;
  targetUrl?: string;
}> {
  const targetUrl = await resolveDocsSpawnTargetUrl({
    explicitTargetUrl: options.targetUrl,
    globals,
    normalizeUrl,
    projectId,
  });
  const args = [
    ...cocalcArgs,
    "browser",
    "session",
    "spawn",
    "--project-id",
    projectId,
    "--session-name",
    "docs-verification",
    "--ready-timeout",
    `${options.spawnReadyTimeout ?? "60s"}`,
    "--timeout",
    `${options.spawnTimeout ?? "90s"}`,
  ];
  if (targetUrl) {
    args.push("--target-url", targetUrl);
  }
  if (options.chromium?.trim()) {
    args.push("--chromium", options.chromium.trim());
  }
  if (options.headed) {
    args.push("--headed");
  } else {
    args.push("--headless");
  }
  const { code, stdout, stderr } = await runCliCommand({
    args,
    command: cocalcCommand,
  });
  const output = parseJsonOutput(stdout);
  const data =
    output && typeof output === "object" && "data" in output
      ? (output as { data?: any }).data
      : undefined;
  const browserId = `${data?.browser_id ?? ""}`.trim();
  const spawnId = `${data?.spawn_id ?? ""}`.trim();
  if (code !== 0 || !browserId || !spawnId) {
    const message =
      output && typeof output === "object" && "error" in output
        ? `${(output as { error?: { message?: string } }).error?.message ?? ""}`
        : "";
    throw new Error(
      [
        "failed to spawn Chromium browser session for docs verification",
        message,
        stderr.trim(),
        stdout.trim(),
      ]
        .filter(Boolean)
        .join(": "),
    );
  }
  return {
    browserId,
    spawnId,
    output,
    ...(targetUrl ? { targetUrl } : {}),
  };
}

async function destroyDocsVerificationBrowser({
  cocalcArgs,
  cocalcCommand,
  spawnId,
}: {
  cocalcArgs: string[];
  cocalcCommand: string;
  spawnId: string;
}): Promise<unknown> {
  const { stdout } = await runCliCommand({
    args: [
      ...cocalcArgs,
      "browser",
      "session",
      "destroy",
      spawnId,
      "--timeout",
      "10s",
    ],
    command: cocalcCommand,
  });
  return parseJsonOutput(stdout);
}

export function registerDocsCommand(
  program: Command,
  deps: DocsCommandDeps,
): Command {
  const docs = program
    .command("docs")
    .description("search and show the versioned CoCalc-ai documentation")
    .addHelpText(
      "after",
      `
These commands read the documentation bundled with this CoCalc-ai version.
They do not require authentication and are designed for both humans and agents.

Examples:

  cocalc docs list
  cocalc docs search "project secrets" --json
  cocalc docs show projects/project-secrets --json
  cocalc docs actions --json
`,
    );

  docs
    .command("list")
    .description("list available documentation pages")
    .option("--audience <audience>", "filter by audience")
    .option("--category <category>", "filter by category")
    .option("--include-admin", "include admin-only documentation pages")
    .option("--status <status>", "filter by status")
    .action((options: DocsListOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs list";
      try {
        const rows = filterDocsEntries(options).map(compactDocsEntry);
        deps.emitSuccess({ globals }, commandName, rows);
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

  docs
    .command("search <query>")
    .description("search documentation pages")
    .option("--include-admin", "include admin-only documentation pages")
    .option("--limit <n>", "maximum number of results", "8")
    .action((query: string, options: DocsSearchOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs search";
      try {
        const rows = searchDocsEntries(
          query,
          parseLimit(options.limit),
          docsAccessFromOptions(options),
        ).map(compactSearchResult);
        deps.emitSuccess({ globals }, commandName, rows);
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

  docs
    .command("actions")
    .description("list stable documentation action ids")
    .option(
      "--executable",
      "only show action ids that the browser action layer can run today",
    )
    .option("--include-admin", "include admin-only documentation actions")
    .action(
      (
        options: { executable?: boolean; includeAdmin?: boolean },
        command: Command,
      ) => {
        const globals = deps.globalsFrom(command);
        const commandName = "docs actions";
        try {
          const rows = listDocsActions(docsAccessFromOptions(options))
            .filter(
              (action) => !options.executable || action.executable === true,
            )
            .map(compactDocsAction);
          deps.emitSuccess({ globals }, commandName, rows);
        } catch (error) {
          deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
          process.exitCode = 1;
        }
      },
    );

  docs
    .command("action <id>")
    .description("show one stable documentation action id")
    .option("--include-admin", "include admin-only documentation actions")
    .action(
      (id: string, options: { includeAdmin?: boolean }, command: Command) => {
        const globals = deps.globalsFrom(command);
        const commandName = "docs action";
        try {
          const summary = listDocsActions(docsAccessFromOptions(options)).find(
            (action) => action.id === id,
          );
          if (summary == null) {
            const known = getDocsAction(id, docsAccessFromOptions(options));
            if (known != null) {
              throw new Error(`documentation action missing summary: ${id}`);
            }
            throw new Error(`documentation action not found: ${id}`);
          }
          deps.emitSuccess(
            { globals },
            commandName,
            compactDocsAction(summary),
          );
        } catch (error) {
          deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
          process.exitCode = 1;
        }
      },
    );

  docs
    .command("show <slugOrId>")
    .description("show a documentation page by slug or id")
    .option("--include-admin", "include admin-only documentation pages")
    .action(
      (
        slugOrId: string,
        options: { includeAdmin?: boolean },
        command: Command,
      ) => {
        const globals = deps.globalsFrom(command);
        const commandName = "docs show";
        try {
          const entry = getDocsEntry(slugOrId, docsAccessFromOptions(options));
          if (entry == null) {
            throw new Error(`documentation page not found: ${slugOrId}`);
          }
          deps.emitSuccess({ globals }, commandName, entry);
        } catch (error) {
          deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
          process.exitCode = 1;
        }
      },
    );

  docs
    .command("verify")
    .description(
      "verify docs metadata, links, actions, and optional live UI actions",
    )
    .option("--list-live", "list live browser-session verification scenarios")
    .option("--live", "run live browser-session action checks")
    .option(
      "--action <id>",
      "only run this live docs action; may be repeated",
      collectOption,
      [],
    )
    .option(
      "--project-id <id>",
      "project id for live checks; defaults to COCALC_PROJECT_ID",
    )
    .option(
      "--host-id <id>",
      "project host id for parameterized project-host live checks; defaults to COCALC_DOCS_VERIFY_HOST_ID",
    )
    .option(
      "--browser <id>",
      "browser id for live checks; defaults to COCALC_BROWSER_ID",
    )
    .option(
      "--cocalc-bin <command>",
      "cocalc command to use for live checks; defaults to this CLI process",
    )
    .option(
      "--spawn-browser",
      "spawn a dedicated Chromium browser session for --live checks",
    )
    .option(
      "--target-url <url>",
      "exact URL to open when using --spawn-browser; defaults to the signed-in home bay when it differs from the API origin",
    )
    .option("--chromium <path>", "Chromium executable path for --spawn-browser")
    .option("--headed", "launch spawned Chromium visibly instead of headless")
    .option(
      "--spawn-ready-timeout <duration>",
      "timeout for spawned browser daemon readiness",
      "60s",
    )
    .option(
      "--spawn-timeout <duration>",
      "timeout for spawned browser registration",
      "90s",
    )
    .option(
      "--keep-browser",
      "leave the spawned browser session running after verification",
    )
    .option("--timeout <duration>", "timeout for each live action", "60s")
    .action(async (options: DocsVerifyOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs verify";
      let spawnedBrowser:
        | Awaited<ReturnType<typeof spawnDocsVerificationBrowser>>
        | undefined;
      let destroyOutput: unknown;
      let destroyAttempted = false;
      try {
        const projectId =
          `${options.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
        const hostId =
          `${options.hostId ?? process.env.COCALC_DOCS_VERIFY_HOST_ID ?? ""}`.trim();
        const explicitBrowserId = `${options.browser ?? ""}`.trim();
        const browserId =
          explicitBrowserId ||
          (options.spawnBrowser
            ? ""
            : `${process.env.COCALC_BROWSER_ID ?? ""}`.trim());
        const cocalcCommand = options.cocalcBin ?? process.execPath;
        const cocalcArgs = options.cocalcBin
          ? ["--json"]
          : [process.argv[1], "--json"];
        const shouldRunLive = !!options.live || !!options.spawnBrowser;
        if (options.spawnBrowser && explicitBrowserId) {
          throw new Error("use either --spawn-browser or --browser, not both");
        }
        if (options.listLive) {
          const scenarios = listDocsLiveVerificationScenarios({
            cocalcArgs,
            cocalcCommand,
            hostId: hostId || "$COCALC_DOCS_VERIFY_HOST_ID",
            projectId: projectId || "$COCALC_PROJECT_ID",
            timeout: options.timeout,
          });
          deps.emitSuccess({ globals }, commandName, scenarios);
          return;
        }
        const staticReport = verifyDocsStatic();
        if (shouldRunLive && !projectId) {
          throw new Error(
            "--project-id or COCALC_PROJECT_ID is required for live docs verification",
          );
        }
        if (options.spawnBrowser) {
          spawnedBrowser = await spawnDocsVerificationBrowser({
            cocalcArgs,
            cocalcCommand,
            globals,
            normalizeUrl: deps.normalizeUrl,
            options,
            projectId,
          });
        }
        const liveReport = shouldRunLive
          ? await verifyDocsLive({
              actionIds: (options.action ?? []) as DocsActionId[],
              browserId: spawnedBrowser?.browserId || browserId || undefined,
              cocalcArgs,
              cocalcCommand,
              hostId: hostId || undefined,
              projectId,
              timeout: options.timeout,
            })
          : undefined;
        const ok = staticReport.ok && (liveReport?.ok ?? true);
        if (spawnedBrowser && !options.keepBrowser) {
          destroyAttempted = true;
          destroyOutput = await destroyDocsVerificationBrowser({
            cocalcArgs,
            cocalcCommand,
            spawnId: spawnedBrowser.spawnId,
          });
        }
        if (globals.json || globals.output === "json") {
          deps.emitSuccess(
            { globals },
            commandName,
            liveReport
              ? {
                  static: staticReport,
                  live: liveReport,
                  ...(spawnedBrowser
                    ? {
                        spawned_browser: spawnedBrowser,
                        destroy: destroyOutput,
                      }
                    : {}),
                }
              : staticReport,
          );
        } else {
          console.log(formatDocsVerificationReport(staticReport));
          if (spawnedBrowser) {
            console.log(
              `Spawned Chromium browser ${spawnedBrowser.browserId} (${spawnedBrowser.spawnId})`,
            );
          }
          for (const result of liveReport?.results ?? []) {
            console.log(
              `${result.ok ? "OK" : "FAIL"} live ${result.actionId}: ${result.command.join(" ")}`,
            );
            if (result.error) {
              console.log(`  ${result.error}`);
            }
          }
        }
        if (!ok) {
          process.exitCode = 1;
        }
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      } finally {
        if (spawnedBrowser && !options.keepBrowser && !destroyAttempted) {
          try {
            destroyAttempted = true;
            destroyOutput = await destroyDocsVerificationBrowser({
              cocalcArgs: options.cocalcBin
                ? ["--json"]
                : [process.argv[1], "--json"],
              cocalcCommand: options.cocalcBin ?? process.execPath,
              spawnId: spawnedBrowser.spawnId,
            });
          } catch (err) {
            if (!process.exitCode) {
              process.exitCode = 1;
            }
            if (!globals.json && globals.output !== "json") {
              console.error(
                `failed to destroy spawned docs verification browser: ${err}`,
              );
            }
          }
        }
      }
    });

  return docs;
}
