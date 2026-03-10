import path from "node:path";
import { URL } from "node:url";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import getLogger from "@cocalc/backend/logger";
import { data } from "@cocalc/backend/data";
import {
  CodexExecAgent,
  EchoAgent,
  type AcpAgent,
  type AcpEvaluateRequest,
  forkSession,
  getSessionsRoot,
} from "@cocalc/ai/acp";
import { AgentTimeTravelRecorder } from "@cocalc/ai/sync";
import { init as initConatAcp } from "@cocalc/conat/ai/acp/server";
import type {
  AcpControlRequest,
  AcpControlResponse,
  AcpRequest,
  AcpStreamPayload,
  AcpStreamMessage,
  AcpStreamEvent,
  AcpChatContext,
  AcpLoopConfig,
  AcpLoopContractDecision,
  AcpLoopState,
  AcpLoopStopReason,
  AcpForkSessionRequest,
  AcpInterruptRequest,
} from "@cocalc/conat/ai/acp/types";
import { resolveCodexSessionMode } from "@cocalc/util/ai/codex";
import { isValidUUID } from "@cocalc/util/misc";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  FileAdapter,
  TerminalAdapter,
  TerminalStartOptions,
} from "@cocalc/ai/acp/adapters";
import { type AcpExecutor, ContainerExecutor, LocalExecutor } from "./executor";
import {
  preferContainerExecutor,
  resolveWorkspaceRoot,
} from "./workspace-root";
import { getBlobstore } from "../blobs/download";
import {
  buildChatMessage,
  buildThreadConfigRecord,
  buildThreadStateRecord,
  computeChatIntegrityReport,
  deriveAcpLogRefs,
  threadConfigRecordKey,
  type MessageHistory,
} from "@cocalc/chat";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  appendStreamMessage,
  extractEventText,
  getLatestMessageText,
  getLatestSummaryText,
} from "@cocalc/chat";
import {
  resolveInlineCodeLinks,
  type InlineCodeLink,
} from "./inline-code-links";
import type { SyncDB } from "@cocalc/conat/sync-doc/syncdb";
import type { AcpStreamUsage } from "@cocalc/ai/acp";
import { once } from "@cocalc/util/async-utils";
import {
  enqueueAcpPayload,
  listAcpPayloads,
  clearAcpPayloads,
} from "../sqlite/acp-queue";
import { initDatabase } from "../sqlite/database";
import {
  finalizeAcpTurnLease,
  heartbeatAcpTurnLease,
  listRunningAcpTurnLeases,
  startAcpTurnLease,
  updateAcpTurnLeaseSessionId,
} from "../sqlite/acp-turns";
import {
  cancelQueuedAcpJob,
  claimNextQueuedAcpJobForThread,
  decodeAcpJobRequest,
  enqueueAcpJob,
  listQueuedAcpJobs,
  listQueuedAcpJobsForThread,
  listRunningAcpJobs,
  markRunningAcpJobsInterrupted,
  reprioritizeAcpJobImmediate,
  setAcpJobState,
  type AcpJobRow,
} from "../sqlite/acp-jobs";
import {
  decodeAcpInterruptCandidateIds,
  decodeAcpInterruptChat,
  enqueueAcpInterrupt,
  listPendingAcpInterrupts,
  markAcpInterruptError,
  markAcpInterruptHandled,
} from "../sqlite/acp-interrupts";
import { throttle } from "lodash";
import { akv, type AKV } from "@cocalc/conat/sync/akv";
import { rotateChatStore } from "@cocalc/backend/chat-store/sqlite-offload";
import {
  ensureAcpWorkerRunning,
  startAcpWorkerSupervisor,
} from "./worker-manager";

// How often to persist in-flight ACP metadata (thread state/usage/flags).
// Message body content is persisted at terminal commits only.
const COMMIT_INTERVAL = 2_000;
const LEASE_HEARTBEAT_INTERVAL = 2_000;
const TERMINAL_CHAT_VERIFY_DELAYS_MS = [0, 100, 250, 500, 1_000] as const;
const MESSAGE_ID_LOOKUP_WARN_ROWS = 2_000;
const MESSAGE_ID_LOOKUP_WARN_EVERY = 100;
const ENABLE_MESSAGE_ID_LINEAR_SCAN_FALLBACK = false;
const CHAT_OFFLOAD_AUTOROTATE_ENABLED =
  `${process.env.COCALC_CHAT_OFFLOAD_AUTOROTATE ?? "1"}`.trim() !== "0";
const CHAT_OFFLOAD_AUTOROTATE_COOLDOWN_MS = 60_000;
const CHAT_OFFLOAD_AUTOROTATE_KEEP_MESSAGES = 500;
const CHAT_OFFLOAD_AUTOROTATE_MAX_BYTES = 2 * 1024 * 1024;
const CHAT_OFFLOAD_AUTOROTATE_MAX_MESSAGES = 500;

const logger = getLogger("lite:hub:acp");
const ACP_INSTANCE_ID = randomUUID();

let blobStore: AKV | null = null;
const agents = new Map<string, AcpAgent>();
let conatClient: ConatClient | null = null;
let cachedMockScriptPromise: Promise<AcpMockScript> | null = null;
const pumpingAcpJobThreads = new Set<string>();
let ensureDetachedWorkerRunning = ensureAcpWorkerRunning;
let acpExecutionOwnedByCurrentProcess = false;
let acpInterruptPollerStarted = false;
let acpInterruptPollInFlight = false;

const INTERRUPT_STATUS_TEXT = "Conversation interrupted.";
const RESTART_INTERRUPTED_NOTICE =
  "**Conversation interrupted because the backend server restarted.**";
const THREAD_CONFIG_EVENT = "chat-thread-config";
const THREAD_STATE_EVENT = "chat-thread-state";
const THREAD_STATE_SCHEMA_VERSION = 2;
const LOOP_DEFAULT_MAX_TURNS = 8;
const LOOP_DEFAULT_MAX_WALL_TIME_MS = 30 * 60_000;
const LOOP_DEFAULT_CHECK_IN_EVERY_TURNS = 0;
const LOOP_DEFAULT_REPEATED_BLOCKER_LIMIT = 2;
const LOOP_DEFAULT_SLEEP_MS = 0;
const ACP_QUEUED_PROMPT_NOTE_THRESHOLD_MS = 1500;
const ACP_CHAT_INTEGRITY_RECOMPUTE_MIN_MS = envNumber(
  "COCALC_ACP_CHAT_INTEGRITY_RECOMPUTE_MIN_MS",
  60_000,
);
const ACP_CHAT_INTEGRITY_SLOW_MS = envNumber(
  "COCALC_ACP_CHAT_INTEGRITY_SLOW_MS",
  75,
);
const ACP_WATCHDOG_SNAPSHOT_SLOW_MS = envNumber(
  "COCALC_ACP_WATCHDOG_SNAPSHOT_SLOW_MS",
  50,
);
const ACP_COMMIT_SLOW_MS = envNumber("COCALC_ACP_COMMIT_SLOW_MS", 50);
const ACP_SYNCDB_SAVE_SLOW_MS = envNumber(
  "COCALC_ACP_SYNCDB_SAVE_SLOW_MS",
  100,
);
const ACP_LOG_PERSIST_SLOW_MS = envNumber(
  "COCALC_ACP_LOG_PERSIST_SLOW_MS",
  150,
);
const ACP_BLOB_MATERIALIZE_SLOW_MS = envNumber(
  "COCALC_ACP_BLOB_MATERIALIZE_SLOW_MS",
  250,
);
const ACP_WORKER_POLL_MS = envNumber("COCALC_ACP_WORKER_POLL_MS", 1000);
const ACP_WORKER_IDLE_EXIT_MS = envNumber(
  "COCALC_ACP_WORKER_IDLE_EXIT_MS",
  5000,
);
const ACP_INTERRUPT_POLL_MS = envNumber("COCALC_ACP_INTERRUPT_POLL_MS", 250);
const ACP_INTERRUPT_MAX_AGE_MS = envNumber(
  "COCALC_ACP_INTERRUPT_MAX_AGE_MS",
  30_000,
);

