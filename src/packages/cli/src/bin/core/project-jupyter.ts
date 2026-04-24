import { once } from "node:events";
import { isAbsolute, resolve as resolvePath } from "node:path";

import {
  SyncDBNotebookSession,
  type NotebookCellRecord,
} from "@cocalc/app-notebook";
import { syncdb as openSyncDb } from "@cocalc/conat/sync-doc/syncdb";
import {
  jupyterClient,
  type JupyterRunAck,
  type OutputMessage,
} from "@cocalc/conat/project/jupyter/run-code";
import {
  canonicalJupyterLiveRunPath,
  openJupyterLiveRunStore,
  type JupyterLiveRunBatch,
  type JupyterLiveRunSnapshot,
} from "@cocalc/conat/project/jupyter/live-run";
import { projectApiClient } from "@cocalc/conat/project/api";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { sleep } from "@cocalc/util/async-utils";
import type { JupyterSaveOptions } from "@cocalc/conat/project/api/jupyter";
import type { KernelSpec } from "@cocalc/util/jupyter/types";

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

export type ProjectJupyterMutationResult = {
  project_id: string;
  path: string;
  cell?: NotebookCellInfo;
  deleted?: string[];
};

export type ProjectJupyterKernelResult = {
  project_id: string;
  path: string;
  kernel: string | null;
  kernel_spec: KernelSpec | null;
  kernels: KernelSpec[];
};

export type ProjectJupyterRunSession = {
  project_id: string;
  project_title: string;
  path: string;
  run_id: string;
  ack: JupyterRunAck | null;
  cells: NotebookCellInfo[];
  iter: AsyncIterable<OutputMessage[]>;
  close: () => Promise<void>;
};

