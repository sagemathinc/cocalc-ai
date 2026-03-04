import type { Command } from "commander";
import type { AuthConfig, GlobalAuthOptions } from "../../../core/auth-config";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import type {
  BrowserAtomicActionRequest,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAutomationPosture,
  BrowserCoordinateSpace,
  BrowserExecPolicyV1,
  BrowserScreenshotMetadata,
} from "@cocalc/conat/service/browser-session";

export type BrowserExecStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type BrowserExecOperation = {
  exec_id: string;
  project_id: string;
  status: BrowserExecStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancel_requested?: boolean;
  error?: string;
  result?: unknown;
};

export type BrowserRuntimeEventKind =
  | "console"
  | "uncaught_error"
  | "unhandled_rejection";

export type BrowserRuntimeEventLevel =
  | "trace"
  | "debug"
  | "log"
  | "info"
  | "warn"
  | "error";

export type BrowserRuntimeEvent = {
  seq: number;
  ts: string;
  kind: BrowserRuntimeEventKind;
  level: BrowserRuntimeEventLevel;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  url?: string;
};

export type BrowserNetworkTraceProtocol = "conat" | "http" | "ws";
export type BrowserNetworkTraceDirection = "send" | "recv";
export type BrowserNetworkTracePhase =
  | "publish_chunk"
  | "recv_chunk"
  | "recv_message"
  | "drop_chunk_seq"
  | "drop_chunk_timeout"
  | "http_request"
  | "http_response"
  | "http_error"
  | "ws_open"
  | "ws_send"
  | "ws_message"
  | "ws_close"
  | "ws_error";

export type BrowserNetworkTraceEvent = {
  seq: number;
  ts: string;
  protocol: BrowserNetworkTraceProtocol;
  direction: BrowserNetworkTraceDirection;
  phase: BrowserNetworkTracePhase;
  client_id?: string;
  address?: string;
  subject?: string;
  chunk_id?: string;
  chunk_seq?: number;
  chunk_done?: boolean;
  chunk_bytes?: number;
  raw_bytes?: number;
  encoding?: number;
  headers?: Record<string, unknown>;
  decoded_preview?: string;
  decode_error?: string;
  message?: string;
  target_url?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  url?: string;
};

export type BrowserSessionClient = {
  getExecApiDeclaration: () => Promise<string>;
  configureNetworkTrace: (opts?: {
    enabled?: boolean;
    include_decoded?: boolean;
    include_internal?: boolean;
    protocols?: BrowserNetworkTraceProtocol[];
    max_events?: number;
    max_preview_chars?: number;
    subject_prefixes?: string[];
    addresses?: string[];
  }) => Promise<{
    enabled: boolean;
    include_decoded: boolean;
    include_internal: boolean;
    protocols: BrowserNetworkTraceProtocol[];
    max_events: number;
    max_preview_chars: number;
    subject_prefixes: string[];
    addresses: string[];
    buffered: number;
    dropped: number;
    next_seq: number;
  }>;
  listNetworkTrace: (opts?: {
    after_seq?: number;
    limit?: number;
    protocol?: BrowserNetworkTraceProtocol;
    protocols?: BrowserNetworkTraceProtocol[];
    direction?: BrowserNetworkTraceDirection;
    phases?: BrowserNetworkTracePhase[];
    subject_prefix?: string;
    address?: string;
    include_decoded?: boolean;
  }) => Promise<{
    events: BrowserNetworkTraceEvent[];
    next_seq: number;
    dropped: number;
    total_buffered: number;
  }>;
  clearNetworkTrace: () => Promise<{
    ok: true;
    cleared: number;
    next_seq: number;
  }>;
  listRuntimeEvents: (opts?: {
    after_seq?: number;
    limit?: number;
    kinds?: BrowserRuntimeEventKind[];
    levels?: BrowserRuntimeEventLevel[];
  }) => Promise<{
    events: BrowserRuntimeEvent[];
    next_seq: number;
    dropped: number;
    total_buffered: number;
  }>;
  startExec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ exec_id: string; status: BrowserExecStatus }>;
  getExec: (opts: { exec_id: string }) => Promise<BrowserExecOperation>;
  cancelExec: (opts: {
    exec_id: string;
  }) => Promise<{ ok: true; exec_id: string; status: BrowserExecStatus }>;
  listOpenFiles: () => Promise<
    { project_id: string; title?: string; path: string }[]
  >;
  openFile: (opts: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
  }) => Promise<{ ok: true }>;
  closeFile: (opts: {
    project_id: string;
    path: string;
  }) => Promise<{ ok: true }>;
  exec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: unknown }>;
  action: (opts: {
    project_id: string;
    action: BrowserActionRequest;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: BrowserActionResult }>;
};