function liteUseDetachedAcpWorker(): boolean {
  const value = `${process.env.COCALC_LITE_ACP_DETACHED_WORKER ?? ""}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function envNumber(name: string, fallback: number): number {
  const value = `${process.env[name] ?? ""}`.trim();
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatQueuedDelay(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return remain > 0 ? `${minutes}m ${remain}s` : `${minutes}m`;
}

type AcpMockRule = {
  name?: string;
  match?: string;
  flags?: string;
  includes?: string;
  response?: string;
  thinking?: string;
  message?: string;
  delayMs?: number;
  usage?: AcpStreamUsage;
  threadId?: string;
};

type AcpMockScript = {
  defaultResponse: string;
  defaultThinking?: string;
  defaultMessage?: string;
  defaultDelayMs: number;
  rules: AcpMockRule[];
};

type ChatIntegrityCounters = ReturnType<
  typeof computeChatIntegrityReport
>["counters"];

type ChatIntegritySnapshot = {
  counters?: ChatIntegrityCounters;
  computedAtMs: number;
  durationMs: number;
  rowCount: number;
  dirty: boolean;
  dirtySinceMs: number;
  recomputeCount: number;
  lastReason?: string;
  lastError?: string;
};

const DEFAULT_ACP_MOCK_SCRIPT: AcpMockScript = {
  defaultResponse: "ACP Mock: deterministic response.",
  defaultThinking: "Mock agent analyzing request...",
  defaultMessage: "Mock agent composing answer...",
  defaultDelayMs: 50,
  rules: [],
};

const chatWritersByChatKey = new Map<string, ChatStreamWriter>();
const chatWritersByThreadId = new Map<string, ChatStreamWriter>();
let acpFinalizeMismatchCount = 0;
let acpFinalizeRecoveredAfterRetryCount = 0;
let acpLookupByMessageIdScans = 0;
let acpLookupByMessageIdHits = 0;
let acpLookupByMessageIdMisses = 0;
let acpLookupByMessageIdRowsScanned = 0;
let acpLookupByMessageIdRowsScannedMax = 0;
let acpLookupByMessageIdLargeScanWarnings = 0;
let acpLookupByMessageIdIndexHits = 0;
let acpLookupByMessageIdIndexMisses = 0;
const chatOffloadRotateAt = new Map<string, number>();

function syncdbRowsMatching(
  syncdb: SyncDB,
  where: Record<string, unknown>,
): Record<string, unknown>[] {
  const source =
    typeof (syncdb as any)?.get === "function"
      ? ((syncdb as any).get(where) ?? (syncdb as any).get())
      : [];
  const rows = Array.isArray(source)
    ? source
    : typeof source?.toJS === "function"
      ? source.toJS()
      : [];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) =>
    Object.entries(where).every(
      ([key, value]) => (row as any)?.[key] === value,
    ),
  ) as Record<string, unknown>[];
}

function threadConfigRowRank(
  row: Record<string, unknown>,
  threadId: string,
): number {
  const canonical = threadConfigRecordKey(threadId);
  const isCanonical =
    syncdbField<string>(row, "sender_id") === canonical.sender_id &&
    syncdbField<string>(row, "date") === canonical.date;
  const updatedAt = Date.parse(
    `${syncdbField<string>(row, "updated_at") ?? ""}`,
  );
  const rowDate = Date.parse(`${syncdbField<string>(row, "date") ?? ""}`);
  return (
    (isCanonical ? 1_000_000_000_000_000 : 0) +
    (Number.isFinite(updatedAt) ? updatedAt : 0) +
    (Number.isFinite(rowDate) ? rowDate : 0)
  );
}

function preferredThreadConfigRow(
  syncdb: SyncDB,
  threadId: string,
): Record<string, unknown> | undefined {
  const rows = syncdbRowsMatching(syncdb, {
    event: THREAD_CONFIG_EVENT,
    thread_id: threadId,
  });
  if (rows.length === 0) {
    const single = (syncdb as any)?.get_one?.({
      event: THREAD_CONFIG_EVENT,
      thread_id: threadId,
    });
    if (single != null) {
      return typeof single?.toJS === "function" ? single.toJS() : single;
    }
    return undefined;
  }
  let best: Record<string, unknown> | undefined;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rank = threadConfigRowRank(row, threadId);
    if (best == null || rank > bestRank) {
      best = row;
      bestRank = rank;
    }
  }
  return best;
}

function replaceThreadScopedRow(
  syncdb: SyncDB,
  event: "chat-thread-config" | "chat-thread-state",
  threadId: string,
  row: any,
): void {
  (syncdb as any)?.delete?.({
    event,
    thread_id: threadId,
  });
  syncdb.set(row);
}

function clampLoopNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeLoopConfig(
  config?: AcpLoopConfig,
): AcpLoopConfig | undefined {
  if (!config || config.enabled !== true) return undefined;
  return {
    enabled: true,
    max_turns: clampLoopNumber(
      config.max_turns,
      LOOP_DEFAULT_MAX_TURNS,
      1,
      200,
    ),
    max_wall_time_ms: clampLoopNumber(
      config.max_wall_time_ms,
      LOOP_DEFAULT_MAX_WALL_TIME_MS,
      1_000,
      7 * 24 * 60 * 60_000,
    ),
    check_in_every_turns: clampLoopNumber(
      config.check_in_every_turns,
      LOOP_DEFAULT_CHECK_IN_EVERY_TURNS,
      0,
      200,
    ),
    stop_on_repeated_blocker_count: clampLoopNumber(
      config.stop_on_repeated_blocker_count,
      LOOP_DEFAULT_REPEATED_BLOCKER_LIMIT,
      1,
      50,
    ),
    sleep_ms_between_turns: clampLoopNumber(
      config.sleep_ms_between_turns,
      LOOP_DEFAULT_SLEEP_MS,
      0,
      60_000,
    ),
  };
}

function normalizeLoopDecision(
  raw: unknown,
): AcpLoopContractDecision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as any;
  if (
    typeof data.rerun !== "boolean" ||
    typeof data.needs_human !== "boolean"
  ) {
    return undefined;
  }
  return {
    rerun: data.rerun,
    needs_human: data.needs_human,
    next_prompt:
      typeof data.next_prompt === "string" ? data.next_prompt : undefined,
    blocker: typeof data.blocker === "string" ? data.blocker : undefined,
    confidence:
      typeof data.confidence === "number" && Number.isFinite(data.confidence)
        ? data.confidence
        : undefined,
    sleep_sec:
      typeof data.sleep_sec === "number" && Number.isFinite(data.sleep_sec)
        ? data.sleep_sec
        : undefined,
  };
}

function parseLoopDecisionPayload(
  input: string,
): AcpLoopContractDecision | undefined {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && "loop" in (parsed as any)) {
      return normalizeLoopDecision((parsed as any).loop);
    }
    return normalizeLoopDecision(parsed);
  } catch {
    return undefined;
  }
}

function parseLoopContractDecision(
  summaryText?: string,
): AcpLoopContractDecision | undefined {
  if (!summaryText || typeof summaryText !== "string") return undefined;
  const whole = parseLoopDecisionPayload(summaryText.trim());
  if (whole) return whole;

  const fenced = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenced.exec(summaryText)) != null) {
    const decision = parseLoopDecisionPayload(match[1].trim());
    if (decision) return decision;
  }

  const lines = summaryText.split("\n").map((x) => x.trim());
  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    const decision = parseLoopDecisionPayload(line);
    if (decision) return decision;
  }
  return undefined;
}

function stripLoopContractForDisplay(
  text: string,
  loopEnabled: boolean,
): string {
  if (!loopEnabled) return text;
  let out = text;

  // Remove fenced json loop-contract blocks anywhere in the text.
  const fenced = /```json\s*([\s\S]*?)\s*```/gi;
  out = out.replace(fenced, (match, payload) => {
    const decision = parseLoopDecisionPayload(`${payload ?? ""}`.trim());
    return decision ? "" : match;
  });

  // Remove unfenced JSON loop-contract blocks (single-line or multi-line).
  const lines = out.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].trim();
    if (!first.startsWith("{")) {
      kept.push(lines[i]);
      continue;
    }
    let removed = false;
    const maxJ = Math.min(lines.length - 1, i + 40);
    for (let j = i; j <= maxJ; j++) {
      const last = lines[j].trim();
      if (!last.endsWith("}")) continue;
      const candidate = lines
        .slice(i, j + 1)
        .join("\n")
        .trim();
      const decision = parseLoopDecisionPayload(candidate);
      if (!decision) continue;
      i = j;
      removed = true;
      break;
    }
    if (!removed) {
      kept.push(lines[i]);
    }
  }

  out = kept.join("\n");
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  return out;
}

async function maybeAutoRotateChatStore({
  chatPath,
  chatKey,
  projectId,
  chatPathKey,
}: {
  chatPath?: string;
  chatKey: string;
  projectId: string;
  chatPathKey: string;
}): Promise<void> {
  if (!CHAT_OFFLOAD_AUTOROTATE_ENABLED) return;
  if (!chatPath || !path.isAbsolute(chatPath)) return;
  // Idleness is determined by live ACP leases, not stale historical
  // generating flags embedded in old chat rows.
  const runningSameChat = listRunningAcpTurnLeases().filter(
    (x) =>
      x.project_id === projectId &&
      x.path === chatPathKey &&
      x.state === "running",
  ).length;
  if (runningSameChat > 0) {
    logger.debug("chat offload autorotate skipped", {
      chatKey,
      chatPath,
      reason: `chat has ${runningSameChat} running ACP leases`,
    });
    return;
  }
  const now = Date.now();
  const last = chatOffloadRotateAt.get(chatPath) ?? 0;
  if (now - last < CHAT_OFFLOAD_AUTOROTATE_COOLDOWN_MS) return;
  chatOffloadRotateAt.set(chatPath, now);
  try {
    const result = await rotateChatStore({
      chat_path: chatPath,
      keep_recent_messages: CHAT_OFFLOAD_AUTOROTATE_KEEP_MESSAGES,
      max_head_bytes: CHAT_OFFLOAD_AUTOROTATE_MAX_BYTES,
      max_head_messages: CHAT_OFFLOAD_AUTOROTATE_MAX_MESSAGES,
      // We already gate idleness using live ACP leases above; this avoids
      // stale legacy generating=true rows blocking rotation forever.
      require_idle: false,
      force: false,
    });
    if (result.rotated) {
      logger.info("chat offload autorotate completed", {
        chatKey,
        chatPath,
        segment_id: result.segment_id,
        archived_rows: result.archived_rows,
        head_bytes_before: result.head_bytes_before,
        head_bytes_after: result.head_bytes_after,
        rewrite_warning: result.rewrite_warning,
      });
    } else if (result.reason && result.reason !== "thresholds not exceeded") {
      logger.debug("chat offload autorotate skipped", {
        chatKey,
        chatPath,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger.warn("chat offload autorotate failed", {
      chatKey,
      chatPath,
      err: `${err}`,
    });
  }
}

function safeJsonParse(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseDelayMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(60_000, Math.round(n)));
}

function normalizeMockScript(raw: any): AcpMockScript {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rulesRaw = Array.isArray(base.rules) ? base.rules : [];
  const rules: AcpMockRule[] = [];
  for (const item of rulesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rule: AcpMockRule = {
      name:
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : undefined,
      match:
        typeof item.match === "string" && item.match.trim().length > 0
          ? item.match.trim()
          : undefined,
      flags:
        typeof item.flags === "string" && item.flags.trim().length > 0
          ? item.flags.trim()
          : undefined,
      includes:
        typeof item.includes === "string" && item.includes.trim().length > 0
          ? item.includes.trim()
          : undefined,
      response:
        typeof item.response === "string" && item.response.length > 0
          ? item.response
          : undefined,
      thinking:
        typeof item.thinking === "string" && item.thinking.length > 0
          ? item.thinking
          : undefined,
      message:
        typeof item.message === "string" && item.message.length > 0
          ? item.message
          : undefined,
      delayMs: parseDelayMs(
        item.delayMs,
        DEFAULT_ACP_MOCK_SCRIPT.defaultDelayMs,
      ),
      threadId:
        typeof item.threadId === "string" && item.threadId.trim().length > 0
          ? item.threadId.trim()
          : undefined,
      usage:
        item.usage &&
        typeof item.usage === "object" &&
        !Array.isArray(item.usage)
          ? (item.usage as AcpStreamUsage)
          : undefined,
    };
    rules.push(rule);
  }
  return {
    defaultResponse:
      typeof base.defaultResponse === "string" &&
      base.defaultResponse.length > 0
        ? base.defaultResponse
        : DEFAULT_ACP_MOCK_SCRIPT.defaultResponse,
    defaultThinking:
      typeof base.defaultThinking === "string" &&
      base.defaultThinking.length > 0
        ? base.defaultThinking
        : DEFAULT_ACP_MOCK_SCRIPT.defaultThinking,
    defaultMessage:
      typeof base.defaultMessage === "string" && base.defaultMessage.length > 0
        ? base.defaultMessage
        : DEFAULT_ACP_MOCK_SCRIPT.defaultMessage,
    defaultDelayMs: parseDelayMs(
      base.defaultDelayMs,
      DEFAULT_ACP_MOCK_SCRIPT.defaultDelayMs,
    ),
    rules,
  };
}

async function loadAcpMockScript(): Promise<AcpMockScript> {
  if (cachedMockScriptPromise) return await cachedMockScriptPromise;
  cachedMockScriptPromise = (async () => {
    const inlineRaw = `${process.env.COCALC_ACP_MOCK_SCRIPT ?? ""}`.trim();
    if (inlineRaw) {
      const parsed = safeJsonParse(inlineRaw);
      if (parsed) {
        logger.info("acp mock mode: using inline script");
        return normalizeMockScript(parsed);
      }
      logger.warn("acp mock mode: invalid inline script JSON; using defaults");
      return DEFAULT_ACP_MOCK_SCRIPT;
    }
    const file = `${process.env.COCALC_ACP_MOCK_FILE ?? ""}`.trim();
    if (!file) {
      logger.info("acp mock mode: using default script");
      return DEFAULT_ACP_MOCK_SCRIPT;
    }
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = safeJsonParse(raw);
      if (parsed) {
        logger.info("acp mock mode: loaded script from file", { file });
        return normalizeMockScript(parsed);
      }
      logger.warn(
        "acp mock mode: invalid JSON in script file; using defaults",
        {
          file,
        },
      );
      return DEFAULT_ACP_MOCK_SCRIPT;
    } catch (err) {
      logger.warn("acp mock mode: failed reading script file; using defaults", {
        file,
        err: `${err}`,
      });
      return DEFAULT_ACP_MOCK_SCRIPT;
    }
  })();
  return await cachedMockScriptPromise;
}

function renderMockTemplate(template: string, prompt: string): string {
  return template
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{prompt_json}}", JSON.stringify(prompt));
}

function ruleMatchesPrompt(rule: AcpMockRule, prompt: string): boolean {
  if (rule.match) {
    try {
      const re = new RegExp(rule.match, rule.flags ?? "i");
      return re.test(prompt);
    } catch {
      return false;
    }
  }
  if (rule.includes) {
    return prompt.toLowerCase().includes(rule.includes.toLowerCase());
  }
  return false;
}

function chooseMockRule(
  script: AcpMockScript,
  prompt: string,
): AcpMockRule | undefined {
  for (const rule of script.rules) {
    if (ruleMatchesPrompt(rule, prompt)) return rule;
  }
  return;
}

class MockAgent implements AcpAgent {
  constructor(private readonly script: AcpMockScript) {}

  async evaluate({
    prompt,
    session_id,
    stream,
  }: AcpEvaluateRequest): Promise<void> {
    const rule = chooseMockRule(this.script, prompt);
    const thinking = rule?.thinking ?? this.script.defaultThinking;
    const message = rule?.message ?? this.script.defaultMessage;
    const responseTemplate = rule?.response ?? this.script.defaultResponse;
    const response = renderMockTemplate(responseTemplate, prompt);
    const delayMs = parseDelayMs(rule?.delayMs, this.script.defaultDelayMs);
    if (thinking) {
      await stream({
        type: "event",
        event: { type: "thinking", text: thinking },
      });
    }
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    if (message) {
      await stream({
        type: "event",
        event: { type: "message", text: message },
      });
    }
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    await stream({
      type: "summary",
      finalResponse: response,
      usage: rule?.usage ?? {
        input_tokens: prompt.length,
        output_tokens: response.length,
      },
      threadId: rule?.threadId ?? session_id ?? randomUUID(),
    });
  }
}

export function getAcpWatchdogStats({ topN = 5 }: { topN?: number } = {}) {
  const top = Math.max(1, topN);
  const snapshots = Array.from(chatWritersByChatKey.values()).map((writer) =>
    writer.watchdogSnapshot(),
  );
  const activeWriters = snapshots.filter((x) => !x.closed).length;
  const finishedWriters = snapshots.filter((x) => x.finished).length;
  const disposeScheduled = snapshots.filter((x) => x.disposeScheduled).length;
  const syncdbErrors = snapshots.filter((x) => x.hasSyncdbError).length;
  const totalBufferedEvents = snapshots.reduce((sum, x) => sum + x.events, 0);
  const timeTravelSnapshots = snapshots
    .map((x) => x.timeTravel)
    .filter(
      (x): x is NonNullable<(typeof snapshots)[number]["timeTravel"]> =>
        x != null,
    );
  const timeTravelActiveRecorders = timeTravelSnapshots.filter(
    (x) => !x.disposed,
  ).length;
  const timeTravelDisposePending = timeTravelSnapshots.filter(
    (x) => x.disposePending,
  ).length;
  const timeTravelPendingOps = timeTravelSnapshots.reduce(
    (sum, x) => sum + x.pendingOps,
    0,
  );
  const timeTravelSyncDocs = timeTravelSnapshots.reduce(
    (sum, x) => sum + x.syncDocs,
    0,
  );
  const timeTravelInflightLoads = timeTravelSnapshots.reduce(
    (sum, x) => sum + x.inflightLoads,
    0,
  );
  const watchdogSnapshotDurationMsTotal = snapshots.reduce(
    (sum, x) => sum + (x.watchdog?.durationMs ?? 0),
    0,
  );
  const watchdogSnapshotDurationMsMax = snapshots.reduce(
    (max, x) => Math.max(max, x.watchdog?.durationMs ?? 0),
    0,
  );
  const integrityDirtyWriters = snapshots.filter(
    (x) => x.watchdog?.integrityDirty,
  ).length;
  const integrityRecomputedWriters = snapshots.filter(
    (x) => x.watchdog?.integrityRecomputed,
  ).length;
  const integrityDurationMsMax = snapshots.reduce(
    (max, x) => Math.max(max, x.watchdog?.integrityDurationMs ?? 0),
    0,
  );
  const integrityAgeMsMax = snapshots.reduce(
    (max, x) => Math.max(max, x.watchdog?.integrityAgeMs ?? 0),
    0,
  );
  const integrityTotals = snapshots.reduce(
    (acc, snapshot) => {
      const counters = snapshot.integrity;
      if (!counters) return acc;
      acc.orphan_messages += counters.orphan_messages ?? 0;
      acc.duplicate_root_messages += counters.duplicate_root_messages ?? 0;
      acc.missing_thread_config += counters.missing_thread_config ?? 0;
      acc.invalid_reply_targets += counters.invalid_reply_targets ?? 0;
      acc.missing_identity_fields += counters.missing_identity_fields ?? 0;
      return acc;
    },
    {
      orphan_messages: 0,
      duplicate_root_messages: 0,
      missing_thread_config: 0,
      invalid_reply_targets: 0,
      missing_identity_fields: 0,
    },
  );
  const integrityChatsWithViolations = snapshots.filter((snapshot) => {
    const counters = snapshot.integrity;
    if (!counters) return false;
    return (
      (counters.orphan_messages ?? 0) > 0 ||
      (counters.duplicate_root_messages ?? 0) > 0 ||
      (counters.missing_thread_config ?? 0) > 0 ||
      (counters.invalid_reply_targets ?? 0) > 0 ||
      (counters.missing_identity_fields ?? 0) > 0
    );
  }).length;
  const topWritersByEvents = [...snapshots]
    .sort((a, b) => b.events - a.events)
    .slice(0, top)
    .map((x) => ({
      chatKey: x.chatKey,
      path: x.path,
      messageDate: x.messageDate,
      events: x.events,
      finished: x.finished,
      disposeScheduled: x.disposeScheduled,
      threadIds: x.threadIds,
      integrity: x.integrity,
      watchdog: x.watchdog,
      timeTravel: x.timeTravel,
    }));
  return {
    writersByChatKey: chatWritersByChatKey.size,
    writersByThreadId: chatWritersByThreadId.size,
    activeWriters,
    finishedWriters,
    disposeScheduled,
    syncdbErrors,
    totalBufferedEvents,
    timeTravelActiveRecorders,
    timeTravelDisposePending,
    timeTravelPendingOps,
    timeTravelSyncDocs,
    timeTravelInflightLoads,
    watchdogSnapshotDurationMsTotal,
    watchdogSnapshotDurationMsMax,
    integrityDirtyWriters,
    integrityRecomputedWriters,
    integrityDurationMsMax,
    integrityAgeMsMax,
    integrityChatsWithViolations,
    integrityTotals: {
      "chat.integrity.orphan_messages": integrityTotals.orphan_messages,
      "chat.integrity.duplicate_root_messages":
        integrityTotals.duplicate_root_messages,
      "chat.integrity.missing_thread_config":
        integrityTotals.missing_thread_config,
      "chat.integrity.invalid_reply_targets":
        integrityTotals.invalid_reply_targets,
      "chat.integrity.missing_identity_fields":
        integrityTotals.missing_identity_fields,
      "chat.acp.finalize_mismatch": acpFinalizeMismatchCount,
      "chat.acp.finalize_recovered_after_retry":
        acpFinalizeRecoveredAfterRetryCount,
      "chat.acp.lookup_message_id_scans": acpLookupByMessageIdScans,
      "chat.acp.lookup_message_id_hits": acpLookupByMessageIdHits,
      "chat.acp.lookup_message_id_misses": acpLookupByMessageIdMisses,
      "chat.acp.lookup_message_id_index_hits": acpLookupByMessageIdIndexHits,
      "chat.acp.lookup_message_id_index_misses":
        acpLookupByMessageIdIndexMisses,
      "chat.acp.lookup_message_id_rows_scanned":
        acpLookupByMessageIdRowsScanned,
      "chat.acp.lookup_message_id_rows_scanned_max":
        acpLookupByMessageIdRowsScannedMax,
      "chat.acp.lookup_message_id_large_scan_warnings":
        acpLookupByMessageIdLargeScanWarnings,
    },
    topWritersByEvents,
  };
}

function logWriterCounts(
  reason: string,
  extra?: Record<string, unknown>,
): void {
  logger.debug("chat writers map size", {
    reason,
    byChatKey: chatWritersByChatKey.size,
    byThreadId: chatWritersByThreadId.size,
    ...extra,
  });
}

function chatKey(metadata: AcpChatContext): string {
  return `${metadata.project_id}:${metadata.path}:${metadata.message_date}`;
}

function findChatWriter({
  threadId,
  chat,
}: {
  threadId?: string;
  chat?: AcpChatContext;
}): ChatStreamWriter | undefined {
  if (threadId) {
    const writer = chatWritersByThreadId.get(threadId);
    if (writer != null) {
      return writer;
    }
  }
  if (chat != null) {
    return chatWritersByChatKey.get(chatKey(chat));
  }
  return undefined;
}

export class ChatStreamWriter {
  public syncdbError?: unknown;
  private syncdb?: SyncDB;
  private syncdbPromise: Promise<SyncDB>;
  private usePool: boolean;
  private metadata: AcpChatContext;
  private readonly chatKey: string;
  private readonly workspaceRoot?: string;
  private readonly hostWorkspaceRoot?: string;
  private inlineCodeLinksCache?: {
    content: string;
    links: InlineCodeLink[];
  };
  private threadKeys = new Set<string>();
  private resolvedChatKey?: { date: string; sender_id: string };
  private prevHistory: MessageHistory[] = [];
  private ready: Promise<void>;
  private closed = false;
  private events: AcpStreamMessage[] = [];
  private usage: AcpStreamUsage | null = null;
  private content = "";
  private lastCommittedThreadId: string | null = null;
  private lastCommittedUsageJson = "null";
  private lastCommittedInterrupted = false;
  private lastCommittedGenerating: boolean | undefined;
  private lastErrorText: string | null = null;
  private threadId: string | null = null;
  private seq = 0;
  private finished = false;
  private finishedBy?: "summary" | "error" | "interrupt";
  private approverAccountId: string;
  private interruptedMessage?: string;
  private interruptNotified = false;
  private disposeTimer?: NodeJS.Timeout;
  private sessionKey?: string;
  private logStore?: AKV<AcpStreamMessage[]>;
  private logStoreName: string;
  private logKey: string;
  private logSubject: string;
  private client: ConatClient;
  private timeTravel?: AgentTimeTravelRecorder;
  private integritySnapshot: ChatIntegritySnapshot = {
    computedAtMs: 0,
    durationMs: 0,
    rowCount: 0,
    dirty: true,
    dirtySinceMs: Date.now(),
    recomputeCount: 0,
  };
  private readonly timeTravelOps = new Set<Promise<void>>();
  private timeTravelDisposePromise?: Promise<void>;
  private leaseFinalized = false;
  private heartbeatLease = throttle(
    () => {
      this.touchLease();
    },
    LEASE_HEARTBEAT_INTERVAL,
    { leading: true, trailing: true },
  );
  private persistLogProgress = throttle(
    async () => {
      const started = performance.now();
      try {
        const store = this.getLogStore();
        await store.set(this.logKey, this.events);
        const durationMs = performance.now() - started;
        if (durationMs >= ACP_LOG_PERSIST_SLOW_MS) {
          logger.warn("acp log incremental persist slow", {
            chatKey: this.chatKey,
            path: this.metadata.path,
            events: this.events.length,
            durationMs: roundMs(durationMs),
          });
        }
      } catch (err) {
        logger.debug("failed to persist acp log incrementally", {
          chatKey: this.chatKey,
          path: this.metadata.path,
          events: this.events.length,
          durationMs: roundMs(performance.now() - started),
          err,
        });
      }
    },
    1000,
    { leading: true, trailing: true },
  );

  // Read a field from a syncdb record that may be either an Immutable.js map
  // (legacy) or a plain JS object (immer). This keeps the ACP hub compatible
  // with both modes while we migrate fully to immer.
  private recordField<T = unknown>(record: any, key: string): T | undefined {
    if (record == null) return undefined;
    if (typeof record.get === "function") return record.get(key) as T;
    return (record as any)[key] as T;
  }

  private toPlainRecord(record: any): Record<string, unknown> {
    if (record == null) return {};
    if (typeof record.toJS === "function") {
      try {
        return record.toJS();
      } catch {
        return {};
      }
    }
    if (typeof record === "object") {
      return { ...(record as Record<string, unknown>) };
    }
    return {};
  }

  private setResolvedChatKey(record: any): void {
    const date = normalizeIsoDateString(syncdbField(record, "date"));
    const sender_id = syncdbField<string>(record, "sender_id");
    if (!date || !sender_id) return;
    this.resolvedChatKey = { date, sender_id };
  }

  private findChatRow(): any {
    if (!this.syncdb) return undefined;
    if (!this.metadata.message_id) {
      return undefined;
    }
    const byMessageId = findChatRowByMessageId(
      this.syncdb,
      this.metadata.message_id,
    );
    if (byMessageId != null) {
      const rowSender = syncdbField<string>(byMessageId, "sender_id");
      if (
        typeof rowSender === "string" &&
        rowSender.trim().length > 0 &&
        rowSender !== this.metadata.sender_id
      ) {
        // ACP allocates a distinct assistant message_id for each backend-owned
        // reply row, so a sender mismatch here is typically stale lease metadata
        // or a sender migration. Refusing the update would fork the same
        // assistant turn into a second row instead of finishing the existing one.
        logger.warn("acp writer row-sender mismatch; using message_id row", {
          chatKey: this.chatKey,
          message_id: this.metadata.message_id,
          expected_sender: this.metadata.sender_id,
          actual_sender: rowSender,
        });
      }
      this.setResolvedChatKey(byMessageId);
      return byMessageId;
    }
    return undefined;
  }

  private resolvedThreadId(): string | undefined {
    const threadId = `${this.metadata.thread_id ?? ""}`.trim();
    return threadId || undefined;
  }

  private clearParentMessageAcpState(): void {
    if (!this.syncdb) return;
    const parentMessageId =
      `${(this.metadata as any).parent_message_id ?? ""}`.trim();
    if (!parentMessageId) return;
    const current = findChatRowByMessageId(this.syncdb, parentMessageId);
    if (current == null) return;
    const rowDate =
      normalizeIsoDateString(syncdbField<string>(current, "date")) ?? undefined;
    const rowSender = syncdbField<string>(current, "sender_id");
    if (!rowDate || !rowSender) return;
    const update: Record<string, unknown> = {
      event: "chat",
      date: rowDate,
      sender_id: rowSender,
      message_id: parentMessageId,
      thread_id:
        syncdbField<string>(current, "thread_id") ?? this.metadata.thread_id,
      acp_state: null,
    };
    const parentOfParent = syncdbField<string>(current, "parent_message_id");
    if (parentOfParent) {
      update.parent_message_id = parentOfParent;
    }
    this.syncdb.set(update);
    this.syncdb.commit();
    this.markIntegrityDirty("clear-parent-acp-state");
  }

  private markIntegrityDirty(reason: string): void {
    this.integritySnapshot.dirty = true;
    this.integritySnapshot.dirtySinceMs = Date.now();
    this.integritySnapshot.lastReason = reason;
  }

  private refreshIntegritySnapshot(reason: string): boolean {
    const snapshot = this.integritySnapshot;
    if (
      this.syncdb == null ||
      typeof (this.syncdb as any).get !== "function" ||
      !snapshot.dirty
    ) {
      return false;
    }
    const nowMs = Date.now();
    if (
      snapshot.computedAtMs > 0 &&
      nowMs - snapshot.computedAtMs < ACP_CHAT_INTEGRITY_RECOMPUTE_MIN_MS
    ) {
      return false;
    }
    const started = performance.now();
    try {
      const rows = (this.syncdb as any).get();
      const rowCount = Array.isArray(rows) ? rows.length : 0;
      snapshot.counters =
        rowCount > 0 ? computeChatIntegrityReport(rows).counters : undefined;
      snapshot.rowCount = rowCount;
      snapshot.computedAtMs = nowMs;
      snapshot.durationMs = performance.now() - started;
      snapshot.dirty = false;
      snapshot.recomputeCount += 1;
      snapshot.lastReason = reason;
      snapshot.lastError = undefined;
      if (snapshot.durationMs >= ACP_CHAT_INTEGRITY_SLOW_MS) {
        logger.warn("chat integrity snapshot slow", {
          chatKey: this.chatKey,
          path: this.metadata.path,
          reason,
          events: this.events.length,
          rowCount,
          durationMs: roundMs(snapshot.durationMs),
        });
      }
      return true;
    } catch (err) {
      snapshot.computedAtMs = nowMs;
      snapshot.durationMs = performance.now() - started;
      snapshot.lastError =
        err instanceof Error ? err.message : `${err ?? "unknown error"}`;
      logger.debug("failed to compute chat integrity snapshot", {
        chatKey: this.chatKey,
        path: this.metadata.path,
        reason,
        durationMs: roundMs(snapshot.durationMs),
        err,
      });
      return false;
    }
  }

  private setThreadState(
    state: "idle" | "queued" | "running" | "interrupted" | "error" | "complete",
  ): void {
    if (this.closed || this.syncdbError || !this.syncdb) return;
    const threadId = this.resolvedThreadId();
    if (!threadId) {
      logger.warn("skip chat thread-state update: missing thread_id", {
        chatKey: this.chatKey,
        message_id: this.metadata.message_id,
        state,
      });
      return;
    }
    try {
      replaceThreadScopedRow(
        this.syncdb,
        THREAD_STATE_EVENT,
        threadId,
        buildThreadStateRecord({
          thread_id: threadId,
          state,
          active_message_id: this.metadata.message_id,
          updated_at: new Date().toISOString(),
          schema_version: THREAD_STATE_SCHEMA_VERSION,
        }),
      );
      this.syncdb.commit();
      this.markIntegrityDirty(`thread-state:${state}`);
    } catch (err) {
      logger.debug("failed to update chat thread state", {
        chatKey: this.chatKey,
        state,
        err,
      });
    }
  }

  private leaseKey() {
    return {
      project_id: this.metadata.project_id,
      path: this.metadata.path,
      message_date: this.metadata.message_date,
    };
  }

  private startLease(): void {
    try {
      startAcpTurnLease({
        context: this.metadata,
        owner_instance_id: ACP_INSTANCE_ID,
        pid: process.pid,
        session_id: this.sessionKey ?? undefined,
      });
    } catch (err) {
      logger.warn("failed to start acp turn lease", {
        chatKey: this.chatKey,
        err,
      });
    }
  }

  private touchLease(): void {
    if (this.leaseFinalized) return;
    try {
      heartbeatAcpTurnLease({
        key: this.leaseKey(),
        owner_instance_id: ACP_INSTANCE_ID,
        pid: process.pid,
        session_id: this.threadId ?? this.sessionKey ?? undefined,
      });
    } catch (err) {
      logger.debug("failed to heartbeat acp turn lease", {
        chatKey: this.chatKey,
        err,
      });
    }
  }

  private finalizeLease(
    state: "completed" | "error" | "aborted",
    reason?: string,
  ): void {
    if (this.leaseFinalized) return;
    this.leaseFinalized = true;
    try {
      this.heartbeatLease.flush();
    } catch {
      // ignore
    }
    this.heartbeatLease.cancel();
    try {
      finalizeAcpTurnLease({
        key: this.leaseKey(),
        state,
        reason,
        owner_instance_id: ACP_INSTANCE_ID,
      });
    } catch (err) {
      logger.warn("failed to finalize acp turn lease", {
        chatKey: this.chatKey,
        state,
        reason,
        err,
      });
    }
  }

  constructor({
    metadata,
    client,
    approverAccountId,
    sessionKey,
    workspaceRoot,
    hostWorkspaceRoot,
    syncdbOverride,
    logStoreFactory,
  }: {
    metadata: AcpChatContext;
    client: ConatClient;
    approverAccountId: string;
    sessionKey?: string;
    workspaceRoot?: string;
    hostWorkspaceRoot?: string;
    syncdbOverride?: any;
    logStoreFactory?: () => AKV<AcpStreamMessage[]>;
  }) {
    if (`${metadata.message_id ?? ""}`.trim().length === 0) {
      throw new Error("acp chat metadata is missing required message_id");
    }
    if (`${metadata.thread_id ?? ""}`.trim().length === 0) {
      throw new Error("acp chat metadata is missing required thread_id");
    }
    this.metadata = metadata;
    this.approverAccountId = approverAccountId;
    this.client = client;
    this.chatKey = chatKey(metadata);
    this.workspaceRoot = workspaceRoot;
    this.hostWorkspaceRoot = hostWorkspaceRoot ?? workspaceRoot;
    this.usePool = syncdbOverride == null;
    this.syncdbPromise =
      syncdbOverride != null
        ? Promise.resolve(syncdbOverride)
        : acquireChatSyncDB({
            client,
            project_id: metadata.project_id,
            path: metadata.path,
          });
    if (syncdbOverride != null) {
      this.syncdb = syncdbOverride as any;
    }
    // Ensure rejections are observed and mark the writer closed on failure.
    this.syncdbPromise.catch((err) => {
      logger.warn("chat syncdb failed to initialize", err);
      this.syncdbError = err;
      this.closed = true;
    });
    const existing = chatWritersByChatKey.get(this.chatKey);
    if (existing != null && existing !== this) {
      logger.warn("duplicate chat writer detected; replacing existing writer", {
        chatKey: this.chatKey,
        existingClosed: existing.isClosed(),
        existingThreadIds: existing.getKnownThreadIds(),
        replacingSessionKey: sessionKey,
      });
      existing.dispose(true);
    }
    chatWritersByChatKey.set(this.chatKey, this);
    logWriterCounts("create", { chatKey: this.chatKey });
    this.sessionKey = sessionKey;
    this.startLease();
    if (sessionKey) {
      this.registerThreadKey(sessionKey);
    }
    const thread_id = `${metadata.thread_id ?? ""}`.trim();
    const message_id = `${metadata.message_id ?? ""}`.trim();
    const refs = deriveAcpLogRefs({
      project_id: metadata.project_id,
      path: metadata.path,
      thread_id,
      message_id,
    });
    this.logStoreName = refs.store;
    this.logKey = refs.key;
    this.logSubject = refs.subject;
    // ensure initialization rejections are observed immediately
    this.ready = this.initialize();
    this.waitUntilReady();
    if (logStoreFactory) {
      this.logStore = logStoreFactory();
    }
    if (workspaceRoot) {
      this.timeTravel = new AgentTimeTravelRecorder({
        project_id: metadata.project_id,
        chat_path: metadata.path,
        chat_thread_id: thread_id,
        chat_message_id: message_id,
        log_store: refs.store,
        log_key: refs.key,
        log_subject: refs.subject,
        client,
        workspaceRoot,
        sessionId: sessionKey,
      });
      logger.debug("agent-tt enabled", {
        chatKey: this.chatKey,
        project_id: metadata.project_id,
        chat_path: metadata.path,
        workspaceRoot,
      });
    } else {
      logger.debug("agent-tt disabled (no workspaceRoot)", {
        chatKey: this.chatKey,
        project_id: metadata.project_id,
        chat_path: metadata.path,
      });
    }
  }

  waitUntilReady = async () => {
    try {
      await this.ready;
    } catch (err) {
      logger.warn("chat stream writer failed to initialize", err);
      this.syncdbError = err;
      this.closed = true;
    }
  };

  isClosed = () => this.closed;

  private async initialize(): Promise<void> {
    const db = await this.syncdbPromise;
    this.syncdb = db;
    if (!db.isReady()) {
      try {
        await once(db, "ready");
      } catch (err) {
        logger.warn("chat syncdb failed to become ready", err);
        throw err;
      }
    }
    let current = this.findChatRow();
    if (current == null) {
      // Create a placeholder chat row so backend-owned updates don’t race with a missing record.
      const placeholder = buildChatMessage({
        sender_id: this.metadata.sender_id,
        date: this.metadata.message_date,
        prevHistory: [],
        content: ":robot: Thinking...",
        generating: true,
        acp_log_store: this.logStoreName,
        acp_log_key: this.logKey,
        acp_log_subject: this.logSubject,
        message_id: this.metadata.message_id,
        thread_id: this.metadata.thread_id,
        parent_message_id: (this.metadata as any).parent_message_id,
      } as any);
      if ((this.metadata as any).parent_message_id) {
        (placeholder as any).parent_message_id = (
          this.metadata as any
        ).parent_message_id;
      }
      db.set(placeholder);
      db.commit();
      this.markIntegrityDirty("init-placeholder");
      try {
        await db.save();
      } catch (err) {
        logger.warn("chat syncdb save failed during init", err);
      }
      current = this.findChatRow();
    }
    const history = this.recordField(current, "history");
    const arr = this.historyToArray(history);
    if (arr.length > 0) {
      this.prevHistory = arr.slice(1);
    }
    const queued = listAcpPayloads(this.metadata);
    for (const payload of queued) {
      this.processPayload(payload, { persist: false });
    }
    this.clearParentMessageAcpState();
    this.setThreadState("running");
  }

  private historyToArray(value: any): MessageHistory[] {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.toJS === "function") {
      return value.toJS();
    }
    return [];
  }

  async handle(payload?: AcpStreamPayload | null): Promise<void> {
    await this.ready;
    if (this.closed) return;
    if (payload == null) {
      this.dispose();
      return;
    }
    const message: AcpStreamMessage = {
      ...(payload as AcpStreamMessage),
      seq: this.seq++,
    };
    this.processPayload(message, { persist: true });
    const isLastMessage =
      message.type === "summary" || message.type === "error" || this.finished;
    this.commit(!isLastMessage);
    if (isLastMessage) {
      // Ensure the final "generating: false" state hits SyncDB immediately,
      // even if the throttle window is large.
      this.commit.flush();
      await this.ensureTerminalChatCommitApplied(
        message.type === "error" ? "error" : "summary",
      );
    }
  }

  private processPayload(
    payload: AcpStreamMessage,
    { persist }: { persist: boolean },
  ): void {
    if (this.closed) return;
    this.heartbeatLease();
    if ((payload.seq ?? -1) >= this.seq) {
      this.seq = (payload.seq ?? -1) + 1;
    }
    if (persist) {
      try {
        enqueueAcpPayload(this.metadata, payload);
      } catch (err) {
        logger.warn("failed to enqueue acp payload", err);
      }
    }
    if (payload.type === "status") {
      this.setThreadState(payload.state === "running" ? "running" : "queued");
      return;
    }
    if ((payload as any).type === "usage") {
      // Live usage updates from Codex; stash for commit and don't treat as a user-visible event.
      this.usage = (payload as any).usage ?? null;
      return;
    }
    this.events = appendStreamMessage(this.events, payload);
    this.publishLog(payload);
    this.persistLogProgress();
    if (payload.type === "event") {
      this.handleAgentEvent(payload.event);
      if (this.interruptNotified) {
        // Preserve interruption state in chat even if late stream payloads arrive.
        return;
      }
      const text = extractEventText(payload.event);
      if (text) {
        const last = this.events[this.events.length - 1];
        const mergedText =
          last?.type === "event" ? extractEventText(last.event) : undefined;
        // Use the merged text so we preserve the full streamed body.
        this.content = mergedText ?? text;
      }
      return;
    }
    if (payload.type === "summary") {
      if (this.interruptNotified) {
        if (
          (!this.content || this.content.trim().length === 0) &&
          this.interruptedMessage
        ) {
          this.content = this.interruptedMessage;
        }
        this.finishedBy = "interrupt";
      } else {
        const finishedFromError = this.finishedBy === "error";
        const latestSummary = getLatestSummaryText(this.events);
        const hasSummary =
          typeof latestSummary === "string" && latestSummary.trim().length > 0;
        const latestMessage = getLatestMessageText(this.events);
        const hasStreamedMessage =
          typeof latestMessage === "string" && latestMessage.trim().length > 0;
        const summaryText =
          (hasSummary ? latestSummary : undefined) ??
          (typeof payload.finalResponse === "string" &&
          payload.finalResponse.trim().length > 0
            ? payload.finalResponse
            : undefined);
        const candidate =
          summaryText ??
          (hasStreamedMessage ? latestMessage : undefined) ??
          this.interruptedMessage ??
          this.content;
        const shouldApplySummary =
          !finishedFromError ||
          (hasStreamedMessage &&
            typeof candidate === "string" &&
            candidate.trim().length > 0 &&
            !looksLikeErrorEcho(candidate, this.lastErrorText));
        if (candidate != null && shouldApplySummary) {
          this.content = stripLoopContractForDisplay(
            candidate,
            this.metadata.loop_config?.enabled === true,
          );
          this.finishedBy = "summary";
        }
      }
      if (payload.usage) {
        this.usage = payload.usage;
      }
      if (payload.threadId != null) {
        this.threadId = payload.threadId;
        this.registerThreadKey(payload.threadId);
        this.timeTravel?.setThreadId(payload.threadId);
      }
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.setThreadState(this.interruptNotified ? "interrupted" : "complete");
      this.finalizeLease("completed");
      this.trackTimeTravelOperation("finalize", this.metadata.path, () =>
        this.timeTravel?.finalizeTurn(this.metadata.message_date),
      );
      void this.persistLog();
      void maybeAutoRotateChatStore({
        chatPath: this.resolveChatFilePath(),
        chatKey: this.chatKey,
        projectId: this.metadata.project_id,
        chatPathKey: this.metadata.path,
      });
      return;
    }
    if (payload.type === "error") {
      this.content = `\n\n<span style='color:#b71c1c'>${payload.error}</span>\n\n`;
      this.lastErrorText = payload.error;
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.finishedBy = "error";
      this.setThreadState("error");
      this.finalizeLease("error", payload.error);
      this.trackTimeTravelOperation("finalize", this.metadata.path, () =>
        this.timeTravel?.finalizeTurn(this.metadata.message_date),
      );
      void this.persistLog();
      void maybeAutoRotateChatStore({
        chatPath: this.resolveChatFilePath(),
        chatKey: this.chatKey,
        projectId: this.metadata.project_id,
        chatPathKey: this.metadata.path,
      });
    }
  }

  private buildChatUpdate(generating: boolean): Record<string, unknown> {
    const rowDate = this.resolvedChatKey?.date ?? this.metadata.message_date;
    const rowSender =
      this.resolvedChatKey?.sender_id ?? this.metadata.sender_id;
    const message = buildChatMessage({
      sender_id: rowSender,
      date: rowDate,
      prevHistory: this.prevHistory,
      content: this.content,
      generating,
      acp_log_store: this.logStoreName,
      acp_log_key: this.logKey,
      acp_log_subject: this.logSubject,
      acp_thread_id: this.threadId,
      acp_usage: this.usage,
      acp_account_id: this.approverAccountId,
      message_id: this.metadata.message_id,
      thread_id: this.metadata.thread_id,
      parent_message_id: (this.metadata as any).parent_message_id,
      inline_code_links: generating ? undefined : this.resolveInlineCodeLinks(),
    } as any);
    if ((this.metadata as any).parent_message_id) {
      (message as any).parent_message_id = (
        this.metadata as any
      ).parent_message_id;
    }
    const update: any = { ...message };
    if (this.interruptNotified) {
      update.acp_interrupted = true;
      update.acp_interrupted_reason = "interrupt";
      update.acp_interrupted_text =
        this.interruptedMessage ?? INTERRUPT_STATUS_TEXT;
    }
    return update;
  }

  private buildChatMetadataUpdate(
    generating: boolean,
  ): Record<string, unknown> {
    const rowDate = this.resolvedChatKey?.date ?? this.metadata.message_date;
    const rowSender =
      this.resolvedChatKey?.sender_id ?? this.metadata.sender_id;
    const update: Record<string, unknown> = {
      event: "chat",
      sender_id: rowSender,
      date: rowDate,
      generating,
      acp_log_store: this.logStoreName,
      acp_log_key: this.logKey,
      acp_log_subject: this.logSubject,
      acp_thread_id: this.threadId,
      acp_usage: this.usage,
      acp_account_id: this.approverAccountId,
      message_id: this.metadata.message_id,
      thread_id: this.metadata.thread_id,
      parent_message_id: (this.metadata as any).parent_message_id,
    };
    if (this.interruptNotified) {
      (update as any).acp_interrupted = true;
      (update as any).acp_interrupted_reason = "interrupt";
      (update as any).acp_interrupted_text =
        this.interruptedMessage ?? INTERRUPT_STATUS_TEXT;
    }
    return update;
  }

  private usageFingerprint(): string {
    try {
      return JSON.stringify(this.usage ?? null);
    } catch {
      return "null";
    }
  }

  private hasMetadataDelta(generating: boolean): boolean {
    const usageChanged =
      this.lastCommittedUsageJson !== this.usageFingerprint();
    return (
      this.lastCommittedThreadId !== this.threadId ||
      this.lastCommittedInterrupted !== this.interruptNotified ||
      this.lastCommittedGenerating !== generating ||
      // During active runs we keep row churn minimal and stream live detail
      // from AKV/pubsub. Persist usage changes at terminal commit.
      (!generating && usageChanged)
    );
  }

  private shouldFullContentCommit({
    generating,
  }: {
    generating: boolean;
  }): boolean {
    // During active runs we render from AKV/pubsub and avoid chat-row churn.
    // Persist full message content only for terminal generating=false commits.
    return generating !== true;
  }

  private markCommitted(generating: boolean): void {
    this.lastCommittedThreadId = this.threadId;
    this.lastCommittedUsageJson = this.usageFingerprint();
    this.lastCommittedInterrupted = this.interruptNotified;
    this.lastCommittedGenerating = generating;
  }

  private resolveInlineCodeLinks(): InlineCodeLink[] | undefined {
    const content = this.content ?? "";
    if (!content.trim()) return undefined;
    if (this.inlineCodeLinksCache?.content === content) {
      return this.inlineCodeLinksCache.links.length
        ? this.inlineCodeLinksCache.links
        : undefined;
    }
    const links = resolveInlineCodeLinks({
      markdown: content,
      workspaceRoot: this.workspaceRoot,
      hostWorkspaceRoot: this.hostWorkspaceRoot,
    });
    this.inlineCodeLinksCache = { content, links };
    return links.length ? links : undefined;
  }

  private resolveChatFilePath(): string | undefined {
    const chatPath = `${this.metadata.path ?? ""}`.trim();
    if (!chatPath) return;
    if (path.isAbsolute(chatPath)) return path.resolve(chatPath);
    const root = this.hostWorkspaceRoot ?? this.workspaceRoot;
    if (!root || !path.isAbsolute(root)) return;
    return path.resolve(root, chatPath);
  }

  private commitNow(
    generating: boolean,
    reason: "throttled" | "terminal-verify" | "dispose" = "throttled",
  ): boolean {
    if (this.closed || this.syncdbError) return false;
    if (!this.syncdb) {
      logger.warn("chat stream writer commit skipped: syncdb not ready", {
        chatKey: this.chatKey,
        reason,
      });
      return false;
    }
    const fullContent = this.shouldFullContentCommit({
      generating,
    });
    const metadataDelta = this.hasMetadataDelta(generating);
    if (!fullContent && !metadataDelta) {
      return true;
    }
    const started = performance.now();
    try {
      this.syncdb.set(
        fullContent
          ? this.buildChatUpdate(generating)
          : this.buildChatMetadataUpdate(generating),
      );
      this.syncdb.commit();
      this.markCommitted(generating);
      this.markIntegrityDirty(
        `chat-commit:${reason}:${fullContent ? "full" : "meta"}`,
      );
    } catch (err) {
      logger.warn("chat syncdb commit failed", {
        chatKey: this.chatKey,
        reason,
        generating,
        fullContent,
        err,
      });
      return false;
    }
    const syncDurationMs = performance.now() - started;
    if (syncDurationMs >= ACP_COMMIT_SLOW_MS) {
      logger.warn("chat syncdb commit slow", {
        chatKey: this.chatKey,
        path: this.metadata.path,
        reason,
        generating,
        fullContent,
        metadataDelta,
        events: this.events.length,
        contentLength: this.content.length,
        durationMs: roundMs(syncDurationMs),
      });
    }
    (async () => {
      const saveStarted = performance.now();
      try {
        await this.syncdb!.save();
        const saveDurationMs = performance.now() - saveStarted;
        if (saveDurationMs >= ACP_SYNCDB_SAVE_SLOW_MS) {
          logger.warn("chat syncdb save slow", {
            chatKey: this.chatKey,
            path: this.metadata.path,
            reason,
            generating,
            fullContent,
            events: this.events.length,
            durationMs: roundMs(saveDurationMs),
          });
        }
      } catch (err) {
        logger.warn("chat syncdb save failed", {
          chatKey: this.chatKey,
          reason,
          generating,
          fullContent,
          durationMs: roundMs(performance.now() - saveStarted),
          err,
        });
      }
    })();
    return true;
  }

  private async ensureTerminalChatCommitApplied(
    source: "summary" | "error",
  ): Promise<void> {
    if (this.closed || this.syncdbError || !this.syncdb) return;
    let lastGenerating: boolean | undefined;
    for (let i = 0; i < TERMINAL_CHAT_VERIFY_DELAYS_MS.length; i++) {
      const delayMs = TERMINAL_CHAT_VERIFY_DELAYS_MS[i];
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      if (this.closed || this.syncdbError || !this.syncdb) return;
      try {
        const current = this.findChatRow();
        lastGenerating = this.recordField<boolean>(current, "generating");
      } catch (err) {
        logger.warn(
          "chat syncdb readback failed during terminal verification",
          {
            chatKey: this.chatKey,
            source,
            attempt: i + 1,
            err,
          },
        );
      }
      if (lastGenerating === false) {
        if (i > 0) {
          acpFinalizeRecoveredAfterRetryCount += 1;
          logger.warn(
            "chat terminal state recovered after verification retry",
            {
              chatKey: this.chatKey,
              source,
              attempts: i + 1,
            },
          );
        }
        return;
      }
      this.commitNow(false, "terminal-verify");
    }
    acpFinalizeMismatchCount += 1;
    logger.warn("chat terminal verification failed; chat remains generating", {
      chatKey: this.chatKey,
      source,
      events: this.events.length,
      finishedBy: this.finishedBy,
      lastGenerating,
      retries: TERMINAL_CHAT_VERIFY_DELAYS_MS.length,
    });
  }

  private commit = throttle((generating: boolean): void => {
    this.heartbeatLease();
    const content = this.content ?? "";
    logger.debug("commit", {
      generating,
      closed: this.closed,
      contentLength: content.length,
      contentPreview: content.slice(0, 160),
      events: this.events.length,
      metadata: this.metadata,
    });
    this.commitNow(generating, "throttled");
  }, COMMIT_INTERVAL);

  dispose(forceImmediate: boolean = false): void {
    if (this.closed) return;

    // If we've already finished the turn, delay dispose slightly to let
    // the final generating=false write propagate unless explicitly forced.
    // This works around a known race in @cocalc/sync (src/packages/sync)
    // where very fast true→false toggles can be dropped; the delay gives
    // the final state a chance to land. Remove once the sync bug is fixed.
    if (!forceImmediate && this.finished) {
      if (this.disposeTimer) return;
      this.disposeTimer = setTimeout(() => this.dispose(true), 1500);
      return;
    }

    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = undefined;
    }

    if (!this.leaseFinalized) {
      const reason = this.finished
        ? "disposed after finished turn"
        : this.interruptNotified
          ? INTERRUPT_STATUS_TEXT
          : "writer disposed before terminal payload";
      if (!this.finished) {
        this.setThreadState(this.interruptNotified ? "interrupted" : "error");
      }
      this.finalizeLease("aborted", reason);
    }

    this.commitNow(false, "dispose");
    this.commit.flush();
    this.closed = true;
    this.startTimeTravelDispose();
    chatWritersByChatKey.delete(this.chatKey);
    logWriterCounts("dispose", { chatKey: this.chatKey });
    for (const key of this.threadKeys) {
      const writer = chatWritersByThreadId.get(key);
      if (writer === this) {
        chatWritersByThreadId.delete(key);
        logWriterCounts("dispose-thread", { threadId: key });
      }
    }
    this.threadKeys.clear();
    if (!this.finished) {
      clearAcpPayloads(this.metadata);
    }
    try {
      this.persistLogProgress.flush();
    } catch {
      // ignore
    }
    void this.persistLog();
    (async () => {
      try {
        await this.syncdbPromise;
        await this.syncdb!.save();
      } catch (err) {
        logger.warn("failed to save chat syncdb", err);
      }
      try {
        if (this.usePool) {
          await releaseChatSyncDB(this.metadata.project_id, this.metadata.path);
        } else {
          await this.syncdb!.close();
        }
      } catch (err) {
        logger.warn("failed to close chat syncdb", err);
      }
    })();
  }

  addLocalEvent(event: AcpStreamEvent): void {
    if (this.closed) return;
    void (async () => {
      await this.ready;
      if (this.closed || this.syncdbError) return;
      const message: AcpStreamMessage = {
        type: "event",
        event,
        seq: this.seq++,
      };
      this.processPayload(message, { persist: true });
      this.commit(true);
    })();
  }

  private handleAgentEvent(event: AcpStreamEvent): void {
    if (!this.timeTravel) return;
    const turnId = this.metadata.message_date;
    if (event.type === "file") {
      if (event.operation === "read") {
        this.trackTimeTravelOperation("read", event.path, () =>
          this.timeTravel?.recordRead(event.path, turnId),
        );
      } else {
        this.trackTimeTravelOperation("write", event.path, () =>
          this.timeTravel?.recordWrite(event.path, turnId),
        );
      }
      return;
    }
    if (event.type === "diff") {
      this.trackTimeTravelOperation("write", event.path, () =>
        this.timeTravel?.recordWrite(event.path, turnId),
      );
    }
  }

  private trackTimeTravelOperation(
    operation: "read" | "write" | "finalize",
    path: string,
    action: () => Promise<void> | undefined,
  ): void {
    if (!this.timeTravel) return;
    const op = (async () => {
      try {
        await action();
      } catch (err) {
        logger.warn("agent-tt operation failed", {
          chatKey: this.chatKey,
          operation,
          path,
          err,
        });
      }
    })();
    this.timeTravelOps.add(op);
    void op.finally(() => {
      this.timeTravelOps.delete(op);
    });
  }

  private startTimeTravelDispose(): void {
    if (!this.timeTravel || this.timeTravelDisposePromise != null) return;
    const pending = [...this.timeTravelOps];
    if (pending.length > 0) {
      logger.debug("chat writer dispose waiting for agent-tt operations", {
        chatKey: this.chatKey,
        pendingOps: pending.length,
      });
    }
    const timeTravel = this.timeTravel;
    this.timeTravelDisposePromise = (async () => {
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      await timeTravel.dispose();
    })()
      .catch((err) => {
        logger.warn("failed to dispose agent-tt recorder", {
          chatKey: this.chatKey,
          err,
        });
      })
      .finally(() => {
        this.timeTravelOps.clear();
        this.timeTravelDisposePromise = undefined;
      });
  }

  notifyInterrupted(text: string): void {
    if (this.interruptNotified) return;
    this.interruptNotified = true;
    this.interruptedMessage = text;
    this.content = text;
    this.finishedBy = "interrupt";
    this.setThreadState("interrupted");
    this.addLocalEvent({
      type: "message",
      text,
    });
  }

  getKnownThreadIds(): string[] {
    const ids: string[] = [];
    if (this.threadId) ids.push(this.threadId);
    if (this.sessionKey) ids.push(this.sessionKey);
    return Array.from(new Set(ids));
  }

  watchdogSnapshot() {
    const started = performance.now();
    const timeTravelStats = this.timeTravel?.debugStats();
    const integrityRecomputed = this.refreshIntegritySnapshot("watchdog");
    const integrity = this.integritySnapshot.counters;
    const nowMs = Date.now();
    const integrityAgeMs =
      this.integritySnapshot.computedAtMs > 0
        ? Math.max(0, nowMs - this.integritySnapshot.computedAtMs)
        : undefined;
    const watchdogDurationMs = performance.now() - started;
    if (watchdogDurationMs >= ACP_WATCHDOG_SNAPSHOT_SLOW_MS) {
      logger.warn("chat watchdog snapshot slow", {
        chatKey: this.chatKey,
        path: this.metadata.path,
        events: this.events.length,
        finished: this.finished,
        durationMs: roundMs(watchdogDurationMs),
        integrityRecomputed,
        integrityDurationMs: roundMs(this.integritySnapshot.durationMs),
        integrityRowCount: this.integritySnapshot.rowCount,
        integrityDirty: this.integritySnapshot.dirty,
        integrityAgeMs,
      });
    }
    return {
      chatKey: this.chatKey,
      path: this.metadata.path,
      messageDate: this.metadata.message_date,
      events: this.events.length,
      finished: this.finished,
      closed: this.closed,
      disposeScheduled: this.disposeTimer != null,
      hasSyncdbError: this.syncdbError != null,
      threadIds: this.getKnownThreadIds(),
      integrity,
      watchdog: {
        durationMs: roundMs(watchdogDurationMs),
        integrityRecomputed,
        integrityDirty: this.integritySnapshot.dirty,
        integrityAgeMs,
        integrityDurationMs: roundMs(this.integritySnapshot.durationMs),
        integrityRowCount: this.integritySnapshot.rowCount,
        integrityRecomputeCount: this.integritySnapshot.recomputeCount,
        integrityLastReason: this.integritySnapshot.lastReason,
      },
      timeTravel:
        timeTravelStats == null
          ? undefined
          : {
              ...timeTravelStats,
              pendingOps: this.timeTravelOps.size,
              disposePending: this.timeTravelDisposePromise != null,
            },
    };
  }

  private registerThreadKey(key: string): void {
    if (!key) return;
    this.threadKeys.add(key);
    chatWritersByThreadId.set(key, this);
    logWriterCounts("register-thread", { threadId: key });
    try {
      updateAcpTurnLeaseSessionId({
        key: this.leaseKey(),
        session_id: key,
      });
    } catch (err) {
      logger.debug("failed to persist acp turn session id", {
        chatKey: this.chatKey,
        key,
        err,
      });
    }
    this.heartbeatLease();
    void this.persistSessionId(key);
  }

  private getLogStore(): AKV<AcpStreamMessage[]> {
    if (this.logStore) return this.logStore;
    this.logStore = akv<AcpStreamMessage[]>({
      project_id: this.metadata.project_id,
      name: this.logStoreName,
      client: this.client,
    });
    return this.logStore;
  }

  private publishLog(event: AcpStreamMessage): void {
    if (this.closed) return;
    void this.client
      .publish(this.logSubject, event)
      .catch((err) => logger.debug("publish log failed", err));
  }

  private async persistLog(): Promise<void> {
    if (this.events.length === 0) return;
    try {
      const store = this.getLogStore();
      await store.set(this.logKey, this.events);
    } catch (err) {
      logger.warn("failed to persist acp log", err);
    }
  }

  // Persist fields in the dedicated thread-config record so finalize/recovery
  // never mutates chat message rows.
  private async patchThreadConfig(
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.ready;
    if (this.closed || !this.syncdb) return;
    try {
      const threadId = this.resolvedThreadId();
      if (!threadId) {
        logger.warn("patchThreadConfig skipped: missing thread_id", {
          chatKey: this.chatKey,
          message_id: this.metadata.message_id,
        });
        return;
      }
      const threadCfgCurrent = preferredThreadConfigRow(this.syncdb, threadId);
      const base = this.toPlainRecord(threadCfgCurrent);
      replaceThreadScopedRow(this.syncdb, THREAD_CONFIG_EVENT, threadId, {
        ...base,
        ...buildThreadConfigRecord({
          thread_id: threadId,
          updated_at: new Date().toISOString(),
          updated_by: this.approverAccountId,
          schema_version: THREAD_STATE_SCHEMA_VERSION,
        }),
        ...patch,
      });
      this.syncdb.commit();
      this.markIntegrityDirty("thread-config");
      await this.syncdb.save();
    } catch (err) {
      logger.debug("patchThreadConfig failed", err);
    }
  }

  private async persistSessionId(sessionId: string): Promise<void> {
    await this.ready;
    if (this.closed || !this.syncdb) return;
    const threadId = this.resolvedThreadId();
    if (!threadId) return;
    const currentRow = preferredThreadConfigRow(this.syncdb, threadId);
    const currentConfig = this.recordField<any>(currentRow, "acp_config");
    const currentConfigObj =
      currentConfig && typeof currentConfig.toJS === "function"
        ? currentConfig.toJS()
        : (currentConfig ?? {});
    if (currentConfigObj?.sessionId === sessionId) return;
    await this.patchThreadConfig({
      acp_config: {
        ...(currentConfigObj as Record<string, unknown>),
        sessionId,
      },
    });
  }

  public async persistLoopState({
    loopConfig,
    loopState,
  }: {
    loopConfig?: AcpLoopConfig;
    loopState?: AcpLoopState;
  }): Promise<void> {
    await this.patchThreadConfig({
      loop_config: loopConfig ?? null,
      loop_state: loopState ?? null,
    });
  }

  public getLatestSummaryText(): string | undefined {
    const latest = getLatestSummaryText(this.events);
    if (typeof latest !== "string") return undefined;
    const trimmed = latest.trim();
    return trimmed.length ? trimmed : undefined;
  }

  public wasInterrupted(): boolean {
    return this.interruptNotified === true;
  }

  public getTerminalState(): "completed" | "error" | "interrupted" | undefined {
    switch (this.finishedBy) {
      case "error":
        return "error";
      case "interrupt":
        return "interrupted";
      case "summary":
        return "completed";
      default:
        return undefined;
    }
  }

  public beginLoopIteration(): void {
    this.finished = false;
    this.finishedBy = undefined;
    this.lastErrorText = null;
    this.interruptNotified = false;
    this.interruptedMessage = undefined;
    this.setThreadState("running");
  }

  public getLoopFallbackSummary(): string | undefined {
    const latest = getLatestMessageText(this.events);
    if (typeof latest !== "string") return undefined;
    const trimmed = latest.trim();
    if (!trimmed) return undefined;
    return trimmed;
  }

  public markLoopStopped(reason: AcpLoopStopReason): void {
    try {
      this.setThreadState(
        reason === "user_stopped" ? "interrupted" : "complete",
      );
    } catch (err) {
      logger.debug("failed to mark loop stopped", { reason, err });
    }
  }
}

function normalizeSummaryText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeErrorEcho(
  summaryText: string,
  errorText: string | null | undefined,
): boolean {
  const summary = normalizeSummaryText(summaryText);
  const error = normalizeSummaryText(errorText);
  if (!summary || !error) return false;
  if (summary === error) return true;
  return summary.includes(error) || error.includes(summary);
}

function syncdbField<T = unknown>(record: any, key: string): T | undefined {
  if (record == null) return undefined;
  if (typeof record.get === "function") return record.get(key) as T;
  return (record as any)[key] as T;
}

function normalizeIsoDateString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return undefined;
    return value.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (Number.isNaN(d.valueOf())) return value;
    return d.toISOString();
  }
  return undefined;
}

function syncdbRows(syncdb: any, where: Record<string, unknown>): any[] {
  if (syncdb == null || typeof syncdb.get !== "function") return [];
  const rows = syncdb.get(where);
  if (rows == null) return [];
  if (Array.isArray(rows)) return rows;
  if (typeof rows.toJS === "function") return rows.toJS();
  return [];
}

function findChatRowByMessageId(syncdb: any, message_id?: string): any {
  if (!message_id) return undefined;
  try {
    const row = syncdb?.get_one?.({
      event: "chat",
      message_id,
    });
    if (row != null) {
      acpLookupByMessageIdIndexHits += 1;
      return row;
    }
    acpLookupByMessageIdIndexMisses += 1;
    if (!ENABLE_MESSAGE_ID_LINEAR_SCAN_FALLBACK) {
      acpLookupByMessageIdMisses += 1;
      return undefined;
    }
  } catch (err) {
    logger.warn("chat message_id indexed lookup failed; checking fallback", {
      project_id: syncdb?.metadata?.project_id,
      path: syncdb?.metadata?.path,
      err,
    });
    if (!ENABLE_MESSAGE_ID_LINEAR_SCAN_FALLBACK) {
      acpLookupByMessageIdMisses += 1;
      return undefined;
    }
  }

  // WARNING: O(n) fallback path for pre-index deployments. This is off by
  // default and exists only for emergency legacy recovery.
  acpLookupByMessageIdScans += 1;
  const rows = syncdbRows(syncdb, { event: "chat" });
  const rowCount = rows.length;
  acpLookupByMessageIdRowsScanned += rowCount;
  acpLookupByMessageIdRowsScannedMax = Math.max(
    acpLookupByMessageIdRowsScannedMax,
    rowCount,
  );
  if (
    rowCount >= MESSAGE_ID_LOOKUP_WARN_ROWS &&
    (acpLookupByMessageIdScans <= 3 ||
      acpLookupByMessageIdScans % MESSAGE_ID_LOOKUP_WARN_EVERY === 0)
  ) {
    acpLookupByMessageIdLargeScanWarnings += 1;
    logger.warn("chat message_id fallback using O(n) scan (legacy mode)", {
      rowCount,
      scans: acpLookupByMessageIdScans,
      project_id: syncdb?.metadata?.project_id,
      path: syncdb?.metadata?.path,
      message_id_prefix: `${message_id}`.slice(0, 12),
      flag: "ENABLE_MESSAGE_ID_LINEAR_SCAN_FALLBACK",
    });
  }
  for (const row of rows) {
    if (syncdbField<string>(row, "message_id") === message_id) {
      acpLookupByMessageIdHits += 1;
      return row;
    }
  }
  acpLookupByMessageIdMisses += 1;
  return undefined;
}

function findRecoverableChatRow(
  syncdb: any,
  context: {
    message_date: string;
    sender_id: string;
    message_id?: string;
  },
): any {
  if (!context.message_id) {
    return undefined;
  }
  return findChatRowByMessageId(syncdb, context.message_id);
}

function historyToArray(value: any): MessageHistory[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as MessageHistory[];
  if (typeof value.toJS === "function") return value.toJS() as MessageHistory[];
  return [];
}

function appendRestartNotice(historyValue: any): MessageHistory[] {
  const history = historyToArray(historyValue);
  if (history.length === 0) {
    return [];
  }
  const first = history[0] as MessageHistory;
  const content =
    typeof first?.content === "string"
      ? first.content
      : `${(first as any)?.content ?? ""}`;
  if (/conversation interrupted/i.test(content)) {
    return history;
  }
  const sep = content.trim().length > 0 ? "\n\n" : "";
  return [
    {
      ...first,
      content: `${content}${sep}${RESTART_INTERRUPTED_NOTICE}`,
    },
    ...history.slice(1),
  ];
}

export async function recoverOrphanedAcpTurns(
  client: ConatClient,
): Promise<number> {
  let running;
  try {
    running = listRunningAcpTurnLeases({
      exclude_owner_instance_id: ACP_INSTANCE_ID,
    });
  } catch (err) {
    logger.warn("failed to list running acp turn leases", err);
    return 0;
  }
  if (!running.length) return 0;
  logger.warn("recovering orphaned acp turns", {
    instance: ACP_INSTANCE_ID,
    count: running.length,
  });
  let recovered = 0;
  for (const turn of running) {
    const context: AcpChatContext = {
      project_id: turn.project_id,
      path: turn.path,
      message_date: turn.message_date,
      sender_id: turn.sender_id ?? "openai-codex-agent",
      message_id: turn.message_id ?? undefined,
      thread_id: turn.thread_id ?? undefined,
      parent_message_id: (turn as any).parent_message_id ?? undefined,
    } as any;
    try {
      clearAcpPayloads(context);
    } catch (err) {
      logger.debug("failed clearing acp queue during recovery", {
        context,
        err,
      });
    }
    try {
      const syncdb = await acquireChatSyncDB({
        client,
        project_id: turn.project_id,
        path: turn.path,
      });
      try {
        if (!syncdb.isReady()) {
          await once(syncdb, "ready");
        }
        const senderId = turn.sender_id ?? "openai-codex-agent";
        const current = findRecoverableChatRow(syncdb, {
          message_date: turn.message_date,
          sender_id: senderId,
          message_id: turn.message_id ?? undefined,
        });
        const generating = syncdbField<boolean>(current, "generating");
        if (current != null && generating === true) {
          const history = appendRestartNotice(syncdbField(current, "history"));
          const rowDate =
            normalizeIsoDateString(syncdbField(current, "date")) ??
            normalizeIsoDateString(turn.message_date) ??
            turn.message_date;
          const rowSender =
            syncdbField<string>(current, "sender_id") ?? senderId;
          const update: any = {
            event: "chat",
            date: rowDate,
            sender_id: rowSender,
            generating: false,
            acp_interrupted: true,
            acp_interrupted_reason: "server_restart",
            acp_interrupted_text: RESTART_INTERRUPTED_NOTICE,
          };
          if (turn.message_id) {
            update.message_id = turn.message_id;
          }
          if (turn.thread_id) {
            update.thread_id = turn.thread_id;
          }
          if ((turn as any).parent_message_id) {
            update.parent_message_id = (turn as any).parent_message_id;
          }
          if (history.length > 0) {
            update.history = history;
          }
          syncdb.set(update);
          const threadId =
            syncdbField<string>(current, "thread_id") ?? turn.thread_id;
          if (threadId) {
            replaceThreadScopedRow(
              syncdb,
              THREAD_STATE_EVENT,
              threadId,
              buildThreadStateRecord({
                thread_id: threadId,
                state: "interrupted",
                active_message_id: syncdbField<string>(current, "message_id"),
                updated_at: new Date().toISOString(),
                schema_version: THREAD_STATE_SCHEMA_VERSION,
              }),
            );
            const cfgRow = preferredThreadConfigRow(syncdb, threadId);
            const rawLoopCfg = syncdbField<any>(cfgRow, "loop_config");
            const loopCfg =
              rawLoopCfg && typeof rawLoopCfg.toJS === "function"
                ? rawLoopCfg.toJS()
                : rawLoopCfg;
            const rawLoopState = syncdbField<any>(cfgRow, "loop_state");
            const loopStateCurrent =
              rawLoopState && typeof rawLoopState.toJS === "function"
                ? rawLoopState.toJS()
                : rawLoopState;
            if (
              loopCfg?.enabled === true &&
              loopStateCurrent &&
              loopStateCurrent.status !== "stopped"
            ) {
              const cfgObj =
                cfgRow && typeof cfgRow.toJS === "function"
                  ? cfgRow.toJS()
                  : (cfgRow ?? {});
              replaceThreadScopedRow(syncdb, THREAD_CONFIG_EVENT, threadId, {
                ...cfgObj,
                ...buildThreadConfigRecord({
                  thread_id: threadId,
                  updated_at: new Date().toISOString(),
                  updated_by: "__system__",
                  schema_version: THREAD_STATE_SCHEMA_VERSION,
                }),
                loop_state: {
                  ...loopStateCurrent,
                  status: "stopped",
                  stop_reason: "backend_error",
                  next_prompt: undefined,
                  updated_at_ms: Date.now(),
                },
              });
            }
          }
          syncdb.commit();
          await syncdb.save();
        }
      } finally {
        await releaseChatSyncDB(turn.project_id, turn.path);
      }
    } catch (err) {
      logger.warn("failed to recover orphaned acp chat row", {
        turn,
        err,
      });
    }
    try {
      finalizeAcpTurnLease({
        key: {
          project_id: turn.project_id,
          path: turn.path,
          message_date: turn.message_date,
        },
        state: "aborted",
        reason: "server restart recovery",
        owner_instance_id: ACP_INSTANCE_ID,
      });
      recovered += 1;
    } catch (err) {
      logger.warn("failed to finalize orphaned acp lease", {
        turn,
        err,
      });
    }
  }
  logger.warn("finished orphaned acp turn recovery", {
    instance: ACP_INSTANCE_ID,
    recovered,
    total: running.length,
  });
  return recovered;
}

function initializeAcpRuntime(client: ConatClient): void {
  // IMPORTANT: initialize sqlite with the same path used by the embedding
  // process before any ACP queue/lease tables are touched. Otherwise ACP can
  // accidentally lock the sqlite module onto a fallback cwd-relative file or a
  // Lite-only default that differs from project-host.
  const sqliteFilename =
    `${process.env.COCALC_LITE_SQLITE_FILENAME ?? ""}`.trim() ||
    path.join(data, "hub.db");
  initDatabase({ filename: sqliteFilename });
  conatClient = client;
  blobStore = getBlobstore(client);
}

export function configureAcpDetachedWorkerRunning(
  ensureRunning: typeof ensureAcpWorkerRunning | undefined,
): void {
  ensureDetachedWorkerRunning = ensureRunning ?? ensureAcpWorkerRunning;
}

export async function runDetachedAcpQueueWorker(
  client: ConatClient,
  options: {
    idleExitMs?: number | null;
    restartReason?: string;
  } = {},
): Promise<void> {
  initializeAcpRuntime(client);
  acpExecutionOwnedByCurrentProcess = true;
  startAcpInterruptPoller();
  if (typeof (client as any)?.waitUntilSignedIn === "function") {
    await (client as any).waitUntilSignedIn({ timeout: 5000 });
  }
  const idleExitMs =
    options.idleExitMs === undefined
      ? ACP_WORKER_IDLE_EXIT_MS
      : options.idleExitMs;
  const restartReason = options.restartReason ?? "worker restart";
  logger.warn("starting ACP queue worker", {
    instance: ACP_INSTANCE_ID,
    pid: process.pid,
    poll_ms: ACP_WORKER_POLL_MS,
    idle_exit_ms: idleExitMs,
  });
  await recoverOrphanedAcpTurns(client);
  markRunningAcpJobsInterrupted(restartReason);
  let idleSince = 0;
  while (true) {
    kickAllQueuedAcpJobs();
    const hasWork =
      listQueuedAcpJobs().length > 0 || listRunningAcpJobs().length > 0;
    if (hasWork) {
      idleSince = 0;
    } else if (!idleSince) {
      idleSince = Date.now();
    } else if (
      idleExitMs != null &&
      idleExitMs >= 0 &&
      Date.now() - idleSince >= idleExitMs
    ) {
      logger.warn("stopping ACP queue worker after idle timeout", {
        instance: ACP_INSTANCE_ID,
        pid: process.pid,
        idle_ms: Date.now() - idleSince,
      });
      return;
    }
    await sleep(ACP_WORKER_POLL_MS);
  }
}

type ExecutorAdapters = {
  workspaceRoot: string;
  fileAdapter: FileAdapter;
  terminalAdapter: TerminalAdapter;
  commandHandlers?: Record<string, any>;
};

function buildExecutorAdapters(
  executor: AcpExecutor,
  workspaceRoot: string,
  hostRoot: string,
): ExecutorAdapters {
  // In container mode we expect:
  // - container paths to live under /root (workspaceRoot is the container path)
  // - host paths to point to the bind mount on the host (never /root)
  // This lets us distinguish whether an incoming absolute path is host-side or
  // container-side. Warn early if we can't tell the difference.
  if (
    workspaceRoot.startsWith("/root") &&
    hostRoot.startsWith("/root") &&
    workspaceRoot !== hostRoot
  ) {
    logger.warn("hostRoot unexpectedly looks like a container path", {
      workspaceRoot,
      hostRoot,
    });
  }

  const shellHandler = async ({ command, args, cwd, env }: any) => {
    logger.debug("shellHandler exec", {
      command,
      args,
      cwd,
      env,
      workspaceRoot: normalizedWorkspace,
      hostRoot: normalizedHostRoot,
    });
    const joined =
      args && Array.isArray(args) && args.length > 0
        ? `${command} ${args.join(" ")}`
        : command;
    const result = await executor.exec(joined, {
      cwd,
      env,
    });
    return {
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      exitStatus: result.exitCode ?? undefined,
      signal: result.signal,
    };
  };

  const normalizedWorkspace = path.normalize(workspaceRoot || "/");
  const normalizedHostRoot = hostRoot ? path.normalize(hostRoot) : undefined;

  const toRelative = (p: string): string => {
    const absolute = path.isAbsolute(p)
      ? path.normalize(p)
      : path.resolve(normalizedWorkspace, path.normalize(p));

    // If the path is under the host mount, prefer that mapping.
    if (normalizedHostRoot && absolute.startsWith(normalizedHostRoot)) {
      const relHost = path.relative(normalizedHostRoot, absolute);
      if (relHost.startsWith("..")) {
        throw new Error(`path ${absolute} is outside host root`);
      }
      return relHost || ".";
    }

    // Otherwise, treat it as a container path relative to the workspaceRoot.
    const rel = path.relative(normalizedWorkspace, absolute);
    if (rel.startsWith("..")) {
      throw new Error(`path ${absolute} is outside workspace root`);
    }
    return rel || ".";
  };

  const fileAdapter: FileAdapter = {
    readTextFile: async (p: string) => {
      const rel = toRelative(p);
      return await executor.readTextFile(rel);
    },
    writeTextFile: async (p: string, content: string) => {
      const rel = toRelative(p);
      await executor.writeTextFile(rel, content);
    },
    toString: () => `FileAdapter(${executor})`,
  };

  const terminalAdapter: TerminalAdapter = {
    toString: () => `TerminalAdapter(${executor})`,
    async start(options: TerminalStartOptions, onOutput) {
      const { command, args, cwd, env, limit } = options;
      const joined =
        args && Array.isArray(args) && args.length > 0
          ? `${command} ${args.join(" ")}`
          : command;
      const relCwd = cwd ? toRelative(cwd) : undefined;
      const result = await executor.exec(joined, {
        cwd: relCwd,
        env,
      });
      let output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      let truncated = false;
      if (limit != null && output.length > limit) {
        output = output.slice(output.length - limit);
        truncated = true;
      }
      await onOutput(output);
      const exitStatus = {
        exitCode: result.exitCode ?? undefined,
        signal: result.signal,
      };
      return {
        async kill() {
          /* no-op for non-streaming exec */
        },
        async waitForExit() {
          return { exitStatus, output, truncated };
        },
      };
    },
  };

  return {
    workspaceRoot,
    fileAdapter,
    terminalAdapter,
    commandHandlers: {
      bash: shellHandler,
      sh: shellHandler,
      zsh: shellHandler,
    },
  };
}

async function ensureAgent(
  useNativeTerminal: boolean,
  bindings: ExecutorAdapters,
): Promise<AcpAgent> {
  const key = `${useNativeTerminal ? "native" : "proxy"}:${bindings.workspaceRoot}`;
  const existing = agents.get(key);
  if (existing != null) return existing;
  const mode = process.env.COCALC_ACP_MODE;
  logger.debug("ensureAgent", { mode, useNativeTerminal });
  if (mode === "echo") {
    logger.debug("ensureAgent: creating echo agent");
    const echo = new EchoAgent();
    agents.set(key, echo);
    return echo;
  }
  if (mode === "mock") {
    logger.debug("ensureAgent: creating mock agent");
    const script = await loadAcpMockScript();
    const mock = new MockAgent(script);
    agents.set(key, mock);
    return mock;
  }
  try {
    logger.debug("ensureAgent: creating codex exec agent");
    const created = await CodexExecAgent.create({
      binaryPath: process.env.COCALC_CODEX_BIN,
      cwd: bindings.workspaceRoot ?? process.cwd(),
    });
    logger.info("codex-exec agent ready", { key });
    agents.set(key, created);
    return created;
  } catch (err) {
    // Fail loudly: use an echo agent that emits an explicit error to the user.
    logger.error("failed to start codex-exec agent; using echo agent", err);
    const echo = new EchoAgent(
      `ERROR: codex-exec failed to start (${(err as Error)?.message ?? "unknown error"})`,
    );
    agents.set(key, echo);
    return echo;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === "localhost" || lower === "::1" || lower.startsWith("127.");
}

function normalizeApiUrl(
  raw: string,
  { rewriteLoopbackHost }: { rewriteLoopbackHost: boolean },
): string | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return;
  try {
    const parsed = new URL(trimmed);
    if (rewriteLoopbackHost && isLoopbackHostname(parsed.hostname)) {
      parsed.hostname = "host.containers.internal";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function resolveCodexApiUrl({
  useContainer,
  request,
}: {
  useContainer: boolean;
  request?: AcpRequest;
}): string {
  const explicit =
    `${process.env.COCALC_API_URL ?? process.env.BASE_URL ?? ""}`.trim();
  const masterConat =
    `${process.env.MASTER_CONAT_SERVER ?? process.env.COCALC_MASTER_CONAT_SERVER ?? ""}`.trim();
  const browserOrigin = `${request?.chat?.api_url ?? ""}`.trim();

  if (useContainer) {
    // In project-host/container mode, Codex needs the hub/master URL, not the
    // project-host listener URL (PORT), to reach account-scoped browser APIs.
    const containerPreferred = normalizeApiUrl(masterConat, {
      rewriteLoopbackHost: true,
    });
    if (containerPreferred) return containerPreferred;

    const explicitContainer = normalizeApiUrl(explicit, {
      rewriteLoopbackHost: true,
    });
    if (explicitContainer) return explicitContainer;

    const browserFallback = normalizeApiUrl(browserOrigin, {
      rewriteLoopbackHost: false,
    });
    if (browserFallback) return browserFallback;

    const port = `${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`.trim();
    return `http://host.containers.internal:${port || "9100"}`;
  }

  const explicitLocal = normalizeApiUrl(explicit, {
    rewriteLoopbackHost: false,
  });
  if (explicitLocal) return explicitLocal;

  const port = `${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`.trim();
  // In lite mode Codex runs on the same machine as the hub process.
  // Prefer loopback to avoid DNS/port-forward/public-origin indirection.
  return `http://localhost:${port || "9100"}`;
}