export type ProjectJupyterLiveSession = {
  project_id: string;
  project_title: string;
  path: string;
  getRunId: () => string | null;
  iter: AsyncIterable<OutputMessage[]>;
  close: () => Promise<void>;
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

const NOTEBOOK_MUTATION_VISIBILITY_TIMEOUT_MS = 2_000;
const NOTEBOOK_MUTATION_VISIBILITY_POLL_MS = 50;

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

export function selectJupyterLiveRunSnapshot({
  all,
  path,
  runId,
}: {
  all: Record<string, JupyterLiveRunSnapshot>;
  path: string;
  runId?: string;
}): JupyterLiveRunSnapshot | undefined {
  const canonicalPath = canonicalJupyterLiveRunPath(path);
  const snapshots = Object.values(all)
    .map((value) => toPlainValue(value) as JupyterLiveRunSnapshot | undefined)
    .filter(
      (value): value is JupyterLiveRunSnapshot => value?.path === canonicalPath,
    );
  if (runId != null && runId !== "") {
    return snapshots.find((snapshot) => snapshot.run_id === runId);
  }
  const running = snapshots.filter((snapshot) => snapshot.done !== true);
  const pool = running.length > 0 ? running : snapshots;
  if (pool.length === 0) {
    return;
  }
  pool.sort((left, right) => {
    const delta = (right.updated_at_ms ?? 0) - (left.updated_at_ms ?? 0);
    if (delta !== 0) {
      return delta;
    }
    return `${right.run_id ?? ""}`.localeCompare(`${left.run_id ?? ""}`);
  });
  return pool[0];
}

export function getUnseenJupyterLiveRunBatches(
  snapshot: JupyterLiveRunSnapshot | undefined,
  seenBatchIds: Set<string>,
): JupyterLiveRunBatch[] {
  if (snapshot == null || !Array.isArray(snapshot.batches)) {
    return [];
  }
  return snapshot.batches
    .filter((batch) => {
      const id = `${batch?.id ?? ""}`.trim();
      return id !== "" && !seenBatchIds.has(id);
    })
    .sort((left, right) => {
      const seqDelta = (left?.seq ?? 0) - (right?.seq ?? 0);
      if (seqDelta !== 0) {
        return seqDelta;
      }
      const sentDelta = (left?.sent_at_ms ?? 0) - (right?.sent_at_ms ?? 0);
      if (sentDelta !== 0) {
        return sentDelta;
      }
      return `${left?.id ?? ""}`.localeCompare(`${right?.id ?? ""}`);
    });
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
    await projectApiClient({
      project_id: project.project_id,
      client,
    }).jupyter.start(normalizedPath);
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

  async function readNotebookCellsFresh({
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
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      cwd,
    );
    await projectApiClient({
      project_id: project.project_id,
      client,
    }).jupyter.start(normalizedPath);
    const syncdb = openSyncDb({
      ...JUPYTER_SYNCDB_OPTIONS,
      project_id: project.project_id,
      path: syncdbPath(normalizedPath),
      client,
    });
    try {
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
        client,
        cells: getLiveNotebookCells(syncdb),
      };
    } finally {
      await syncdb.close();
    }
  }

  async function waitForFreshNotebookCells<T>({
    ctx,
    projectIdentifier,
    path,
    cwd,
    desc,
    pick,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
    desc: string;
    pick: (cells: NotebookCellInfo[]) => T | undefined;
  }): Promise<{
    project: Project;
    cells: NotebookCellInfo[];
    value: T;
  }> {
    const started = Date.now();
    while (true) {
      const { project, cells } = await readNotebookCellsFresh({
        ctx,
        projectIdentifier,
        path,
        cwd,
      });
      const value = pick(cells);
      if (value !== undefined) {
        return { project, cells, value };
      }
      if (Date.now() - started >= NOTEBOOK_MUTATION_VISIBILITY_TIMEOUT_MS) {
        break;
      }
      await sleep(NOTEBOOK_MUTATION_VISIBILITY_POLL_MS);
    }
    throw new Error(
      `timed out waiting for notebook mutation to become visible (${desc})`,
    );
  }

  async function saveNotebookCellsToDisk({
    project,
    client,
    ...saveOpts
  }: {
    project: Project;
    client: any;
  } & JupyterSaveOptions): Promise<void> {
    try {
      await projectApiClient({
        project_id: project.project_id,
        client,
      }).jupyter.save(saveOpts);
    } catch (err) {
      throw new Error(
        `notebook mutation became live but could not be saved to disk; update/restart the project host if this persists: ${err}`,
      );
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

  async function projectJupyterKernelData({
    ctx,
    projectIdentifier,
    path,
    cwd,
    noCache,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
    noCache?: boolean;
  }): Promise<ProjectJupyterKernelResult> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, kernel, kernelSpec, kernels } =
      await resolveNotebookKernelState({
        ctx,
        projectIdentifier,
        path: normalizedPath,
        cwd,
        noCache,
      });
    return {
      project_id: project.project_id,
      path: normalizedPath,
      kernel,
      kernel_spec: kernelSpec,
      kernels,
    };
  }

  async function projectJupyterSetKernelData({
    ctx,
    projectIdentifier,
    path,
    cwd,
    kernel,
    noCache,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
    kernel: string | null;
    noCache?: boolean;
  }): Promise<ProjectJupyterKernelResult> {
    const normalizedPath = normalizeNotebookPath(path);
    const requestedKernel =
      typeof kernel === "string" && kernel.trim().length > 0
        ? kernel.trim()
        : "";
    const { project, client, kernels } = await resolveNotebookKernelState({
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
      noCache,
    });
    if (
      requestedKernel !== "" &&
      !kernels.some((candidate) => candidate.name === requestedKernel)
    ) {
      throw new Error(
        `unknown kernel '${requestedKernel}'; inspect available kernels with 'cocalc project jupyter kernel --path ${normalizedPath}'`,
      );
    }
    await withNotebookSession({
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
      fn: async ({ session }) => {
        await session.setKernel(requestedKernel);
      },
    });
    await saveNotebookCellsToDisk({
      project,
      client,
      path: normalizedPath,
      expectedKernel: requestedKernel,
    });
    const kernelSpec =
      requestedKernel === ""
        ? null
        : (kernels.find((candidate) => candidate.name === requestedKernel) ??
          null);
    return {
      project_id: project.project_id,
      path: normalizedPath,
      kernel: requestedKernel || null,
      kernel_spec: kernelSpec,
      kernels,
    };
  }

  async function withNotebookSession<T>({
    ctx,
    projectIdentifier,
    path,
    cwd,
    fn,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
    fn: (opts: {
      project: Project;
      path: string;
      session: SyncDBNotebookSession;
    }) => Promise<T>;
  }): Promise<T> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, syncdb, release } = await acquireProjectJupyterSession0({
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
    });
    try {
      return await fn({
        project,
        path: normalizedPath,
        session: new SyncDBNotebookSession(syncdb as any),
      });
    } finally {
      await release();
    }
  }

  async function resolveNotebookKernelState({
    ctx,
    projectIdentifier,
    path,
    cwd,
    noCache,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cwd?: string;
    noCache?: boolean;
  }): Promise<{
    project: Project;
    client: any;
    kernel: string | null;
    kernelSpec: KernelSpec | null;
    kernels: KernelSpec[];
  }> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      cwd,
    );
    const kernelValue = await withNotebookSession({
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
      fn: async ({ session }) => await session.getKernel(),
    });
    const kernel = kernelValue && kernelValue.length > 0 ? kernelValue : null;
    const kernels = await projectApiClient({
      project_id: project.project_id,
      client,
    }).jupyter.kernels({ noCache });
    const kernelSpec =
      kernel == null
        ? null
        : (kernels.find((candidate) => candidate.name === kernel) ?? null);
    return { project, client, kernel, kernelSpec, kernels };
  }

  async function projectJupyterSetCellData({
    ctx,
    projectIdentifier,
    path,
    cellId,
    input,
    cellType,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cellId: string;
    input?: string;
    cellType?: string;
    cwd?: string;
  }): Promise<ProjectJupyterMutationResult> {
    return await withNotebookSession({
      ctx,
      projectIdentifier,
      path,
      cwd,
      fn: async ({ project, path, session }) => {
        if (input == null && cellType == null) {
          throw new Error("set requires --input, --stdin, and/or --type");
        }
        const beforeCells = await session.listCells();
        if (input != null) {
          await session.setCellInput(cellId, input);
        }
        if (cellType != null) {
          await session.setCellType(cellId, cellType);
        }
        const { client } = await deps.resolveProjectConatClient(
          ctx,
          projectIdentifier,
          cwd,
        );
        const { cells, value: cell } = await waitForFreshNotebookCells({
          ctx,
          projectIdentifier,
          path,
          cwd,
          desc: `set ${cellId}`,
          pick: (cells) => {
            const cell = cells.find((candidate) => candidate.id === cellId);
            if (cell == null) {
              return undefined;
            }
            if (input != null && cell.input !== input) {
              return undefined;
            }
            if (cellType != null && cell.cell_type !== cellType) {
              return undefined;
            }
            return cell;
          },
        });
        if (
          cells.length !== beforeCells.length ||
          !beforeCells.every((beforeCell) =>
            cells.some((candidate) => candidate.id === beforeCell.id),
          )
        ) {
          throw new Error("notebook cell set changed unexpected cell ids");
        }
        await saveNotebookCellsToDisk({
          project,
          client,
          path,
          expectedCellCount: beforeCells.length,
          expectedCellIdsInOrder: cells.map((candidate) => candidate.id),
          expectedCells: [
            {
              id: cell.id,
              ...(cellType != null ? { cell_type: cellType } : {}),
              ...(input != null ? { input } : {}),
            },
          ],
        });
        return {
          project_id: project.project_id,
          path,
          cell,
        };
      },
    });
  }

  async function projectJupyterInsertCellData({
    ctx,
    projectIdentifier,
    path,
    afterId,
    beforeId,
    atStart,
    atEnd,
    input,
    cellType,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    afterId?: string;
    beforeId?: string;
    atStart?: boolean;
    atEnd?: boolean;
    input?: string;
    cellType?: string;
    cwd?: string;
  }): Promise<ProjectJupyterMutationResult> {
    return await withNotebookSession({
      ctx,
      projectIdentifier,
      path,
      cwd,
      fn: async ({ project, path, session }) => {
        const anchors = [
          afterId ? 1 : 0,
          beforeId ? 1 : 0,
          atStart ? 1 : 0,
          atEnd ? 1 : 0,
        ].reduce((sum, n) => sum + n, 0);
        if (anchors !== 1) {
          throw new Error(
            "insert requires exactly one of --after-id, --before-id, --at-start, or --at-end",
          );
        }
        const beforeCells = await session.listCells();
        let cell: NotebookCellRecord;
        if (afterId) {
          cell = await session.insertCellAdjacent({
            anchorId: afterId,
            delta: 1,
            input,
            cell_type: cellType,
          });
        } else if (beforeId) {
          cell = await session.insertCellAdjacent({
            anchorId: beforeId,
            delta: -1,
            input,
            cell_type: cellType,
          });
        } else {
          const cells = await session.listCells();
          const pos =
            cells.length === 0
              ? 0
              : atStart
                ? cells[0].pos - 1
                : cells[cells.length - 1].pos + 1;
          cell = await session.insertCellAt({
            pos,
            input,
            cell_type: cellType,
          });
        }
        const { client } = await deps.resolveProjectConatClient(
          ctx,
          projectIdentifier,
          cwd,
        );
        const { cells, value: freshCell } = await waitForFreshNotebookCells({
          ctx,
          projectIdentifier,
          path,
          cwd,
          desc: `insert ${cell.id}`,
          pick: (cells) => {
            if (cells.length !== beforeCells.length + 1) {
              return undefined;
            }
            if (
              !beforeCells.every((beforeCell) =>
                cells.some((candidate) => candidate.id === beforeCell.id),
              )
            ) {
              return undefined;
            }
            const index = cells.findIndex(
              (candidate) => candidate.id === cell.id,
            );
            if (index === -1) {
              return undefined;
            }
            const freshCell = cells[index];
            if (cellType != null && freshCell.cell_type !== cellType) {
              return undefined;
            }
            if (input != null && freshCell.input !== input) {
              return undefined;
            }
            if (beforeId != null && cells[index + 1]?.id !== beforeId) {
              return undefined;
            }
            if (afterId != null && cells[index - 1]?.id !== afterId) {
              return undefined;
            }
            if (atStart && index !== 0) {
              return undefined;
            }
            if (atEnd && index !== cells.length - 1) {
              return undefined;
            }
            return freshCell;
          },
        });
        await saveNotebookCellsToDisk({
          project,
          client,
          path,
          expectedCellCount: cells.length,
          expectedCellIdsInOrder: cells.map((candidate) => candidate.id),
          expectedCells: [
            {
              id: freshCell.id,
              cell_type: freshCell.cell_type,
              input: freshCell.input,
            },
          ],
        });
        return {
          project_id: project.project_id,
          path,
          cell: freshCell,
        };
      },
    });
  }

  async function projectJupyterDeleteCellsData({
    ctx,
    projectIdentifier,
    path,
    cellIds,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cellIds: string[];
    cwd?: string;
  }): Promise<ProjectJupyterMutationResult> {
    return await withNotebookSession({
      ctx,
      projectIdentifier,
      path,
      cwd,
      fn: async ({ project, path, session }) => {
        const beforeCells = await session.listCells();
        await session.deleteCells(cellIds);
        const { client } = await deps.resolveProjectConatClient(
          ctx,
          projectIdentifier,
          cwd,
        );
        await waitForFreshNotebookCells({
          ctx,
          projectIdentifier,
          path,
          cwd,
          desc: `delete ${cellIds.join(",")}`,
          pick: (cells) => {
            const removed = new Set(cellIds);
            const expectedRemaining = beforeCells.filter(
              (cell) => !removed.has(cell.id),
            );
            if (cells.length !== expectedRemaining.length) {
              return undefined;
            }
            if (
              !expectedRemaining.every((beforeCell) =>
                cells.some((candidate) => candidate.id === beforeCell.id),
              )
            ) {
              return undefined;
            }
            return cellIds.every(
              (cellId) => !cells.some((candidate) => candidate.id === cellId),
            )
              ? true
              : undefined;
          },
        });
        const removed = new Set(cellIds);
        const expectedRemaining = beforeCells.filter(
          (cell) => !removed.has(cell.id),
        );
        await saveNotebookCellsToDisk({
          project,
          client,
          path,
          expectedCellCount: expectedRemaining.length,
          expectedCellIdsInOrder: expectedRemaining.map((cell) => cell.id),
          expectedCells: [],
        });
        return {
          project_id: project.project_id,
          path,
          deleted: [...cellIds],
        };
      },
    });
  }

  async function projectJupyterMoveCellData({
    ctx,
    projectIdentifier,
    path,
    cellId,
    beforeId,
    afterId,
    atStart,
    atEnd,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    cellId: string;
    beforeId?: string;
    afterId?: string;
    atStart?: boolean;
    atEnd?: boolean;
    cwd?: string;
  }): Promise<ProjectJupyterMutationResult> {
    return await withNotebookSession({
      ctx,
      projectIdentifier,
      path,
      cwd,
      fn: async ({ project, path, session }) => {
        const beforeCells = await session.listCells();
        const cell = await session.moveCell({
          cellId,
          beforeId,
          afterId,
          atStart,
          atEnd,
        });
        const { client } = await deps.resolveProjectConatClient(
          ctx,
          projectIdentifier,
          cwd,
        );
        const { cells } = await waitForFreshNotebookCells({
          ctx,
          projectIdentifier,
          path,
          cwd,
          desc: `move ${cell.id}`,
          pick: (cells) => {
            if (cells.length !== beforeCells.length) {
              return undefined;
            }
            if (
              !beforeCells.every((beforeCell) =>
                cells.some((candidate) => candidate.id === beforeCell.id),
              )
            ) {
              return undefined;
            }
            const index = cells.findIndex(
              (candidate) => candidate.id === cell.id,
            );
            if (index === -1) {
              return undefined;
            }
            if (beforeId != null) {
              return cells[index + 1]?.id === beforeId ? true : undefined;
            }
            if (afterId != null) {
              return cells[index - 1]?.id === afterId ? true : undefined;
            }
            if (atStart) {
              return index === 0 ? true : undefined;
            }
            if (atEnd) {
              return index === cells.length - 1 ? true : undefined;
            }
            return true;
          },
        });
        await saveNotebookCellsToDisk({
          project,
          client,
          path,
          expectedCellCount: cells.length,
          expectedCellIdsInOrder: cells.map((candidate) => candidate.id),
          expectedCells: [],
        });
        return {
          project_id: project.project_id,
          path,
          cell: cells.find((candidate) => candidate.id === cell.id)!,
        };
      },
    });
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
    waitForAck = false,
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
    waitForAck?: boolean;
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
      let ack: JupyterRunAck | null = null;
      const iter = await runClient.run(
        selected.map(({ id, input }) => ({ id, input })),
        {
          noHalt,
          limit,
          run_id,
          waitForAck,
          onAck: (nextAck) => {
            ack = nextAck;
            onAck?.(nextAck);
          },
        },
      );
      return {
        project_id: project.project_id,
        project_title: project.title,
        path: normalizedPath,
        run_id,
        ack,
        cells: selected,
        iter,
        close: async () => {
          runClient.close();
          await release();
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function projectJupyterLiveRunSession({
    ctx,
    projectIdentifier,
    path,
    runId,
    follow = true,
    waitMs = 30_000,
    pollMs = 200,
    cwd,
  }: {
    ctx: Ctx;
    projectIdentifier?: string;
    path: string;
    runId?: string;
    follow?: boolean;
    waitMs?: number;
    pollMs?: number;
    cwd?: string;
  }): Promise<ProjectJupyterLiveSession> {
    const normalizedPath = normalizeNotebookPath(path);
    const { project, client } = await deps.resolveProjectConatClient(
      ctx,
      projectIdentifier,
      cwd,
    );
    const store = await openJupyterLiveRunStore({
      client,
      project_id: project.project_id,
    });
    const startedAt = Date.now();
    let selectedRunId = `${runId ?? ""}`.trim() || null;

    async function* iter(): AsyncIterable<OutputMessage[]> {
      const seenBatchIds = new Set<string>();
      for (;;) {
        const snapshot = selectJupyterLiveRunSnapshot({
          all: store.getAll() as Record<string, JupyterLiveRunSnapshot>,
          path: normalizedPath,
          runId: selectedRunId ?? undefined,
        });
        if (snapshot == null) {
          if (Date.now() - startedAt >= waitMs) {
            throw new Error(
              selectedRunId == null
                ? `timed out waiting for live Jupyter run for ${normalizedPath}`
                : `timed out waiting for live Jupyter run ${selectedRunId} for ${normalizedPath}`,
            );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(25, pollMs)),
          );
          continue;
        }
        selectedRunId = snapshot.run_id;
        const nextBatches = getUnseenJupyterLiveRunBatches(
          snapshot,
          seenBatchIds,
        );
        for (const batch of nextBatches) {
          seenBatchIds.add(batch.id);
          yield batch.mesgs as OutputMessage[];
        }
        if (!follow || snapshot.done === true) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(25, pollMs)),
        );
      }
    }

    return {
      project_id: project.project_id,
      project_title: project.title,
      path: normalizedPath,
      getRunId: () => selectedRunId,
      iter: iter(),
      close: async () => {
        store.close();
      },
    };
  }
  return {
    close,
    projectJupyterCellsData,
    projectJupyterKernelData,
    projectJupyterSetKernelData,
    projectJupyterSetCellData,
    projectJupyterInsertCellData,
    projectJupyterDeleteCellsData,
    projectJupyterMoveCellData,
    projectJupyterRunSession,
    projectJupyterLiveRunSession,
  };
}
