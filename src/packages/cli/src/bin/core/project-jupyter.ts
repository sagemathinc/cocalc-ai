import {
  jupyterClient,
  type OutputMessage,
} from "@cocalc/conat/project/jupyter/run-code";

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

function summarizePreview(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
}

export function parseNotebookCells(content: string): NotebookCellInfo[] {
  const parsed = JSON.parse(content) as { cells?: any[] };
  const cells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  return cells.map((cell, index) => {
    const rawId = typeof cell?.id === "string" ? cell.id.trim() : "";
    const input = normalizeNotebookSource(cell?.source);
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

async function readNotebookCells<Ctx, Project extends ProjectIdentity>({
  deps,
  ctx,
  projectIdentifier,
  path,
  cwd,
}: {
  deps: ProjectJupyterOpsDeps<Ctx, Project>;
  ctx: Ctx;
  projectIdentifier?: string;
  path: string;
  cwd?: string;
}): Promise<{
  project: Project;
  client: any;
  cells: NotebookCellInfo[];
}> {
  const normalizedPath = `${path ?? ""}`.trim();
  if (!normalizedPath) {
    throw new Error("--path is required");
  }
  const { project, client } = await deps.resolveProjectConatClient(
    ctx,
    projectIdentifier,
    cwd,
  );
  const content = String(
    await client
      .fs({ project_id: project.project_id })
      .readFile(normalizedPath, "utf8"),
  );
  return {
    project,
    client,
    cells: parseNotebookCells(content),
  };
}

export function createProjectJupyterOps<Ctx, Project extends ProjectIdentity>(
  deps: ProjectJupyterOpsDeps<Ctx, Project>,
) {
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
    const normalizedPath = `${path ?? ""}`.trim();
    const { project, cells } = await readNotebookCells({
      deps,
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
    cwd?: string;
  }): Promise<ProjectJupyterRunSession> {
    const normalizedPath = `${path ?? ""}`.trim();
    const { project, client, cells } = await readNotebookCells({
      deps,
      ctx,
      projectIdentifier,
      path: normalizedPath,
      cwd,
    });
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
      },
    );
    return {
      project_id: project.project_id,
      project_title: project.title,
      path: normalizedPath,
      run_id,
      cells: selected,
      iter,
      close: () => runClient.close(),
    };
  }

  return {
    projectJupyterCellsData,
    projectJupyterRunSession,
  };
}
