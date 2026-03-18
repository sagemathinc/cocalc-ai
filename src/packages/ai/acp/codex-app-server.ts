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
import type { CodexSessionConfig } from "@cocalc/util/ai/codex";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import type { AcpAgent, AcpEvaluateRequest, AcpStreamUsage } from "./types";
import {
  getCodexProjectSpawner,
  type CodexAppServerLoginHint,
  type CodexProjectContainerPathMap,
  type CodexAppServerRequestHandler,
} from "./codex-project";
import { getCodexSiteKeyGovernor } from "./codex-site-key-governor";

const logger = getLogger("ai:acp:codex-app-server");
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

const IMMEDIATE_SEND_GUIDANCE = [
  "[CoCalc immediate-send behavior]",
  "This user message was sent with 'Send Immediately' during an active run.",
  "Treat it as additional context for the same task.",
  "Do not stop or switch tasks unless the user explicitly asks to stop/cancel/switch.",
  "If the message is short acknowledgement only (e.g., 'thanks'), acknowledge briefly and continue the interrupted task.",
  "[/CoCalc immediate-send behavior]",
].join(" ");

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;

function getCoCalcRuntimeGuidanceHeader(cliCommand: string): string {
  return [
    "[CoCalc runtime capabilities]",
    "This turn may run with CoCalc CLI/browser automation context.",
    `If relevant, you can use \`${cliCommand}\` to inspect browser state and run browser exec scripts.`,
    "Prefer scoped variables already provided in environment, e.g.:",
    "- COCALC_PROJECT_ID",
    "- COCALC_BROWSER_ID",
    "- COCALC_API_URL",
    "- COCALC_BEARER_TOKEN",
    "Prefer high-signal commands over raw browser scripts when available.",
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
        `codex app-server exited unexpectedly: ${this.exitDetail}${this.stderrTail.length ? `\n${this.stderrTail.join("\n")}` : ""}`,
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
  if (normalized.length === 0) return "Codex app-server request failed.";
  if (normalized.length === 1) return normalized[0];
  return normalized.join("\n\n");
}

function mapContainerPathToHost(
  targetPath: string,
  containerPathMap?: CodexProjectContainerPathMap,
): string {
  if (!containerPathMap || !path.isAbsolute(targetPath)) {
    return targetPath;
  }
  if (targetPath === "/root" || targetPath.startsWith("/root/")) {
    const suffix = targetPath.slice("/root".length).replace(/^\/+/, "");
    if (!containerPathMap.rootHostPath) return targetPath;
    return suffix
      ? path.join(containerPathMap.rootHostPath, suffix)
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

async function readPersistedTurnUsage(opts: {
  spawned: SpawnedCodexAppServer;
  cwd: string;
  threadId: string;
  turnId: string;
}): Promise<AcpStreamUsage | undefined> {
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
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
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
        return toUsageFromTokenCount(payload.info);
      }
      if (
        payload.type === "task_started" &&
        `${payload.turn_id ?? ""}` === opts.turnId
      ) {
        break;
      }
    }
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
  config?: CodexSessionConfig,
): "read-only" | "workspace-write" | "danger-full-access" {
  const mode = resolveCodexSessionMode(config);
  switch (mode) {
    case "read-only":
      return "read-only";
    case "full-access":
      return "danger-full-access";
    default:
      return "workspace-write";
  }
}

function getCoCalcCliCommand(runtimeEnv?: Record<string, string>): string {
  const rawCli = `${runtimeEnv?.COCALC_CLI_BIN ?? ""}`.trim();
  return rawCli ? `"${rawCli}"` : "cocalc";
}

function decoratePrompt(
  prompt: string,
  opts?: {
    sendMode?: "immediate";
    runtimeEnv?: Record<string, string>;
  },
): string {
  if (/^\s*\/\w+/.test(prompt)) {
    return prompt;
  }
  const withRuntime = addRuntimeGuidance(prompt, opts?.runtimeEnv);
  if (opts?.sendMode === "immediate") {
    return `${IMMEDIATE_SEND_GUIDANCE}\n\n${withRuntime}`;
  }
  return withRuntime;
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

async function spawnStandaloneAppServer(
  opts: CodexAppServerOptions,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnedCodexAppServer> {
  const cmd = opts.binaryPath ?? "codex";
  const args = ["app-server", "--listen", "stdio://"];
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

  async evaluate(request: AcpEvaluateRequest): Promise<void> {
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
    const client = new AppServerClient(
      spawned.proc,
      spawned.handleAppServerRequest,
    );
    const errors: string[] = [];
    let finalResponse = "";
    let latestUsage: AcpStreamUsage | undefined;
    let currentThreadId = session.sessionId;
    let runningEntry: RunningTurn | undefined;
    let turnId: string | undefined;
    const terminalOutputs = new Map<string, string>();
    const startedTerminalIds = new Set<string>();
    const emittedFileWrites = new Set<string>();
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
        },
        interrupted: false,
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
      const resumeId = `${config?.sessionId ?? session_id ?? ""}`.trim();
      const threadParams = {
        cwd,
        model: config?.model ?? this.opts.model,
        approvalPolicy: "never",
        sandbox: toSandboxMode(config),
      };
      if (resumeId) {
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
      this.sessions.set(actualThreadId, { sessionId: actualThreadId, cwd });

      await stream({
        type: "status",
        state: "init",
        threadId: actualThreadId,
      });

      const turnStart = await client.request("turn/start", {
        threadId: actualThreadId,
        cwd,
        model: config?.model ?? this.opts.model,
        effort: toReasoningEffort(config),
        input: [
          {
            type: "text",
            text: decoratePrompt(prompt, {
              sendMode: request.chat?.send_mode,
              runtimeEnv,
            }),
            textElements: [],
          },
        ],
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
        if (startedTerminalIds.has(terminalId)) return;
        startedTerminalIds.add(terminalId);
        await stream({
          type: "event",
          event: {
            type: "terminal",
            terminalId,
            phase: "start",
            command,
            cwd: terminalCwd ?? cwd,
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
            if (item.command && !terminalOutputs.has(terminalId)) {
              terminalOutputs.set(terminalId, "");
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
            if (item.status === "completed" && Array.isArray(item.changes)) {
              for (const change of item.changes) {
                if (!change?.path) continue;
                const eventKey = `${item.id ?? "file"}:${change.path}`;
                if (emittedFileWrites.has(eventKey)) continue;
                emittedFileWrites.add(eventKey);
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
          default:
            break;
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
      if (quotaPollTimer) {
        clearInterval(quotaPollTimer);
      }
      if (maxTurnTimer) {
        clearTimeout(maxTurnTimer);
      }
      if (!latestUsage) {
        latestUsage = await readPersistedTurnUsage({
          spawned,
          cwd,
          threadId: actualThreadId,
          turnId,
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
        return;
      }
      const stderrTail = client.getStderrTail();
      const error = [
        (err as Error)?.message ?? `${err}`,
        ...stderrTail.filter((line) => !errors.includes(line)),
      ]
        .filter(Boolean)
        .join("\n");
      logger.warn("codex app-server evaluate failed", {
        threadId: currentThreadId,
        cwd,
        cmd: spawned.cmd,
        args: argsJoin(spawned.args),
        authSource: spawned.authSource,
        err: `${err}`,
        stderrTail,
      });
      await stream({ type: "error", error });
      return;
    } finally {
      this.running.delete(currentThreadId);
      if (spawned.proc.exitCode == null && !spawned.proc.killed) {
        spawned.proc.kill("SIGKILL");
      }
    }
  }

  async interrupt(threadId: string): Promise<boolean> {
    const running = this.running.get(threadId);
    if (!running) return false;
    running.interrupted = true;
    await running.stop();
    return true;
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
    const key = `${config?.sessionId ?? sessionId ?? ""}`.trim();
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
