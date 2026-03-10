import type { ExportBundle, ExportFile } from "./bundle";
import {
  type ExportAssetIndexEntry,
  buildRelativeBlobReplacementMap,
  collectReferencedAssets,
  rewriteBlobRefs,
} from "./blob-assets";
import {
  defaultExportRootDir,
  normalizeIsoDate,
  normalizeString,
  readJsonlRows,
  stringifyJsonlRows,
} from "./jsonl";
import { normalizeExportManifest } from "./manifest";

export interface TaskExportOptions {
  taskPath: string;
  includeBlobs?: boolean;
  blobBaseUrl?: string;
  blobBearerToken?: string;
  exportedAt?: string;
}

interface TaskRow {
  task_id: string;
  desc?: string;
  position?: number;
  last_edited?: number;
  due_date?: number;
  done?: boolean;
  deleted?: boolean;
  color?: string;
  hideBody?: boolean;
}

interface ExportTaskRow {
  event: "task";
  message_kind: "task";
  task_id: string;
  timestamp?: string;
  due_at?: string;
  content: string;
  content_format: "markdown";
  done: boolean;
  deleted: boolean;
  position?: number;
  hashtags: string[];
  color?: string;
  hide_body?: boolean;
}

interface TaskDocumentData {
  path: string;
  task_count: number;
  open_count: number;
  done_count: number;
  deleted_count: number;
  hashtags: string[];
  asset_refs?: ExportAssetIndexEntry[];
}

export async function collectTaskExport(
  options: TaskExportOptions,
): Promise<ExportBundle> {
  const rows = (await readJsonlRows(options.taskPath))
    .filter(isTaskRow)
    .map(normalizeTaskRow);
  const sorted = [...rows].sort(compareTasks);
  const assetResult = options.includeBlobs
    ? await collectReferencedAssets({
        contents: sorted.map((row) => row.desc),
        blobBaseUrl: normalizeString(options.blobBaseUrl),
        blobBearerToken: normalizeString(options.blobBearerToken),
      })
    : undefined;
  const assetIndex = assetResult?.index ?? [];
  const rawReplacements = buildRelativeBlobReplacementMap(
    "document.jsonl",
    assetIndex,
  );
  const tasksReplacements = buildRelativeBlobReplacementMap(
    "tasks.jsonl",
    assetIndex,
  );
  const markdownReplacements = buildRelativeBlobReplacementMap(
    "tasks.md",
    assetIndex,
  );

  const exportedTasks = sorted.map((row) =>
    toExportTaskRow(row, tasksReplacements),
  );
  const rawDocumentRows = sorted.map((row) => ({
    ...row,
    desc: rewriteMaybeBlobRefs(row.desc, rawReplacements),
  }));
  const hashtags = Array.from(
    new Set(exportedTasks.flatMap((task) => task.hashtags)),
  ).sort((a, b) => a.localeCompare(b));

  const document: TaskDocumentData = {
    path: options.taskPath,
    task_count: exportedTasks.length,
    open_count: exportedTasks.filter((task) => !task.done && !task.deleted)
      .length,
    done_count: exportedTasks.filter((task) => task.done && !task.deleted)
      .length,
    deleted_count: exportedTasks.filter((task) => task.deleted).length,
    hashtags,
    asset_refs: assetIndex.length ? assetIndex : undefined,
  };

  const files: ExportFile[] = [
    {
      path: "README.md",
      content: renderTasksExportReadme(options.includeBlobs === true),
    },
    {
      path: "document.json",
      content: `${JSON.stringify(document, null, 2)}\n`,
    },
    {
      path: "document.jsonl",
      content: stringifyJsonlRows(rawDocumentRows),
    },
    {
      path: "tasks.jsonl",
      content: stringifyJsonlRows(exportedTasks),
    },
    {
      path: "tasks.md",
      content: renderTasksMarkdown(exportedTasks, markdownReplacements),
    },
  ];
  if (assetIndex.length) {
    files.push({
      path: "assets/index.json",
      content: `${JSON.stringify(assetIndex, null, 2)}\n`,
    });
  }

  return {
    manifest: normalizeExportManifest({
      format: "cocalc-export",
      version: 1,
      kind: "tasks",
      exported_at: options.exportedAt ?? new Date().toISOString(),
      entrypoints: {
        human_overview: "README.md",
        machine_index: "document.json",
        canonical_data: ["tasks.jsonl"],
        derived_views: ["tasks.md"],
        assets_index: assetIndex.length ? "assets/index.json" : undefined,
      },
      agent_hints: {
        local_first: true,
        reconstruction_source: "document.jsonl",
        derived_files_are_optional: true,
      },
      source: { path: options.taskPath },
      task_count: exportedTasks.length,
      asset_count: assetIndex.length,
    }),
    rootDir: defaultExportRootDir(options.taskPath, "tasks"),
    files,
    assets: assetResult?.assets,
  };
}

