/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
cocalc project edit-history: a project's edit history and logs (its persist
streams, conat/project/persist-storage.ts), which its users can't reach as
files: what they take, and deleting or trimming them to free space.
*/

import { Command } from "commander";
import {
  applyPersistStorageInChunks,
  PERSIST_STORAGE_APPLY_TIMEOUT_MS,
  type PersistStorageAction,
  type PersistStorageList,
  type PersistStreamInfo,
  type PersistStreamKind,
} from "@cocalc/conat/project/persist-storage";
import { humanSize } from "@cocalc/util/misc";
import type { ProjectCommandDeps } from "../project";

const KINDS: PersistStreamKind[] = [
  "edit-history",
  "agent-log",
  "notebook",
  "project",
  "other",
];

// enough to see every stream of a project when choosing what to clean up
const ALL = 10_000;

function wantsJson(ctx: any): boolean {
  return !!ctx?.globals?.json || ctx?.globals?.output === "json";
}

function parseKind(kind?: string): PersistStreamKind | undefined {
  if (kind == null) return;
  if (!KINDS.includes(kind as PersistStreamKind)) {
    throw new Error(`--kind must be one of ${KINDS.join(", ")}`);
  }
  return kind as PersistStreamKind;
}

function row(stream: PersistStreamInfo) {
  return {
    name: stream.name,
    kind: stream.kind,
    size: humanSize(stream.bytes),
    reclaimable: stream.reclaimable ? humanSize(stream.reclaimable) : "",
    modified: new Date(stream.modified).toISOString(),
    document: stream.document ?? "",
    document_exists:
      stream.document_exists == null
        ? ""
        : stream.document_exists
          ? "yes"
          : "no",
  };
}

// The streams `targets` mean: stream names as `list` shows them, or the
// paths of documents (all of their streams, or those of `kind`).
export function selectStreams({
  streams,
  targets,
  kind,
}: {
  streams: PersistStreamInfo[];
  targets: string[];
  kind?: PersistStreamKind;
}): PersistStreamInfo[] {
  const selected: PersistStreamInfo[] = [];
  for (const target of targets) {
    const matches = streams.filter(
      (s) =>
        (s.name === target || s.document === target) &&
        (kind == null || s.kind === kind),
    );
    if (matches.length === 0) {
      throw new Error(`no stream or document ${target} in this project`);
    }
    for (const s of matches) {
      if (!selected.includes(s)) selected.push(s);
    }
  }
  return selected;
}

// What `trim` does to `selected`: drops entries before `before` from logs
// (never from an edit history), and the archived history of edit histories;
// a stream the request doesn't apply to is left out.
export function trimActions({
  selected,
  before,
  archived,
}: {
  selected: PersistStreamInfo[];
  before?: number;
  archived?: boolean;
}): PersistStorageAction[] {
  const actions: PersistStorageAction[] = [];
  for (const s of selected) {
    if (s.kind === "edit-history") {
      if (archived) actions.push({ op: "trim", name: s.name, archived: true });
    } else if (before != null) {
      actions.push({ op: "trim", name: s.name, before });
    }
  }
  if (actions.length === 0) {
    throw new Error(
      before != null
        ? "nothing to trim: --older-than applies to logs, not to edit histories (use --archived for those)"
        : "nothing to trim: --archived applies to edit histories",
    );
  }
  return actions;
}

// What `cleanup` does: deletes the streams of documents that no longer exist,
// and trims entries of logs (agent logs, the project's own) older than
// `before`.
export function cleanupActions({
  streams,
  deletedDocuments,
  before,
  archived,
}: {
  streams: PersistStreamInfo[];
  deletedDocuments?: boolean;
  before?: number;
  archived?: boolean;
}): PersistStorageAction[] {
  const actions: PersistStorageAction[] = [];
  for (const s of streams) {
    if (deletedDocuments && s.document_exists === false) {
      actions.push({ op: "delete", name: s.name });
    } else if (
      before != null &&
      (s.kind === "agent-log" || s.kind === "project")
    ) {
      actions.push({ op: "trim", name: s.name, before });
    } else if (archived && s.kind === "edit-history") {
      actions.push({ op: "trim", name: s.name, archived: true });
    }
  }
  return actions;
}

