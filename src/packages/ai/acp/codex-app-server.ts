import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import getLogger from "@cocalc/backend/logger";
import { argsJoin } from "@cocalc/util/args";
import {
  codexServiceTierForAppServer,
  CODEX_APP_SERVER_FEATURE_ARGS,
  DEFAULT_CODEX_MODEL_NAME,
  normalizeCodexSessionId,
  type CodexSessionConfig,
} from "@cocalc/util/ai/codex";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import type { CodexModelCapabilityInfo } from "@cocalc/conat/hub/api/system";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";
import type {
  AcpAgent,
  AcpEvaluateRequest,
  AcpStreamEvent,
  AcpSteerRequest,
  AcpSteerResult,
  AcpStreamUsage,
} from "./types";
import {
  getCodexProjectSpawner,
  type CodexAppServerLoginHint,
  type CodexAttentionContext,
  type CodexAttentionHandler,
  type CodexProjectContainerPathMap,
  type CodexAppServerRequestHandler,
  type CodexSiteFundedTurnRequest,
  type CodexSiteFundedTurnRuntime,
} from "./codex-project";
import {
  CODEX_SYNC_QUESTION_METHOD,
  normalizeCodexAsyncQuestions,
  normalizeCodexSyncQuestionRequest,
  supportsCodexAttentionInput,
} from "./codex-attention";
import { getCodexSiteKeyGovernor } from "./codex-site-key-governor";
const logger = getLogger("ai:acp:codex-app-server");
const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_APP_SERVER_TIMEOUT_MS ?? 90_000),
);
const ACCOUNT_STATUS_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_ACCOUNT_STATUS_TIMEOUT_MS ?? 20_000),
);
const ACCOUNT_STATUS_SHUTDOWN_GRACE_MS = 200;
const TURN_NOTIFICATION_IDLE_TIMEOUT_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(process.env.COCALC_CODEX_APP_SERVER_NOTIFICATION_TIMEOUT_MS ?? 60_000),
);
function getTurnNotificationIdleTimeoutMs(): number {
  const override = Number(
    process.env.COCALC_CODEX_TURN_NOTIFICATION_IDLE_TIMEOUT_MS,
  );
  return Number.isFinite(override) && override > 0
    ? Math.max(10, override)
    : TURN_NOTIFICATION_IDLE_TIMEOUT_MS;
}
function getTurnReconcileFailureLimit(): number {
  return Math.max(
    1,
    Number(process.env.COCALC_CODEX_TURN_RECONCILE_FAILURE_LIMIT ?? 3),
  );
}
export const CODEX_ACP_RECOVERY_ERROR_CODE = {
  appServerExited: "codex_app_server_exited",
  commandBlocked: "codex_command_blocked",
  modelCapacity: "codex_model_capacity",
  resourceKilled: "codex_resource_killed",
  turnLost: "codex_turn_lost",
} as const;
export type CodexAcpRecoveryErrorCode =
  (typeof CODEX_ACP_RECOVERY_ERROR_CODE)[keyof typeof CODEX_ACP_RECOVERY_ERROR_CODE];
const APP_SERVER_IDLE_EXIT_MS = Math.max(
  0,
  Number(process.env.COCALC_CODEX_APP_SERVER_IDLE_EXIT_MS ?? 10 * 60_000),
);
const BACKGROUND_TERMINAL_POLL_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_BACKGROUND_TERMINAL_POLL_MS ?? 30_000),
);
const MAX_CONCURRENT_SUBAGENTS = 16;
const MAX_SUBAGENT_EVENT_TEXT_LENGTH = 2_000;

type SubagentStreamEvent = Extract<AcpStreamEvent, { type: "subagent" }>;

function boundedSubagentText(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!text) return;
  return text.length <= MAX_SUBAGENT_EVENT_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_SUBAGENT_EVENT_TEXT_LENGTH)}...`;
}

function normalizeMaxConcurrentSubagents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return;
  return Math.min(MAX_CONCURRENT_SUBAGENTS, Math.max(1, value));
}

function attentionInputEnabled(supported: boolean): boolean {
  return supported && process.env.COCALC_CODEX_ATTENTION_INPUT === "1";
}

function asyncAttentionEnabled(): boolean {
  return process.env.COCALC_CODEX_ATTENTION_ASYNC === "1";
}

function threadConfig(
  maxConcurrentSubagents: number | undefined,
  hasAttentionHandler = false,
): Record<string, number | boolean> | undefined {
  const config: Record<string, number | boolean> = {};
  if (attentionInputEnabled(hasAttentionHandler)) {
    config["features.default_mode_request_user_input"] = true;
  }
  if (maxConcurrentSubagents == null) {
    return Object.keys(config).length > 0 ? config : undefined;
  }
  // Codex counts the manager in max_concurrent_threads_per_session.
  const totalThreads = maxConcurrentSubagents + 1;
  // V1 and V2 have separate config paths. Supplying both is accepted by
  // Codex and prevents a feature rollout from silently bypassing the cap.
  config["agents.max_concurrent_threads_per_session"] = totalThreads;
  config["features.multi_agent_v2.max_concurrent_threads_per_session"] =
    totalThreads;
  return config;
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function normalizeDiffLines(text: string): string[] {
  const lines = `${text ?? ""}`.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function shouldClearActiveGoalBeforeTurn(request: AcpEvaluateRequest): boolean {
  return !!request.chat;
}

function formatDiffGutter(
  left: number | undefined,
  right: number | undefined,
  sign: string,
): string {
  const leftLabel = left == null ? "" : `${left}`;
  const rightLabel = right == null ? "" : `${right}`;
  return `${leftLabel.padStart(6)} ${rightLabel.padStart(6)}  ${sign}`;
}

function lineDiffFromRawChangeText(
  text: string,
  op: -1 | 1,
): LineDiffResult | undefined {
  const lines = normalizeDiffLines(text);
  if (!lines.length) return undefined;
  return {
    lines,
    types: lines.map(() => op),
    gutters: lines.map((_line, i) =>
      op === 1
        ? formatDiffGutter(undefined, i + 1, "+")
        : formatDiffGutter(i + 1, undefined, "-"),
    ),
    chunkBoundaries: [lines.length - 1],
  };
}

function lineDiffFromUnifiedPatch(
  diffText: string,
): LineDiffResult | undefined {
  const lines = normalizeDiffLines(diffText);
  const diffLines: string[] = [];
  const types: Array<-1 | 0 | 1> = [];
  const gutters: string[] = [];
  const chunkBoundaries: number[] = [];
  let leftLine = 0;
  let rightLine = 0;
  let sawHunk = false;

  const pushBoundary = () => {
    const last = diffLines.length - 1;
    if (last < 0) return;
    if (chunkBoundaries[chunkBoundaries.length - 1] === last) return;
    chunkBoundaries.push(last);
  };

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      pushBoundary();
      leftLine = Math.max(0, Number(header[1]) - 1);
      rightLine = Math.max(0, Number(header[2]) - 1);
      sawHunk = true;
      continue;
    }
    if (!sawHunk) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("diff --git ") || line.startsWith("index ")) continue;
    if (
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      diffLines.push(line);
      types.push(0);
      gutters.push(formatDiffGutter(undefined, undefined, " "));
      continue;
    }
    if (line.startsWith("+")) {
      rightLine += 1;
      diffLines.push(line.slice(1));
      types.push(1);
      gutters.push(formatDiffGutter(undefined, rightLine, "+"));
      continue;
    }
    if (line.startsWith("-")) {
      leftLine += 1;
      diffLines.push(line.slice(1));
      types.push(-1);
      gutters.push(formatDiffGutter(leftLine, undefined, "-"));
      continue;
    }
    if (line.startsWith(" ")) {
      leftLine += 1;
      rightLine += 1;
      diffLines.push(line.slice(1));
      types.push(0);
      gutters.push(formatDiffGutter(leftLine, rightLine, " "));
      continue;
    }
    diffLines.push(line);
    types.push(0);
    gutters.push(formatDiffGutter(undefined, undefined, " "));
  }

  pushBoundary();
  if (!diffLines.length) return undefined;
  return { lines: diffLines, types, gutters, chunkBoundaries };
}

function getFileChangeLineDiff(change: any): LineDiffResult | undefined {
  const diffText = typeof change?.diff === "string" ? change.diff : "";
  if (!diffText.trim()) return undefined;
  const changeKind =
    `${change?.kind?.type ?? change?.kind ?? ""}`.toLowerCase();
  if (changeKind === "add") {
    return lineDiffFromRawChangeText(diffText, 1);
  }
  if (changeKind === "delete") {
    return lineDiffFromRawChangeText(diffText, -1);
  }
  return lineDiffFromUnifiedPatch(diffText);
}

function patchPathFromHeaderLine(line: string): string | undefined {
  const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (diffMatch) {
    return diffMatch[2] || diffMatch[1];
  }
  const plusMatch = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
  if (plusMatch && plusMatch[1] !== "/dev/null") {
    return plusMatch[1];
  }
  const minusMatch = /^--- (?:a\/)?(.+)$/.exec(line);
  if (minusMatch && minusMatch[1] !== "/dev/null") {
    return minusMatch[1];
  }
  return undefined;
}

function splitUnifiedDiffByFile(
  diffText: string,
): Array<{ path: string; diffText: string }> {
  const lines = normalizeDiffLines(diffText);
  const blocks: Array<{ path: string; diffText: string }> = [];
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath || currentLines.length === 0) return;
    blocks.push({
      path: currentPath,
      diffText: currentLines.join("\n"),
    });
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentLines = [line];
      currentPath = patchPathFromHeaderLine(line);
      continue;
    }
    currentLines.push(line);
    currentPath ||= patchPathFromHeaderLine(line);
  }

  flush();
  return blocks;
}

function normalizeActivityPathKey(
  rawPath: string | undefined,
  cwd?: string,
): string | undefined {
  const trimmed = `${rawPath ?? ""}`.trim();
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (cwd) {
    return path.normalize(path.resolve(cwd, trimmed));
  }
  return path.normalize(trimmed);
}

function getCoCalcProjectRuntimeGuidance(cliCommand: string): string[] {
  return [
    "This turn may run with CoCalc CLI/project runtime context.",
    `When you need the CoCalc CLI, use this exact command: \`${cliCommand}\`. Do not assume bare \`cocalc\` resolves to the right binary.`,
    "Prefer scoped variables already provided in environment, e.g.:",
    "- COCALC_PROJECT_ID",
    "- COCALC_API_URL",
    "- COCALC_BEARER_TOKEN",
    "Project secret changes apply immediately to running projects; do not restart a project merely to apply a secret update. Programs that cache credentials may need their own reload.",
    "Use Codex's synchronous or asynchronous question tools when human input is required. Use asynchronous questions only when useful authorized work can continue while waiting.",
    "Do not use question tools for permission or authentication escalation. Use typed first-party CoCalc actions for supported fresh-auth, login, and approval flows.",
    "Never ask the user to paste a password, access token, one-time code, cookie, or other secret into a question response.",
    "Prefer high-signal commands over raw browser scripts when available.",
    `For supported document builds, use \`${cliCommand} project build -h\` and \`${cliCommand} project build <path>\` so the complete editor pipeline runs without requiring a browser.`,
    "For notebook edits/execution that must survive browser refresh or disconnect, prefer `cocalc project jupyter -h` over `browser exec`.",
    "For multi-step notebook work, prefer `cocalc project jupyter exec --path ... --stdin` for ad hoc snippets or `--file <script.js>` for saved scripts instead of shelling multiple notebook commands.",
    "Use `cocalc project jupyter exec-api` to inspect the ambient notebook script API before writing a multi-step script. `api.notebook.run(...)` returns `run.run_id`.",
    "Treat the live in-memory notebook state as the source of truth for live notebook work.",
    "Do not read or edit `.ipynb` JSON directly for live notebook inspection or mutation unless the user explicitly asks for filesystem-level work.",
    "For live text editor content or edits, prefer backend exec with the live sync/session API over direct filesystem reads when unsaved browser state may matter.",
    `Example read: ${cliCommand} exec 'const doc = api.text.open({ path: "/home/user/file.md", projectIdentifier: process.env.COCALC_PROJECT_ID }); return await doc.read();'`,
    `Example append: ${cliCommand} exec 'const doc = api.text.open({ path: "/home/user/file.md", projectIdentifier: process.env.COCALC_PROJECT_ID }); const before = await doc.read(); return await doc.append("\\nAgent note", { expectedHash: before.hash });'`,
    "The `api.text` write/append/replace methods save to disk by default; pass `{ saveToDisk: false }` only for intentional live-only collaborative edits.",
  ];
}

function getCoCalcBrowserRuntimeGuidance(cliCommand: string): string[] {
  return [
    `If relevant, you can use \`${cliCommand}\` to inspect browser state and run browser exec scripts.`,
    "The browser-scoped environment includes COCALC_BROWSER_ID.",
    "Use `browser exec` only for UI-only context such as selection or viewport state.",
    "For questions like 'what browser tabs/files do I have open?', start with:",
    `1) List open files/tabs: ${cliCommand} browser files --project-id \"$COCALC_PROJECT_ID\" --browser \"$COCALC_BROWSER_ID\"`,
    "Use `browser workspace-state` for workspace selection/records, not as the first command for simple tab listing.",
    `For visible UI-only state that typed commands cannot answer, use screenshot or browser exec with exact targets: ${cliCommand} browser exec --project-id \"$COCALC_PROJECT_ID\" --browser \"$COCALC_BROWSER_ID\" --file <script.js>`,
    "Under agent auth, pass exact browser/project targets to avoid blocked session discovery.",
  ];
}

function getCoCalcRuntimeGuidanceHeader(
  cliCommand: string,
  { hasBrowser }: { hasBrowser: boolean },
): string {
  return [
    "[CoCalc runtime capabilities]",
    ...getCoCalcProjectRuntimeGuidance(cliCommand),
    ...(hasBrowser ? getCoCalcBrowserRuntimeGuidance(cliCommand) : []),
    "[/CoCalc runtime capabilities]",
  ].join("\n");
}

type CodexAppServerOptions = {
  binaryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  uploadGeneratedImage?: (opts: {
    savedPath: string;
    hostPath: string;
    codexHomeHostPath?: string;
    filename: string;
    imageId?: string;
    revisedPrompt?: string;
    cwd: string;
    projectId?: string;
    accountId?: string;
    threadId?: string;
    turnId?: string;
  }) => Promise<
    | {
        uuid: string;
        filename: string;
        url: string;
      }
    | undefined
  >;
  onOutstandingWorkChanged?: (status: {
    sessionId: string;
    projectId: string;
    accountId: string;
    chat?: AcpEvaluateRequest["chat"];
    managerState: "completed" | "interrupted";
    activeDescendantThreadIds: string[];
    activeDescendants: number;
    backgroundTerminals: number;
    maxConcurrentSubagents?: number;
  }) => void | Promise<void>;
  onRuntimeOwnershipChanged?: (status: {
    state: "owned" | "released";
    sessionId: string;
    projectId: string;
    accountId: string;
    path?: string;
  }) => void | Promise<void>;
  attentionHandler?: CodexAttentionHandler;
};

