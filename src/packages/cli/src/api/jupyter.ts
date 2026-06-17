import {
  defaultApiBaseUrl,
  openCurrentProjectConnection,
} from "./current-project";
import {
  createProjectJupyterOps,
  type NotebookCellInfo,
  type NotebookCellDetailInfo,
  type ProjectJupyterKernelResult,
  type ProjectJupyterRestartResult,
  type ProjectJupyterRunSession,
} from "../bin/core/project-jupyter";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type JupyterDocumentBindingOptions = {
  projectIdentifier?: string;
  path: string;
  cwd?: string;
};

export type JupyterRunOptions = {
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
};

export type JupyterCellSelectionOptions = {
  cellIds?: string[];
  cellIndices?: number[];
  all?: boolean;
};

export interface BoundJupyterDocument<Project extends ProjectIdentity> {
  readonly projectIdentifier?: string;
  readonly path: string;
  readonly cwd?: string;

  listCells(options?: { codeOnly?: boolean }): Promise<{
    project: Project;
    path: string;
    cells: NotebookCellInfo[];
  }>;

  getKernel(options?: { noCache?: boolean }): Promise<{
    project: Project;
    path: string;
    kernel: string | null;
    kernelSpec: ProjectJupyterKernelResult["kernel_spec"];
    kernels: ProjectJupyterKernelResult["kernels"];
  }>;

  setKernel(options: { kernel: string | null; noCache?: boolean }): Promise<{
    project: Project;
    path: string;
    kernel: string | null;
    kernelSpec: ProjectJupyterKernelResult["kernel_spec"];
    kernels: ProjectJupyterKernelResult["kernels"];
  }>;

  restart(): Promise<{
    project: Project;
    path: string;
    restarted: ProjectJupyterRestartResult["restarted"];
  }>;

  interrupt(): Promise<{
    project: Project;
    path: string;
    interrupted: true;
  }>;

  status(): Promise<{
    project: Project;
    path: string;
    backendState: string;
    kernelState: string;
  }>;

  save(): Promise<{
    project: Project;
    path: string;
    saved: true;
  }>;

  outputs(options?: JupyterCellSelectionOptions): Promise<{
    project: Project;
    path: string;
    cells: NotebookCellDetailInfo[];
  }>;

  clearOutputs(options?: JupyterCellSelectionOptions): Promise<{
    project: Project;
    path: string;
    cleared: string[];
  }>;

  metadata(options?: { cellId?: string; metadata?: unknown }): Promise<{
    project: Project;
    path: string;
    scope: "notebook" | "cell";
    cell?: NotebookCellDetailInfo;
    metadata: unknown;
  }>;

  trust(options?: { trust?: boolean }): Promise<{
    project: Project;
    path: string;
    trust: boolean | null;
  }>;

  setCell(options: {
    cellId: string;
    input?: string;
    cellType?: string;
  }): Promise<{
    project: Project;
    path: string;
    cell: NotebookCellInfo;
  }>;

  insertCell(options: {
    afterId?: string;
    beforeId?: string;
    atStart?: boolean;
    atEnd?: boolean;
    input?: string;
    cellType?: string;
  }): Promise<{
    project: Project;
    path: string;
    cell: NotebookCellInfo;
  }>;

  deleteCells(options: { cellIds: string[] }): Promise<{
    project: Project;
    path: string;
    deleted: string[];
  }>;

  moveCell(options: {
    cellId: string;
    beforeId?: string;
    afterId?: string;
    atStart?: boolean;
    atEnd?: boolean;
  }): Promise<{
    project: Project;
    path: string;
    cell: NotebookCellInfo;
  }>;

  run(options: JupyterRunOptions): Promise<ProjectJupyterRunSession>;
}

export interface JupyterApi<Ctx, Project extends ProjectIdentity> {
  bindDocument(
    ctx: Ctx,
    options: JupyterDocumentBindingOptions,
  ): BoundJupyterDocument<Project>;
}

export interface OpenJupyterApiOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
}

export interface OpenedJupyterApi extends JupyterApi<
  undefined,
  ProjectIdentity
> {
  readonly project: ProjectIdentity;
  readonly apiBaseUrl: string;
  close(): Promise<void>;
}