export function registerProjectEditHistoryCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    durationToMs,
    parsePositiveInteger,
  } = deps;

  // the time (ms) `duration` (e.g., "30d") ago
  const olderThan = (duration?: string): number | undefined => {
    if (duration == null) return;
    const ms = Number(durationToMs(duration));
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`invalid --older-than: ${duration}`);
    }
    return Date.now() - ms;
  };

  const list = async (
    ctx: any,
    project_id: string,
    limit = ALL,
  ): Promise<PersistStorageList> => {
    const result = (await ctx.hub.projects.listProjectPersistStorage({
      project_id,
      limit,
    })) as PersistStorageList;
    if (!result.supported) {
      throw new Error(
        "this project's edit history is in its home, with its other files",
      );
    }
    return result;
  };

  const apply = async (
    ctx: any,
    project_id: string,
    actions: PersistStorageAction[],
    dryRun?: boolean,
  ) => {
    if (dryRun || actions.length === 0) {
      return { project_id, dry_run: !!dryRun, would_apply: actions };
    }
    const result = await applyPersistStorageInChunks(
      actions,
      async (chunk) =>
        await ctx.hub.projects.applyProjectPersistStorage({
          project_id,
          actions: chunk,
          timeout: PERSIST_STORAGE_APPLY_TIMEOUT_MS,
        }),
    );
    return {
      project_id,
      freed: humanSize(result.freed),
      freed_bytes: result.freed,
      failed: result.results.filter((r) => !r.ok).length,
      results: result.results,
    };
  };

  const history = project
    .command("edit-history")
    .description(
      "a project's edit history and logs (TimeTravel, agent logs, notebook state): list, delete, trim",
    );

  history
    .command("list")
    .description("list the project's edit history and logs, largest first")
    .option("-w, --project <project>", "project id or name")
    .option("--kind <kind>", `only one kind: ${KINDS.join(", ")}`)
    .option("--limit <n>", "at most this many", "50")
    .option(
      "--deleted-documents",
      "only the history of documents that no longer exist",
    )
    .action(
      async (
        opts: {
          project?: string;
          kind?: string;
          limit?: string;
          deletedDocuments?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project edit-history list", async (ctx) => {
          const kind = parseKind(opts.kind);
          const limit = parsePositiveInteger(opts.limit, 50, "--limit");
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const result = await list(ctx, ws.project_id);
          const streams = result.streams
            .filter((s) => kind == null || s.kind === kind)
            .filter(
              (s) => !opts.deletedDocuments || s.document_exists === false,
            )
            .slice(0, limit);
          if (wantsJson(ctx)) {
            return { project_id: ws.project_id, ...result, streams };
          }
          return [
            {
              name: "(total)",
              kind: "",
              size: humanSize(result.total.bytes),
              reclaimable: "",
              modified: "",
              document: `${result.total.count} streams`,
              document_exists: "",
            },
            ...streams.map(row),
          ];
        });
      },
    );

  history
    .command("delete <targets...>")
    .description(
      "delete streams entirely (names from `list`, or document paths); open documents reload",
    )
    .option("-w, --project <project>", "project id or name")
    .option("--kind <kind>", "with document paths: only this kind")
    .option("--dry-run", "only show what would be deleted")
    .action(
      async (
        targets: string[],
        opts: { project?: string; kind?: string; dryRun?: boolean },
        command: Command,
      ) => {
        await withContext(
          command,
          "project edit-history delete",
          async (ctx) => {
            const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
            const { streams } = await list(ctx, ws.project_id);
            const selected = selectStreams({
              streams,
              targets,
              kind: parseKind(opts.kind),
            });
            return await apply(
              ctx,
              ws.project_id,
              selected.map((s) => ({ op: "delete" as const, name: s.name })),
              opts.dryRun,
            );
          },
        );
      },
    );

  history
    .command("trim <targets...>")
    .description(
      "keep what's recent: drop log entries older than a time, or a document's archived history",
    )
    .option("-w, --project <project>", "project id or name")
    .option("--kind <kind>", "with document paths: only this kind")
    .option("--older-than <duration>", "drop entries older than this, e.g. 30d")
    .option("--archived", "drop the archived history of edit histories")
    .option("--dry-run", "only show what would be trimmed")
    .action(
      async (
        targets: string[],
        opts: {
          project?: string;
          kind?: string;
          olderThan?: string;
          archived?: boolean;
          dryRun?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project edit-history trim", async (ctx) => {
          if (!opts.olderThan && !opts.archived) {
            throw new Error("say what to drop: --older-than and/or --archived");
          }
          const before = olderThan(opts.olderThan);
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const { streams } = await list(ctx, ws.project_id);
          const selected = selectStreams({
            streams,
            targets,
            kind: parseKind(opts.kind),
          });
          return await apply(
            ctx,
            ws.project_id,
            trimActions({ selected, before, archived: opts.archived }),
            opts.dryRun,
          );
        });
      },
    );

  history
    .command("cleanup")
    .description(
      "free space: delete the history of deleted documents, and/or trim old log entries and archived history",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--deleted-documents",
      "delete the history of documents that no longer exist",
    )
    .option(
      "--older-than <duration>",
      "trim agent and project log entries older than this, e.g. 30d",
    )
    .option("--archived", "drop the archived history of every document")
    .option("--dry-run", "only show what would be done")
    .action(
      async (
        opts: {
          project?: string;
          deletedDocuments?: boolean;
          olderThan?: string;
          archived?: boolean;
          dryRun?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project edit-history cleanup",
          async (ctx) => {
            if (!opts.deletedDocuments && !opts.olderThan && !opts.archived) {
              throw new Error(
                "say what to clean up: --deleted-documents, --older-than and/or --archived",
              );
            }
            const before = olderThan(opts.olderThan);
            const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
            const { streams } = await list(ctx, ws.project_id);
            return await apply(
              ctx,
              ws.project_id,
              cleanupActions({
                streams,
                deletedDocuments: opts.deletedDocuments,
                before,
                archived: opts.archived,
              }),
              opts.dryRun,
            );
          },
        );
      },
    );
}