type SpawnedCodexAppServer = {
  proc: ReturnType<typeof spawn>;
  cmd: string;
  args: string[];
  logArgs?: string;
  cwd?: string;
  authSource?: string;
  containerPathMap?: CodexProjectContainerPathMap;
  appServerLogin?: CodexAppServerLoginHint;
  handleAppServerRequest?: CodexAppServerRequestHandler;
  runtimeEnv?: Record<string, string>;
  setAgentSessionKey?: (agentSessionKey: string) => Promise<void>;
  siteFundedTurn?: CodexSiteFundedTurnRuntime;
};

function agentTurnSessionKey(
  request: AcpEvaluateRequest,
  fallback: string,
): string {
  const threadId = `${request.chat?.thread_id ?? ""}`.trim();
  const turnId =
    `${request.chat?.user_message_date ?? ""}`.trim() ||
    `${request.chat?.recovery_parent_op_id ?? ""}`.trim() ||
    `${request.chat?.message_id ?? ""}`.trim() ||
    fallback;
  return `${threadId}\0${turnId}`;
}

function authSourceForSpawned(
  spawned: Pick<SpawnedCodexAppServer, "authSource" | "appServerLogin">,
): string | undefined {
  if (spawned.authSource) return spawned.authSource;
  if (spawned.appServerLogin?.type === "chatgptAuthTokens") {
    return "subscription";
  }
  return undefined;
}

export type CodexAppServerAccountStatus = {
  authentication: {
    status: "connected" | "needs-sign-in" | "unverified";
    reason?: string;
  };
  account?: any;
  rateLimits?: any;
  tokenUsage?: any;
  models?: CodexModelCapabilityInfo[];
  errors?: {
    account?: string;
    rateLimits?: string;
    tokenUsage?: string;
    models?: string;
  };
};

function isCodexAuthenticationError(value: unknown): boolean {
  const text = `${value ?? ""}`.trim().toLowerCase();
  if (!text) return false;
  return [
    "authentication required",
    "unauthorized",
    "invalid_grant",
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "sign-in has expired",
    "sign-in is no longer connected",
    "http 401",
  ].some((needle) => text.includes(needle));
}

function classifyCodexAuthentication({
  account,
  rateLimits,
  errors,
}: {
  account?: any;
  rateLimits?: any;
  errors?: CodexAppServerAccountStatus["errors"];
}): CodexAppServerAccountStatus["authentication"] {
  if (
    isCodexAuthenticationError(errors?.account) ||
    isCodexAuthenticationError(errors?.rateLimits)
  ) {
    return {
      status: "needs-sign-in",
      reason:
        "ChatGPT could not authenticate the stored sign-in. Sign in again with ChatGPT in CoCalc, then retry.",
    };
  }
  if (rateLimits != null || account?.requiresOpenaiAuth === false) {
    return { status: "connected" };
  }
  if (account?.requiresOpenaiAuth === true && account?.account == null) {
    return {
      status: "needs-sign-in",
      reason:
        "ChatGPT sign-in is missing or expired. Sign in again with ChatGPT in CoCalc, then retry.",
    };
  }
  if (account?.account != null) {
    // Account identity is authoritative even when the independent usage API is
    // temporarily unavailable.
    return { status: "connected" };
  }
  return {
    status: "unverified",
    reason:
      errors?.account ??
      errors?.rateLimits ??
      "CoCalc could not verify the ChatGPT sign-in.",
  };
}

type RpcResponse = {
  id?: number;
  result?: any;
  error?: { message?: string };
};

type RpcNotification = {
  method: string;
  params?: any;
};

type RpcServerRequest = RpcNotification & {
  id: string | number;
};

type SessionStoreEntry = {
  sessionId: string;
  cwd: string;
};

type RunningTurn = {
  proc: ReturnType<typeof spawn>;
  client: AppServerClient;
  stop: () => Promise<void>;
  interrupted: boolean;
  turnId?: string;
};

type CodexAppServerRuntime = {
  key: string;
  aliases: Set<string>;
  projectId: string;
  accountId: string;
  cwd: string;
  paymentSource: CodexSessionConfig["paymentSource"];
  maxConcurrentSubagents?: number;
  spawned: SpawnedCodexAppServer;
  client: AppServerClient;
  fundedTurn?: CodexSiteFundedTurnRuntime;
  threadId?: string;
  active: boolean;
  backgroundTerminalCount: number;
  activeDescendantCount: number;
  chat?: AcpEvaluateRequest["chat"];
  managerState: "completed" | "interrupted";
  lastOutstandingSignature?: string;
  idleTimer?: NodeJS.Timeout;
  backgroundPollTimer?: NodeJS.Timeout;
  disposed: boolean;
  publishedOwnershipSessionId?: string;
};

type RetryableAppServerFailureKind =
  | "remote-compact-timeout"
  | "model-capacity"
  | "timeout"
  | "stream-disconnect";
type InProcessRetryableAppServerFailureKind = Exclude<
  RetryableAppServerFailureKind,
  "model-capacity"
>;

type RetryableAppServerError = Error & {
  retryableAppServerError: true;
  kind: RetryableAppServerFailureKind;
  threadId?: string;
  turnId?: string;
  stderrTail?: string[];
};

type RecoverableTurnError = Error & {
  recoverableTurnError: true;
  code: Exclude<CodexAcpRecoveryErrorCode, "codex_model_capacity">;
};

