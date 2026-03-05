import type { BrowserOpenFileInfo } from "@cocalc/conat/service/browser-session";
import type {
  BrowserExtensionSummary,
  BrowserInstallHelloWorldOptions,
} from "../extensions-runtime";
import type {
  BrowserBashOptions,
  BrowserNotifyType,
  BrowserTerminalHistoryOptions,
  BrowserTerminalSpawnOptions,
} from "./exec-utils";

export type BrowserExecOutput = {
  stdout: unknown;
  stderr: unknown;
  exit_code?: number;
  code?: number | null;
  status?: string;
  job_id?: string;
  pid?: number;
  elapsed_s?: number;
  stats?: unknown;
  truncated?: boolean;
};

export type BrowserFsExecOutput = {
  stdout: Buffer | string;
  stderr: Buffer | string;
  code: number | null;
  truncated?: boolean;
};

export type BrowserFsFindOptions = {
  timeout?: number;
  options?: string[];
  darwin?: string[];
  linux?: string[];
  maxSize?: number;
};

export type BrowserFsFdOptions = BrowserFsFindOptions & {
  pattern?: string;
};

export type BrowserFsRipgrepOptions = BrowserFsFindOptions;
export type BrowserFsDustOptions = BrowserFsFindOptions;

export type BrowserFsDirent = {
  name: string;
  parentPath: string;
  path: string;
  type?: number;
};

export type BrowserFsStat = {
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  atimeMs?: number;
  mode?: number;
};

export type BrowserTerminalFrameInfo = {
  parent_path: string;
  frame_id: string;
  type: string;
  active: boolean;
  number?: number;
  command?: string;
  args?: string[];
  title?: string;
  session_path?: string;
};

export type BrowserTerminalSessionInfo = {
  session_path: string;
  command: string;
  args: string[];
  pid?: number;
  history_chars?: number;
};

export type BrowserExtensionApiSummary = BrowserExtensionSummary;
export type BrowserInstallHelloOptions = BrowserInstallHelloWorldOptions;

