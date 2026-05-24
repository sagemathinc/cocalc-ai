import { Command } from "commander";

import {
  getDocsAction,
  getDocsEntry,
  listDocsActions,
  listDocsEntries,
  searchDocsEntries,
  type DocsActionSummary,
  type DocsActionId,
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

export type DocsCommandDeps = {
  emitError: any;
  emitSuccess: any;
  globalsFrom: any;
  normalizeUrl: any;
};

type DocsListOptions = {
  audience?: string;
  category?: string;
  status?: string;
};

type DocsSearchOptions = {
  limit?: string;
};

type DocsVerifyOptions = {
  action?: string[];
  browser?: string;
  cocalcBin?: string;
  listLive?: boolean;
  live?: boolean;
  projectId?: string;
  timeout?: string;
};

function compactDocsEntry(entry: DocsEntry): Record<string, unknown> {
  return {
    id: entry.id,
    slug: entry.slug,
    title: entry.title,
    category: entry.category,
    status: entry.status,
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
  return listDocsEntries().filter((entry) => {
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

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
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
    .option("--limit <n>", "maximum number of results", "8")
    .action((query: string, options: DocsSearchOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs search";
      try {
        const rows = searchDocsEntries(query, parseLimit(options.limit)).map(
          compactSearchResult,
        );
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
    .action((options: { executable?: boolean }, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs actions";
      try {
        const rows = listDocsActions()
          .filter((action) => !options.executable || action.executable === true)
          .map(compactDocsAction);
        deps.emitSuccess({ globals }, commandName, rows);
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

  docs
    .command("action <id>")
    .description("show one stable documentation action id")
    .action((id: string, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs action";
      try {
        const summary = listDocsActions().find((action) => action.id === id);
        if (summary == null) {
          const known = getDocsAction(id);
          if (known != null) {
            throw new Error(`documentation action missing summary: ${id}`);
          }
          throw new Error(`documentation action not found: ${id}`);
        }
        deps.emitSuccess({ globals }, commandName, compactDocsAction(summary));
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

  docs
    .command("show <slugOrId>")
    .description("show a documentation page by slug or id")
    .action((slugOrId: string, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs show";
      try {
        const entry = getDocsEntry(slugOrId);
        if (entry == null) {
          throw new Error(`documentation page not found: ${slugOrId}`);
        }
        deps.emitSuccess({ globals }, commandName, entry);
      } catch (error) {
        deps.emitError({ globals }, commandName, error, deps.normalizeUrl);
        process.exitCode = 1;
      }
    });

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
      "--browser <id>",
      "browser id for live checks; defaults to COCALC_BROWSER_ID",
    )
    .option(
      "--cocalc-bin <command>",
      "cocalc command to use for live checks; defaults to this CLI process",
    )
    .option("--timeout <duration>", "timeout for each live action", "60s")
    .action(async (options: DocsVerifyOptions, command: Command) => {
      const globals = deps.globalsFrom(command);
      const commandName = "docs verify";
      try {
        const projectId =
          `${options.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
        const browserId =
          `${options.browser ?? process.env.COCALC_BROWSER_ID ?? ""}`.trim();
        const cocalcCommand = options.cocalcBin ?? process.execPath;
        const cocalcArgs = options.cocalcBin
          ? ["--json"]
          : [process.argv[1], "--json"];
        if (options.listLive) {
          const scenarios = listDocsLiveVerificationScenarios({
            cocalcArgs,
            cocalcCommand,
            projectId: projectId || "$COCALC_PROJECT_ID",
            timeout: options.timeout,
          });
          deps.emitSuccess({ globals }, commandName, scenarios);
          return;
        }
        const staticReport = verifyDocsStatic();
        if (options.live && !projectId) {
          throw new Error(
            "--project-id or COCALC_PROJECT_ID is required for --live",
          );
        }
        const liveReport = options.live
          ? await verifyDocsLive({
              actionIds: (options.action ?? []) as DocsActionId[],
              browserId: browserId || undefined,
              cocalcArgs,
              cocalcCommand,
              projectId,
              timeout: options.timeout,
            })
          : undefined;
        const ok = staticReport.ok && (liveReport?.ok ?? true);
        if (globals.json || globals.output === "json") {
          deps.emitSuccess(
            { globals },
            commandName,
            liveReport
              ? { static: staticReport, live: liveReport }
              : staticReport,
          );
        } else {
          console.log(formatDocsVerificationReport(staticReport));
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
      }
    });

  return docs;
}
