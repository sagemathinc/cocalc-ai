import { once } from "node:events";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { syncdb as openSyncDb } from "@cocalc/conat/sync-doc/syncdb";
import {
  jupyterClient,
  type JupyterRunAck,
  type OutputMessage,
} from "@cocalc/conat/project/jupyter/run-code";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type ProjectJupyterOpsDeps<Ctx, Project extends ProjectIdentity> = {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{
    project: Project;
    client: any;
  }>;
};

type LiveJupyterSessionEntry<Project extends ProjectIdentity> = {
  project: Project;
  path: string;
  client: any;
  syncdb: any;
};

export type NotebookCellInfo = {
  id: string;
  index: number;
  cell_type: string;
  input: string;
  preview: string;
  line_count: number;
  generated_id: boolean;
};

export type ProjectJupyterCellsResult = {
  project_id: string;
  path: string;
  cells: NotebookCellInfo[];
};

export type ProjectJupyterRunSession = {
  project_id: string;
  project_title: string;
  path: string;
  run_id: string;
  cells: NotebookCellInfo[];
  iter: AsyncIterable<OutputMessage[]>;
  close: () => void;
};

type NotebookCellSelector = {
  cellIds?: string[];
  cellIndices?: number[];
  allCode?: boolean;
};

const JUPYTER_SYNCDB_OPTIONS = {
  change_throttle: 25,
  patch_interval: 25,
  primary_keys: ["type", "id"],
  string_cols: ["input"],
  cursors: true,
  persistent: true,
  noSaveToDisk: true,
};

function normalizeNotebookSource(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }
  if (Array.isArray(source)) {
    return source
      .map((part) => (typeof part === "string" ? part : `${part ?? ""}`))
      .join("");
  }
  return `${source ?? ""}`;
}

function normalizeNotebookPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("notebook path is required");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