function renderTasksExportReadme(includeBlobs: boolean): string {
  return `# Tasks Export

This archive is designed for both people and agents.

Start here:

- Read \`manifest.json\` for top-level metadata and entrypoints.
- Read \`document.json\` for counts and hashtags.
- Treat \`tasks.jsonl\` as the canonical normalized task stream.
- Treat \`document.jsonl\` as a reconstructable view of the underlying task rows.
- Treat \`tasks.md\` as a derived human-readable rendering.

Blob references are ${includeBlobs ? "copied into `assets/` and rewritten to local paths." : "left as external references because blobs were not included."}

\`tasks.jsonl\` row schema:

- \`event: "task"\`
- \`message_kind: "task"\`
- \`task_id\`: stable task identifier; may be omitted by agents when creating a new task during import
- \`timestamp\`: last edited time in ISO format
- \`due_at\`: due date in ISO format
- \`content\`: markdown task body
- \`content_format\`: currently always \`markdown\`
- \`done\`: completion flag
- \`deleted\`: trash flag
- \`position\`: numeric ordering key
- \`hashtags\`: extracted hashtag list
- \`color\`: optional task color
- \`hide_body\`: whether the task body is collapsed in the UI

Import workflow:

1. Treat \`document.jsonl\` as the export-time base snapshot.
2. Edit \`tasks.jsonl\` as the desired final task state.
3. Use \`cocalc import tasks <bundle-or-directory>\` to merge those task changes back into the live \`.tasks\` file by \`task_id\`.
4. The importer detects conflicting live edits instead of overwriting them blindly.

Recommended agent workflow:

1. Inspect \`document.json\` to understand counts and tags.
2. Work from \`tasks.jsonl\` for triage, rewriting, prioritization, or analysis.
3. Use \`tasks.md\` when a compact human-readable summary is more useful than JSONL.
4. If you need to import changes back, edit \`tasks.jsonl\` and preserve \`task_id\` values for tasks you intend to update.
5. Prefer \`document.jsonl\` / \`tasks.jsonl\` over the markdown rendering for any reconstruction or import.
`;
}

function isTaskRow(row: any): row is TaskRow {
  return typeof normalizeString(row?.task_id) === "string";
}

function normalizeTaskRow(row: TaskRow): TaskRow {
  return {
    task_id: normalizeString(row.task_id) ?? "",
    desc: `${row.desc ?? ""}`,
    position: typeof row.position === "number" ? row.position : undefined,
    last_edited:
      typeof row.last_edited === "number" && Number.isFinite(row.last_edited)
        ? row.last_edited
        : undefined,
    due_date:
      typeof row.due_date === "number" && Number.isFinite(row.due_date)
        ? row.due_date
        : undefined,
    done: row.done === true,
    deleted: row.deleted === true,
    color: normalizeString(row.color),
    hideBody: row.hideBody === true,
  };
}

function compareTasks(a: TaskRow, b: TaskRow): number {
  const posA =
    typeof a.position === "number" ? a.position : Number.POSITIVE_INFINITY;
  const posB =
    typeof b.position === "number" ? b.position : Number.POSITIVE_INFINITY;
  if (posA !== posB) return posA - posB;
  const editedA = typeof a.last_edited === "number" ? a.last_edited : 0;
  const editedB = typeof b.last_edited === "number" ? b.last_edited : 0;
  if (editedA !== editedB) return editedA - editedB;
  return a.task_id.localeCompare(b.task_id);
}

function toExportTaskRow(
  row: TaskRow,
  replacements: Map<string, string>,
): ExportTaskRow {
  const content = rewriteMaybeBlobRefs(row.desc, replacements) ?? "";
  return {
    event: "task",
    message_kind: "task",
    task_id: row.task_id,
    timestamp: normalizeIsoDate(row.last_edited),
    due_at: normalizeIsoDate(row.due_date),
    content,
    content_format: "markdown",
    done: row.done === true,
    deleted: row.deleted === true,
    position: row.position,
    hashtags: extractHashtags(content),
    color: row.color,
    hide_body: row.hideBody === true ? true : undefined,
  };
}

function extractHashtags(content: string): string[] {
  const found = new Set<string>();
  const matches =
    `${content ?? ""}`.match(/(^|[^\w])#([A-Za-z0-9][A-Za-z0-9_-]*)/g) ?? [];
  for (const match of matches) {
    const tag = match.slice(match.lastIndexOf("#") + 1).trim();
    if (tag) found.add(tag);
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function rewriteMaybeBlobRefs(
  value: string | undefined,
  replacements: Map<string, string>,
): string | undefined {
  const normalized = normalizeString(value);
  return normalized ? rewriteBlobRefs(normalized, replacements) : undefined;
}

function renderTasksMarkdown(
  tasks: ExportTaskRow[],
  replacements: Map<string, string>,
): string {
  const sections: Array<{ title: string; rows: ExportTaskRow[] }> = [
    {
      title: "Open Tasks",
      rows: tasks.filter((task) => !task.done && !task.deleted),
    },
    {
      title: "Done Tasks",
      rows: tasks.filter((task) => task.done && !task.deleted),
    },
    {
      title: "Deleted Tasks",
      rows: tasks.filter((task) => task.deleted),
    },
  ];
  const lines: string[] = ["# Tasks Export", ""];
  for (const section of sections) {
    if (!section.rows.length) continue;
    lines.push(`## ${section.title}`, "");
    for (const task of section.rows) {
      const checkbox = task.done ? "x" : " ";
      lines.push(`### [${checkbox}] ${task.task_id}`, "");
      if (task.timestamp) lines.push(`- Edited: ${task.timestamp}`);
      if (task.due_at) lines.push(`- Due: ${task.due_at}`);
      if (task.position != null) lines.push(`- Position: ${task.position}`);
      if (task.hashtags.length) {
        lines.push(
          `- Tags: ${task.hashtags.map((tag) => `#${tag}`).join(" ")}`,
        );
      }
      lines.push(
        "",
        rewriteBlobRefs(task.content, replacements) || "(empty)",
        "",
        "---",
        "",
      );
    }
  }
  return `${lines.join("\n").trim()}\n`;
}
