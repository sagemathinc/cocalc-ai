import type {
  NbconvertParams,
  NbconvertResult,
} from "@cocalc/util/jupyter/types";
import type { RunNotebookOptions } from "@cocalc/util/jupyter/nbgrader-types";
import type { KernelSpec } from "@cocalc/util/jupyter/types";
import { type ProjectJupyterApiOptions } from "@cocalc/util/jupyter/api-types";

export type JupyterBackendState =
  | "failed"
  | "off"
  | "spawning"
  | "starting"
  | "running"
  | "closed";

export type JupyterKernelState = "idle" | "busy" | "running";

export interface KernelStatus {
  backend_state: JupyterBackendState;
  kernel_state: JupyterKernelState;
  identity?: string;
}

export interface KernelSignalResult {
  identity?: string;
}

export const jupyter = {
  start: true,
  stop: true,
  save: true,
  load: true,
  set: true,
  getKernelStatus: true,
  stripNotebook: true,
  nbconvert: true,
  runNotebook: true,
  kernelLogo: true,
  kernels: true,
  introspect: true,
  complete: true,
  signal: true,
  getConnectionFile: true,

  sendCommMessageToKernel: true,
  ipywidgetsGetBuffer: true,

  // jupyter stateless API
  apiExecute: true,

  // the user-confirmed restart of an unloadable edit history from the saved
  // notebook (bounded history plan H1b-3, option B)
  restartHistoryFromIpynb: true,
  // the live-writer seed of an unloadable history (option A)
  seedOversizedHistory: true,
};

export type SeedOversizedHistoryResult =
  | { seeded: true; history_epoch: number; repeated?: boolean }
  | {
      seeded: false;
      reason:
        | "not-running"
        | "not-ready"
        | "epoch"
        | "not-caught-up"
        | "busy"
        | "too-large"
        | "moved"
        | "deadline"
        | "invalid"
        | "failed";
      message?: string;
    };

export type RestartHistoryFromIpynbResult =
  | { restarted: true; history_epoch: number; repeated?: boolean }
  | {
      restarted: false;
      reason:
        | "invalid"
        | "busy"
        | "deadline"
        | "too-large"
        | "missing"
        | "unreadable"
        | "moved"
        | "epoch"
        | "failed";
      message?: string;
    };

// In the functions below path can be either the .ipynb or the .sage-jupyter2 path, and
// the correct backend kernel will get found/created automatically.
export interface Jupyter {
  stripNotebook: (path_ipynb: string) => Promise<string>;

  // path = the syncdb path (not *.ipynb). These methods run in the compute
  // container. Passive notebook open/edit/save and portable ipynb conversion
  // must use the project-host filesystem API so they never autostart compute.
  start: (path: string) => Promise<void>;
  stop: (path: string) => Promise<void>;
  save: (opts: JupyterSaveOptions) => Promise<void>;
  load: (opts: { path: string }) => Promise<void>;
  set: (opts: { path: string; ipynb: object }) => Promise<void>;
  getKernelStatus: (opts: { path: string }) => Promise<KernelStatus>;

  nbconvert: (opts: NbconvertParams) => Promise<NbconvertResult>;

  runNotebook: (opts: RunNotebookOptions) => Promise<string>;

  kernelLogo: (
    kernelName: string,
    opts?: { noCache?: boolean },
  ) => Promise<{ filename: string; base64: string }>;

  kernels: (opts?: { noCache?: boolean }) => Promise<KernelSpec[]>;

  introspect: (opts: {
    path: string;
    code: string;
    cursor_pos: number;
    detail_level: 0 | 1;
  }) => Promise<any>;

  complete: (opts: {
    path: string;
    code: string;
    cursor_pos: number;
  }) => Promise<any>;

  getConnectionFile: (opts: { path: string }) => Promise<string>;

  signal: (opts: {
    path: string;
    signal: string;
  }) => Promise<KernelSignalResult | undefined>;

  apiExecute: (opts: ProjectJupyterApiOptions) => Promise<object[]>;

  // Restart the notebook's edit history from its saved .ipynb, as one seeded
  // reset conditional on the history state the user confirmed (epoch and
  // revision): see jupyter/history-restart.ts.  Never starts the kernel.
  restartHistoryFromIpynb: (opts: {
    path: string;
    epoch: number;
    revision: { seq: number; count: number };
  }) => Promise<RestartHistoryFromIpynbResult>;

  // Seed a new history of the notebook from its live value, if this project's
  // backend has it open and ready in that epoch (bounded history plan H1b-3,
  // option A): see SyncDoc.seedHistoryFromLiveValue.  Never starts it.
  seedOversizedHistory: (opts: {
    path: string;
    epoch: number;
    oversizedSeq: number;
  }) => Promise<SeedOversizedHistoryResult>;

  sendCommMessageToKernel: (opts: {
    path: string;
    msg: {
      msg_id: string;
      comm_id: string;
      target_name: string;
      data: any;
      buffers64?: string[];
      buffers?: Buffer[];
    };
  }) => Promise<void>;

  ipywidgetsGetBuffer: (opts: {
    path: string;
    model_id: string;
    buffer_path: string | string[];
  }) => Promise<{ buffer64: string }>;
}

export type ExpectedJupyterCell = {
  id: string;
  cell_type?: string;
  input?: string;
};

export type JupyterSaveOptions = {
  path: string;
  expectedCellCount?: number;
  expectedCells?: ExpectedJupyterCell[];
  expectedCellIdsInOrder?: string[];
  expectedKernel?: string;
};