export function createJupyterApi<Ctx, Project extends ProjectIdentity>({
  resolveProjectConatClient,
}: {
  resolveProjectConatClient: (
    ctx: Ctx,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{
    project: Project;
    client: any;
  }>;
}): JupyterApi<Ctx, Project> {
  const ops = createProjectJupyterOps({
    resolveProjectConatClient,
  });

  return {
    bindDocument(ctx, options) {
      const binding = {
        projectIdentifier: options.projectIdentifier,
        path: options.path,
        cwd: options.cwd,
      } as const;
      return {
        ...binding,
        async listCells(opts) {
          const result = await ops.projectJupyterCellsData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            codeOnly: opts?.codeOnly,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cells: result.cells,
          };
        },
        async getKernel(options) {
          const result = await ops.projectJupyterKernelData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            noCache: options?.noCache,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            kernel: result.kernel,
            kernelSpec: result.kernel_spec,
            kernels: result.kernels,
          };
        },
        async setKernel(options) {
          const result = await ops.projectJupyterSetKernelData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            kernel: options.kernel,
            noCache: options.noCache,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            kernel: result.kernel,
            kernelSpec: result.kernel_spec,
            kernels: result.kernels,
          };
        },
        async restart() {
          const result = await ops.projectJupyterRestartData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            restarted: result.restarted,
          };
        },
        async interrupt() {
          const result = await ops.projectJupyterInterruptData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            interrupted: result.interrupted,
          };
        },
        async status() {
          const result = await ops.projectJupyterStatusData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            backendState: result.backend_state,
            kernelState: result.kernel_state,
          };
        },
        async save() {
          const result = await ops.projectJupyterSaveData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            saved: result.saved,
          };
        },
        async outputs(options) {
          const result = await ops.projectJupyterOutputsData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellIds: options?.cellIds,
            cellIndices: options?.cellIndices,
            all: options?.all,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cells: result.cells,
          };
        },
        async clearOutputs(options) {
          const result = await ops.projectJupyterClearOutputsData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellIds: options?.cellIds,
            cellIndices: options?.cellIndices,
            all: options?.all,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cleared: result.cleared,
          };
        },
        async metadata(options) {
          const result = await ops.projectJupyterMetadataData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellId: options?.cellId,
            metadata: options?.metadata,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            scope: result.scope,
            cell: result.cell,
            metadata: result.metadata,
          };
        },
        async trust(options) {
          const result = await ops.projectJupyterTrustData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            trust: options?.trust,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            trust: result.trust,
          };
        },
        async setCell(options) {
          const result = await ops.projectJupyterSetCellData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellId: options.cellId,
            input: options.input,
            cellType: options.cellType,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cell: result.cell!,
          };
        },
        async insertCell(options) {
          const result = await ops.projectJupyterInsertCellData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            afterId: options.afterId,
            beforeId: options.beforeId,
            atStart: options.atStart,
            atEnd: options.atEnd,
            input: options.input,
            cellType: options.cellType,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cell: result.cell!,
          };
        },
        async deleteCells(options) {
          const result = await ops.projectJupyterDeleteCellsData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellIds: options.cellIds,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            deleted: result.deleted ?? [],
          };
        },
        async moveCell(options) {
          const result = await ops.projectJupyterMoveCellData({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellId: options.cellId,
            beforeId: options.beforeId,
            afterId: options.afterId,
            atStart: options.atStart,
            atEnd: options.atEnd,
          });
          return {
            project: (
              await resolveProjectConatClient(
                ctx,
                binding.projectIdentifier,
                binding.cwd,
              )
            ).project,
            path: result.path,
            cell: result.cell!,
          };
        },
        async run(runOptions) {
          return await ops.projectJupyterRunSession({
            ctx,
            projectIdentifier: binding.projectIdentifier,
            path: binding.path,
            cwd: binding.cwd,
            cellIds: runOptions.cellIds,
            cellIndices: runOptions.cellIndices,
            allCode: runOptions.allCode,
            noHalt: runOptions.noHalt,
            limit: runOptions.limit,
            stdin: runOptions.stdin,
          });
        },
      };
    },
    close: ops.close,
  } as JupyterApi<Ctx, Project> & {
    close(): Promise<void>;
  };
}

export async function openJupyterApi(
  options: OpenJupyterApiOptions = {},
): Promise<OpenedJupyterApi> {
  const {
    apiBaseUrl = defaultApiBaseUrl(),
    client,
    project,
  } = await openCurrentProjectConnection(options);

  let closed = false;
  const api = createJupyterApi<undefined, ProjectIdentity>({
    async resolveProjectConatClient(_ctx, projectIdentifier) {
      if (closed) {
        throw new Error("jupyter api is closed");
      }
      if (
        projectIdentifier != null &&
        `${projectIdentifier}`.trim() !== "" &&
        `${projectIdentifier}`.trim() !== project.project_id
      ) {
        throw new Error(
          `openJupyterApi is bound to project ${project.project_id}, not ${projectIdentifier}`,
        );
      }
      return { project, client };
    },
  });

  return {
    ...api,
    project,
    apiBaseUrl,
    async close() {
      if (closed) return;
      closed = true;
      const internal = api as typeof api & { close?: () => Promise<void> };
      await internal.close?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
      client.close();
    },
  };
}