type RequestEntry = {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

type Waiter = {
  matches: (message: RpcNotification) => boolean;
  resolve: (message: RpcNotification) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

function formatAppServerExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrDetail: string,
): string {
  if (code === 137 || signal === "SIGKILL") {
    return (
      "Codex was killed by SIGKILL (exit code 137). This is usually caused " +
      "by the project running out of RAM. Increase the project's RAM or " +
      `reduce memory use, then retry.${stderrDetail}`
    );
  }
  const exitDetail = signal ? `signal:${signal}` : `${code ?? "?"}`;
  return `codex app-server exited unexpectedly: ${exitDetail}${stderrDetail}`;
}

export class AppServerClient {
  private nextId = 1;
  private readonly pendingRequests = new Map<number, RequestEntry>();
  private readonly waiters: Waiter[] = [];
  private readonly stderrTail: string[] = [];
  private readonly notifications: RpcNotification[] = [];
  private exited = false;
  private exitDetail = "unknown";
  private exitError?: Error & { stderrTail?: string[] };
  private attentionContext?: CodexAttentionContext;
  private attentionInputSupported = false;
  private readonly serverRequestContexts = new Map<
    string,
    CodexAttentionContext
  >();
  private readonly serverRequestAborts = new Map<
    string | number,
    AbortController
  >();

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly requestHandler?: CodexAppServerRequestHandler,
    private readonly attentionHandler?: CodexAttentionHandler,
  ) {
    const rl = createInterface({
      input: proc.stdout as Readable,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as
          | RpcResponse
          | RpcNotification
          | RpcServerRequest;
        if ("method" in message && typeof message.method === "string") {
          if ("id" in message) {
            this.handleServerRequest(message as RpcServerRequest);
          } else {
            this.handleNotification(message);
          }
        } else {
          this.handleResponse(message as RpcResponse);
        }
      } catch (err) {
        logger.warn("codex app-server: failed parsing JSONL", {
          line,
          err: `${err}`,
        });
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 40) {
          this.stderrTail.shift();
        }
      }
    });
    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitDetail = signal ? `signal:${signal}` : `${code ?? "?"}`;
      const stderrTail = this.getStderrTail();
      const userFacingStderrTail = getUserFacingStderrTail(stderrTail);
      const stderrDetail =
        userFacingStderrTail.length > 0
          ? `; stderr: ${userFacingStderrTail.join("\n")}`
          : "";
      const blockedCommandError = userFacingStderrTail.find((line) =>
        line.startsWith("Codex blocked a command:"),
      );
      const err = new Error(
        blockedCommandError ??
          formatAppServerExitMessage(code, signal, stderrDetail),
      ) as Error & { stderrTail?: string[] };
      err.stderrTail = stderrTail;
      this.exitError = err;
      for (const [, pending] of this.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(err);
      }
      for (const controller of this.serverRequestAborts.values()) {
        controller.abort(err);
      }
      this.serverRequestAborts.clear();
      const contexts = new Map<string, CodexAttentionContext>();
      const addContext = (context?: CodexAttentionContext) => {
        if (!context) return;
        contexts.set(
          `${context.projectId}\0${context.threadId}\0${context.turnId}`,
          context,
        );
      };
      addContext(this.attentionContext);
      for (const context of this.serverRequestContexts.values()) {
        addContext(context);
      }
      this.serverRequestContexts.clear();
      for (const context of contexts.values()) {
        void this.attentionHandler?.runtimeClosed?.(context);
      }
    });
  }

  setAttentionContext(context: CodexAttentionContext): void {
    this.attentionContext = context;
  }

  async initialize(timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const result = await this.request(
      "initialize",
      {
        clientInfo: {
          name: "cocalc_app_server",
          title: "CoCalc App Server Bridge",
          version: "0.0.1",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      timeoutMs,
    );
    this.attentionInputSupported = supportsCodexAttentionInput(
      result?.userAgent,
    );
    if (this.attentionHandler && !this.attentionInputSupported) {
      logger.warn(
        "codex app-server: synchronous attention input is not supported",
        { userAgent: result?.userAgent },
      );
    }
    this.notify("initialized", {});
    return result;
  }

  supportsAttentionInput(): boolean {
    return this.attentionInputSupported;
  }

  notify(method: string, params: any = {}): void {
    this.send({ method, params });
  }

  request(method: string, params: any = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) {
      throw (
        this.exitError ??
        new Error(`codex app-server already exited: ${this.exitDetail}`)
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timer,
      });
      this.send({ id, method, params });
    });
  }

  waitForNotification(
    method: string,
    predicate: (params: any) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<RpcNotification> {
    return this.waitForMessage(
      (message) => message.method === method && predicate(message.params ?? {}),
      timeoutMs,
    );
  }

  waitForMessage(
    predicate: (message: RpcNotification) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<RpcNotification> {
    const existingIndex = this.notifications.findIndex((message) =>
      predicate(message),
    );
    if (existingIndex >= 0) {
      const [existing] = this.notifications.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }
    if (this.exited) {
      return Promise.reject(
        this.exitError ??
          new Error(`codex app-server already exited: ${this.exitDetail}`),
      );
    }
    return new Promise<RpcNotification>((resolve, reject) => {
      const waiter: Waiter = {
        matches: (message) => predicate(message),
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(
          new Error(`app-server notification timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  getStderrTail(): string[] {
    return [...this.stderrTail];
  }

  hasExited(): boolean {
    return this.exited;
  }

  private send(message: Record<string, any>): void {
    if (this.exited) {
      throw (
        this.exitError ??
        new Error(`codex app-server already exited: ${this.exitDetail}`)
      );
    }
    this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private handleServerRequest(message: RpcServerRequest): void {
    void this.resolveServerRequest(message);
  }

  private async resolveServerRequest(message: RpcServerRequest): Promise<void> {
    try {
      if (message.method === CODEX_SYNC_QUESTION_METHOD) {
        if (!this.attentionHandler || !this.attentionContext) {
          throw new Error("Codex attention input is not available");
        }
        const request = normalizeCodexSyncQuestionRequest(message.params);
        if (
          request.threadId !== this.attentionContext.threadId ||
          request.turnId !== this.attentionContext.turnId
        ) {
          throw new Error("request_user_input does not match the active turn");
        }
        const context = this.attentionContext;
        const requestKey = `${message.id}`;
        this.serverRequestContexts.set(requestKey, context);
        const controller = new AbortController();
        this.serverRequestAborts.set(message.id, controller);
        try {
          const answers = await this.attentionHandler.requestSyncQuestion({
            requestId: `${message.id}`,
            itemId: request.itemId,
            isBlocking: request.isBlocking,
            autoResolutionMs: request.autoResolutionMs,
            questions: request.questions,
            context,
            signal: controller.signal,
          });
          if (this.exited) return;
          this.send({ id: message.id, result: { answers } });
          return;
        } finally {
          this.serverRequestAborts.delete(message.id);
        }
      }
      if (!this.requestHandler) {
        throw new Error(`unsupported app-server request: ${message.method}`);
      }
      const result = await this.requestHandler({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      if (this.exited) return;
      this.send({
        id: message.id,
        result: result ?? {},
      });
    } catch (err) {
      if (this.exited) return;
      const requestKey = `${message.id}`;
      const context = this.serverRequestContexts.get(requestKey);
      if (context) {
        this.serverRequestContexts.delete(requestKey);
        void this.attentionHandler?.serverRequestResolved?.({
          requestId: requestKey,
          context,
        });
      }
      this.send({
        id: message.id,
        error: {
          code: -32000,
          message: (err as Error)?.message ?? `${err}`,
        },
      });
    }
  }

  private handleResponse(message: RpcResponse): void {
    if (typeof message.id !== "number") return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    this.pendingRequests.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          `${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`,
        ),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  private handleNotification(message: RpcNotification): void {
    if (message.method === "serverRequest/resolved") {
      const requestId = message.params?.requestId;
      if (requestId != null) {
        const requestKey = `${requestId}`;
        const context = this.serverRequestContexts.get(requestKey);
        this.serverRequestContexts.delete(requestKey);
        void this.attentionHandler?.serverRequestResolved?.({
          requestId: requestKey,
          context,
        });
      }
    }
    this.notifications.push(message);
    let consumed = false;
    if (this.notifications.length > 400) {
      this.notifications.shift();
    }
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      if (!waiter.matches(message)) continue;
      this.waiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      consumed = true;
      waiter.resolve(message);
    }
    if (consumed) {
      const index = this.notifications.lastIndexOf(message);
      if (index >= 0) {
        this.notifications.splice(index, 1);
      }
    }
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeErrorMessages(errors: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of errors) {
    const value = stripAnsi(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function isRoutineBundledBubblewrapWarning(line: string): boolean {
  const normalized = stripAnsi(line).toLowerCase();
  return (
    normalized.includes("codex could not find bubblewrap on path") &&
    normalized.includes("will use the bundled bubblewrap")
  );
}

function getUserFacingStderrTail(lines: string[]): string[] {
  const filtered = normalizeErrorMessages(lines).filter(
    (line) => !isRoutineBundledBubblewrapWarning(line),
  );
  const rejected = filtered
    .join("\n")
    .match(/\brejected:\s*([^"\n]+)/i)?.[1]
    ?.trim();
  if (rejected) {
    const message = rejected.replace(/[\s)}]+$/, "");
    return [`Codex blocked a command: ${message}`];
  }
  return filtered;
}

function formatAppServerError(errors: string[]): string {
  const normalized = normalizeErrorMessages(errors);
  const authError = formatCodexAuthError(normalized);
  if (authError) return authError;
  if (normalized.length === 0) return "Codex app-server request failed.";
  if (normalized.length === 1) return normalized[0];
  return normalized.join("\n\n");
}

function classifyCodexAuthError(
  errors: string[],
): "expired-auth" | "missing-auth" | undefined {
  const normalized = errors.join("\n").toLowerCase();
  if (
    normalized.includes("token_expired") ||
    normalized.includes("provided authentication token is expired") ||
    normalized.includes("please try signing in again") ||
    normalized.includes("invalidated oauth token") ||
    normalized.includes("identity_edge_internal_error")
  ) {
    return "expired-auth";
  }
  if (
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("missing authentication in header")
  ) {
    return "missing-auth";
  }
  return undefined;
}

function formatCodexAuthError(errors: string[]): string | undefined {
  switch (classifyCodexAuthError(errors)) {
    case "expired-auth":
      return [
        "Codex authentication expired.",
        "",
        "Sign in again with your ChatGPT Plan or update your OpenAI API key, then retry this message.",
      ].join("\n");
    case "missing-auth":
      return [
        "Codex is not configured.",
        "",
        "Connect a ChatGPT Plan or add an OpenAI API key, then retry this message.",
      ].join("\n");
    default:
      return undefined;
  }
}

function getRemoteCompactRetryLimit(): number {
  return Math.max(
    0,
    Number(process.env.COCALC_CODEX_REMOTE_COMPACT_MAX_RETRIES ?? 2),
  );
}

function getRemoteCompactRetryDelayMs(): number {
  return Math.max(
    250,
    Number(process.env.COCALC_CODEX_REMOTE_COMPACT_RETRY_DELAY_MS ?? 1_500),
  );
}

function getTimeoutRetryLimit(): number {
  return Math.max(0, Number(process.env.COCALC_CODEX_TIMEOUT_MAX_RETRIES ?? 2));
}

function getTimeoutRetryDelayMs(): number {
  return Math.max(
    1_000,
    Number(process.env.COCALC_CODEX_TIMEOUT_RETRY_DELAY_MS ?? 5_000),
  );
}

function getStreamDisconnectRetryLimit(): number {
  return Math.max(
    0,
    Number(process.env.COCALC_CODEX_STREAM_DISCONNECT_MAX_RETRIES ?? 2),
  );
}

function getStreamDisconnectRetryDelayMs(): number {
  return Math.max(
    1_000,
    Number(process.env.COCALC_CODEX_STREAM_DISCONNECT_RETRY_DELAY_MS ?? 30_000),
  );
}

function isRetryableRemoteCompactTimeoutText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  if (!normalized.includes("error running remote compact task")) {
    return false;
  }
  return (
    normalized.includes("timeout waiting for child process to exit") ||
    normalized.includes(
      "compact_error=timeout waiting for child process to exit",
    ) ||
    normalized.includes("compact_remote: remote compaction failed") ||
    normalized.includes("remote compaction failed")
  );
}

function isRetryableModelCapacityText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  return (
    normalized.includes("selected model is at capacity") ||
    normalized.includes("model is at capacity") ||
    normalized.includes("models are at capacity")
  );
}

function isBlockedCommandErrorText(text: string): boolean {
  return stripAnsi(`${text ?? ""}`)
    .toLowerCase()
    .includes("codex blocked a command:");
}

function isResourceKilledErrorText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  return (
    normalized.includes("killed by sigkill (exit code 137)") ||
    normalized.includes("codex app-server already exited: 137")
  );
}

function createRecoverableTurnError({
  code,
  message,
}: {
  code: RecoverableTurnError["code"];
  message: string;
}): RecoverableTurnError {
  return Object.assign(new Error(message), {
    recoverableTurnError: true as const,
    code,
  });
}

function isRecoverableTurnError(err: unknown): err is RecoverableTurnError {
  return !!(err as RecoverableTurnError)?.recoverableTurnError;
}

function threadStatusIsActive(status: unknown): boolean {
  if (typeof status === "string") {
    return status.toLowerCase() === "active";
  }
  return (
    !!status &&
    typeof status === "object" &&
    `${(status as { type?: unknown }).type ?? ""}`.toLowerCase() === "active"
  );
}

function isRetryableBareTimeoutText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  if (
    normalized.includes("timeout waiting for child process to exit") ||
    normalized.includes("idle timeout waiting for sse") ||
    normalized.includes("idle timeout waiting for websocket") ||
    normalized.includes("timed out after")
  ) {
    return false;
  }
  return normalized
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === "timeout");
}

function isRetryableStreamDisconnectText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  return normalized.includes("stream disconnected before completion");
}

function hasObservableTurnSideEffects(opts: {
  startedTerminalMeta: Map<string, { command?: string; cwd?: string }>;
  terminalOutputs: Map<string, string>;
  completedTerminals: Set<string>;
  emittedFileWrites: Set<string>;
  emittedFileWritePaths: Set<string>;
  finalResponse: string;
  latestTurnDiffText?: string;
}): boolean {
  return (
    opts.startedTerminalMeta.size > 0 ||
    Array.from(opts.terminalOutputs.values()).some((output) => !!output) ||
    opts.completedTerminals.size > 0 ||
    opts.emittedFileWrites.size > 0 ||
    opts.emittedFileWritePaths.size > 0 ||
    !!opts.finalResponse.trim() ||
    !!`${opts.latestTurnDiffText ?? ""}`.trim()
  );
}

function hasRetryBlockingTurnSideEffects(
  kind: RetryableAppServerFailureKind,
  opts: {
    startedTerminalMeta: Map<string, { command?: string; cwd?: string }>;
    terminalOutputs: Map<string, string>;
    completedTerminals: Set<string>;
    emittedFileWrites: Set<string>;
    emittedFileWritePaths: Set<string>;
    finalResponse: string;
    latestTurnDiffText?: string;
  },
): boolean {
  const base = hasObservableTurnSideEffects(opts);
  if (!base) {
    return false;
  }
  if (kind !== "timeout" && kind !== "stream-disconnect") {
    return true;
  }
  return (
    Array.from(opts.terminalOutputs.values()).some((output) => !!output) ||
    opts.completedTerminals.size > 0 ||
    opts.emittedFileWrites.size > 0 ||
    opts.emittedFileWritePaths.size > 0 ||
    !!opts.finalResponse.trim() ||
    !!`${opts.latestTurnDiffText ?? ""}`.trim()
  );
}

function createRetryableAppServerError(opts: {
  kind: RetryableAppServerFailureKind;
  message: string;
  threadId?: string;
  turnId?: string;
  stderrTail?: string[];
}): RetryableAppServerError {
  return Object.assign(new Error(opts.message), {
    retryableAppServerError: true as const,
    kind: opts.kind,
    threadId: opts.threadId,
    turnId: opts.turnId,
    stderrTail: opts.stderrTail,
  });
}

function isRetryableAppServerError(
  err: unknown,
): err is RetryableAppServerError {
  return !!(err as RetryableAppServerError)?.retryableAppServerError;
}

function getRetryableFailureKind(
  text: string,
): RetryableAppServerFailureKind | undefined {
  if (isRetryableModelCapacityText(text)) {
    return "model-capacity";
  }
  if (isRetryableRemoteCompactTimeoutText(text)) {
    return "remote-compact-timeout";
  }
  if (isRetryableBareTimeoutText(text)) {
    return "timeout";
  }
  if (isRetryableStreamDisconnectText(text)) {
    return "stream-disconnect";
  }
  return undefined;
}

function formatRemoteCompactRetryExhaustedError(error: string): string {
  const normalized = `${error ?? ""}`.trim();
  const guidance =
    "This looks like an upstream Codex remote context-compaction timeout. If it keeps happening, try forking or starting a fresh chat to reduce history size, or switch to a model with a larger context window.";
  return normalized ? `${normalized}\n\n${guidance}` : guidance;
}

function formatTimeoutRetryExhaustedError(error: string): string {
  const normalized = `${error ?? ""}`.trim();
  const guidance =
    "Codex kept returning a transient timeout after automatic retries. Check the project-host ACP logs for the failed turn payload and stderr tail if this repeats.";
  return normalized ? `${normalized}\n\n${guidance}` : guidance;
}

function formatStreamDisconnectRetryExhaustedError(error: string): string {
  const normalized = `${error ?? ""}`.trim();
  const guidance =
    "Codex disconnected before completing the response after automatic retries. This is usually a transient upstream streaming failure; retry the turn if needed.";
  return normalized ? `${normalized}\n\n${guidance}` : guidance;
}

function formatRetryDelay(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${ms}ms`;
}

function getRetryPolicyForFailure(
  kind: InProcessRetryableAppServerFailureKind,
): {
  maxRetries: number;
  retryDelayMs: number;
  retryMessage: (attempt: number, maxRetries: number) => string;
  exhaustedMessage: (error: string) => string;
} {
  switch (kind) {
    case "timeout": {
      const retryDelayMs = getTimeoutRetryDelayMs();
      return {
        maxRetries: getTimeoutRetryLimit(),
        retryDelayMs,
        retryMessage: (attempt, maxRetries) =>
          `Codex returned a transient timeout. Retrying in ${formatRetryDelay(retryDelayMs * attempt)} (${attempt}/${maxRetries})... If this repeats, check the project-host ACP logs.`,
        exhaustedMessage: formatTimeoutRetryExhaustedError,
      };
    }
    case "stream-disconnect": {
      const retryDelayMs = getStreamDisconnectRetryDelayMs();
      return {
        maxRetries: getStreamDisconnectRetryLimit(),
        retryDelayMs,
        retryMessage: (attempt, maxRetries) =>
          `Codex stream disconnected before completion. Retrying in ${formatRetryDelay(retryDelayMs * attempt)} (${attempt}/${maxRetries})...`,
        exhaustedMessage: formatStreamDisconnectRetryExhaustedError,
      };
    }
    case "remote-compact-timeout":
    default: {
      const retryDelayMs = getRemoteCompactRetryDelayMs();
      return {
        maxRetries: getRemoteCompactRetryLimit(),
        retryDelayMs,
        retryMessage: (attempt, maxRetries) =>
          `Remote context compaction timed out. Retrying (${attempt}/${maxRetries})...`,
        exhaustedMessage: formatRemoteCompactRetryExhaustedError,
      };
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function mapContainerPathToHost(
  targetPath: string,
  containerPathMap?: CodexProjectContainerPathMap,
): string {
  if (!containerPathMap || !path.isAbsolute(targetPath)) {
    return targetPath;
  }
  const runtimeRelative = projectRuntimeHomeRelativePath(targetPath);
  if (runtimeRelative != null) {
    if (!containerPathMap.rootHostPath) return targetPath;
    return runtimeRelative
      ? path.join(containerPathMap.rootHostPath, runtimeRelative)
      : containerPathMap.rootHostPath;
  }
  if (targetPath === "/tmp" || targetPath.startsWith("/tmp/")) {
    const suffix = targetPath.slice("/tmp".length).replace(/^\/+/, "");
    if (!containerPathMap.scratchHostPath) return targetPath;
    return suffix
      ? path.join(containerPathMap.scratchHostPath, suffix)
      : containerPathMap.scratchHostPath;
  }
  return targetPath;
}

function getCodexHomeHostPath(
  spawned: SpawnedCodexAppServer,
  cwd: string,
): string | undefined {
  if (spawned.containerPathMap?.rootHostPath) {
    return path.join(spawned.containerPathMap.rootHostPath, ".codex");
  }
  const configuredCodexHome = `${process.env.COCALC_CODEX_HOME ?? ""}`.trim();
  if (configuredCodexHome) {
    return configuredCodexHome;
  }
  const originalHome = `${process.env.COCALC_ORIGINAL_HOME ?? ""}`.trim();
  if (originalHome) {
    return path.join(originalHome, ".codex");
  }
  const localHome = `${process.env.HOME ?? ""}`.trim();
  if (localHome) {
    return path.join(localHome, ".codex");
  }
  if (path.isAbsolute(cwd)) {
    return path.join(cwd, ".codex");
  }
  return undefined;
}

function clearPersistedCodexGoalsBeforeTurn({
  spawned,
  cwd,
}: {
  spawned: SpawnedCodexAppServer;
  cwd: string;
}): void {
  const codexHome = getCodexHomeHostPath(spawned, cwd);
  if (!codexHome) return;
  const goalsDbPath = path.join(codexHome, "goals_1.sqlite");
  if (!existsSync(goalsDbPath)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(goalsDbPath);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_goals'",
      )
      .get() as { name?: string } | undefined;
    if (!table?.name) return;
    const result = db.prepare("DELETE FROM thread_goals").run();
    const deleted = Number(result.changes ?? 0);
    if (deleted > 0) {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (err) {
        logger.debug("codex app-server: goal DB checkpoint failed", {
          codexHome,
          err: `${err}`,
        });
      }
      logger.info("codex app-server: cleared persisted Codex goals", {
        codexHome,
        deleted,
      });
    }
  } catch (err) {
    logger.warn("codex app-server: failed to clear persisted Codex goals", {
      codexHome,
      err: `${err}`,
    });
  } finally {
    db?.close();
  }
}

function toUsageFromTokenCount(info: any): AcpStreamUsage | undefined {
  const usage = info?.last_token_usage ?? info?.lastTokenUsage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    cached_input_tokens:
      usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    reasoning_output_tokens:
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens ?? 0,
    total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
    model_context_window:
      info?.model_context_window ?? info?.modelContextWindow ?? undefined,
  };
}

type PersistedTurnInfo = {
  usage?: AcpStreamUsage;
  compacted?: boolean;
};

async function readPersistedTurnInfo(opts: {
  spawned: SpawnedCodexAppServer;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<PersistedTurnInfo | undefined> {
  const codexHome = getCodexHomeHostPath(opts.spawned, opts.cwd);
  if (!codexHome) return undefined;
  const stateDbPath = path.join(codexHome, "state_5.sqlite");
  if (!existsSync(stateDbPath)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare("SELECT rollout_path FROM threads WHERE id = ?")
      .get(opts.threadId) as { rollout_path?: string } | undefined;
    const rolloutPath = `${row?.rollout_path ?? ""}`.trim();
    if (!rolloutPath) return undefined;
    const hostRolloutPath = mapContainerPathToHost(
      rolloutPath,
      opts.spawned.containerPathMap,
    );
    if (!existsSync(hostRolloutPath)) return undefined;
    const lines = readFileSync(hostRolloutPath, "utf8").split(/\r?\n/);
    let foundCompletion = false;
    let compacted = false;
    let usage: AcpStreamUsage | undefined;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "compacted") {
        if (foundCompletion) {
          compacted = true;
        }
        continue;
      }
      const payload = entry?.payload;
      if (
        entry?.type !== "event_msg" ||
        !payload ||
        typeof payload !== "object"
      ) {
        continue;
      }
      if (
        payload.type === "task_complete" &&
        `${payload.turn_id ?? ""}` === opts.turnId
      ) {
        foundCompletion = true;
        continue;
      }
      if (!foundCompletion) continue;
      if (payload.type === "token_count") {
        usage = toUsageFromTokenCount(payload.info);
        continue;
      }
      if (
        payload.type === "task_started" &&
        `${payload.turn_id ?? ""}` === opts.turnId
      ) {
        return usage || compacted ? { usage, compacted } : undefined;
      }
    }
    return usage || compacted ? { usage, compacted } : undefined;
  } catch (err) {
    logger.debug("codex app-server: persisted usage fallback failed", {
      threadId: opts.threadId,
      turnId: opts.turnId,
      codexHome,
      err: `${err}`,
    });
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
  return undefined;
}

function toReasoningEffort(
  config?: CodexSessionConfig,
): "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | undefined {
  switch (config?.reasoning) {
    case "low":
    case "medium":
    case "high":
    case "max":
    case "ultra":
      return config.reasoning;
    case "extra_high":
      return "xhigh";
    default:
      return undefined;
  }
}

function toSandboxMode(
  spawned: SpawnedCodexAppServer | undefined,
  config?: CodexSessionConfig,
): "read-only" | "workspace-write" | "danger-full-access" {
  const mode = resolveCodexSessionMode(config);
  if (spawned?.containerPathMap?.rootHostPath && mode !== "read-only") {
    // Launchpad Codex runs inside a dedicated project container already, so
    // Codex's own workspace sandbox only adds flakiness without improving
    // isolation. Keep explicit read-only threads read-only.
    return "danger-full-access";
  }
  switch (mode) {
    case "read-only":
      return "read-only";
    case "full-access":
      return "danger-full-access";
    default:
      return "workspace-write";
  }
}

function toTurnSandboxPolicy(
  spawned: SpawnedCodexAppServer | undefined,
  config?: CodexSessionConfig,
):
  | {
      type: "readOnly";
      access: { type: "fullAccess" };
      networkAccess: true;
    }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      readOnlyAccess: { type: "fullAccess" };
      networkAccess: true;
      excludeTmpdirEnvVar: false;
      excludeSlashTmp: false;
    }
  | {
      type: "dangerFullAccess";
    } {
  const mode = resolveCodexSessionMode(config);
  if (spawned?.containerPathMap?.rootHostPath && mode !== "read-only") {
    return {
      type: "dangerFullAccess",
    };
  }
  switch (mode) {
    case "read-only":
      return {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: true,
      };
    case "full-access":
      return {
        type: "dangerFullAccess",
      };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function getCoCalcCliCommand(runtimeEnv?: Record<string, string>): string {
  const rawCliCommand = `${runtimeEnv?.COCALC_CLI_CMD ?? ""}`.trim();
  if (rawCliCommand) return rawCliCommand;
  const rawCli = `${runtimeEnv?.COCALC_CLI_BIN ?? ""}`.trim();
  return rawCli ? `"${rawCli}"` : "cocalc";
}

function decoratePrompt(
  prompt: string,
  opts?: { runtimeEnv?: Record<string, string> },
): string {
  if (/^\s*\/\w+/.test(prompt)) {
    return prompt;
  }
  return addRuntimeGuidance(prompt, opts?.runtimeEnv);
}

function addRuntimeGuidance(
  prompt: string,
  runtimeEnv?: Record<string, string>,
): string {
  const hasProject = `${runtimeEnv?.COCALC_PROJECT_ID ?? ""}`.trim();
  const hasBrowser = `${runtimeEnv?.COCALC_BROWSER_ID ?? ""}`.trim();
  if (!hasProject) {
    return prompt;
  }
  return `${getCoCalcRuntimeGuidanceHeader(getCoCalcCliCommand(runtimeEnv), {
    hasBrowser: !!hasBrowser,
  })}\n\n${prompt}`;
}

function buildTurnInput({
  local_images,
  prompt,
  runtimeEnv,
}: {
  local_images?: string[];
  prompt: string;
  runtimeEnv?: Record<string, string>;
}): Array<
  | { type: "localImage"; path: string }
  | { type: "text"; text: string; textElements: any[] }
> {
  const input: Array<
    | { type: "localImage"; path: string }
    | { type: "text"; text: string; textElements: any[] }
  > = [];
  for (const imagePath of local_images ?? []) {
    const trimmed = `${imagePath ?? ""}`.trim();
    if (!trimmed) continue;
    input.push({ type: "localImage", path: trimmed });
  }
  input.push({
    type: "text",
    text: decoratePrompt(prompt, { runtimeEnv }),
    textElements: [],
  });
  return input;
}

function classifySteerError(err: unknown): {
  kind: "missing" | "mismatch" | "not_steerable" | "other";
  actualTurnId?: string;
} {
  const message = `${err ?? ""}`;
  if (message.includes("no active turn to steer")) {
    return { kind: "missing" };
  }
  const mismatch = message.match(
    /expected active turn id `[^`]+` but found `([^`]+)`/,
  );
  if (mismatch?.[1]) {
    return { kind: "mismatch", actualTurnId: mismatch[1] };
  }
  if (
    message.includes("cannot steer a review turn") ||
    message.includes("cannot steer a compact turn")
  ) {
    return { kind: "not_steerable" };
  }
  return { kind: "other" };
}

async function spawnStandaloneAppServer(
  opts: CodexAppServerOptions,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnedCodexAppServer> {
  const cmd = opts.binaryPath ?? "codex";
  const args = [
    ...CODEX_APP_SERVER_FEATURE_ARGS,
    "app-server",
    "--listen",
    "stdio://",
  ];
  const HOME = process.env.COCALC_ORIGINAL_HOME ?? process.env.HOME;
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...(env ?? {}),
      ...(HOME ? { HOME } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  logger.debug("codex app-server: spawning", {
    cmd,
    args: argsJoin(args),
    cwd: opts.cwd,
  });
  return {
    proc,
    cmd,
    args,
    cwd: opts.cwd,
  };
}

async function loginAppServerIfNeeded(
  client: AppServerClient,
  login?: CodexAppServerLoginHint,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  if (!login) return;
  switch (login.type) {
    case "apiKey":
      await client.request(
        "account/login/start",
        {
          type: "apiKey",
          apiKey: login.apiKey,
        },
        timeoutMs,
      );
      return;
    case "chatgptAuthTokens":
      await client.request(
        "account/login/start",
        {
          type: "chatgptAuthTokens",
          accessToken: login.accessToken,
          chatgptAccountId: login.chatgptAccountId,
          chatgptPlanType: login.chatgptPlanType ?? null,
        },
        timeoutMs,
      );
      return;
  }
}

export async function forkCodexAppServerSession(opts: {
  projectId: string;
  accountId?: string;
  sessionId: string;
  binaryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ sessionId: string }> {
  const projectSpawner = getCodexProjectSpawner();
  const spawned =
    projectSpawner && opts.projectId && projectSpawner.spawnCodexAppServer
      ? await projectSpawner.spawnCodexAppServer({
          projectId: opts.projectId,
          accountId: opts.accountId,
          cwd: opts.cwd,
          env: opts.env,
        })
      : await spawnStandaloneAppServer(
          {
            binaryPath: opts.binaryPath,
            cwd: opts.cwd,
          },
          opts.env,
        );
  const client = new AppServerClient(
    spawned.proc,
    spawned.handleAppServerRequest,
  );
  try {
    await client.initialize();
    await loginAppServerIfNeeded(client, spawned.appServerLogin);
    const result = await client.request("thread/fork", {
      threadId: opts.sessionId,
      excludeTurns: true,
      config: threadConfig(undefined, client.supportsAttentionInput()),
    });
    const sessionId = `${result?.thread?.id ?? ""}`.trim();
    if (!sessionId) {
      throw new Error("thread/fork did not return a thread id");
    }
    return { sessionId };
  } finally {
    if (spawned.proc.exitCode == null && !spawned.proc.killed) {
      spawned.proc.kill("SIGKILL");
    }
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): {
  value?: T;
  error?: string;
} {
  if (result.status === "fulfilled") {
    return { value: result.value };
  }
  return { error: `${result.reason}` };
}

const MAX_MODEL_CATALOG_ENTRIES = 100;
const MAX_MODEL_REASONING_EFFORTS = 20;
const MAX_MODEL_SERVICE_TIERS = 20;

function boundedCatalogText(value: unknown, maxLength = 2_000): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function catalogLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function catalogReasoningId(value: unknown): string {
  const id = boundedCatalogText(value, 100);
  return id === "xhigh" ? "extra_high" : id;
}

function normalizeCodexModelCatalog(
  value: unknown,
): CodexModelCapabilityInfo[] {
  const data = (value as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw Error("model/list returned an invalid response");
  }
  const models: CodexModelCapabilityInfo[] = [];
  const seen = new Set<string>();
  for (const raw of data.slice(0, MAX_MODEL_CATALOG_ENTRIES)) {
    if (raw == null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const model = boundedCatalogText(entry.model ?? entry.id, 200);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const defaultReasoningEffort = catalogReasoningId(
      entry.defaultReasoningEffort,
    );
    const reasoning = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
          .slice(0, MAX_MODEL_REASONING_EFFORTS)
          .flatMap((rawEffort): CodexModelCapabilityInfo["reasoning"] => {
            if (rawEffort == null || typeof rawEffort !== "object") return [];
            const effort = rawEffort as Record<string, unknown>;
            const id = catalogReasoningId(effort.reasoningEffort);
            if (!id) return [];
            return [
              {
                id,
                description: boundedCatalogText(effort.description),
                ...(id === defaultReasoningEffort ? { default: true } : {}),
              },
            ];
          })
      : [];
    const defaultServiceTier = boundedCatalogText(
      entry.defaultServiceTier,
      100,
    );
    const rawServiceTiers = [
      ...(Array.isArray(entry.serviceTiers) ? entry.serviceTiers : []),
      ...(Array.isArray(entry.additionalSpeedTiers)
        ? entry.additionalSpeedTiers.map((id) => ({ id }))
        : []),
    ];
    const seenServiceTiers = new Set<string>();
    const serviceTiers = rawServiceTiers
      .slice(0, MAX_MODEL_SERVICE_TIERS)
      .flatMap((rawTier): CodexModelCapabilityInfo["serviceTiers"] => {
        if (rawTier == null || typeof rawTier !== "object") return [];
        const tier = rawTier as Record<string, unknown>;
        const id = boundedCatalogText(tier.id, 100);
        if (!id || seenServiceTiers.has(id)) return [];
        seenServiceTiers.add(id);
        return [
          {
            id,
            label: boundedCatalogText(tier.name, 200) || catalogLabel(id),
            description: boundedCatalogText(tier.description),
            ...(id === defaultServiceTier ? { default: true } : {}),
          },
        ];
      });
    models.push({
      model,
      displayName:
        boundedCatalogText(entry.displayName, 200) || catalogLabel(model),
      description: boundedCatalogText(entry.description),
      specialty: boundedCatalogText(entry.modelSpecialty, 100) || undefined,
      reasoning,
      serviceTiers,
      default: entry.isDefault === true || undefined,
    });
  }
  return models;
}

function isRateLimitsAuthError(error: string | undefined): boolean {
  const normalized = `${error ?? ""}`.toLowerCase();
  return (
    normalized.includes("account/ratelimits/read") &&
    normalized.includes("auth")
  );
}

function stopAccountStatusAppServer(proc: ReturnType<typeof spawn>): void {
  if (proc.exitCode != null || proc.signalCode != null || proc.killed) return;
  if (!proc.stdin || proc.stdin.destroyed) {
    proc.kill("SIGKILL");
    return;
  }
  // Codex treats stdin EOF as a graceful app-server shutdown. Give the inner
  // process time to exit before killing the outer project-runtime launcher.
  proc.stdin.end();
  const timer = setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null && !proc.killed) {
      proc.kill("SIGKILL");
    }
  }, ACCOUNT_STATUS_SHUTDOWN_GRACE_MS);
  timer.unref?.();
  proc.once("close", () => clearTimeout(timer));
}

export async function getCodexAppServerAccountStatus(opts: {
  projectId?: string;
  accountId?: string;
  binaryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  appServerLogin?: CodexAppServerLoginHint;
  isolatedCodexHome?: boolean;
  includeTokenUsage?: boolean;
  includeModels?: boolean;
  timeoutMs?: number;
}): Promise<CodexAppServerAccountStatus> {
  const timeoutMs = opts.timeoutMs ?? ACCOUNT_STATUS_REQUEST_TIMEOUT_MS;
  const projectSpawner = getCodexProjectSpawner();
  const spawned =
    projectSpawner && opts.projectId && projectSpawner.spawnCodexAppServer
      ? await projectSpawner.spawnCodexAppServer({
          projectId: opts.projectId,
          accountId: opts.accountId,
          cwd: opts.cwd,
          env: opts.env,
          isolatedCodexHome: opts.isolatedCodexHome,
          touchReason: false,
        })
      : await spawnStandaloneAppServer(
          {
            binaryPath: opts.binaryPath,
            cwd: opts.cwd,
          },
          opts.env,
        );
  const client = new AppServerClient(
    spawned.proc,
    spawned.handleAppServerRequest,
  );
  try {
    await client.initialize(timeoutMs);
    const appServerLogin = spawned.appServerLogin ?? opts.appServerLogin;
    await loginAppServerIfNeeded(client, appServerLogin, timeoutMs);
    // Validate the current token before rotating it. Status checks are common,
    // and forcing a refresh on every check creates avoidable refresh-token
    // churn across projects and browser tabs.
    const [accountResult] = await Promise.allSettled([
      client.request("account/read", { refreshToken: false }, timeoutMs),
    ]);
    const [rateLimitsResult] = await Promise.allSettled([
      client.request("account/rateLimits/read", {}, timeoutMs),
    ]);
    let account = settledValue(accountResult);
    let rateLimits = settledValue(rateLimitsResult);
    const shouldRefreshSubscription =
      authSourceForSpawned(spawned) === "subscription" &&
      (isRateLimitsAuthError(rateLimits.error) ||
        (account.value?.requiresOpenaiAuth === true &&
          account.value?.account == null));
    if (shouldRefreshSubscription && appServerLogin) {
      try {
        account = {
          value: await client.request(
            "account/read",
            { refreshToken: true },
            timeoutMs,
          ),
        };
        rateLimits = {
          value: await client.request("account/rateLimits/read", {}, timeoutMs),
        };
      } catch (reason) {
        const error = `${reason}`;
        if (account.value == null) {
          account = { error };
        }
        rateLimits = { error };
      }
    }
    let tokenUsageResult: PromiseSettledResult<any> | undefined;
    if (opts.includeTokenUsage) {
      try {
        tokenUsageResult = {
          status: "fulfilled",
          value: await client.request("account/usage/read", {}, timeoutMs),
        };
      } catch (reason) {
        tokenUsageResult = { status: "rejected", reason };
      }
    }
    const tokenUsage = tokenUsageResult
      ? settledValue(tokenUsageResult)
      : { value: undefined };
    let models: {
      value?: CodexModelCapabilityInfo[];
      error?: string;
    } = { value: undefined };
    if (opts.includeModels) {
      try {
        models = {
          value: normalizeCodexModelCatalog(
            await client.request(
              "model/list",
              { limit: MAX_MODEL_CATALOG_ENTRIES, includeHidden: false },
              timeoutMs,
            ),
          ),
        };
      } catch (reason) {
        models = { error: `${reason}` };
      }
    }
    const errors: CodexAppServerAccountStatus["errors"] = {};
    if (account.error) errors.account = account.error;
    if (rateLimits.error) errors.rateLimits = rateLimits.error;
    if (tokenUsage.error) errors.tokenUsage = tokenUsage.error;
    if (models.error) errors.models = models.error;
    const normalizedErrors = Object.keys(errors).length ? errors : undefined;
    return {
      authentication: classifyCodexAuthentication({
        account: account.value,
        rateLimits: rateLimits.value,
        errors: normalizedErrors,
      }),
      account: account.value,
      rateLimits: rateLimits.value,
      tokenUsage: tokenUsage.value,
      models: models.value,
      errors: normalizedErrors,
    };
  } finally {
    stopAccountStatusAppServer(spawned.proc);
  }
}

export class CodexAppServerAgent implements AcpAgent {
  static async create(
    opts: CodexAppServerOptions = {},
  ): Promise<CodexAppServerAgent> {
    return new CodexAppServerAgent(opts);
  }

  constructor(private readonly opts: CodexAppServerOptions = {}) {}

  private readonly sessions = new Map<string, SessionStoreEntry>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly runtimes = new Set<CodexAppServerRuntime>();
  private readonly runtimesByAlias = new Map<string, CodexAppServerRuntime>();

  private registerRuntimeAlias(
    runtime: CodexAppServerRuntime,
    alias: string | undefined,
  ): void {
    const normalized = normalizeCodexSessionId(alias);
    if (!normalized) return;
    runtime.aliases.add(normalized);
    this.runtimesByAlias.set(normalized, runtime);
  }

  private clearRuntimeTimers(runtime: CodexAppServerRuntime): void {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
    if (runtime.backgroundPollTimer) {
      clearTimeout(runtime.backgroundPollTimer);
      runtime.backgroundPollTimer = undefined;
    }
  }

  private removeRuntime(runtime: CodexAppServerRuntime): void {
    this.clearRuntimeTimers(runtime);
    this.runtimes.delete(runtime);
    for (const alias of runtime.aliases) {
      if (this.runtimesByAlias.get(alias) === runtime) {
        this.runtimesByAlias.delete(alias);
      }
    }
  }

  private async disposeRuntime(
    runtime: CodexAppServerRuntime,
    reason: string,
  ): Promise<void> {
    if (runtime.disposed) return;
    runtime.disposed = true;
    this.removeRuntime(runtime);
    await this.publishRuntimeOwnership(runtime, "released");
    logger.debug("codex app-server: disposing retained runtime", {
      threadId: runtime.threadId,
      projectId: runtime.projectId,
      accountId: runtime.accountId,
      backgroundTerminals: runtime.backgroundTerminalCount,
      reason,
    });
    if (runtime.spawned.siteFundedTurn) {
      try {
        await runtime.spawned.siteFundedTurn.close();
      } catch (err) {
        logger.warn("codex app-server: failed closing funded runtime", {
          threadId: runtime.threadId,
          err: `${err}`,
        });
      }
    }
    if (runtime.spawned.proc.exitCode == null && !runtime.spawned.proc.killed) {
      runtime.spawned.proc.kill("SIGKILL");
    }
  }

  private async publishRuntimeOwnership(
    runtime: CodexAppServerRuntime,
    state: "owned" | "released",
  ): Promise<void> {
    if (!this.opts.onRuntimeOwnershipChanged) return;
    const sessionId =
      state === "owned"
        ? runtime.threadId
        : runtime.publishedOwnershipSessionId;
    if (!sessionId) return;
    if (
      state === "owned" &&
      runtime.publishedOwnershipSessionId === sessionId
    ) {
      return;
    }
    if (state === "released") {
      runtime.publishedOwnershipSessionId = undefined;
    }
    try {
      await this.opts.onRuntimeOwnershipChanged({
        state,
        sessionId,
        projectId: runtime.projectId,
        accountId: runtime.accountId,
        path: runtime.chat?.path,
      });
      if (state === "owned") {
        runtime.publishedOwnershipSessionId = sessionId;
      }
    } catch (err) {
      logger.warn("codex app-server: failed publishing runtime ownership", {
        state,
        sessionId,
        projectId: runtime.projectId,
        err: `${err}`,
      });
    }
  }

  private async listBackgroundTerminals(
    runtime: CodexAppServerRuntime,
  ): Promise<number> {
    const threadId = runtime.threadId;
    if (!threadId || runtime.disposed) return 0;
    let cursor: string | null | undefined;
    let count = 0;
    do {
      const result = await runtime.client.request(
        "thread/backgroundTerminals/list",
        {
          threadId,
          cursor,
          limit: 100,
        },
      );
      count += Array.isArray(result?.data) ? result.data.length : 0;
      cursor = result?.nextCursor ?? null;
    } while (cursor);
    runtime.backgroundTerminalCount = count;
    return count;
  }

  private async listDescendantThreads(
    runtime: CodexAppServerRuntime,
  ): Promise<any[]> {
    const threadId = runtime.threadId;
    if (!threadId || runtime.disposed) return [];
    let cursor: string | null | undefined;
    const rows: any[] = [];
    do {
      const result = await runtime.client.request("thread/list", {
        ancestorThreadId: threadId,
        cursor,
        limit: 100,
        useStateDbOnly: true,
      });
      if (Array.isArray(result?.data)) rows.push(...result.data);
      cursor = result?.nextCursor ?? null;
    } while (cursor);
    runtime.activeDescendantCount = rows.filter(
      (thread) => thread?.status?.type === "active",
    ).length;
    return rows;
  }

  private scheduleRuntimeIdleExit(runtime: CodexAppServerRuntime): void {
    if (
      runtime.disposed ||
      runtime.active ||
      runtime.backgroundTerminalCount ||
      runtime.activeDescendantCount
    ) {
      return;
    }
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = undefined;
      if (
        runtime.disposed ||
        runtime.active ||
        runtime.backgroundTerminalCount
      ) {
        return;
      }
      void this.disposeRuntime(runtime, "idle timeout");
    }, APP_SERVER_IDLE_EXIT_MS);
    runtime.idleTimer.unref?.();
  }

  private scheduleBackgroundTerminalPoll(runtime: CodexAppServerRuntime): void {
    if (runtime.disposed || runtime.backgroundPollTimer) return;
    runtime.backgroundPollTimer = setTimeout(() => {
      runtime.backgroundPollTimer = undefined;
      if (runtime.disposed) return;
      void this.refreshRuntimeLifecycle(runtime);
    }, BACKGROUND_TERMINAL_POLL_MS);
    runtime.backgroundPollTimer.unref?.();
  }

  private async refreshRuntimeLifecycle(
    runtime: CodexAppServerRuntime,
  ): Promise<void> {
    if (runtime.disposed || runtime.active) return;
    try {
      const [count, descendants] = await Promise.all([
        this.listBackgroundTerminals(runtime),
        this.listDescendantThreads(runtime),
      ]);
      const activeDescendants = descendants.filter(
        (thread) => thread?.status?.type === "active",
      ).length;
      await this.notifyOutstandingWork(runtime, descendants);
      if (count > 0 || activeDescendants > 0) {
        if (runtime.idleTimer) {
          clearTimeout(runtime.idleTimer);
          runtime.idleTimer = undefined;
        }
        this.scheduleBackgroundTerminalPoll(runtime);
        return;
      }
    } catch (err) {
      logger.warn("codex app-server: failed reconciling retained work", {
        threadId: runtime.threadId,
        err: `${err}`,
      });
      // A failed liveness query must not destroy a process that might own work.
      this.scheduleBackgroundTerminalPoll(runtime);
      return;
    }
    this.scheduleRuntimeIdleExit(runtime);
  }

  private async notifyOutstandingWork(
    runtime: CodexAppServerRuntime,
    descendants: any[],
  ): Promise<void> {
    if (!this.opts.onOutstandingWorkChanged || !runtime.threadId) return;
    const activeDescendantThreadIds = descendants
      .filter(
        (thread) =>
          thread?.status?.type === "active" && typeof thread?.id === "string",
      )
      .map((thread) => thread.id)
      .sort();
    const signature = JSON.stringify({
      managerState: runtime.managerState,
      activeDescendantThreadIds,
      backgroundTerminals: runtime.backgroundTerminalCount,
      maxConcurrentSubagents: runtime.maxConcurrentSubagents,
    });
    if (signature === runtime.lastOutstandingSignature) return;
    if (
      runtime.maxConcurrentSubagents != null &&
      runtime.activeDescendantCount > runtime.maxConcurrentSubagents
    ) {
      logger.warn("codex app-server: active subagent limit exceeded", {
        threadId: runtime.threadId,
        activeDescendants: runtime.activeDescendantCount,
        maxConcurrentSubagents: runtime.maxConcurrentSubagents,
        activeDescendantThreadIds,
      });
    }
    try {
      await this.opts.onOutstandingWorkChanged({
        sessionId: runtime.threadId,
        projectId: runtime.projectId,
        accountId: runtime.accountId,
        chat: runtime.chat,
        managerState: runtime.managerState,
        activeDescendantThreadIds,
        activeDescendants: runtime.activeDescendantCount,
        backgroundTerminals: runtime.backgroundTerminalCount,
        maxConcurrentSubagents: runtime.maxConcurrentSubagents,
      });
      runtime.lastOutstandingSignature = signature;
    } catch (err) {
      logger.warn("codex app-server: failed publishing outstanding work", {
        threadId: runtime.threadId,
        err: `${err}`,
      });
    }
  }

  private runtimeMatchesRequest(
    runtime: CodexAppServerRuntime,
    request: AcpEvaluateRequest,
    cwd: string,
  ): boolean {
    // The subagent limit configures a Codex thread, not its owning process.
    // Never replace a live manager (and its retained work) merely because a
    // recovered or older client omitted the limit that a newer client sends.
    return (
      runtime.projectId === (request.chat?.project_id ?? request.project_id) &&
      runtime.accountId === request.account_id &&
      runtime.cwd === cwd &&
      (runtime.paymentSource ?? "auto") ===
        (request.config?.paymentSource ?? "auto")
    );
  }

  private async acquireRuntime({
    request,
    session,
    cwd,
    runtimeEnv,
  }: {
    request: AcpEvaluateRequest;
    session: SessionStoreEntry;
    cwd: string;
    runtimeEnv: Record<string, string>;
  }): Promise<{ runtime: CodexAppServerRuntime; created: boolean }> {
    const agentSessionKey = agentTurnSessionKey(request, session.sessionId);
    let runtime = this.runtimesByAlias.get(session.sessionId);
    if (runtime && !this.runtimeMatchesRequest(runtime, request, cwd)) {
      let backgroundTerminalCount = runtime.backgroundTerminalCount;
      let activeDescendantCount = runtime.activeDescendantCount;
      try {
        const [backgroundCount, descendants] = await Promise.all([
          this.listBackgroundTerminals(runtime),
          this.listDescendantThreads(runtime),
        ]);
        backgroundTerminalCount = backgroundCount;
        activeDescendantCount = descendants.filter(
          (thread) => thread?.status?.type === "active",
        ).length;
      } catch (err) {
        // Preserve the runtime when we cannot prove it owns no work, but do
        // not misreport a reconciliation failure as actual background work.
        throw new Error(
          `Unable to verify whether this Codex thread still has subagents or background commands running, so its runtime settings were not changed. Retry shortly. ${err}`,
        );
      }
      if (backgroundTerminalCount > 0 || activeDescendantCount > 0) {
        throw new Error(
          "This Codex thread still has subagents or background commands running. Wait for them to finish or stop them before changing its runtime settings.",
        );
      }
      await this.disposeRuntime(runtime, "runtime configuration changed");
      runtime = undefined;
    }
    if (runtime) {
      if (runtime.active) {
        throw new Error("This Codex thread already has an active turn.");
      }
      this.clearRuntimeTimers(runtime);
      await runtime.spawned.setAgentSessionKey?.(agentSessionKey);
      runtime.chat = request.chat;
      runtime.managerState = "completed";
      runtime.lastOutstandingSignature = undefined;
      runtime.active = true;
      if (runtime.spawned.siteFundedTurn) {
        try {
          runtime.fundedTurn = await runtime.spawned.siteFundedTurn.beginTurn({
            fundedTurnId: randomUUID(),
            idempotencyKey: randomUUID(),
            path: request.chat?.path,
          });
        } catch (err) {
          runtime.active = false;
          void this.refreshRuntimeLifecycle(runtime);
          throw err;
        }
      }
      return { runtime, created: false };
    }

    const spawned = await this.spawnAppServer({
      projectId: request.chat?.project_id ?? request.project_id,
      accountId: request.account_id,
      agentSessionKey,
      cwd,
      env: runtimeEnv,
      siteFundedTurn: {
        fundedTurnId: randomUUID(),
        idempotencyKey: randomUUID(),
        path: request.chat?.path,
      },
      paymentSource: request.config?.paymentSource,
    });
    const client = new AppServerClient(
      spawned.proc,
      spawned.handleAppServerRequest,
      this.opts.attentionHandler,
    );
    try {
      await client.initialize();
      await loginAppServerIfNeeded(client, spawned.appServerLogin);
    } catch (err) {
      if (spawned.siteFundedTurn) {
        try {
          await spawned.siteFundedTurn.finish({
            status: "failed",
            outcome: "app-server initialization failed",
          });
        } catch (finishErr) {
          logger.warn(
            "codex app-server: failed releasing initialization reservation",
            {
              reservationId: spawned.siteFundedTurn.reservation.reservationId,
              err: `${finishErr}`,
            },
          );
        }
      }
      if (spawned.proc.exitCode == null && !spawned.proc.killed) {
        spawned.proc.kill("SIGKILL");
      }
      throw err;
    }
    runtime = {
      key: session.sessionId,
      aliases: new Set(),
      projectId: request.chat?.project_id ?? request.project_id,
      accountId: request.account_id,
      cwd,
      paymentSource: request.config?.paymentSource,
      maxConcurrentSubagents: normalizeMaxConcurrentSubagents(
        request.config?.maxConcurrentSubagents,
      ),
      spawned,
      client,
      fundedTurn: spawned.siteFundedTurn,
      active: true,
      backgroundTerminalCount: 0,
      activeDescendantCount: 0,
      chat: request.chat,
      managerState: "completed",
      disposed: false,
    };
    this.runtimes.add(runtime);
    this.registerRuntimeAlias(runtime, session.sessionId);
    spawned.proc.once("exit", () => {
      runtime!.disposed = true;
      this.removeRuntime(runtime!);
      void this.publishRuntimeOwnership(runtime!, "released");
    });
    return { runtime, created: true };
  }

  async evaluate(request: AcpEvaluateRequest): Promise<void> {
    let maxRetries = 0;
    let retryDelayMs = 0;
    let retryMessage = (_attempt: number, _maxRetries: number) => "Retrying...";
    let exhaustedMessage = (error: string) => error;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const outcome = await this.evaluateOnce(request);
        if (outcome === "interrupted") {
          return;
        }
        return;
      } catch (err) {
        const terminalError = (err as Error)?.message ?? `${err}`;
        const terminalRecoveryCode = isBlockedCommandErrorText(terminalError)
          ? CODEX_ACP_RECOVERY_ERROR_CODE.commandBlocked
          : isResourceKilledErrorText(terminalError)
            ? CODEX_ACP_RECOVERY_ERROR_CODE.resourceKilled
            : undefined;
        if (terminalRecoveryCode) {
          await request.stream({
            type: "error",
            error: terminalError,
            code: terminalRecoveryCode,
            retryable: true,
          });
          return;
        }
        if (isRecoverableTurnError(err)) {
          await request.stream({
            type: "error",
            error: err.message,
            code: err.code,
            retryable: true,
          });
          return;
        }
        if (isRetryableAppServerError(err)) {
          const retryKind = err.kind;
          if (retryKind === "model-capacity") {
            await request.stream({
              type: "error",
              error: err.message,
              code: CODEX_ACP_RECOVERY_ERROR_CODE.modelCapacity,
              retryable: true,
            });
            return;
          }
          const policy = getRetryPolicyForFailure(retryKind);
          maxRetries = policy.maxRetries;
          retryDelayMs = policy.retryDelayMs;
          retryMessage = policy.retryMessage;
          exhaustedMessage = policy.exhaustedMessage;
        }
        if (!isRetryableAppServerError(err) || attempt >= maxRetries) {
          const error =
            isRetryableAppServerError(err) && attempt >= maxRetries
              ? exhaustedMessage(err.message ?? `${err}`)
              : ((err as Error)?.message ?? `${err}`);
          await request.stream({ type: "error", error });
          return;
        }
        const retryNumber = attempt + 1;
        logger.warn("codex app-server: retrying transient failure", {
          projectId: request.chat?.project_id ?? request.project_id,
          accountId: request.account_id,
          kind: err.kind,
          threadId: err.threadId,
          turnId: err.turnId,
          attempt: retryNumber,
          maxRetries,
          delayMs: retryDelayMs,
          stderrTail: err.stderrTail ?? [],
        });
        await request.stream({
          type: "event",
          event: {
            type: "thinking",
            text: retryMessage(retryNumber, maxRetries),
          },
        });
        await delay(retryDelayMs * retryNumber);
      }
    }
  }

  private async evaluateOnce(
    request: AcpEvaluateRequest,
  ): Promise<"completed" | "interrupted"> {
    const { prompt, stream, session_id, config } = request;
    const requestedSessionKey = normalizeCodexSessionId(session_id);
    const persistedSessionId = normalizeCodexSessionId(config?.sessionId);
    const hasEstablishedSession =
      persistedSessionId != null ||
      (requestedSessionKey != null && this.sessions.has(requestedSessionKey));
    let session = this.resolveSession(session_id, config);
    const runtimeEnv = Object.fromEntries(
      Object.entries({
        ...(this.opts.env ?? {}),
        ...(request.runtime_env ?? {}),
      }).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
    const cwd = this.resolveCwd(config);
    const { runtime } = await this.acquireRuntime({
      request,
      session,
      cwd,
      runtimeEnv,
    });
    const { spawned, client } = runtime;
    const fundedTurn = runtime.fundedTurn;
    const effectiveConfig: CodexSessionConfig | undefined = fundedTurn
      ? {
          ...config,
          model: fundedTurn.policy.model,
          reasoning: fundedTurn.policy.reasoning,
          serviceTier: fundedTurn.policy.serviceTier,
        }
      : config;
    if (effectiveConfig !== config) {
      session = this.resolveSession(session_id, effectiveConfig);
    }
    const turnEnv = Object.fromEntries(
      Object.entries({
        ...runtimeEnv,
        ...(spawned.runtimeEnv ?? {}),
      }).filter(([, value]) => typeof value === "string" && !!`${value}`),
    ) as Record<string, string>;
    if (shouldClearActiveGoalBeforeTurn(request)) {
      clearPersistedCodexGoalsBeforeTurn({ spawned, cwd });
    }
    const errors: string[] = [];
    let lastErrorNotification: any | undefined;
    let lastFailedTurnCompletion: any | undefined;
    let finalResponse = "";
    let latestUsage: AcpStreamUsage | undefined;
    let persistedTurnInfo: PersistedTurnInfo | undefined;
    let currentThreadId = session.sessionId;
    let runningEntry: RunningTurn | undefined;
    let turnId: string | undefined;
    const terminalOutputs = new Map<string, string>();
    const startedTerminalMeta = new Map<
      string,
      { command?: string; cwd?: string }
    >();
    const agentMessageTextById = new Map<string, string>();
    const emittedAsyncAttentionItems = new Set<string>();
    const emittedSubagentEventSignatures = new Set<string>();
    const latestSubagentEvents = new Map<string, SubagentStreamEvent>();
    const completedTerminals = new Set<string>();
    const emittedFileWrites = new Set<string>();
    const emittedFileWritePaths = new Set<string>();
    const emittedImages = new Set<string>();
    let latestTurnDiffText: string | undefined;
    const siteKeyGovernor = getCodexSiteKeyGovernor();
    const siteKeyEnforced =
      spawned.authSource === "site-api-key" &&
      !fundedTurn &&
      !!siteKeyGovernor &&
      !!request.account_id &&
      !!(request.chat?.project_id ?? request.project_id);
    let quotaPollTimer: NodeJS.Timeout | undefined;
    let maxTurnTimer: NodeJS.Timeout | undefined;
    let quotaCheckInFlight = false;
    let quotaStopReason: string | undefined;
    const attemptStartedAt = Date.now();
    let fundedFinishStatus: "committed" | "interrupted" | "failed" = "failed";
    let fundedFinishOutcome = "turn failed";
    let runtimeHealthy = false;

    const setRunningKey = (nextThreadId: string) => {
      if (!nextThreadId || currentThreadId === nextThreadId) {
        if (runningEntry) {
          this.running.set(currentThreadId, runningEntry);
        }
        return;
      }
      if (runningEntry) {
        this.running.delete(currentThreadId);
        this.running.set(nextThreadId, runningEntry);
      }
      currentThreadId = nextThreadId;
    };

    const stopForQuota = (message: string) => {
      if (quotaStopReason) return;
      quotaStopReason = message;
      errors.push(message);
      if (runningEntry) {
        void runningEntry.stop().catch((err) => {
          logger.debug("codex app-server: quota stop failed", {
            threadId: currentThreadId,
            turnId,
            err: `${err}`,
          });
        });
      }
    };

    const checkQuota = async (phase: "start" | "poll") => {
      if (
        !siteKeyEnforced ||
        !siteKeyGovernor ||
        !request.account_id ||
        !(request.chat?.project_id ?? request.project_id)
      ) {
        return;
      }
      const projectId = request.chat?.project_id ?? request.project_id;
      try {
        const verdict = await siteKeyGovernor.checkAllowed({
          accountId: request.account_id,
          projectId,
          model: this.effectiveModel(effectiveConfig),
          phase,
        });
        if (!verdict.allowed) {
          stopForQuota(
            verdict.reason ??
              "Stopped: you reached your CoCalc AI usage limit for site-provided OpenAI access.",
          );
        }
      } catch (err) {
        logger.warn("codex app-server: site-key quota check failed", {
          phase,
          accountId: request.account_id,
          projectId,
          err: `${err}`,
        });
      }
    };

    try {
      runningEntry = {
        proc: spawned.proc,
        client,
        stop: async () => {
          if (turnId) {
            try {
              await client.request("turn/interrupt", {
                threadId: currentThreadId,
                turnId,
              });
            } catch (err) {
              logger.debug("codex app-server: interrupt request failed", {
                threadId: currentThreadId,
                turnId,
                err: `${err}`,
              });
            }
          }
        },
        interrupted: false,
      };
      this.running.set(currentThreadId, runningEntry);

      await checkQuota("start");
      if (quotaStopReason) {
        throw new Error(formatAppServerError(errors));
      }
      await stream({ type: "status", state: "queued" });

      let threadResult: any;
      const requestedThreadKey =
        normalizeCodexSessionId(effectiveConfig?.sessionId) ??
        normalizeCodexSessionId(session_id);
      const resumeId = requestedThreadKey ? session.sessionId : undefined;
      const model = this.effectiveModel(effectiveConfig);
      const serviceTier = this.resolveAppServerServiceTier(
        effectiveConfig,
        model,
      );
      const authSource = authSourceForSpawned(spawned);
      const threadParams = {
        cwd,
        model,
        serviceTier,
        approvalPolicy: "never",
        sandbox: toSandboxMode(spawned, effectiveConfig),
        config: threadConfig(
          normalizeMaxConcurrentSubagents(
            effectiveConfig?.maxConcurrentSubagents,
          ),
          this.opts.attentionHandler != null && client.supportsAttentionInput(),
        ),
      };
      const sessionMode = resolveCodexSessionMode(effectiveConfig);
      await stream({
        type: "event",
        event: {
          type: "config",
          model,
          reasoning: effectiveConfig?.reasoning,
          serviceTier: serviceTier ? "fast" : "standard",
          appServerServiceTier: serviceTier,
          sessionMode,
          sandbox: threadParams.sandbox,
          workingDirectory: cwd,
          authSource,
          siteFundedReservationId: fundedTurn?.reservation.reservationId,
        },
      });
      logger.debug("codex app-server: resolved service tier", {
        threadId: resumeId,
        model: threadParams.model,
        requestedServiceTier: effectiveConfig?.serviceTier ?? "standard",
        appServerServiceTier: serviceTier,
      });
      if (runtime.threadId && runtime.threadId === resumeId) {
        threadResult = { thread: { id: runtime.threadId } };
      } else if (resumeId) {
        try {
          threadResult = await client.request("thread/resume", {
            threadId: resumeId,
            ...threadParams,
            excludeTurns: true,
          });
        } catch (err) {
          if (!hasEstablishedSession) {
            logger.info(
              "codex app-server: initial thread alias was not a Codex session; starting the first session",
              {
                threadId: resumeId,
                cwd,
                err: `${err}`,
              },
            );
            threadResult = await client.request("thread/start", threadParams);
          } else {
            logger.warn(
              "codex app-server: refusing to replace failed session",
              {
                threadId: resumeId,
                cwd,
                err: `${err}`,
              },
            );
            throw new Error(
              `Unable to resume Codex session ${resumeId}. CoCalc did not start a replacement session because that would discard its accumulated context. ${err}`,
            );
          }
        }
      } else {
        threadResult = await client.request("thread/start", threadParams);
      }

      const actualThreadId = threadResult?.thread?.id ?? resumeId;
      if (!actualThreadId) {
        throw new Error(`app-server did not return a thread id`);
      }
      setRunningKey(actualThreadId);
      runtime.threadId = actualThreadId;
      await this.publishRuntimeOwnership(runtime, "owned");
      this.registerRuntimeAlias(runtime, actualThreadId);
      this.registerRuntimeAlias(runtime, requestedThreadKey);
      const sessionEntry = { sessionId: actualThreadId, cwd };
      this.sessions.set(actualThreadId, sessionEntry);
      if (requestedThreadKey && requestedThreadKey !== actualThreadId) {
        this.sessions.set(requestedThreadKey, sessionEntry);
      }

      await stream({
        type: "status",
        state: "init",
        threadId: actualThreadId,
      });

      const turnStart = await client.request("turn/start", {
        threadId: actualThreadId,
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: toTurnSandboxPolicy(spawned, effectiveConfig),
        model,
        serviceTier,
        effort: toReasoningEffort(effectiveConfig),
        env: Object.keys(turnEnv).length > 0 ? turnEnv : undefined,
        input: buildTurnInput({
          local_images: request.local_images,
          prompt,
          runtimeEnv: turnEnv,
        }),
      });

      turnId = turnStart?.turn?.id;
      if (!turnId) {
        throw new Error(`turn/start did not return a turn id`);
      }
      if (runningEntry) {
        runningEntry.turnId = turnId;
      }
      client.setAttentionContext({
        projectId: request.chat?.project_id ?? request.project_id,
        accountId: request.account_id,
        chat: request.chat,
        threadId: actualThreadId,
        turnId,
        stream,
      });
      if (siteKeyEnforced && siteKeyGovernor) {
        const pollMs = Math.max(
          30_000,
          siteKeyGovernor.pollIntervalMs ?? 120_000,
        );
        quotaPollTimer = setInterval(() => {
          if (quotaCheckInFlight || quotaStopReason) return;
          quotaCheckInFlight = true;
          void checkQuota("poll").finally(() => {
            quotaCheckInFlight = false;
          });
        }, pollMs);
        quotaPollTimer.unref?.();

        const configuredMaxTurnMs = siteKeyGovernor.maxTurnMs;
        if (configuredMaxTurnMs != null && configuredMaxTurnMs > 0) {
          const maxTurnMs = Math.max(60_000, configuredMaxTurnMs);
          maxTurnTimer = setTimeout(() => {
            stopForQuota(
              "Stopped: this Codex turn exceeded the maximum runtime for site-provided OpenAI access.",
            );
          }, maxTurnMs);
          maxTurnTimer.unref?.();
        }
      }

      const ensureTerminalStarted = async (
        terminalId: string,
        { command, cwd: terminalCwd }: { command?: string; cwd?: string } = {},
      ): Promise<void> => {
        const nextCwd = terminalCwd ?? cwd;
        const previous = startedTerminalMeta.get(terminalId);
        const shouldEmit =
          previous == null ||
          (command != null && command !== previous.command) ||
          (nextCwd != null && nextCwd !== previous.cwd);
        if (!shouldEmit) return;
        startedTerminalMeta.set(terminalId, {
          command: command ?? previous?.command,
          cwd: nextCwd ?? previous?.cwd,
        });
        await stream({
          type: "event",
          event: {
            type: "terminal",
            terminalId,
            phase: "start",
            command: command ?? previous?.command,
            cwd: nextCwd ?? previous?.cwd,
          },
        });
      };

      const emitSubagentEvent = async (
        event: SubagentStreamEvent,
      ): Promise<void> => {
        latestSubagentEvents.set(event.threadId, event);
        const signature = JSON.stringify(event);
        if (emittedSubagentEventSignatures.has(signature)) return;
        emittedSubagentEventSignatures.add(signature);
        await stream({ type: "event", event });
      };

      const reconcileSubagentStates = async (): Promise<void> => {
        if (latestSubagentEvents.size === 0) return;
        let descendants: any[];
        try {
          descendants = await this.listDescendantThreads(runtime);
        } catch (err) {
          logger.warn("codex app-server: failed reconciling subagent states", {
            threadId: actualThreadId,
            turnId,
            err: `${err}`,
          });
          return;
        }
        const descendantsById = new Map(
          descendants
            .filter((thread) => typeof thread?.id === "string")
            .map((thread) => [thread.id, thread]),
        );
        for (const [threadId, previous] of latestSubagentEvents) {
          if (previous.state !== "pending" && previous.state !== "running") {
            continue;
          }
          const descendant = descendantsById.get(threadId);
          let state: SubagentStreamEvent["state"];
          if (descendant?.status?.type === "active") {
            state = "running";
          } else if (descendant?.status?.type === "systemError") {
            state = "failed";
          } else {
            try {
              const result = await runtime.client.request("thread/read", {
                threadId,
                includeTurns: true,
              });
              const turns = Array.isArray(result?.thread?.turns)
                ? result.thread.turns
                : [];
              const status = `${turns[turns.length - 1]?.status ?? ""}`;
              state =
                status === "inProgress"
                  ? "running"
                  : status === "failed"
                    ? "failed"
                    : status === "interrupted"
                      ? "interrupted"
                      : status === "completed"
                        ? "completed"
                        : "unknown";
            } catch {
              state = descendant ? "unknown" : "missing";
            }
          }
          if (state === previous.state) continue;
          await emitSubagentEvent({
            ...previous,
            operationId: `reconcile:${turnId ?? "turn"}:${threadId}`,
            state,
            tool: "activity",
            message:
              state === "unknown"
                ? "The subagent is no longer active; its final outcome was unavailable."
                : previous.message,
          });
        }
      };

      const handleItem = async (item: any): Promise<void> => {
        if (!item || typeof item !== "object") return;
        switch (item.type) {
          case "collabAgentToolCall": {
            const tool =
              item.tool === "spawnAgent"
                ? "spawn"
                : item.tool === "sendInput"
                  ? "send"
                  : item.tool === "resumeAgent"
                    ? "resume"
                    : item.tool === "closeAgent"
                      ? "close"
                      : item.tool === "wait"
                        ? "wait"
                        : undefined;
            const receiverIds = Array.isArray(item.receiverThreadIds)
              ? item.receiverThreadIds.filter(
                  (value: unknown): value is string =>
                    typeof value === "string" && value.length > 0,
                )
              : [];
            const agentStates =
              item.agentsStates && typeof item.agentsStates === "object"
                ? item.agentsStates
                : {};
            for (const threadId of receiverIds) {
              const agentState = agentStates[threadId];
              const rawState = `${agentState?.status ?? ""}`;
              const state =
                rawState === "pendingInit"
                  ? "pending"
                  : rawState === "running"
                    ? "running"
                    : rawState === "completed"
                      ? "completed"
                      : rawState === "interrupted"
                        ? "interrupted"
                        : rawState === "errored"
                          ? "failed"
                          : rawState === "shutdown"
                            ? "shutdown"
                            : rawState === "notFound"
                              ? "missing"
                              : item.status === "failed"
                                ? "failed"
                                : item.status === "completed" &&
                                    tool === "close"
                                  ? "shutdown"
                                  : "running";
              const event = {
                type: "subagent",
                operationId: `${item.id ?? `${tool ?? "activity"}:${threadId}`}`,
                threadId,
                parentThreadId:
                  typeof item.senderThreadId === "string"
                    ? item.senderThreadId
                    : undefined,
                state,
                tool,
                task: boundedSubagentText(item.prompt),
                message: boundedSubagentText(agentState?.message),
                model: typeof item.model === "string" ? item.model : undefined,
                reasoning:
                  typeof item.reasoningEffort === "string"
                    ? item.reasoningEffort
                    : undefined,
              } as const;
              await emitSubagentEvent(event);
            }
            break;
          }
          case "subAgentActivity": {
            if (typeof item.agentThreadId !== "string") break;
            const event = {
              type: "subagent",
              operationId: `${item.id ?? `activity:${item.agentThreadId}`}`,
              threadId: item.agentThreadId,
              state:
                item.kind === "interrupted"
                  ? "interrupted"
                  : item.kind === "started"
                    ? "pending"
                    : "running",
              tool: "activity",
              agentPath:
                typeof item.agentPath === "string" ? item.agentPath : undefined,
            } as const;
            await emitSubagentEvent(event);
            break;
          }
          case "agentMessage":
            if (this.opts.attentionHandler && asyncAttentionEnabled()) {
              const normalized = normalizeCodexAsyncQuestions(item);
              if (
                normalized &&
                !emittedAsyncAttentionItems.has(normalized.itemId)
              ) {
                emittedAsyncAttentionItems.add(normalized.itemId);
                const context: CodexAttentionContext = {
                  projectId: request.chat?.project_id ?? request.project_id,
                  accountId: request.account_id,
                  chat: request.chat,
                  threadId: actualThreadId,
                  turnId: turnId!,
                  stream,
                };
                await this.opts.attentionHandler.createAsyncQuestion({
                  itemId: normalized.itemId,
                  questions: normalized.questions,
                  context,
                });
              }
            }
            if (typeof item.text === "string") {
              finalResponse = item.text;
              const itemId = `${item.id ?? "agent-message"}`;
              const previous = agentMessageTextById.get(itemId) ?? "";
              if (item.text !== previous) {
                const delta =
                  previous && item.text.startsWith(previous)
                    ? item.text.slice(previous.length)
                    : "";
                agentMessageTextById.set(itemId, item.text);
                if (!previous || delta) {
                  await stream({
                    type: "event",
                    event: {
                      type: "message",
                      text: delta || item.text,
                      delta: !!delta,
                    },
                  });
                } else {
                  logger.debug(
                    "codex app-server: completed manager snapshot was not an append-only update",
                    {
                      itemId,
                      previousLength: previous.length,
                      nextLength: item.text.length,
                    },
                  );
                }
              }
            }
            break;
          case "commandExecution": {
            const terminalId = `${item.id ?? item.processId ?? "app-server-terminal"}`;
            const cwdForEvent =
              typeof item.cwd === "string" && item.cwd.trim() ? item.cwd : cwd;
            if (item.command || cwdForEvent) {
              await ensureTerminalStarted(terminalId, {
                command: item.command,
                cwd: cwdForEvent,
              });
            }
            if (typeof item.aggregatedOutput === "string") {
              const previous = terminalOutputs.get(terminalId) ?? "";
              if (item.aggregatedOutput !== previous) {
                const delta = item.aggregatedOutput.slice(previous.length);
                terminalOutputs.set(terminalId, item.aggregatedOutput);
                if (delta) {
                  await stream({
                    type: "event",
                    event: {
                      type: "terminal",
                      terminalId,
                      phase: "data",
                      cwd: cwdForEvent,
                      chunk: delta,
                    },
                  });
                }
              }
            }
            if (
              item.status === "completed" ||
              item.status === "failed" ||
              item.status === "declined"
            ) {
              completedTerminals.add(terminalId);
              await stream({
                type: "event",
                event: {
                  type: "terminal",
                  terminalId,
                  phase: "exit",
                  cwd: cwdForEvent,
                  output:
                    terminalOutputs.get(terminalId) ?? item.aggregatedOutput,
                  exitStatus: {
                    exitCode:
                      typeof item.exitCode === "number"
                        ? item.exitCode
                        : undefined,
                  },
                },
              });
            }
            break;
          }
          case "fileChange":
            if (
              item.status !== "failed" &&
              item.status !== "declined" &&
              Array.isArray(item.changes)
            ) {
              for (const change of item.changes) {
                if (!change?.path) continue;
                const eventKey = `${item.id ?? "file"}:${change.path}`;
                if (emittedFileWrites.has(eventKey)) continue;
                const diff = getFileChangeLineDiff(change);
                const normalizedPathKey = normalizeActivityPathKey(
                  change.path,
                  cwd,
                );
                emittedFileWrites.add(eventKey);
                if (normalizedPathKey) {
                  emittedFileWritePaths.add(normalizedPathKey);
                }
                if (diff) {
                  await stream({
                    type: "event",
                    event: {
                      type: "diff",
                      path: change.path,
                      diff,
                    },
                  });
                  continue;
                }
                await stream({
                  type: "event",
                  event: {
                    type: "file",
                    path: change.path,
                    operation: "write",
                    cwd,
                  },
                });
              }
            }
            break;
          case "imageGeneration": {
            const imageId =
              typeof item.id === "string" && item.id.trim()
                ? item.id.trim()
                : undefined;
            const status =
              typeof item.status === "string" && item.status.trim()
                ? item.status.trim()
                : "unknown";
            const savedPath =
              typeof item.savedPath === "string" && item.savedPath.trim()
                ? item.savedPath.trim()
                : typeof item.saved_path === "string" && item.saved_path.trim()
                  ? item.saved_path.trim()
                  : undefined;
            const revisedPrompt =
              typeof item.revisedPrompt === "string"
                ? item.revisedPrompt
                : typeof item.revised_prompt === "string"
                  ? item.revised_prompt
                  : undefined;
            const normalizedStatus = status.toLowerCase();
            const terminal =
              savedPath != null ||
              normalizedStatus === "completed" ||
              normalizedStatus === "failed" ||
              normalizedStatus === "declined" ||
              normalizedStatus === "cancelled";
            if (!terminal) {
              break;
            }
            const eventKey =
              imageId ??
              `anonymous:${normalizedStatus}:${savedPath ?? ""}:${
                revisedPrompt ?? ""
              }`;
            if (emittedImages.has(eventKey)) {
              break;
            }
            emittedImages.add(eventKey);
            let blob:
              | {
                  uuid: string;
                  filename: string;
                  url: string;
                }
              | undefined;
            if (savedPath && this.opts.uploadGeneratedImage) {
              const hostPath = mapContainerPathToHost(
                savedPath,
                spawned.containerPathMap,
              );
              try {
                blob =
                  (await this.opts.uploadGeneratedImage({
                    savedPath,
                    hostPath,
                    codexHomeHostPath: getCodexHomeHostPath(spawned, cwd),
                    filename: path.basename(hostPath),
                    imageId,
                    revisedPrompt,
                    cwd,
                    projectId: request.chat?.project_id ?? request.project_id,
                    accountId: request.account_id,
                    threadId: actualThreadId,
                    turnId,
                  })) ?? undefined;
              } catch (err) {
                logger.warn("codex app-server: generated image upload failed", {
                  savedPath,
                  hostPath,
                  err: `${err}`,
                });
              }
            }
            await stream({
              type: "event",
              event: {
                type: "image",
                id: imageId,
                status,
                revisedPrompt,
                savedPath,
                ...(blob ? { blob } : {}),
              },
            });
            break;
          }
          default:
            break;
        }
      };

      const emitMissingTurnDiffEvents = async (): Promise<void> => {
        const diffText = `${latestTurnDiffText ?? ""}`.trim();
        if (!diffText) return;
        for (const block of splitUnifiedDiffByFile(diffText)) {
          const normalizedPathKey = normalizeActivityPathKey(block.path, cwd);
          if (
            !block.path ||
            !normalizedPathKey ||
            emittedFileWritePaths.has(normalizedPathKey)
          ) {
            continue;
          }
          const diff = lineDiffFromUnifiedPatch(block.diffText);
          emittedFileWritePaths.add(normalizedPathKey);
          if (diff) {
            await stream({
              type: "event",
              event: {
                type: "diff",
                path: block.path,
                diff,
              },
            });
            continue;
          }
          await stream({
            type: "event",
            event: {
              type: "file",
              path: block.path,
              operation: "write",
              cwd,
            },
          });
        }
      };

      const handleNotification = async (notification: RpcNotification) => {
        switch (notification.method) {
          case "turn/started":
            await stream({ type: "status", state: "running" });
            break;
          case "item/agentMessage/delta": {
            const itemId = `${notification.params?.itemId ?? "agent-message"}`;
            const delta = `${notification.params?.delta ?? ""}`;
            if (delta) {
              finalResponse += delta;
              agentMessageTextById.set(
                itemId,
                `${agentMessageTextById.get(itemId) ?? ""}${delta}`,
              );
              await stream({
                type: "event",
                event: { type: "message", text: delta, delta: true },
              });
            }
            break;
          }
          case "item/reasoningSummaryText/delta": {
            const delta = `${notification.params?.delta ?? ""}`;
            if (delta) {
              await stream({
                type: "event",
                event: { type: "thinking", text: delta },
              });
            }
            break;
          }
          case "item/reasoning/summaryTextDelta": {
            const delta = `${notification.params?.delta ?? ""}`;
            if (delta) {
              await stream({
                type: "event",
                event: { type: "thinking", text: delta },
              });
            }
            break;
          }
          case "item/commandExecution/outputDelta": {
            const terminalId = `${notification.params?.itemId ?? "app-server-terminal"}`;
            const delta = `${notification.params?.delta ?? ""}`;
            if (!delta) break;
            await ensureTerminalStarted(terminalId);
            terminalOutputs.set(
              terminalId,
              `${terminalOutputs.get(terminalId) ?? ""}${delta}`,
            );
            await stream({
              type: "event",
              event: {
                type: "terminal",
                terminalId,
                phase: "data",
                cwd,
                chunk: delta,
              },
            });
            break;
          }
          case "item/completed":
            if (notification.params?.item?.type === "agentMessage") {
              await stream({ type: "status", state: "running" });
            }
            await handleItem(notification.params?.item);
            break;
          case "item/started":
          case "item/updated":
            await handleItem(notification.params?.item);
            break;
          case "turn/diff/updated": {
            const diff = notification.params?.diff;
            if (typeof diff === "string" && diff.trim().length > 0) {
              latestTurnDiffText = diff;
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const usage = notification.params?.tokenUsage?.last;
            if (usage) {
              latestUsage = {
                input_tokens: usage.inputTokens,
                cached_input_tokens: usage.cachedInputTokens,
                output_tokens: usage.outputTokens,
                reasoning_output_tokens: usage.reasoningOutputTokens,
                total_tokens: usage.totalTokens,
                model_context_window:
                  notification.params?.tokenUsage?.modelContextWindow,
              };
              await stream({
                type: "usage",
                usage: latestUsage,
              });
            }
            break;
          }
          case "error": {
            const message =
              `${notification.params?.error?.message ?? ""}`.trim();
            lastErrorNotification = notification.params;
            if (message && notification.params?.willRetry !== true) {
              errors.push(message);
            }
            break;
          }
          default:
            break;
        }
      };

      const pendingNotificationLoop = (async () => {
        let reconciliationFailures = 0;
        let lastReconciliationNoticeAt = 0;
        while (true) {
          let notification: RpcNotification;
          try {
            notification = await client.waitForMessage((message) => {
              const params = message.params ?? {};
              if (message.method === "turn/completed") {
                return params?.turn?.id === turnId;
              }
              if (message.method === "turn/started") {
                return params?.turn?.id === turnId;
              }
              return params?.turnId === turnId;
            }, getTurnNotificationIdleTimeoutMs());
          } catch (err) {
            // Reconciliation can recover a dropped notification from a live
            // app-server. It cannot recover a process that has already exited;
            // retrying here used to leave the UI in "starting" for successive
            // notification timeouts while the original stderr was hidden.
            if (client.hasExited()) throw err;
            try {
              const result = await client.request("thread/read", {
                threadId: actualThreadId,
                includeTurns: true,
              });
              const turns = Array.isArray(result?.thread?.turns)
                ? result.thread.turns
                : [];
              const reconciledTurn = turns.find(
                (candidate) => candidate?.id === turnId,
              );
              const status = `${reconciledTurn?.status ?? ""}`;
              const threadStatus = result?.thread?.status;
              // Codex 0.151 paginated histories persist a turn only when it
              // completes. thread/read can therefore omit a live turn even
              // though its thread-level status is authoritatively active.
              if (
                status === "inProgress" ||
                threadStatusIsActive(threadStatus)
              ) {
                reconciliationFailures = 0;
                if (Date.now() - lastReconciliationNoticeAt >= 5 * 60_000) {
                  lastReconciliationNoticeAt = Date.now();
                  await stream({
                    type: "event",
                    event: {
                      type: "thinking",
                      text: "Codex is still working; CoCalc reconciled the live turn after a quiet period.",
                    },
                  });
                }
                continue;
              }
              if (status) {
                notification = {
                  method: "turn/completed",
                  params: { turn: reconciledTurn },
                };
              } else {
                throw new Error("active turn was absent from thread/read");
              }
            } catch (reconcileErr) {
              reconciliationFailures += 1;
              logger.warn("codex app-server: turn reconciliation failed", {
                threadId: actualThreadId,
                turnId,
                failures: reconciliationFailures,
                waitError: `${err}`,
                reconcileError: `${reconcileErr}`,
              });
              if (reconciliationFailures < getTurnReconcileFailureLimit()) {
                continue;
              }
              throw createRecoverableTurnError({
                code: CODEX_ACP_RECOVERY_ERROR_CODE.turnLost,
                message: `Unable to confirm Codex turn state after ${reconciliationFailures} reconciliation attempts: ${reconcileErr}`,
              });
            }
          }
          if (notification.method === "turn/completed") {
            const status =
              `${notification.params?.turn?.status ?? ""}`.toLowerCase();
            if (
              status === "failed" &&
              notification.params?.turn?.error?.message
            ) {
              lastFailedTurnCompletion = notification.params;
              errors.push(notification.params.turn.error.message);
            }
            if (status === "interrupted" && runningEntry) {
              runningEntry.interrupted = true;
            }
            break;
          }
          await handleNotification(notification);
        }
      })();

      await pendingNotificationLoop;
      await reconcileSubagentStates();
      await emitMissingTurnDiffEvents();
      if (quotaPollTimer) {
        clearInterval(quotaPollTimer);
      }
      if (maxTurnTimer) {
        clearTimeout(maxTurnTimer);
      }
      persistedTurnInfo = await readPersistedTurnInfo({
        spawned,
        cwd,
        threadId: actualThreadId,
        turnId,
      });
      if (!latestUsage) {
        latestUsage = persistedTurnInfo?.usage;
      }
      if (persistedTurnInfo?.compacted) {
        await stream({
          type: "event",
          event: { type: "thinking", text: "Context compacted" },
        });
      }

      if (
        errors.length > 0 &&
        (!runningEntry?.interrupted || !!quotaStopReason)
      ) {
        throw new Error(formatAppServerError(errors));
      }

      if (
        siteKeyEnforced &&
        siteKeyGovernor &&
        request.account_id &&
        (request.chat?.project_id ?? request.project_id) &&
        latestUsage &&
        !runningEntry?.interrupted
      ) {
        try {
          await siteKeyGovernor.reportUsage({
            accountId: request.account_id,
            projectId: request.chat?.project_id ?? request.project_id,
            model: this.effectiveModel(effectiveConfig),
            usage: {
              input_tokens: latestUsage.input_tokens ?? 0,
              cached_input_tokens: latestUsage.cached_input_tokens,
              output_tokens: latestUsage.output_tokens ?? 0,
              total_tokens:
                (latestUsage.input_tokens ?? 0) +
                (latestUsage.cached_input_tokens ?? 0) +
                (latestUsage.output_tokens ?? 0),
            },
            totalTimeS: Math.max(0, (Date.now() - attemptStartedAt) / 1000),
            path: request.chat?.path,
          });
        } catch (err) {
          logger.warn("codex app-server: failed to report site-key usage", {
            accountId: request.account_id,
            projectId: request.chat?.project_id ?? request.project_id,
            model: this.effectiveModel(effectiveConfig),
            err: `${err}`,
          });
        }
      }

      await stream({
        type: "summary",
        finalResponse,
        usage: latestUsage ?? undefined,
        threadId: actualThreadId,
      });
      runtimeHealthy = true;
      fundedFinishStatus = "committed";
      fundedFinishOutcome = "turn completed";
    } catch (err) {
      if (quotaPollTimer) {
        clearInterval(quotaPollTimer);
      }
      if (maxTurnTimer) {
        clearTimeout(maxTurnTimer);
      }
      if (runningEntry?.interrupted && !quotaStopReason) {
        runtime.managerState = "interrupted";
        runtimeHealthy = true;
        fundedFinishStatus = "interrupted";
        fundedFinishOutcome = "turn interrupted";
        logger.info("codex app-server evaluate interrupted", {
          threadId: currentThreadId,
          turnId,
          err: `${err}`,
        });
        return "interrupted";
      }
      const stderrTail = client.getStderrTail();
      const primaryError = (err as Error)?.message ?? `${err}`;
      fundedFinishOutcome = primaryError.slice(0, 500);
      const userFacingPrimaryError =
        formatCodexAuthError(normalizeErrorMessages([primaryError])) ??
        primaryError;
      const diagnosticError = [
        primaryError,
        ...stderrTail.filter((line) => !errors.includes(line)),
      ]
        .filter(Boolean)
        .join("\n");
      logger.warn("codex app-server evaluate failed", {
        threadId: currentThreadId,
        turnId,
        cwd,
        cmd: spawned.cmd,
        args: spawned.logArgs ?? argsJoin(spawned.args),
        authSource: spawned.authSource,
        err: `${err}`,
        normalizedErrors: normalizeErrorMessages(errors),
        lastErrorNotification,
        lastFailedTurnCompletion,
        persistedTurnInfo,
        stderrTail,
      });
      if (isRecoverableTurnError(err)) {
        throw err;
      }
      if (
        client.hasExited() &&
        isBlockedCommandErrorText(userFacingPrimaryError)
      ) {
        throw createRecoverableTurnError({
          code: CODEX_ACP_RECOVERY_ERROR_CODE.commandBlocked,
          message: userFacingPrimaryError,
        });
      }
      if (
        client.hasExited() &&
        isResourceKilledErrorText(userFacingPrimaryError)
      ) {
        throw createRecoverableTurnError({
          code: CODEX_ACP_RECOVERY_ERROR_CODE.resourceKilled,
          message: userFacingPrimaryError,
        });
      }
      if (turnId && client.hasExited()) {
        throw createRecoverableTurnError({
          code: CODEX_ACP_RECOVERY_ERROR_CODE.appServerExited,
          message: userFacingPrimaryError,
        });
      }
      const retryKind = getRetryableFailureKind(diagnosticError);
      if (
        retryKind &&
        !hasRetryBlockingTurnSideEffects(retryKind, {
          startedTerminalMeta,
          terminalOutputs,
          completedTerminals,
          emittedFileWrites,
          emittedFileWritePaths,
          finalResponse,
          latestTurnDiffText,
        })
      ) {
        throw createRetryableAppServerError({
          kind: retryKind,
          message: primaryError,
          threadId: currentThreadId,
          turnId,
          stderrTail,
        });
      }
      if (retryKind) {
        logger.info(
          "codex app-server: suppressing transient retry after side effects",
          {
            kind: retryKind,
            threadId: currentThreadId,
            turnId,
            startedTerminals: startedTerminalMeta.size,
            terminalsWithOutput: Array.from(terminalOutputs.values()).filter(
              Boolean,
            ).length,
            completedTerminals: completedTerminals.size,
            fileWrites: emittedFileWrites.size,
            fileWritePaths: emittedFileWritePaths.size,
            hasFinalResponse: !!finalResponse.trim(),
            hasTurnDiff: !!`${latestTurnDiffText ?? ""}`.trim(),
          },
        );
      }
      throw new Error(userFacingPrimaryError);
    } finally {
      this.running.delete(currentThreadId);
      if (fundedTurn) {
        try {
          await fundedTurn.finish({
            status: fundedFinishStatus,
            outcome: fundedFinishOutcome,
          });
        } catch (err) {
          logger.warn("codex app-server: funded turn settlement failed", {
            reservationId: fundedTurn.reservation.reservationId,
            status: fundedFinishStatus,
            err: `${err}`,
          });
        }
      }
      runtime.active = false;
      runtime.fundedTurn = undefined;
      if (!runtimeHealthy) {
        await this.disposeRuntime(runtime, "turn failed");
      } else {
        await this.refreshRuntimeLifecycle(runtime);
      }
    }
    return "completed";
  }

  async interrupt(threadId: string): Promise<boolean> {
    const running = this.running.get(threadId);
    if (!running) return false;
    running.interrupted = true;
    await running.stop();
    return true;
  }

  async interruptOutstanding(threadId: string): Promise<boolean> {
    const runtime = this.runtimesByAlias.get(threadId);
    let handled = await this.interrupt(threadId);
    if (!runtime || runtime.disposed || !runtime.threadId) return handled;

    let descendants: any[] = [];
    try {
      descendants = await this.listDescendantThreads(runtime);
    } catch (err) {
      logger.warn(
        "codex app-server: failed listing subagents during stop all",
        {
          parentThreadId: runtime.threadId,
          err: `${err}`,
        },
      );
    }
    for (const descendant of descendants) {
      if (descendant?.status?.type !== "active" || !descendant?.id) continue;
      try {
        const result = await runtime.client.request("thread/read", {
          threadId: descendant.id,
          includeTurns: true,
        });
        const turns = Array.isArray(result?.thread?.turns)
          ? result.thread.turns
          : [];
        const activeTurn = [...turns]
          .reverse()
          .find((turn) => turn?.status === "inProgress");
        if (activeTurn?.id) {
          await runtime.client.request("turn/interrupt", {
            threadId: descendant.id,
            turnId: activeTurn.id,
          });
          handled = true;
        }
      } catch (err) {
        logger.warn("codex app-server: failed interrupting subagent", {
          parentThreadId: runtime.threadId,
          threadId: descendant.id,
          err: `${err}`,
        });
      }
    }
    for (const targetThreadId of [
      runtime.threadId,
      ...descendants.map((thread) => thread?.id).filter(Boolean),
    ]) {
      try {
        await runtime.client.request("thread/backgroundTerminals/clean", {
          threadId: targetThreadId,
        });
        handled = true;
      } catch (err) {
        logger.debug("codex app-server: background cleanup failed", {
          threadId: targetThreadId,
          err: `${err}`,
        });
      }
    }
    try {
      await this.refreshRuntimeLifecycle(runtime);
    } catch (err) {
      logger.debug("codex app-server: post-interrupt reconciliation failed", {
        threadId: runtime.threadId,
        err: `${err}`,
      });
    }
    return handled;
  }

  hasRunningTurn(threadId: string): boolean {
    return this.running.has(threadId);
  }

  getRuntimeStatus(): {
    liveRuntimes: number;
    activeTurns: number;
    backgroundTerminals: number;
    activeDescendants: number;
  } {
    let activeTurns = 0;
    let backgroundTerminals = 0;
    let activeDescendants = 0;
    for (const runtime of this.runtimes) {
      if (runtime.active) activeTurns += 1;
      backgroundTerminals += runtime.backgroundTerminalCount;
      activeDescendants += runtime.activeDescendantCount;
    }
    return {
      liveRuntimes: this.runtimes.size,
      activeTurns,
      backgroundTerminals,
      activeDescendants,
    };
  }

  async steer(
    threadId: string,
    request: AcpSteerRequest,
  ): Promise<AcpSteerResult> {
    const running = this.running.get(threadId);
    if (!running) {
      return { state: "missing" };
    }
    const runtimeEnv = Object.fromEntries(
      Object.entries({
        ...(this.opts.env ?? {}),
        ...(request.runtime_env ?? {}),
      }).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
    let expectedTurnId = `${running.turnId ?? ""}`.trim();
    if (!expectedTurnId) {
      return { state: "missing" };
    }
    const input = buildTurnInput({
      local_images: request.local_images,
      prompt: request.prompt,
      runtimeEnv,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await running.client.request("turn/steer", {
          threadId,
          expectedTurnId,
          input,
        });
        const actualTurnId = `${result?.turnId ?? expectedTurnId}`.trim();
        if (actualTurnId) {
          running.turnId = actualTurnId;
        }
        return { state: "steered", threadId };
      } catch (err) {
        const classified = classifySteerError(err);
        if (classified.kind === "missing") {
          return { state: "missing" };
        }
        if (classified.kind === "not_steerable") {
          return { state: "not_steerable", threadId };
        }
        if (
          classified.kind === "mismatch" &&
          classified.actualTurnId &&
          classified.actualTurnId !== expectedTurnId
        ) {
          expectedTurnId = classified.actualTurnId;
          running.turnId = classified.actualTurnId;
          continue;
        }
        throw err;
      }
    }

    return { state: "missing" };
  }

  async dispose(): Promise<void> {
    for (const running of this.running.values()) {
      running.interrupted = true;
      await running.stop();
    }
    this.running.clear();
    await Promise.all(
      [...this.runtimes].map((runtime) =>
        this.disposeRuntime(runtime, "ACP agent disposed"),
      ),
    );
  }

  private resolveSession(
    sessionId: string | undefined,
    config?: CodexSessionConfig,
  ): SessionStoreEntry {
    const key =
      normalizeCodexSessionId(config?.sessionId) ??
      normalizeCodexSessionId(sessionId);
    if (key && this.sessions.has(key)) {
      return this.sessions.get(key)!;
    }
    const newId = key || randomUUID();
    return { sessionId: newId, cwd: this.resolveCwd(config) };
  }

  private resolveCwd(config?: CodexSessionConfig): string {
    const base = this.opts.cwd ?? process.cwd();
    const requested = config?.workingDirectory;
    if (!requested) return base;
    if (path.isAbsolute(requested)) return requested;
    return path.resolve(base, requested);
  }

  private effectiveModel(config: CodexSessionConfig | undefined): string {
    return config?.model ?? this.opts.model ?? DEFAULT_CODEX_MODEL_NAME;
  }

  private resolveAppServerServiceTier(
    config: CodexSessionConfig | undefined,
    model: string | undefined,
  ): string | null {
    return codexServiceTierForAppServer({
      model,
      serviceTier: config?.serviceTier,
    });
  }

  private async spawnAppServer({
    projectId,
    accountId,
    agentSessionKey,
    cwd,
    env,
    siteFundedTurn,
    paymentSource,
  }: {
    projectId: string;
    accountId?: string;
    agentSessionKey?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    siteFundedTurn?: CodexSiteFundedTurnRequest;
    paymentSource?: CodexSessionConfig["paymentSource"];
  }): Promise<SpawnedCodexAppServer> {
    const projectSpawner = getCodexProjectSpawner();
    if (projectSpawner && projectId && projectSpawner.spawnCodexAppServer) {
      const spawned = await projectSpawner.spawnCodexAppServer({
        projectId,
        accountId,
        agentSessionKey,
        cwd,
        env,
        siteFundedTurn,
        paymentSource,
      });
      logger.debug("codex app-server: spawning via project container", {
        cmd: spawned.cmd,
        args: spawned.logArgs ?? argsJoin(spawned.args),
        cwd: spawned.cwd ?? cwd,
        authSource: spawned.authSource,
      });
      return spawned;
    }
    return await spawnStandaloneAppServer(
      {
        ...this.opts,
        cwd,
      },
      env,
    );
  }
}