function summarizePreview(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

function mapNotebookCells(rawCells: any[]): NotebookCellInfo[] {
  return rawCells.map((cell, index) => {
    const rawId = typeof cell?.id === "string" ? cell.id.trim() : "";
    const input = normalizeNotebookSource(cell?.input ?? cell?.source);
    return {
      id: rawId || `__missing_cell_id__:${index}`,
      index,
      cell_type:
        typeof cell?.cell_type === "string" ? cell.cell_type : "unknown",
      input,
      preview: summarizePreview(input),
      line_count: input === "" ? 0 : input.split("\n").length,
      generated_id: rawId === "",
    };
  });
}

export function parseNotebookCells(content: string): NotebookCellInfo[] {
  const parsed = JSON.parse(content) as { cells?: any[] };
  const cells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  return mapNotebookCells(cells);
}

function toPlainValue(value: any): any {
  if (value?.toJS instanceof Function) {
    return value.toJS();
  }
  return value;
}

export function mapSyncDbNotebookCells(rows: any[]): NotebookCellInfo[] {
  return rows
    .map((row) => toPlainValue(row))
    .filter((row) => row?.type === "cell")
    .sort((left, right) => {
      const leftPos =
        typeof left?.pos === "number" && Number.isFinite(left.pos)
          ? left.pos
          : Number.MAX_SAFE_INTEGER;
      const rightPos =
        typeof right?.pos === "number" && Number.isFinite(right.pos)
          ? right.pos
          : Number.MAX_SAFE_INTEGER;
      if (leftPos !== rightPos) {
        return leftPos - rightPos;
      }
      return `${left?.id ?? ""}`.localeCompare(`${right?.id ?? ""}`);
    })
    .map((row, index) => {
      const rawId = typeof row?.id === "string" ? row.id.trim() : "";
      const input = normalizeNotebookSource(row?.input);
      return {
        id: rawId || `__missing_cell_id__:${index}`,
        index,
        cell_type: typeof row?.cell_type === "string" ? row.cell_type : "code",
        input,
        preview: summarizePreview(input),
        line_count: input === "" ? 0 : input.split("\n").length,
        generated_id: rawId === "",
      };
    });
}

function getLiveNotebookCells(syncdb: any): NotebookCellInfo[] {
  const rows = toPlainValue(syncdb.get({ type: "cell" })) ?? [];
  return mapSyncDbNotebookCells(Array.isArray(rows) ? rows : []);
}

export function selectNotebookCells(
  cells: NotebookCellInfo[],
  selector: NotebookCellSelector,
): NotebookCellInfo[] {
  const cellIds = (selector.cellIds ?? [])
    .map((value) => `${value ?? ""}`.trim())
    .filter(Boolean);
  const cellIndices = (selector.cellIndices ?? []).filter((value) =>
    Number.isInteger(value),
  );
  const wantsAllCode = selector.allCode === true;
  if (!wantsAllCode && cellIds.length === 0 && cellIndices.length === 0) {
    throw new Error(
      "select code cells with --cell-id, --cell-index, or --all-code",
    );
  }
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const byIndex = new Map(cells.map((cell) => [cell.index, cell]));
  const selected = new Set<string>();

  if (wantsAllCode) {
    for (const cell of cells) {
      if (cell.cell_type === "code") {
        selected.add(cell.id);
      }
    }
  }

  for (const cellId of cellIds) {
    const cell = byId.get(cellId);
    if (cell == null) {
      throw new Error(`unknown cell id '${cellId}'`);
    }
    selected.add(cell.id);
  }

  for (const cellIndex of cellIndices) {
    const cell = byIndex.get(cellIndex);
    if (cell == null) {
      throw new Error(`unknown cell index '${cellIndex}'`);
    }
    selected.add(cell.id);
  }

  const ordered = cells.filter((cell) => selected.has(cell.id));
  if (ordered.length === 0) {
    throw new Error("no code cells matched the requested selection");
  }
  const nonCode = ordered.filter((cell) => cell.cell_type !== "code");
  if (nonCode.length > 0) {
    throw new Error(
      `selected cells must be code cells: ${nonCode
        .map((cell) => `#${cell.index}`)
        .join(", ")}`,
    );
  }
  return ordered;
}

export function createProjectJupyterOps<Ctx, Project extends ProjectIdentity>(
  deps: ProjectJupyterOpsDeps<Ctx, Project>,
) {
  let closed = false;
  const sessionPromises = new Map<
    string,
    Promise<LiveJupyterSessionEntry<Project>>
  >();
  const sessionLeases = new RefcountLeaseManager<string>({
    delayMs: 30_000,
    disposer: async (key) => {
      const entryPromise = sessionPromises.get(key);
      sessionPromises.delete(key);
      if (!entryPromise) return;
      try {
        const entry = await entryPromise;
        await entry.syncdb.close();
      } catch {
        // ignore cleanup failures
      }
    },
  });

  async function acquireProjectJupyterSession0({
    ctx,
    projectIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
  }): Promise<
    LiveJupyterSessionEntry<Project> & {
      release: () => Promise<void>;
    }
  > {
    if (closed) {
      throw new Error("project jupyter ops are closed");
    }
    const normalizedPath = normalizeNotebookPath(path);
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      cwd,
    );
    const key = JSON.stringify({
      project_id: project.project_id,
      path: normalizedPath,
    });
    const release = await sessionLeases.acquire(key);
    try {
      let entryPromise = sessionPromises.get(key);
      if (!entryPromise) {
        const created = (async () => {
          const syncdb = openSyncDb({
            ...JUPYTER_SYNCDB_OPTIONS,
            project_id: project.project_id,
            path: syncdbPath(normalizedPath),
            client,
          });
          if (syncdb.get_state() === "init") {
            await once(syncdb, "ready");
          }
          if (syncdb.isClosed?.()) {
            throw new Error(
              `failed to open notebook sync session for ${normalizedPath}`,
            );
          }
          return {
            project,
            path: normalizedPath,
            client,
            syncdb,
          };
        })();
        sessionPromises.set(key, created);
        entryPromise = created;
        try {
          await created;
        } catch (error) {
          if (sessionPromises.get(key) === created) {
            sessionPromises.delete(key);
          }
          throw error;
        }
      }
      const entry = await entryPromise;
      return {
        ...entry,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    const pending = Array.from(sessionPromises.values());
    sessionPromises.clear();
    await Promise.allSettled(
      pending.map(async (entryPromise) => {
        const entry = await entryPromise;
        await entry.syncdb.close();
      }),
    );
    await sessionLeases.close();
  }

  async function readNotebookCells({
    ctx,
    projectIdentifier,
    path,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
  }): Promise<{
    project: Project;
    client: any;
    cells: NotebookCellInfo[];
  }> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, client, syncdb, release } =
      await acquireProjectJupyterSession0({
        ctx,
        projectIdentifier,
        path: normalizedPath,
        cwd,
      });
    try {
      return {
        project,
        client,
        cells: getLiveNotebookCells(syncdb),
      };
    } finally {
      await release();
    }
  }

  async function projectJupyterCellsData({
    ctx,
    projectIdentifier,
    path,
    codeOnly,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    codeOnly?: boolean;
    cwd?: string;
  }): Promise<ProjectJupyterCellsResult> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, cells } = await readNotebookCells({
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
    });
    return {
      project_id: project.project_id,
      path: normalizedPath,
      cells: codeOnly
        ? cells.filter((cell) => cell.cell_type === "code")
        : cells,
    };
  }

  async function projectJupyterRunSession({
    ctx,
    projectIdentifier,
    path,
    cellIds,
    cellIndices,
    allCode,
    noHalt,
    limit,
    stdin,
    onAck,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cellIds?: string[];
    cellIndices?: number[];
    allCode?: boolean;
    noHalt?: boolean;
    limit?: number;
    stdin?: (opts: {
      id: string;
      prompt: string;
      password?: boolean;
    }) => Promise<string>;
    onAck?: (ack: JupyterRunAck) => void;
    cwd?: string;
  }): Promise<ProjectJupyterRunSession> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, client, syncdb, release } =
      await acquireProjectJupyterSession0({
        ctx,
        projectIdentifier,
        path: normalizedPath,
        cwd,
      });
    try {
      const cells = getLiveNotebookCells(syncdb);
      const selected = selectNotebookCells(cells, {
        cellIds,
        cellIndices,
        allCode,
      });
      const runClient = jupyterClient({
        path: normalizedPath,
        project_id: project.project_id,
        client,
        stdin,
      });
      const run_id = `cli-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const iter = await runClient.run(
        selected.map(({ id, input }) => ({ id, input })),
        {
          noHalt,
          limit,
          run_id,
          waitForAck: false,
          onAck,
        },
      );
      return {
        project_id: project.project_id,
        project_title: project.title,
        path: normalizedPath,
        run_id,
        cells: selected,
        iter,
        close: () => {
          runClient.close();
          return void release();
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  return {
    close,
    projectJupyterCellsData,
    projectJupyterRunSession,
  };
}