function buildCodexRuntimeEnv({
  request,
  projectId,
  includeCliBin,
  useContainer,
}: {
  request: AcpRequest;
  projectId: string;
  includeCliBin: boolean;
  useContainer: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  const accountId = `${request.account_id ?? ""}`.trim();
  if (accountId) out.COCALC_ACCOUNT_ID = accountId;
  if (projectId) out.COCALC_PROJECT_ID = projectId;
  const browserId = `${request.chat?.browser_id ?? ""}`.trim();
  if (browserId) out.COCALC_BROWSER_ID = browserId;
  out.COCALC_API_URL = resolveCodexApiUrl({
    useContainer,
    request,
  });
  out.COCALC_CLI_AGENT_MODE = "1";
  const bearer =
    `${process.env.COCALC_BEARER_TOKEN ?? ""}`.trim() ||
    `${process.env.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (bearer) {
    out.COCALC_BEARER_TOKEN = bearer;
    out.COCALC_AGENT_TOKEN = bearer;
  }
  if (includeCliBin) {
    const cliBin = `${process.env.COCALC_CLI_BIN ?? ""}`.trim();
    if (cliBin) out.COCALC_CLI_BIN = cliBin;
  }
  if (request.runtime_env) {
    for (const [key, value] of Object.entries(request.runtime_env)) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (normalized) {
        out[key] = normalized;
      }
    }
  }
  return out;
}

type AcpExecutionResult = {
  terminalState: "completed" | "error" | "interrupted";
};

async function executeAcpRequest({
  stream,
  ...request
}: AcpRequest & {
  stream: (payload?: AcpStreamPayload | null) => Promise<void>;
}): Promise<AcpExecutionResult> {
  const reqId = randomUUID();
  const startedAt = Date.now();
  const { config } = request;
  const projectId = request.chat?.project_id ?? request.project_id;
  const sessionMode = resolveCodexSessionMode(config);
  const workspaceRoot = resolveWorkspaceRoot(config);
  logger.debug("evaluate: start", {
    reqId,
    session_id: request.session_id,
    chat: request.chat,
    projectId,
    config,
    sessionMode,
    workspaceRoot,
  });
  if (!projectId) {
    throw Error("project_id must be set");
  }
  const executor: AcpExecutor = preferContainerExecutor()
    ? new ContainerExecutor({
        projectId,
        workspaceRoot,
        conatClient: conatClient!,
      })
    : new LocalExecutor(workspaceRoot);
  const effectiveConfig = {
    ...(config ?? {}),
    workingDirectory: workspaceRoot,
  };
  const useContainer = preferContainerExecutor();
  const runtimeEnv = buildCodexRuntimeEnv({
    request,
    projectId,
    includeCliBin: !useContainer,
    useContainer,
  });
  const hostRoot =
    useContainer && executor instanceof ContainerExecutor
      ? executor.getMountPoint()
      : workspaceRoot;
  // Container mode must always proxy terminals (useNativeTerminal=false) so ACP
  // routes commands through our adapter into the project container. In local
  // mode, respect "auto" behavior.
  const useNativeTerminal = useContainer ? false : sessionMode === "auto";
  logger.debug("evaluate: mode selection", {
    useContainer,
    workspaceRoot,
    project_id: projectId,
    useNativeTerminal,
  });
  if (useContainer && !conatClient) {
    throw Error("conat client must be initialized");
  }
  const bindings = buildExecutorAdapters(executor, workspaceRoot, hostRoot);
  const currentAgent = await ensureAgent(useNativeTerminal, bindings);
  const { prompt, cleanup } = await materializeBlobs(request.prompt ?? "");
  if (!conatClient) {
    throw Error("conat client must be initialized");
  }
  const chatWriter = request.chat
    ? new ChatStreamWriter({
        metadata: request.chat,
        client: conatClient,
        approverAccountId: request.account_id,
        sessionKey: request.session_id,
        workspaceRoot,
        hostWorkspaceRoot: hostRoot,
      })
    : null;

  let wrappedStream;
  stream({ type: "status", state: "init" });
  if (chatWriter != null) {
    await chatWriter.waitUntilReady();
    if (chatWriter.isClosed()) {
      throw Error(
        `failed to initialize chat writer -- ${chatWriter.syncdbError}`,
      );
    }
    wrappedStream = async (payload?: AcpStreamPayload | null) => {
      try {
        await chatWriter.handle(payload);
      } catch (err) {
        logger.warn("chat writer handle failed", err);
      }
      if (payload == null) {
        stream(null);
      }
    };
  } else {
    wrappedStream = stream;
  }

  const loopConfig = normalizeLoopConfig(request.chat?.loop_config);
  const loopEnabled = !!(loopConfig && chatWriter && request.chat?.thread_id);
  let loopState: AcpLoopState | undefined = loopEnabled
    ? (() => {
        const existing = request.chat?.loop_state;
        if (
          existing &&
          typeof existing.loop_id === "string" &&
          existing.loop_id.trim().length > 0 &&
          existing.status !== "stopped"
        ) {
          const iteration = clampLoopNumber(existing.iteration, 1, 1, 10_000);
          return {
            ...existing,
            iteration,
            updated_at_ms: Date.now(),
            status: "running",
            stop_reason: undefined,
          };
        }
        const now = Date.now();
        return {
          loop_id: randomUUID(),
          status: "running",
          started_at_ms: now,
          updated_at_ms: now,
          iteration: 1,
          max_turns: loopConfig?.max_turns,
          max_wall_time_ms: loopConfig?.max_wall_time_ms,
        };
      })()
    : undefined;
  const loopStartedAt = loopState?.started_at_ms ?? Date.now();

  const persistLoopState = async () => {
    if (!chatWriter || !loopEnabled) return;
    await chatWriter.persistLoopState({
      loopConfig,
      loopState,
    });
  };

  let terminalState: AcpExecutionResult["terminalState"] = "completed";
  try {
    if (loopEnabled) {
      await persistLoopState();
    }
    logger.debug("evaluate: running", {
      reqId,
      loopEnabled,
      loopId: loopState?.loop_id,
      iteration: loopState?.iteration,
    });
    let iterationPrompt = prompt;
    let continueLoop = true;
    while (continueLoop) {
      stream({ type: "status", state: "running" });
      if (loopEnabled && loopState && loopState.iteration > 1 && chatWriter) {
        chatWriter.beginLoopIteration();
      }
      let terminalFallbackError: string | undefined;
      try {
        await currentAgent.evaluate({
          ...request,
          prompt: iterationPrompt,
          runtime_env: runtimeEnv,
          config: effectiveConfig,
          stream: wrappedStream,
        });
        logger.debug("evaluate: done", {
          reqId,
          iteration: loopState?.iteration,
        });
      } catch (err) {
        logger.warn("evaluate: agent failed", {
          reqId,
          iteration: loopState?.iteration,
          err,
        });
        terminalFallbackError = `codex agent failed: ${(err as Error)?.message ?? err}`;
        try {
          await wrappedStream({
            type: "error",
            error: terminalFallbackError,
          });
        } catch (streamErr) {
          logger.warn("evaluate: failed to stream error", streamErr);
        }
      }
      if (chatWriter != null) {
        const snapshot = chatWriter.watchdogSnapshot();
        if (!snapshot.finished) {
          logger.warn("evaluate: forcing terminal ACP payload", {
            reqId,
            messageDate: snapshot.messageDate,
            path: snapshot.path,
            events: snapshot.events,
            fallback: terminalFallbackError ? "error" : "summary",
            iteration: loopState?.iteration,
          });
          try {
            await chatWriter.handle(
              terminalFallbackError
                ? { type: "error", error: terminalFallbackError }
                : { type: "summary", finalResponse: "" },
            );
          } catch (err) {
            logger.warn("evaluate: failed forced terminal payload", {
              reqId,
              err,
            });
          }
        }
      }

      if (!loopEnabled || !loopState || !chatWriter) {
        break;
      }

      const now = Date.now();
      loopState = {
        ...loopState,
        status: "waiting_decision",
        updated_at_ms: now,
      };
      await persistLoopState();

      const maxTurns = loopConfig?.max_turns ?? LOOP_DEFAULT_MAX_TURNS;
      const maxWallTimeMs =
        loopConfig?.max_wall_time_ms ?? LOOP_DEFAULT_MAX_WALL_TIME_MS;
      const checkInEveryTurns =
        loopConfig?.check_in_every_turns ?? LOOP_DEFAULT_CHECK_IN_EVERY_TURNS;
      const repeatedBlockerLimit =
        loopConfig?.stop_on_repeated_blocker_count ??
        LOOP_DEFAULT_REPEATED_BLOCKER_LIMIT;

      const summaryText =
        chatWriter.getLatestSummaryText() ??
        chatWriter.getLoopFallbackSummary();
      const decision = parseLoopContractDecision(summaryText);

      let stopReason: AcpLoopStopReason | undefined;
      let nextStatus: AcpLoopState["status"] = "stopped";
      if (chatWriter.wasInterrupted()) {
        stopReason = "user_stopped";
      } else if (Date.now() - loopStartedAt >= maxWallTimeMs) {
        stopReason = "max_wall_time";
      } else if (loopState.iteration >= maxTurns) {
        stopReason = "max_turns";
      } else if (!decision) {
        stopReason = terminalFallbackError
          ? "backend_error"
          : "missing_contract";
      } else if (decision.needs_human) {
        stopReason = "needs_human";
        nextStatus = "paused";
      } else if (decision.rerun !== true) {
        stopReason = "completed";
      }

      const blockerSignature = `${decision?.blocker ?? ""}`
        .trim()
        .toLowerCase();
      if (!stopReason && blockerSignature) {
        const prevSig = `${loopState.last_blocker_signature ?? ""}`
          .trim()
          .toLowerCase();
        const repeatedCount =
          prevSig && prevSig === blockerSignature
            ? (loopState.repeated_blocker_count ?? 0) + 1
            : 1;
        loopState = {
          ...loopState,
          last_blocker_signature: blockerSignature,
          repeated_blocker_count: repeatedCount,
          updated_at_ms: Date.now(),
        };
        if (repeatedCount >= repeatedBlockerLimit) {
          stopReason = "repeated_blocker";
        }
      }

      if (
        !stopReason &&
        checkInEveryTurns > 0 &&
        loopState.iteration > 0 &&
        loopState.iteration % checkInEveryTurns === 0
      ) {
        stopReason = "needs_human";
        nextStatus = "paused";
      }

      if (stopReason) {
        loopState = {
          ...loopState,
          status: nextStatus,
          stop_reason: stopReason,
          next_prompt: undefined,
          updated_at_ms: Date.now(),
        };
        await persistLoopState();
        chatWriter.markLoopStopped(stopReason);
        break;
      }

      const nextPrompt = `${decision?.next_prompt ?? ""}`.trim();
      if (!nextPrompt) {
        loopState = {
          ...loopState,
          status: "stopped",
          stop_reason: "invalid_contract",
          next_prompt: undefined,
          updated_at_ms: Date.now(),
        };
        await persistLoopState();
        chatWriter.markLoopStopped("invalid_contract");
        break;
      }

      loopState = {
        ...loopState,
        status: "scheduled",
        next_prompt: nextPrompt,
        updated_at_ms: Date.now(),
      };
      await persistLoopState();

      let sleepMs = loopConfig?.sleep_ms_between_turns ?? 0;
      if (typeof decision?.sleep_sec === "number") {
        sleepMs = clampLoopNumber(
          decision.sleep_sec * 1000,
          sleepMs,
          0,
          60_000,
        );
      }
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }

      iterationPrompt = nextPrompt;
      loopState = {
        ...loopState,
        status: "running",
        next_prompt: undefined,
        iteration: loopState.iteration + 1,
        updated_at_ms: Date.now(),
      };
      await persistLoopState();

      continueLoop = true;
    }
  } finally {
    terminalState = chatWriter?.getTerminalState() ?? terminalState;
    const elapsedMs = Date.now() - startedAt;
    logger.debug("evaluate: end", { reqId, elapsedMs });
    // TODO: we might not want to immediately close, since there is
    // overhead in creating the syncdoc each time.
    chatWriter?.dispose();
    await cleanup();
  }
  return { terminalState };
}

function acpJobThreadKey({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): string {
  return `${project_id}:${path}:${thread_id}`;
}

function maybeDecorateQueuedPromptForJob({
  prompt,
  job,
}: {
  prompt: string;
  job: Pick<AcpJobRow, "created_at" | "send_mode">;
}): string {
  if (job.send_mode === "immediate") return prompt;
  const delayMs = Date.now() - job.created_at;
  if (
    !Number.isFinite(delayMs) ||
    delayMs < ACP_QUEUED_PROMPT_NOTE_THRESHOLD_MS
  ) {
    return prompt;
  }
  return [
    `System note: this message was queued for ${formatQueuedDelay(
      delayMs,
    )} while another turn was active, and is being sent automatically now.`,
    "",
    prompt,
  ].join("\n");
}

async function withChatSyncDB<T>({
  client,
  project_id,
  path,
  fn,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  fn: (syncdb: SyncDB) => Promise<T>;
}): Promise<T> {
  const syncdb = await acquireChatSyncDB({
    client,
    project_id,
    path,
  });
  try {
    if (!syncdb.isReady()) {
      await once(syncdb, "ready");
    }
    return await fn(syncdb);
  } finally {
    await releaseChatSyncDB(project_id, path);
  }
}

function latestThreadMessageIdInSyncDB({
  syncdb,
  threadId,
  excludeMessageId,
}: {
  syncdb: SyncDB;
  threadId: string;
  excludeMessageId?: string;
}): string | undefined {
  const rows = syncdbRowsMatching(syncdb, {
    event: "chat",
    thread_id: threadId,
  });
  let bestMessageId: string | undefined;
  let bestDate = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const messageId = `${syncdbField<string>(row, "message_id") ?? ""}`.trim();
    if (!messageId || messageId === excludeMessageId) continue;
    const date =
      normalizeIsoDateString(syncdbField<string>(row, "date")) ??
      `${syncdbField<string>(row, "date") ?? ""}`;
    const parsed = Date.parse(date);
    if (!Number.isFinite(parsed)) continue;
    if (parsed >= bestDate) {
      bestDate = parsed;
      bestMessageId = messageId;
    }
  }
  return bestMessageId;
}

function threadHasRunningState(syncdb: SyncDB, threadId: string): boolean {
  const rows = syncdbRowsMatching(syncdb, {
    event: THREAD_STATE_EVENT,
    thread_id: threadId,
  });
  return rows.some((row) => syncdbField<string>(row, "state") === "running");
}

async function persistQueuedUserMessageProjection({
  client,
  project_id,
  path,
  thread_id,
  user_message_id,
  queued,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  queued: boolean;
}): Promise<"queued" | "running" | null> {
  return await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      const waitingInLine = threadHasRunningState(syncdb, thread_id);
      const projectedMessageState = queued
        ? waitingInLine
          ? "queued"
          : "running"
        : null;
      const current = findChatRowByMessageId(syncdb, user_message_id);
      if (current != null) {
        const rowDate =
          normalizeIsoDateString(syncdbField<string>(current, "date")) ??
          undefined;
        const rowSender = syncdbField<string>(current, "sender_id");
        if (rowDate && rowSender) {
          const update: Record<string, unknown> = {
            event: "chat",
            date: rowDate,
            sender_id: rowSender,
            message_id: user_message_id,
            thread_id: syncdbField<string>(current, "thread_id") ?? thread_id,
            acp_state: projectedMessageState,
          };
          const parentMessageId = syncdbField<string>(
            current,
            "parent_message_id",
          );
          if (parentMessageId) {
            update.parent_message_id = parentMessageId;
          }
          syncdb.set(update);
        }
      }

      if (!waitingInLine) {
        const nextQueued = queued
          ? user_message_id
          : listQueuedAcpJobsForThread({
              project_id,
              path,
              thread_id,
            })[0]?.user_message_id;
        replaceThreadScopedRow(
          syncdb,
          THREAD_STATE_EVENT,
          thread_id,
          buildThreadStateRecord({
            thread_id,
            state: nextQueued ? "queued" : "idle",
            active_message_id: nextQueued,
            updated_at: new Date().toISOString(),
            schema_version: THREAD_STATE_SCHEMA_VERSION,
          }),
        );
      }

      syncdb.commit();
      await syncdb.save();
      return projectedMessageState;
    },
  });
}

async function prepareQueuedUserMessageForExecution({
  client,
  project_id,
  path,
  thread_id,
  user_message_id,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
}): Promise<void> {
  await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      const current = findChatRowByMessageId(syncdb, user_message_id);
      if (current != null) {
        const rowDate =
          normalizeIsoDateString(syncdbField<string>(current, "date")) ??
          undefined;
        const rowSender = syncdbField<string>(current, "sender_id");
        if (rowDate && rowSender) {
          const latestParentMessageId = latestThreadMessageIdInSyncDB({
            syncdb,
            threadId: thread_id,
            excludeMessageId: user_message_id,
          });
          const update: Record<string, unknown> = {
            event: "chat",
            date: rowDate,
            sender_id: rowSender,
            message_id: user_message_id,
            thread_id: syncdbField<string>(current, "thread_id") ?? thread_id,
            acp_state: null,
          };
          const currentParentMessageId = syncdbField<string>(
            current,
            "parent_message_id",
          );
          const effectiveParentMessageId =
            latestParentMessageId ?? currentParentMessageId;
          if (effectiveParentMessageId) {
            update.parent_message_id = effectiveParentMessageId;
          }
          syncdb.set(update);
          syncdb.commit();
          await syncdb.save();
        }
      }
    },
  });
}

async function writeQueuedJobFailureToChat({
  request,
  error,
}: {
  request: AcpRequest;
  error: string;
}): Promise<void> {
  if (!request.chat || !conatClient) return;
  try {
    const writer = new ChatStreamWriter({
      metadata: request.chat,
      client: conatClient,
      approverAccountId: request.account_id,
      sessionKey: request.session_id,
      workspaceRoot: resolveWorkspaceRoot(request.config),
      hostWorkspaceRoot: resolveWorkspaceRoot(request.config),
    });
    await writer.waitUntilReady();
    if (writer.isClosed()) {
      throw new Error(
        `failed to initialize chat writer -- ${writer.syncdbError ?? "unknown"}`,
      );
    }
    await writer.handle({ type: "error", error });
    await writer.handle(null);
  } catch (writerErr) {
    logger.warn("failed to write queued acp job failure to chat", {
      chat: request.chat,
      error,
      writerErr,
    });
  }
}

async function runQueuedAcpJob(job: AcpJobRow): Promise<void> {
  const request = decodeAcpJobRequest(job);
  const project_id = `${job.project_id}`.trim();
  const path = `${job.path}`.trim();
  const thread_id = `${job.thread_id}`.trim();
  const user_message_id = `${job.user_message_id}`.trim();
  if (!project_id || !path || !thread_id || !user_message_id) {
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: "queued acp job missing required thread identity",
    });
    return;
  }
  if (!conatClient) {
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: "conat client must be initialized",
    });
    return;
  }
  try {
    await prepareQueuedUserMessageForExecution({
      client: conatClient,
      project_id,
      path,
      thread_id,
      user_message_id,
    });
  } catch (err) {
    logger.warn("failed preparing queued acp user message for execution", {
      job: job.op_id,
      project_id,
      path,
      thread_id,
      user_message_id,
      err,
    });
  }

  request.prompt = maybeDecorateQueuedPromptForJob({
    prompt: request.prompt ?? "",
    job,
  });

  try {
    const result = await executeAcpRequest({
      ...request,
      stream: async () => {},
    });
    setAcpJobState({
      op_id: job.op_id,
      state: result.terminalState,
    });
  } catch (err) {
    const message = `ACP queued job failed: ${(err as Error)?.message ?? err}`;
    logger.warn("queued acp job execution failed", {
      op_id: job.op_id,
      err,
    });
    await writeQueuedJobFailureToChat({
      request,
      error: message,
    });
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: message,
    });
  }
}

async function pumpQueuedAcpJobsForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): Promise<void> {
  while (true) {
    const job = claimNextQueuedAcpJobForThread({
      project_id,
      path,
      thread_id,
    });
    if (!job) {
      return;
    }
    await runQueuedAcpJob(job);
  }
}

function kickQueuedAcpJobsForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): void {
  const key = acpJobThreadKey({ project_id, path, thread_id });
  if (pumpingAcpJobThreads.has(key)) {
    return;
  }
  pumpingAcpJobThreads.add(key);
  void pumpQueuedAcpJobsForThread({
    project_id,
    path,
    thread_id,
  })
    .catch((err) => {
      logger.warn("queued acp thread pump failed", {
        project_id,
        path,
        thread_id,
        err,
      });
    })
    .finally(() => {
      pumpingAcpJobThreads.delete(key);
      if (
        listQueuedAcpJobsForThread({
          project_id,
          path,
          thread_id,
        }).length > 0
      ) {
        kickQueuedAcpJobsForThread({ project_id, path, thread_id });
      }
    });
}

function kickAllQueuedAcpJobs(): void {
  const seen = new Set<string>();
  for (const job of listQueuedAcpJobs()) {
    const key = acpJobThreadKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    kickQueuedAcpJobsForThread(job);
  }
}

function resolveRunningInterruptKey({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): string {
  const running = listRunningAcpTurnLeases().find(
    (row) =>
      row.project_id === project_id &&
      row.path === path &&
      row.thread_id === thread_id &&
      row.state === "running",
  );
  return `${running?.session_id ?? thread_id}`.trim() || thread_id;
}

function resolveInterruptCandidateIds({
  project_id,
  path,
  thread_id,
}: {
  project_id?: string;
  path?: string;
  thread_id?: string;
}): string[] {
  const ids = new Set<string>();
  const projectId = `${project_id ?? ""}`.trim();
  const chatPath = `${path ?? ""}`.trim();
  const threadId = `${thread_id ?? ""}`.trim();
  if (threadId) {
    ids.add(threadId);
  }
  try {
    for (const row of listRunningAcpTurnLeases()) {
      if (projectId && row.project_id !== projectId) continue;
      if (chatPath && row.path !== chatPath) continue;
      if (
        threadId &&
        row.thread_id !== threadId &&
        `${row.session_id ?? ""}`.trim() !== threadId
      ) {
        continue;
      }
      const sessionId = `${row.session_id ?? ""}`.trim();
      if (sessionId) {
        ids.add(sessionId);
      }
      const runningThreadId = `${row.thread_id ?? ""}`.trim();
      if (runningThreadId) {
        ids.add(runningThreadId);
      }
    }
  } catch (err) {
    logger.debug("failed to resolve interrupt candidates from leases", {
      project_id: projectId,
      path: chatPath,
      thread_id: threadId,
      err,
    });
  }
  return [...ids];
}

async function tryInterruptCandidateIds({
  threadId,
  chat,
  candidateIds,
  notifyText = INTERRUPT_STATUS_TEXT,
}: {
  threadId?: string;
  chat?: AcpChatContext;
  candidateIds?: string[];
  notifyText?: string;
}): Promise<boolean> {
  const writer = findChatWriter({ threadId, chat });
  const ids = new Set<string>();
  for (const id of candidateIds ?? []) {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) ids.add(trimmed);
  }
  if (threadId) {
    ids.add(threadId);
  }
  writer?.getKnownThreadIds().forEach((id) => {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) ids.add(trimmed);
  });

  for (const id of ids) {
    if (await interruptCodexSession(id)) {
      writer?.notifyInterrupted(notifyText);
      return true;
    }
  }
  return false;
}

function enqueueInterruptRequestForExecution({
  project_id,
  path,
  thread_id,
  chat,
  candidateIds,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  chat?: AcpChatContext;
  candidateIds?: string[];
}): void {
  enqueueAcpInterrupt({
    project_id,
    path,
    thread_id,
    candidate_ids: candidateIds,
    chat,
  });
}

async function processPendingAcpInterruptsOnce(): Promise<void> {
  if (acpInterruptPollInFlight) return;
  acpInterruptPollInFlight = true;
  try {
    for (const row of listPendingAcpInterrupts()) {
      const ageMs = Date.now() - row.created_at;
      const chat = decodeAcpInterruptChat(row);
      const handled = await tryInterruptCandidateIds({
        threadId: row.thread_id,
        chat,
        candidateIds: [
          ...decodeAcpInterruptCandidateIds(row),
          ...resolveInterruptCandidateIds({
            project_id: row.project_id,
            path: row.path,
            thread_id: row.thread_id,
          }),
        ],
      });
      if (handled) {
        markAcpInterruptHandled({ id: row.id });
      } else if (ageMs >= ACP_INTERRUPT_MAX_AGE_MS) {
        markAcpInterruptError({
          id: row.id,
          error: "unable to interrupt codex session",
        });
      }
    }
  } finally {
    acpInterruptPollInFlight = false;
  }
}

function startAcpInterruptPoller(): void {
  if (acpInterruptPollerStarted) return;
  acpInterruptPollerStarted = true;
  const timer = setInterval(() => {
    void processPendingAcpInterruptsOnce().catch((err) => {
      logger.warn("ACP interrupt poll failed", err);
    });
  }, ACP_INTERRUPT_POLL_MS);
  timer.unref?.();
  void processPendingAcpInterruptsOnce().catch((err) => {
    logger.warn("ACP initial interrupt poll failed", err);
  });
}

async function enqueueChatAcpTurn({
  request,
  stream,
}: {
  request: AcpRequest;
  stream: (payload?: AcpStreamPayload | null) => Promise<void>;
}): Promise<void> {
  if (!request.chat) {
    throw new Error("chat metadata is required to enqueue an ACP turn");
  }
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  const row = enqueueAcpJob(request);
  const projectedState = await persistQueuedUserMessageProjection({
    client: conatClient,
    project_id: row.project_id,
    path: row.path,
    thread_id: row.thread_id,
    user_message_id: row.user_message_id,
    queued: row.state === "queued",
  });
  await stream({
    type: "status",
    state:
      row.state === "running" || projectedState === "running"
        ? "running"
        : "queued",
  });
  await stream(null);
  if (liteUseDetachedAcpWorker()) {
    await ensureDetachedWorkerRunning({ force: true });
  } else {
    kickAllQueuedAcpJobs();
  }
}

async function handleAcpControlRequest(
  request: AcpControlRequest,
): Promise<AcpControlResponse> {
  const project_id = `${request.project_id ?? ""}`.trim();
  const path = `${request.path ?? ""}`.trim();
  const thread_id = `${request.thread_id ?? ""}`.trim();
  const user_message_id = `${request.user_message_id ?? ""}`.trim();
  if (!project_id || !path || !thread_id || !user_message_id) {
    throw new Error("ACP control request is missing required fields");
  }
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  if (request.action === "cancel") {
    const row = cancelQueuedAcpJob({
      project_id,
      path,
      user_message_id,
    });
    if (!row || row.state !== "canceled") {
      return { ok: false, state: row?.state ?? "missing" };
    }
    await persistQueuedUserMessageProjection({
      client: conatClient,
      project_id,
      path,
      thread_id,
      user_message_id,
      queued: false,
    });
    return { ok: true, state: "canceled" };
  }
  if (request.action === "send_immediately") {
    const row = reprioritizeAcpJobImmediate({
      project_id,
      path,
      user_message_id,
    });
    if (!row || row.state !== "queued") {
      return { ok: false, state: row?.state ?? "missing" };
    }
    const interruptKey = resolveRunningInterruptKey({
      project_id,
      path,
      thread_id,
    });
    try {
      await handleInterruptRequest({
        project_id,
        account_id: request.account_id,
        threadId: interruptKey,
        chat: {
          project_id,
          path,
          thread_id,
          message_date: "",
          sender_id: "",
        },
      });
    } catch (err) {
      logger.debug("send-immediately did not interrupt an active turn", {
        project_id,
        path,
        thread_id,
        user_message_id,
        err,
      });
    }
    if (liteUseDetachedAcpWorker()) {
      await ensureDetachedWorkerRunning({ force: true });
    } else {
      kickAllQueuedAcpJobs();
    }
    return { ok: true, state: "queued" };
  }
  throw new Error(`unsupported ACP control action: ${request.action}`);
}

export async function evaluate({
  stream,
  ...request
}: AcpRequest & {
  stream: (payload?: AcpStreamPayload | null) => Promise<void>;
}): Promise<void> {
  if (request.chat) {
    await enqueueChatAcpTurn({ request, stream });
    return;
  }
  await executeAcpRequest({ ...request, stream });
}

export async function init(
  client: ConatClient,
  options: {
    manageDetachedWorker?: boolean;
  } = {},
): Promise<void> {
  logger.debug(
    "initializing ACP conat server",
    "preferContainerExecutor =",
    preferContainerExecutor(),
  );
  initializeAcpRuntime(client);
  process.once("exit", () => {
    void disposeAcpAgents();
  });
  await initConatAcp(
    {
      evaluate,
      interrupt: handleInterruptRequest,
      forkSession: handleForkSessionRequest,
      control: handleAcpControlRequest,
    },
    client,
  );
  if (options.manageDetachedWorker !== false) {
    if (liteUseDetachedAcpWorker()) {
      acpExecutionOwnedByCurrentProcess = false;
      startAcpWorkerSupervisor();
      await ensureDetachedWorkerRunning();
    } else {
      acpExecutionOwnedByCurrentProcess = true;
      logger.warn(
        "ACP detached worker disabled in Lite; using same-process queue execution",
      );
      await recoverOrphanedAcpTurns(client);
      markRunningAcpJobsInterrupted("server restart");
      startAcpInterruptPoller();
      kickAllQueuedAcpJobs();
    }
  } else {
    acpExecutionOwnedByCurrentProcess = false;
  }
}

type BlobReference = {
  url: string;
  uuid: string;
  filename?: string;
};

async function materializeBlobs(
  prompt: string,
): Promise<{ prompt: string; cleanup: () => Promise<void> }> {
  if (!blobStore) {
    return { prompt, cleanup: async () => {} };
  }
  const refs = extractBlobReferences(prompt);
  if (!refs.length) {
    return { prompt, cleanup: async () => {} };
  }
  const unique = dedupeRefs(refs);
  if (!unique.length) {
    return { prompt, cleanup: async () => {} };
  }
  const started = performance.now();
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `cocalc-blobs-${randomUUID()}-`),
  );
  const attachments: { url: string; path: string }[] = [];
  let bytes = 0;
  try {
    for (const ref of unique) {
      try {
        const data = await blobStore!.get(ref.uuid);
        if (data == null) continue;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const safeName = buildSafeFilename(ref);
        const filePath = path.join(tempDir, safeName);
        await fs.writeFile(filePath, buffer);
        bytes += buffer.byteLength;
        attachments.push({ url: ref.url, path: filePath });
      } catch (err) {
        logger.warn("failed to materialize blob", { ref, err });
      }
    }
    const durationMs = performance.now() - started;
    logger.debug("materialized chat blobs", {
      refs: unique.length,
      attachments: attachments.length,
      bytes,
      durationMs: roundMs(durationMs),
    });
    if (durationMs >= ACP_BLOB_MATERIALIZE_SLOW_MS) {
      logger.warn("materialize chat blobs slow", {
        refs: unique.length,
        attachments: attachments.length,
        bytes,
        durationMs: roundMs(durationMs),
      });
    }
    if (!attachments.length) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return { prompt, cleanup: async () => {} };
    }
    const info = attachments
      .map(
        (att, idx) =>
          `Attachment ${idx + 1}: saved at ${att.path} (source ${att.url})`,
      )
      .join("\n");
    const augmented = `${prompt}\n\nAttachments saved locally:\n${info}\n`;
    return {
      prompt: augmented,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    logger.warn("failed to prepare attachments", {
      refs: unique.length,
      attachments: attachments.length,
      bytes,
      durationMs: roundMs(performance.now() - started),
      err,
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    return { prompt, cleanup: async () => {} };
  }
}

function dedupeRefs(refs: BlobReference[]): BlobReference[] {
  const seen = new Set<string>();
  const result: BlobReference[] = [];
  for (const ref of refs) {
    if (seen.has(ref.uuid)) continue;
    seen.add(ref.uuid);
    result.push(ref);
  }
  return result;
}

function buildSafeFilename(ref: BlobReference): string {
  const baseName = sanitizeFilename(ref.filename || ref.uuid);
  const extension = path.extname(baseName);
  const finalName =
    extension.length > 0 ? baseName : `${baseName || ref.uuid}.bin`;
  return `${ref.uuid}-${finalName}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extractBlobReferences(prompt: string): BlobReference[] {
  const urls = new Set<string>();
  const markdown = /!\[[^\]]*\]\(([^)]+\/blobs\/[^)]+)\)/gi;
  const html = /<img[^>]+src=["']([^"']+\/blobs\/[^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  while ((match = html.exec(prompt)) != null) {
    urls.add(match[1]);
  }
  const refs: BlobReference[] = [];
  for (const url of urls) {
    const parsed = parseBlobReference(url);
    if (parsed?.uuid) {
      refs.push(parsed);
    }
  }
  return refs;
}

