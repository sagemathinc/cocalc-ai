import { Command } from "commander";

import {
  getDocsEntry,
  listDocsEntries,
  searchDocsEntries,
  type DocsAudience,
  type DocsEntry,
  type DocsEntryStatus,
  type DocsSearchResult,
} from "@cocalc/docs";

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

  return docs;
}