export type BrowserGlobals = GlobalAuthOptions & {
  json?: boolean;
  output?: "table" | "json" | "yaml";
  hubPassword?: string;
  apiKey?: string;
};

export type BrowserCommandContext = {
  globals: BrowserGlobals;
  accountId: string;
  timeoutMs: number;
  apiBaseUrl: string;
  remote: {
    client: unknown;
  };
  hub: {
    system: {
      listBrowserSessions: (opts: {
        include_stale?: boolean;
        max_age_ms?: number;
      }) => Promise<BrowserSessionInfo[]>;
      removeBrowserSession: (opts: {
        browser_id: string;
      }) => Promise<{ removed?: boolean }>;
    };
  };
};

export type BrowserWithContext = (
  command: unknown,
  commandName: string,
  fn: (ctx: BrowserCommandContext) => Promise<unknown>,
) => Promise<void>;

export type BrowserCommandDeps = {
  withContext: BrowserWithContext;
  authConfigPath: (env?: NodeJS.ProcessEnv) => string;
  loadAuthConfig: (path?: string) => AuthConfig;
  saveAuthConfig: (config: AuthConfig, path?: string) => void;
  selectedProfileName: (
    globals: Pick<GlobalAuthOptions, "profile">,
    config: AuthConfig,
    env?: NodeJS.ProcessEnv,
  ) => string;
  globalsFrom: (command: unknown) => BrowserGlobals;
  resolveWorkspace: (
    ctx: BrowserCommandContext,
    workspace: string,
  ) => Promise<{
    project_id: string;
    title?: string;
    host_id?: string | null;
  }>;
  createBrowserSessionClient: (opts: {
    account_id: string;
    browser_id: string;
    client?: unknown;
    timeout?: number;
  }) => BrowserSessionClient;
};

