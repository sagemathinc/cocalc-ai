/* Browser exec API declaration string used by browser-session service. */
export const BROWSER_EXEC_API_DECLARATION = `/**
 * Browser exec API available via 'cocalc browser exec'.
 *
 * Quick start:
 *   pnpm cli browser exec-api
 *   pnpm cli browser exec <workspace> 'const files = api.listOpenFiles(); return files;'
 *
 * Useful snippets:
 *   // Close all currently open markdown files in this workspace:
 *   const md = api.listOpenFiles().filter((x) => x.path.endsWith(".md"));
 *   await api.closeFiles(md.map((x) => x.path));
 *
 *   // Find notebooks containing "elliptic curve" and open the newest 3:
 *   const out = await api.fs.ripgrep("/root", "elliptic curve", { options: ["-l"] });
 *   const files = Buffer.from(out.stdout).toString().trim().split("\\n").filter(Boolean);
 *   const stats = await Promise.all(files.map(async (p) => ({ p, s: await api.fs.stat(p) })));
 *   stats.sort((a, b) => (b.s?.mtimeMs ?? 0) - (a.s?.mtimeMs ?? 0));
 *   await api.openFiles(stats.slice(0, 3).map((x) => x.p));
 *
 *   // Install hello-world extension editor and open a demo file:
 *   await api.extensions.installHelloWorld({ ext: ".hello" });
 *   await api.fs.writeFile("/root/demo.hello", "hello extension runtime\\n");
 *   await api.openFiles(["/root/demo.hello"]);
 *
 * Notes:
 * - paths are absolute (e.g. "/home/user/file.txt")
 * - api.projectId is the workspace id passed to browser exec
 * - In prod posture, if policy.allow_raw_exec is not true, exec runs in a
 *   QuickJS sandbox with a constrained API (api.navigate/click/type/...) where
 *   each api call executes immediately via policy-gated host actions and
 *   returns structured results to the script.
 */
export type BrowserOpenFileInfo = {
  project_id: string;
  title?: string;
  path: string;
};

export type BrowserNotebookCell = {
  id: string;
  cell_type: string;
  input: string;
  output: unknown;
};

export type BrowserNotifyType =
  | "error"
  | "default"
  | "success"
  | "info"
  | "warning";

export type BrowserNotifyOptions = {
  type?: BrowserNotifyType;
  title?: string;
  timeout?: number;
  block?: boolean;
};

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

export type BrowserBashOptions = {
  cwd?: string;
  path?: string;
  timeout?: number;
  max_output?: number;
  err_on_exit?: boolean;
  env?: Record<string, string>;
  filesystem?: boolean;
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

export type BrowserTerminalSpawnOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  env0?: Record<string, string>;
  rows?: number;
  cols?: number;
  timeout?: number;
  handleFlowControl?: boolean;
};

export type BrowserTerminalHistoryOptions = {
  max_chars?: number;
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

export type BrowserExtensionSummary = {
  id: string;
  name: string;
  version: string;
  kind: "hello-world";
  enabled: boolean;
  file_extensions: string[];
  installed_at: string;
};

export type BrowserInstallHelloWorldOptions = {
  id?: string;
  name?: string;
  version?: string;
  ext?: string | string[];
  title?: string;
  message?: string;
  replace?: boolean;
};

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
    listCells: (path: string) => Promise<BrowserNotebookCell[]>;
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
      opts?: BrowserNotifyOptions,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    info: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    success: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    warning: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
    error: (
      message: unknown,
      opts?: Omit<BrowserNotifyOptions, "type">,
    ) => { ok: true; type: BrowserNotifyType; message: string };
  };
  /**
   * File API closely mirrors CoCalc's async Node-like fs client.
   *
   * Notes:
   * - readFile(path, encoding) returns string if encoding is provided; otherwise Buffer.
   * - find/fd/ripgrep/dust return command-style output
   *   with stdout, stderr, code and optional truncated fields.
   */
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
    list: () => BrowserExtensionSummary[];
    installHelloWorld: (
      options?: BrowserInstallHelloWorldOptions,
    ) => Promise<BrowserExtensionSummary>;
    uninstall: (id: string) => { ok: true; id: string };
  };
};`;