function parseBlobReference(target: string): BlobReference | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(
      trimmed,
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? undefined
        : "http://placeholder",
    );
    if (!url.pathname.includes("/blobs/")) {
      return undefined;
    }
    const uuid = url.searchParams.get("uuid");
    if (!uuid) return undefined;
    const filename = path.basename(url.pathname);
    return {
      url: trimmed,
      uuid,
      filename,
    };
  } catch {
    return undefined;
  }
}

async function handleInterruptRequest(
  request: AcpInterruptRequest,
): Promise<void> {
  const project_id =
    `${request.project_id ?? request.chat?.project_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? ""}`.trim();
  const threadId =
    `${request.threadId ?? request.chat?.thread_id ?? ""}`.trim();
  const candidateIds = resolveInterruptCandidateIds({
    project_id,
    path,
    thread_id: threadId,
  });

  if (
    await tryInterruptCandidateIds({
      threadId,
      chat: request.chat,
      candidateIds,
    })
  ) {
    return;
  }
  if (!project_id || !path || !threadId) {
    throw Error("unable to interrupt codex session");
  }
  enqueueInterruptRequestForExecution({
    project_id,
    path,
    thread_id: threadId,
    chat: request.chat,
    candidateIds,
  });
  if (!acpExecutionOwnedByCurrentProcess) {
    try {
      await ensureDetachedWorkerRunning({ force: true });
    } catch (err) {
      logger.debug("failed waking detached ACP worker for interrupt", {
        project_id,
        path,
        threadId,
        err,
      });
    }
  }
}

