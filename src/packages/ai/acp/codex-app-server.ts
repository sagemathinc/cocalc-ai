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
  normalizeCodexSessionId,
  type CodexSessionConfig,
} from "@cocalc/util/ai/codex";
import type { LineDiffResult } from "@cocalc/util/line-diff";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";
import type {
  AcpAgent,
  AcpEvaluateRequest,
  AcpSteerRequest,
  AcpSteerResult,
  AcpStreamUsage,
} from "./types";
import {
  getCodexProjectSpawner,
  type CodexAppServerLoginHint,
  type CodexProjectContainerPathMap,
  type CodexAppServerRequestHandler,
} from "./codex-project";
import { getCodexSiteKeyGovernor } from "./codex-site-key-governor";
import {
  findSessionFile,
  getSessionsRoot,
  rewriteSessionMeta,
  truncateSessionHistoryById,
} from "./codex-session-store";

const logger = getLogger("ai:acp:codex-app-server");
// Codex 0.120 still marks this under-development and disabled by default.
// The built-in tool has its own auth/model gates, so enabling the feature flag
// here does not expose image generation to unsupported auth modes.
const IMAGE_GENERATION_FEATURE_ARGS = ["--enable", "image_generation"];
const REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.COCALC_CODEX_APP_SERVER_TIMEOUT_MS ?? 90_000),
);
const TURN_NOTIFICATION_IDLE_TIMEOUT_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(
    process.env.COCALC_CODEX_APP_SERVER_NOTIFICATION_TIMEOUT_MS ?? 30 * 60_000,
  ),
);
const SESSION_TRUNCATE_CHECK_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_CODEX_SESSION_TRUNCATE_INTERVAL_MS ?? 15 * 60_000),
);

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function normalizeDiffLines(text: string): string[] {
  const lines = `${text ?? ""}`.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
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

function getCoCalcRuntimeGuidanceHeader(cliCommand: string): string {
  return [
    "[CoCalc runtime capabilities]",
    "This turn may run with CoCalc CLI/browser automation context.",
    `When you need the CoCalc CLI, use this exact command: \`${cliCommand}\`. Do not assume bare \`cocalc\` resolves to the right binary.`,
    `If relevant, you can use \`${cliCommand}\` to inspect browser state and run browser exec scripts.`,
    "Prefer scoped variables already provided in environment, e.g.:",
    "- COCALC_PROJECT_ID",
    "- COCALC_BROWSER_ID",
    "- COCALC_API_URL",
    "- COCALC_BEARER_TOKEN",
    "Prefer high-signal commands over raw browser scripts when available.",
    "For notebook edits/execution that must survive browser refresh or disconnect, prefer `cocalc project jupyter -h` over `browser exec`.",
    "For multi-step notebook work, prefer `cocalc project jupyter exec --path ... --stdin` for ad hoc snippets or `--file <script.js>` for saved scripts instead of shelling multiple notebook commands.",
    "Use `cocalc project jupyter exec-api` to inspect the ambient notebook script API before writing a multi-step script. `api.notebook.run(...)` returns `run.run_id`.",
    "Treat the live in-memory notebook state as the source of truth for live notebook work.",
    "Do not read or edit `.ipynb` JSON directly for live notebook inspection or mutation unless the user explicitly asks for filesystem-level work.",
    "Use `browser exec` only for UI-only notebook context such as selection or viewport state.",
    "For questions like 'tell me about my browser workspaces', start with:",
    `1) Inspect live workspace state: ${cliCommand} browser workspace-state --project-id \"$COCALC_PROJECT_ID\" --browser \"$COCALC_BROWSER_ID\"`,
    `2) Inspect API: ${cliCommand} browser exec-api --browser \"$COCALC_BROWSER_ID\"`,
    `3) Execute in browser: ${cliCommand} browser exec --project-id \"$COCALC_PROJECT_ID\" --browser \"$COCALC_BROWSER_ID\" --file <script.js>`,
    "Under agent auth, pass exact browser/project targets to avoid blocked session discovery.",
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
};

type SpawnedCodexAppServer = {
  proc: ReturnType<typeof spawn>;
  cmd: string;
  args: string[];
  cwd?: string;
  authSource?: string;
  containerPathMap?: CodexProjectContainerPathMap;
  appServerLogin?: CodexAppServerLoginHint;
  handleAppServerRequest?: CodexAppServerRequestHandler;
  runtimeEnv?: Record<string, string>;
};

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
  exited: Promise<void>;
};

type RetryableAppServerFailureKind =
  | "remote-compact-timeout"
  | "model-capacity"
  | "timeout"
  | "stream-disconnect";

type RetryableAppServerError = Error & {
  retryableAppServerError: true;
  kind: RetryableAppServerFailureKind;
  threadId?: string;
  turnId?: string;
  stderrTail?: string[];
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

class AppServerClient {
  private nextId = 1;
  private readonly pendingRequests = new Map<number, RequestEntry>();
  private readonly waiters: Waiter[] = [];
  private readonly stderrTail: string[] = [];
  private readonly notifications: RpcNotification[] = [];
  private exited = false;
  private exitDetail = "unknown";

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly requestHandler?: CodexAppServerRequestHandler,
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
      const err = new Error(
        `codex app-server exited unexpectedly: ${this.exitDetail}`,
      );
      for (const [, pending] of this.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    });
  }

  async initialize(): Promise<any> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "cocalc_app_server",
        title: "CoCalc App Server Bridge",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    return result;
  }

  notify(method: string, params: any = {}): void {
    this.send({ method, params });
  }

  request(method: string, params: any = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) {
      throw new Error(`codex app-server already exited: ${this.exitDetail}`);
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

  private send(message: Record<string, any>): void {
    if (this.exited) {
      throw new Error(`codex app-server already exited: ${this.exitDetail}`);
    }
    this.proc.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private handleServerRequest(message: RpcServerRequest): void {
    void this.resolveServerRequest(message);
  }

  private async resolveServerRequest(message: RpcServerRequest): Promise<void> {
    try {
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
    normalized.includes("please try signing in again")
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

function getModelCapacityRetryLimit(): number {
  return Math.max(
    0,
    Number(process.env.COCALC_CODEX_MODEL_CAPACITY_MAX_RETRIES ?? 2),
  );
}

function getModelCapacityRetryDelayMs(): number {
  return Math.max(
    1_000,
    Number(process.env.COCALC_CODEX_MODEL_CAPACITY_RETRY_DELAY_MS ?? 60_000),
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
    normalized.includes(
      "compact_error=timeout waiting for child process to exit",
    ) ||
    normalized.includes("compact_remote: remote compaction failed") ||
    normalized.includes("remote compaction failed")
  );
}

function isRetryableModelCapacityText(text: string): boolean {
  const normalized = stripAnsi(`${text ?? ""}`).toLowerCase();
  return normalized.includes(
    "selected model is at capacity. please try a different model.",
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

function formatModelCapacityRetryExhaustedError(error: string): string {
  const normalized = `${error ?? ""}`.trim();
  const guidance =
    "The selected model stayed at capacity after automatic retries. Try again later, or switch to a different model if the turn is urgent.";
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

function getRetryPolicyForFailure(kind: RetryableAppServerFailureKind): {
  maxRetries: number;
  retryDelayMs: number;
  retryMessage: (attempt: number, maxRetries: number) => string;
  exhaustedMessage: (error: string) => string;
} {
  switch (kind) {
    case "model-capacity": {
      const retryDelayMs = getModelCapacityRetryDelayMs();
      return {
        maxRetries: getModelCapacityRetryLimit(),
        retryDelayMs,
        retryMessage: (attempt, maxRetries) =>
          `Selected model is at capacity. Retrying in ${formatRetryDelay(retryDelayMs * attempt)} (${attempt}/${maxRetries})...`,
        exhaustedMessage: formatModelCapacityRetryExhaustedError,
      };
    }
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
  if (targetPath === "/scratch" || targetPath.startsWith("/scratch/")) {
    const suffix = targetPath.slice("/scratch".length).replace(/^\/+/, "");
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
): "low" | "medium" | "high" | "xhigh" | undefined {
  switch (config?.reasoning) {
    case "low":
    case "medium":
    case "high":
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

function getSessionMetaSandboxPolicy(
  spawned: SpawnedCodexAppServer | undefined,
  config?: CodexSessionConfig,
):
  | { type: "read-only" }
  | {
      type: "workspace-write";
      network_access: true;
      exclude_tmpdir_env_var: false;
      exclude_slash_tmp: false;
    }
  | { type: "danger-full-access" } {
  const mode = resolveCodexSessionMode(config);
  if (spawned?.containerPathMap?.rootHostPath && mode !== "read-only") {
    return { type: "danger-full-access" };
  }
  if (mode === "read-only") {
    return { type: "read-only" };
  }
  if (mode === "full-access") {
    return { type: "danger-full-access" };
  }
  return {
    type: "workspace-write",
    network_access: true,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  };
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
  if (!hasProject || !hasBrowser) {
    return prompt;
  }
  return `${getCoCalcRuntimeGuidanceHeader(getCoCalcCliCommand(runtimeEnv))}\n\n${prompt}`;
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
    ...IMAGE_GENERATION_FEATURE_ARGS,
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
): Promise<void> {
  if (!login) return;
  switch (login.type) {
    case "apiKey":
      await client.request("account/login/start", {
        type: "apiKey",
        apiKey: login.apiKey,
      });
      return;
    case "chatgptAuthTokens":
      await client.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: login.accessToken,
        chatgptAccountId: login.chatgptAccountId,
        chatgptPlanType: login.chatgptPlanType ?? null,
      });
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

export class CodexAppServerAgent implements AcpAgent {
  static async create(
    opts: CodexAppServerOptions = {},
  ): Promise<CodexAppServerAgent> {
    return new CodexAppServerAgent(opts);
  }

  constructor(private readonly opts: CodexAppServerOptions = {}) {}

  private readonly sessions = new Map<string, SessionStoreEntry>();
  private readonly running = new Map<string, RunningTurn>();
  private readonly lastSessionTruncateAt = new Map<string, number>();
  private readonly truncatingSessions = new Set<string>();

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
        if (isRetryableAppServerError(err)) {
          const policy = getRetryPolicyForFailure(err.kind);
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
    const session = this.resolveSession(session_id, config);
    const runtimeEnv = Object.fromEntries(
      Object.entries({
        ...(this.opts.env ?? {}),
        ...(request.runtime_env ?? {}),
      }).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
    const cwd = this.resolveCwd(config);
    const spawned = await this.spawnAppServer({
      projectId: request.chat?.project_id ?? request.project_id,
      accountId: request.account_id,
      cwd,
      env: runtimeEnv,
    });
    const turnEnv = Object.fromEntries(
      Object.entries({
        ...runtimeEnv,
        ...(spawned.runtimeEnv ?? {}),
      }).filter(([, value]) => typeof value === "string" && !!`${value}`),
    ) as Record<string, string>;
    const client = new AppServerClient(
      spawned.proc,
      spawned.handleAppServerRequest,
    );
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
    const completedTerminals = new Set<string>();
    const emittedFileWrites = new Set<string>();
    const emittedFileWritePaths = new Set<string>();
    const emittedImages = new Set<string>();
    let latestTurnDiffText: string | undefined;
    const siteKeyGovernor = getCodexSiteKeyGovernor();
    const siteKeyEnforced =
      spawned.authSource === "site-api-key" &&
      !!siteKeyGovernor &&
      !!request.account_id &&
      !!(request.chat?.project_id ?? request.project_id);
    let quotaPollTimer: NodeJS.Timeout | undefined;
    let maxTurnTimer: NodeJS.Timeout | undefined;
    let quotaCheckInFlight = false;
    let quotaStopReason: string | undefined;
    const attemptStartedAt = Date.now();

    let resolveExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      let settled = false;
      resolveExited = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
    });
    spawned.proc.once("exit", () => resolveExited?.());
    spawned.proc.once("close", () => resolveExited?.());
    spawned.proc.once("error", () => resolveExited?.());

    const stop = async () => {
      if (spawned.proc.exitCode == null && !spawned.proc.killed) {
        spawned.proc.kill("SIGKILL");
      }
    };

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
          model: config?.model ?? this.opts.model,
          phase,
        });
        if (!verdict.allowed) {
          stopForQuota(
            verdict.reason ??
              "Stopped: you reached your CoCalc LLM usage limit for site-provided OpenAI access.",
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
          await stop();
          await exited;
        },
        interrupted: false,
        exited,
      };
      this.running.set(currentThreadId, runningEntry);

      await client.initialize();
      await loginAppServerIfNeeded(client, spawned.appServerLogin);
      await checkQuota("start");
      if (quotaStopReason) {
        throw new Error(formatAppServerError(errors));
      }
      await stream({ type: "status", state: "queued" });

      let threadResult: any;
      const requestedSessionKey =
        normalizeCodexSessionId(config?.sessionId) ??
        normalizeCodexSessionId(session_id);
      const resumeId = requestedSessionKey ? session.sessionId : undefined;
      const threadParams = {
        cwd,
        model: config?.model ?? this.opts.model,
        approvalPolicy: "never",
        sandbox: toSandboxMode(spawned, config),
      };
      if (resumeId) {
        await this.tryEnsureSessionConfig(spawned, resumeId, cwd, config);
        try {
          threadResult = await client.request("thread/resume", {
            threadId: resumeId,
            ...threadParams,
          });
        } catch (err) {
          logger.info(
            "codex app-server: resume failed; starting fresh thread",
            {
              threadId: resumeId,
              cwd,
              err: `${err}`,
            },
          );
          threadResult = await client.request("thread/start", threadParams);
        }
      } else {
        threadResult = await client.request("thread/start", threadParams);
      }

      const actualThreadId = threadResult?.thread?.id ?? resumeId;
      if (!actualThreadId) {
        throw new Error(`app-server did not return a thread id`);
      }
      setRunningKey(actualThreadId);
      const sessionEntry = { sessionId: actualThreadId, cwd };
      this.sessions.set(actualThreadId, sessionEntry);
      if (requestedSessionKey && requestedSessionKey !== actualThreadId) {
        this.sessions.set(requestedSessionKey, sessionEntry);
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
        sandboxPolicy: toTurnSandboxPolicy(spawned, config),
        model: config?.model ?? this.opts.model,
        effort: toReasoningEffort(config),
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

      const handleItem = async (item: any): Promise<void> => {
        if (!item || typeof item !== "object") return;
        switch (item.type) {
          case "agentMessage":
            if (typeof item.text === "string") {
              finalResponse = item.text;
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
            const delta = `${notification.params?.delta ?? ""}`;
            if (delta) {
              finalResponse += delta;
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
        while (true) {
          const notification = await client.waitForMessage((message) => {
            const params = message.params ?? {};
            if (message.method === "turn/completed") {
              return params?.turn?.id === turnId;
            }
            if (message.method === "turn/started") {
              return params?.turn?.id === turnId;
            }
            return params?.turnId === turnId;
          }, TURN_NOTIFICATION_IDLE_TIMEOUT_MS);
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
            model: config?.model ?? this.opts.model,
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
            model: config?.model ?? this.opts.model,
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
      void this.maybeTruncateSessionHistory({
        sessionId: actualThreadId,
        spawned,
        cwd,
      });
    } catch (err) {
      if (quotaPollTimer) {
        clearInterval(quotaPollTimer);
      }
      if (maxTurnTimer) {
        clearTimeout(maxTurnTimer);
      }
      if (runningEntry?.interrupted && !quotaStopReason) {
        logger.info("codex app-server evaluate interrupted", {
          threadId: currentThreadId,
          turnId,
          err: `${err}`,
        });
        return "interrupted";
      }
      const stderrTail = client.getStderrTail();
      const primaryError = (err as Error)?.message ?? `${err}`;
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
        args: argsJoin(spawned.args),
        authSource: spawned.authSource,
        err: `${err}`,
        normalizedErrors: normalizeErrorMessages(errors),
        lastErrorNotification,
        lastFailedTurnCompletion,
        persistedTurnInfo,
        stderrTail,
      });
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
      if (spawned.proc.exitCode == null && !spawned.proc.killed) {
        spawned.proc.kill("SIGKILL");
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

  private async ensureSessionConfig(
    spawned: SpawnedCodexAppServer,
    sessionId: string,
    cwd: string,
    config?: CodexSessionConfig,
  ): Promise<void> {
    const codexHome = getCodexHomeHostPath(spawned, cwd);
    const sessionsRoot = codexHome
      ? path.join(codexHome, "sessions")
      : getSessionsRoot();
    if (!sessionsRoot) return;
    const filePath = await findSessionFile(sessionId, sessionsRoot);
    if (!filePath) return;
    await rewriteSessionMeta(filePath, (payload) => ({
      ...payload,
      cwd,
      approval_policy: "never",
      sandbox_policy: getSessionMetaSandboxPolicy(spawned, config),
    }));
  }

  private async tryEnsureSessionConfig(
    spawned: SpawnedCodexAppServer,
    sessionId: string,
    cwd: string,
    config?: CodexSessionConfig,
  ): Promise<void> {
    try {
      await this.ensureSessionConfig(spawned, sessionId, cwd, config);
    } catch (err) {
      logger.warn("codex app-server: failed to update session metadata", {
        sessionId,
        cwd,
        err: `${err}`,
      });
    }
  }

  private async maybeTruncateSessionHistory({
    sessionId,
    spawned,
    cwd,
    force = false,
  }: {
    sessionId?: string;
    spawned: SpawnedCodexAppServer;
    cwd: string;
    force?: boolean;
  }): Promise<void> {
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (this.truncatingSessions.has(normalizedSessionId)) return;
    const now = Date.now();
    const last = this.lastSessionTruncateAt.get(normalizedSessionId) ?? 0;
    if (!force && now - last < SESSION_TRUNCATE_CHECK_INTERVAL_MS) {
      return;
    }
    const codexHome = getCodexHomeHostPath(spawned, cwd);
    if (!codexHome) return;
    this.truncatingSessions.add(normalizedSessionId);
    this.lastSessionTruncateAt.set(normalizedSessionId, now);
    try {
      const truncated = await truncateSessionHistoryById(normalizedSessionId, {
        sessionsRoot: path.join(codexHome, "sessions"),
        force,
      });
      if (truncated) {
        logger.debug("codex app-server: truncated session history", {
          sessionId: normalizedSessionId,
          cwd,
          codexHome,
        });
      }
    } catch (err) {
      logger.warn("codex app-server: failed to truncate session history", {
        sessionId: normalizedSessionId,
        cwd,
        codexHome,
        err: `${err}`,
      });
    } finally {
      this.truncatingSessions.delete(normalizedSessionId);
    }
  }

  private async spawnAppServer({
    projectId,
    accountId,
    cwd,
    env,
  }: {
    projectId: string;
    accountId?: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<SpawnedCodexAppServer> {
    const projectSpawner = getCodexProjectSpawner();
    if (projectSpawner && projectId && projectSpawner.spawnCodexAppServer) {
      const spawned = await projectSpawner.spawnCodexAppServer({
        projectId,
        accountId,
        cwd,
        env,
      });
      logger.debug("codex app-server: spawning via project container", {
        cmd: spawned.cmd,
        args: argsJoin(spawned.args),
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