export type SpawnCookie = {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

export type PlaywrightDaemonConfig = {
  spawn_id: string;
  state_file: string;
  target_url: string;
  headless?: boolean;
  timeout_ms?: number;
  executable_path?: string;
  session_name?: string;
  cookies?: SpawnCookie[];
};

export type SpawnStateRecord = {
  spawn_id: string;
  pid: number;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  target_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  ready_at?: string;
  reason?: string;
  error?: string;
  page_url?: string;
  executable_path?: string;
  session_name?: string;
  browser_id?: string;
  session_url?: string;
  ipc_dir?: string;
};

export type ScreenshotRenderer = "auto" | "dom" | "native" | "media";

export type SpawnedScreenshotRequest = {
  request_id: string;
  action: "screenshot";
  selector: string;
  wait_for_idle_ms: number;
  timeout_ms: number;
  full_page?: boolean;
  viewport_width?: number;
  viewport_height?: number;
};

export type SpawnedScreenshotResponse =
  | {
      ok: true;
      request_id: string;
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      request_id: string;
      error: string;
    };

export type BrowserProfileSelection = {
  path: string;
  config: AuthConfig;
  profile: string;
  browser_id?: string;
  browser_id_scoped?: string;
  browser_id_global?: string;
  api_scope?: string;
};

export type BrowserSessionRegisterUtils = {
  loadProfileSelection: (deps: BrowserCommandDeps, command: Command) => BrowserProfileSelection;
  saveProfileBrowserId: (opts: {
    deps: BrowserCommandDeps;
    command: Command;
    browser_id?: string;
    apiBaseUrl?: string;
  }) => { profile: string; browser_id?: string };
  resolveBrowserSession: (
    sessions: BrowserSessionInfo[],
    browserHint: string,
  ) => BrowserSessionInfo;
  randomSpawnId: () => string;
  spawnStateFile: (spawnId: string) => string;
  readSpawnState: (path: string) => SpawnStateRecord | undefined;
  isProcessRunning: (pid: number) => boolean;
  resolveSpawnTargetUrl: (opts: {
    apiUrl: string;
    projectId?: string;
    explicitTargetUrl?: string;
  }) => string;
  withSpawnMarker: (targetUrl: string, marker: string) => string;
  resolveChromiumExecutablePath: (preferred?: string) => string | undefined;
  resolveSecret: (value: unknown) => string | undefined;
  buildSpawnCookies: (opts: {
    apiUrl: string;
    hubPassword?: string;
    apiKey?: string;
  }) => SpawnCookie[];
  writeDaemonConfig: (path: string, value: PlaywrightDaemonConfig) => void;
  parseDiscoveryTimeout: (value: string | undefined, fallbackMs: number) => number;
  waitForSpawnStateReady: (opts: {
    stateFile: string;
    timeoutMs: number;
  }) => Promise<SpawnStateRecord>;
  waitForSpawnedSession: (opts: {
    ctx: BrowserCommandContext;
    marker: string;
    timeoutMs: number;
  }) => Promise<BrowserSessionInfo>;
  nowIso: () => string;
  terminateSpawnedProcess: (opts: {
    pid: number;
    timeoutMs: number;
  }) => Promise<{ terminated: boolean; killed: boolean }>;
  listSpawnStates: () => Array<{ file: string; state: SpawnStateRecord }>;
  resolveSpawnStateById: (
    id: string,
  ) => { file: string; state: SpawnStateRecord } | undefined;
  isSeaMode: () => boolean;
  sessionMatchesProject: (
    session: BrowserSessionInfo,
    projectId: string | undefined,
  ) => boolean;
  sessionTargetContext: (
    ctx: BrowserCommandContext,
    sessionInfo: BrowserSessionInfo,
    project_id?: string,
  ) => Record<string, unknown>;
  writeSpawnState: (path: string, value: SpawnStateRecord) => void;
  DEFAULT_READY_TIMEOUT_MS: number;
  DEFAULT_DISCOVERY_TIMEOUT_MS: number;
  DEFAULT_DESTROY_TIMEOUT_MS: number;
  SPAWN_STATE_DIR: string;
  spawnProcess: typeof import("node:child_process").spawn;
  resolvePath: (...paths: string[]) => string;
  join: (...paths: string[]) => string;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
  isValidUUID: (s: string) => boolean;
};

export type BrowserObservabilityRegisterUtils = {
  loadProfileSelection: (deps: BrowserCommandDeps, command: Command) => BrowserProfileSelection;
  chooseBrowserSession: (opts: {
    ctx: BrowserCommandContext;
    browserHint?: string;
    fallbackBrowserId?: string;
    requireDiscovery?: boolean;
    sessionProjectId?: string;
    activeOnly?: boolean;
  }) => Promise<BrowserSessionInfo>;
  browserHintFromOption: (value: unknown) => string | undefined;
  parseRuntimeEventLevels: (value: unknown) => BrowserRuntimeEventLevel[] | undefined;
  formatRuntimeEventLine: (event: BrowserRuntimeEvent) => string;
  durationToMs: (value: unknown, fallbackMs: number) => number;
  sessionTargetContext: (
    ctx: BrowserCommandContext,
    sessionInfo: BrowserSessionInfo,
    project_id?: string,
  ) => Record<string, unknown>;
  parseNetworkDirection: (
    value: unknown,
  ) => BrowserNetworkTraceDirection | undefined;
  parseNetworkProtocols: (
    value: unknown,
  ) => BrowserNetworkTraceProtocol[] | undefined;
  parseNetworkPhases: (value: unknown) => BrowserNetworkTracePhase[] | undefined;
  formatNetworkTraceLine: (event: BrowserNetworkTraceEvent) => string;
  parseCsvStrings: (value: unknown) => string[] | undefined;
  sleep: (ms: number) => Promise<void>;
};

export type BrowserActionRegisterUtils = {
  loadProfileSelection: (deps: BrowserCommandDeps, command: Command) => BrowserProfileSelection;
  browserHintFromOption: (value: unknown) => string | undefined;
  chooseBrowserSession: (opts: {
    ctx: BrowserCommandContext;
    browserHint?: string;
    fallbackBrowserId?: string;
    requireDiscovery?: boolean;
    sessionProjectId?: string;
    activeOnly?: boolean;
  }) => Promise<BrowserSessionInfo>;
  resolveTargetProjectId: (opts: {
    deps: Pick<BrowserCommandDeps, "resolveWorkspace">;
    ctx: BrowserCommandContext;
    workspace?: string;
    projectId?: string;
    sessionInfo: BrowserSessionInfo;
  }) => Promise<string>;
  resolveBrowserPolicyAndPosture: (opts: {
    posture?: string;
    policyFile?: string;
    allowRawExec?: boolean;
    apiBaseUrl?: string;
  }) => Promise<{
    posture: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }>;
  parseOptionalDurationMs: (
    value: unknown,
    fallbackMs: number,
  ) => number | undefined;
  parseCoordinateSpace: (value: unknown) => BrowserCoordinateSpace;
  readScreenshotMeta: (
    metaFile: string | undefined,
  ) => Promise<BrowserScreenshotMetadata | undefined>;
  parseRequiredNumber: (value: unknown, label: string) => number;
  sessionTargetContext: (
    ctx: BrowserCommandContext,
    sessionInfo: BrowserSessionInfo,
    project_id?: string,
  ) => Record<string, unknown>;
  parseScrollBehavior: (value: unknown) => "auto" | "smooth";
  parseScrollAlign: (
    value: unknown,
    label: "block" | "inline",
  ) => "start" | "center" | "end" | "nearest";
  durationToMs: (value: unknown, fallbackMs: number) => number;
};

export type BrowserHarnessRegisterUtils = {
  loadProfileSelection: (deps: BrowserCommandDeps, command: Command) => BrowserProfileSelection;
  browserHintFromOption: (value: unknown) => string | undefined;
  chooseBrowserSession: (opts: {
    ctx: BrowserCommandContext;
    browserHint?: string;
    fallbackBrowserId?: string;
    requireDiscovery?: boolean;
    sessionProjectId?: string;
    activeOnly?: boolean;
  }) => Promise<BrowserSessionInfo>;
  resolveTargetProjectId: (opts: {
    deps: Pick<BrowserCommandDeps, "resolveWorkspace">;
    ctx: BrowserCommandContext;
    workspace?: string;
    projectId?: string;
    sessionInfo: BrowserSessionInfo;
  }) => Promise<string>;
  resolveBrowserPolicyAndPosture: (opts: {
    posture?: string;
    policyFile?: string;
    allowRawExec?: boolean;
    apiBaseUrl?: string;
  }) => Promise<{
    posture: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }>;
  sessionTargetContext: (
    ctx: BrowserCommandContext,
    sessionInfo: BrowserSessionInfo,
    project_id?: string,
  ) => Record<string, unknown>;
  durationToMs: (value: unknown, fallbackMs: number) => number;
};

export type BrowserInspectRegisterUtils = {
  loadProfileSelection: (deps: BrowserCommandDeps, command: Command) => BrowserProfileSelection;
  browserHintFromOption: (value: unknown) => string | undefined;
  chooseBrowserSession: (opts: {
    ctx: BrowserCommandContext;
    browserHint?: string;
    fallbackBrowserId?: string;
    requireDiscovery?: boolean;
    sessionProjectId?: string;
    activeOnly?: boolean;
  }) => Promise<BrowserSessionInfo>;
  resolveTargetProjectId: (opts: {
    deps: Pick<BrowserCommandDeps, "resolveWorkspace">;
    ctx: BrowserCommandContext;
    workspace?: string;
    projectId?: string;
    sessionInfo: BrowserSessionInfo;
  }) => Promise<string>;
  resolveBrowserPolicyAndPosture: (opts: {
    posture?: string;
    policyFile?: string;
    allowRawExec?: boolean;
    apiBaseUrl?: string;
  }) => Promise<{
    posture: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }>;
  sessionTargetContext: (
    ctx: BrowserCommandContext,
    sessionInfo: BrowserSessionInfo,
    project_id?: string,
  ) => Record<string, unknown>;
  durationToMs: (value: unknown, fallbackMs: number) => number;
};

export type { BrowserAtomicActionRequest };