async function handleForkSessionRequest(
  request: AcpForkSessionRequest,
): Promise<{ sessionId: string }> {
  if (!isValidUUID(request.sessionId)) {
    throw Error("sessionId must be a valid uuid");
  }
  const sessionsRoot = getSessionsRoot();
  if (!sessionsRoot) {
    throw Error("codex sessions directory not configured");
  }
  const newSessionId = request.newSessionId ?? randomUUID();
  if (!isValidUUID(newSessionId)) {
    throw Error("newSessionId must be a valid uuid");
  }
  await forkSession(request.sessionId, newSessionId, sessionsRoot);
  return { sessionId: newSessionId };
}

async function interruptCodexSession(threadId: string): Promise<boolean> {
  for (const agent of agents.values()) {
    if (
      "interrupt" in agent &&
      typeof (agent as any).interrupt === "function"
    ) {
      try {
        if (await (agent as any).interrupt(threadId)) {
          return true;
        }
      } catch (err) {
        logger.warn("failed to interrupt codex session", {
          threadId,
          err,
        });
      }
    }
  }
  return false;
}

export async function disposeAcpAgents(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [key, agent] of agents.entries()) {
    if (typeof agent.dispose !== "function") continue;
    pending.push(
      Promise.resolve(agent.dispose()).catch((err) => {
        logger.warn("failed to dispose ACP agent", { key, err });
      }),
    );
  }
  await Promise.all(pending);
  agents.clear();
}