export type BrowserExecApi = {
  projectId: string;
  workspaceId: string;
  listOpenFiles: () => BrowserOpenFileInfo[];
  listOpenFilesAll: () => BrowserOpenFileInfo[];
  openFiles: (
    paths: unknown,
    opts?: { background?: boolean },
  ) => Promise<{ opened: number; paths: string[] }>;
  closeFiles: (paths: unknown) => Promise<{ closed: number; paths: string[] }>;
  notebook: {
    listCells: (
      path: string,
    ) => Promise<
      {
        id: string;
        cell_type: string;
        input: string;
        output: unknown;
      }[]
    >;
    runCells: (
      path: string,
      ids?: unknown,
    ) => Promise<{ ran: number; mode: "all" | "selected"; ids: string[] }>;
    setCells: (
      path: string,
      updates: unknown,
    ) => Promise<{ updated: number; ids: string[] }>;
  };
  notify: {
    show: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    info: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    success: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    warning: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    error: (
      message: unknown,
      opts?: unknown,
    ) => { ok: true; type: BrowserNotifyType; message: string };
  };
  fs: {
    exists: (path: string) => Promise<boolean>;
    readFile: (
      path: string,
      encoding?: string,
      lock?: number,
    ) => Promise<string | Buffer>;
    writeFile: (path: string, data: string | Buffer, saveLast?: boolean) => Promise<void>;
    readdir: (
      path: string,
      options?: { withFileTypes?: boolean },
    ) => Promise<string[] | BrowserFsDirent[]>;
    stat: (path: string) => Promise<BrowserFsStat>;
    lstat: (path: string) => Promise<BrowserFsStat>;
    mkdir: (
      path: string,
      options?: { recursive?: boolean; mode?: string | number },
    ) => Promise<void>;
    rm: (
      path: string | string[],
      options?: {
        recursive?: boolean;
        force?: boolean;
        maxRetries?: number;
        retryDelay?: number;
      },
    ) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    copyFile: (src: string, dest: string) => Promise<void>;
    cp: (
      src: string | string[],
      dest: string,
      options?: {
        dereference?: boolean;
        errorOnExist?: boolean;
        force?: boolean;
        preserveTimestamps?: boolean;
        recursive?: boolean;
        verbatimSymlinks?: boolean;
        reflink?: boolean;
        timeout?: number;
      },
    ) => Promise<void>;
    move: (
      src: string | string[],
      dest: string,
      options?: { overwrite?: boolean },
    ) => Promise<void>;
    find: (path: string, options?: BrowserFsFindOptions) => Promise<BrowserFsExecOutput>;
    fd: (path: string, options?: BrowserFsFdOptions) => Promise<BrowserFsExecOutput>;
    ripgrep: (
      path: string,
      pattern: string,
      options?: BrowserFsRipgrepOptions,
    ) => Promise<BrowserFsExecOutput>;
    dust: (path: string, options?: BrowserFsDustOptions) => Promise<BrowserFsExecOutput>;
  };
  bash: {
    run: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    start: (script: string, options?: BrowserBashOptions) => Promise<BrowserExecOutput>;
    get: (
      job_id: string,
      options?: { async_stats?: boolean; async_await?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
    wait: (
      job_id: string,
      options?: { async_stats?: boolean; timeout?: number },
    ) => Promise<BrowserExecOutput>;
  };
  terminal: {
    listOpen: () => Promise<BrowserTerminalFrameInfo[]>;
    openSplit: (
      path: string,
      opts?: {
        direction?: "row" | "col";
        anchor_frame_id?: string;
        command?: string;
        args?: string[];
        no_focus?: boolean;
        first?: boolean;
      },
    ) => Promise<BrowserTerminalFrameInfo>;
    spawn: (
      session_path: string,
      options?: BrowserTerminalSpawnOptions,
    ) => Promise<BrowserTerminalSessionInfo>;
    write: (
      session_path: string,
      data: string,
      opts?: { kind?: "user" | "auto" },
    ) => Promise<{ ok: true }>;
    history: (
      session_path: string,
      opts?: BrowserTerminalHistoryOptions,
    ) => Promise<string>;
    state: (session_path: string) => Promise<"running" | "off">;
    cwd: (session_path: string) => Promise<string | undefined>;
    resize: (
      session_path: string,
      opts: { rows: number; cols: number },
    ) => Promise<{ ok: true }>;
    destroy: (session_path: string) => Promise<{ ok: true }>;
  };
  timetravel: {
    providers: () => Promise<{
      patchflow: boolean;
      snapshots: boolean;
      backups: boolean;
      git: boolean;
    }>;
    patchflow: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          patch_time?: number;
          wall_time?: number;
          version_number?: number;
          account_id?: string;
          user_id?: number;
        }[]
      >;
      getText: (path: string, version: string) => Promise<string>;
    };
    snapshots: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime_ms?: number;
        }[]
      >;
      getText: (path: string, snapshot: string) => Promise<string>;
    };
    backups: {
      listVersions: (path: string) => Promise<
        {
          id: string;
          wall_time?: number;
          mtime?: number;
          size?: number;
        }[]
      >;
      getText: (path: string, backup_id: string) => Promise<string>;
    };
    git: {
      listVersions: (path: string) => Promise<
        {
          hash: string;
          wall_time?: number;
          author_name?: string;
          author_email?: string;
          subject?: string;
        }[]
      >;
      getText: (path: string, commit: string) => Promise<string>;
    };
  };
  extensions: {
    list: () => BrowserExtensionApiSummary[];
    installHelloWorld: (
      options?: BrowserInstallHelloOptions,
    ) => Promise<BrowserExtensionApiSummary>;
    uninstall: (id: string) => { ok: true; id: string };
  };
};
