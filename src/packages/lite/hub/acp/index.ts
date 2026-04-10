import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import getLogger from "@cocalc/backend/logger";
import { data } from "@cocalc/backend/data";
import {
  CodexAppServerAgent,
  EchoAgent,
  type AcpAgent,
  type AcpEvaluateRequest,
  forkCodexAppServerSession,
} from "@cocalc/ai/acp";
import { AgentTimeTravelRecorder } from "@cocalc/ai/sync";
import { init as initConatAcp } from "@cocalc/conat/ai/acp/server";
import type {
  AcpAutomationRequest,
  AcpAutomationResponse,
  AcpCommandRequest,
  AcpAutomationRecord,
  AcpControlRequest,
  AcpControlResponse,
  AcpJobRequest,
  AcpRequest,
  AcpSteerRequest,
  AcpSteerResponse,
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
import {
  normalizeCodexSessionId,
  resolveCodexSessionMode,
} from "@cocalc/util/ai/codex";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  FileAdapter,
  TerminalAdapter,
  TerminalStartOptions,
} from "@cocalc/ai/acp/adapters";
import { type AcpExecutor, ContainerExecutor, LocalExecutor } from "./executor";
import {
  DEFAULT_AUTOMATION_CHAT_SENDER_ID,
  resolveAutomationChatSenderId,
} from "./automation-chat-sender";
import { buildAutomationAcpConfig } from "./automation-request-config";
import {
  computeNextAutomationRunAt,
  normalizeAcpAutomationConfig,
  AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
  AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS,
} from "./automation-schedule";
import {
  captureCommandAutomationOutput,
  formatCommandAutomationMarkdown,
  resolveAutomationCommandCwd,
} from "./command-automation";
import { ensureLoopContractPrompt } from "./loop-contract";
import {
  preferContainerExecutor,
  resolveWorkspaceRoot,
} from "./workspace-root";
import {
  buildSafeBlobFilename,
  dedupeBlobReferences,
  extractBlobReferences,
  rewriteBlobReferencesInPrompt,
  type MaterializedBlobAttachment,
} from "./blob-materialization";
import { getBlobstore } from "../blobs/download";
import {
  buildChatMessage,
  buildThreadStateRecord,
  computeChatIntegrityReport,
  deriveAcpLogRefs,
  threadStateRecordKey,
  threadConfigRecordKey,
  type ChatThreadAutomationConfig,
  type ChatThreadAutomationState,
  type MessageHistory,
} from "@cocalc/chat";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  appendStreamMessage,
  extractEventText,
  getInterruptedResponseMarkdown,
  getLiveResponseMarkdown,
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
  createAdaptiveAsyncBatcher,
  type AdaptiveAsyncBatcher,
} from "@cocalc/util/adaptive-batching";
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
  countRunningAcpJobsForWorker,
  decodeAcpJobRequest,
  enqueueAcpJob,
  getAcpJobByOpId,
  listQueuedAcpJobs,
  listAcpJobsByRecoveryParent,
  listQueuedAcpJobsForThread,
  listRunningAcpJobs,
  markRunningAcpJobsInterrupted,
  requeueRunningAcpJob,
  resendCanceledAcpJob,
  reprioritizeAcpJobImmediate,
  setAcpJobState,
  type AcpJobRow,
} from "../sqlite/acp-jobs";
import {
  deleteAcpAutomationsForProject,
  deleteAcpAutomationByThread,
  getAcpAutomationById,
  getAcpAutomationByThread,
  listAllAcpAutomations,
  listDueAcpAutomations,
  toAutomationConfig,
  toAutomationRecord,
  toAutomationState,
  upsertAcpAutomation,
  type AcpAutomationRow,
} from "../sqlite/acp-automations";
import {
  decodeAcpInterruptCandidateIds,
  decodeAcpInterruptChat,
  enqueueAcpInterrupt,
  listPendingAcpInterrupts,
  markAcpInterruptError,
  markAcpInterruptHandled,
  markAcpInterruptsHandledForThread,
} from "../sqlite/acp-interrupts";
import {
  decodeAcpSteerCandidateIds,
  decodeAcpSteerRequest,
  enqueueAcpSteer,
  listPendingAcpSteers,
  markAcpSteerError,
  markAcpSteerHandled,
} from "../sqlite/acp-steers";
import {
  getAcpWorker,
  heartbeatAcpWorker,
  listLiveAcpWorkers,
  stopAcpWorker,
  upsertAcpWorker,
} from "../sqlite/acp-workers";
import type { AcpWorkerState } from "../sqlite/acp-workers";
import { throttle } from "lodash";
import { akv, type AKV } from "@cocalc/conat/sync/akv";
import { astream, type AStream } from "@cocalc/conat/sync/astream";
import type { DKV } from "@cocalc/conat/sync/dkv";
import {
  rotateChatStore,
  type RotateChatStoreApplyHeadChangesContext,
} from "@cocalc/backend/chat-store/sqlite-offload";
import {
  ensureAcpWorkerRunning,
  startAcpWorkerSupervisor,
} from "./worker-manager";
import { buildCodexRuntimeEnv } from "./runtime-env";

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
const ACP_AUTOMATION_STORE = "cocalc-thread-automations-v1";
const ACP_AUTOMATION_POLL_MS = 30_000;
const AUTOMATION_DEFAULT_UNACK_LIMIT = 7;

const logger = getLogger("lite:hub:acp");
// Use a stable externally assigned instance id when a detached worker process
// is managed by project-host. That lets leases, queued jobs, and worker state
// all refer to the same durable worker identity across restarts of the main
// process.
const ACP_INSTANCE_ID =
  `${process.env.COCALC_ACP_INSTANCE_ID ?? ""}`.trim() || randomUUID();

let blobStore: AKV | null = null;
const agents = new Map<string, AcpAgent>();
let conatClient: ConatClient | null = null;
let cachedMockScriptPromise: Promise<AcpMockScript> | null = null;
const pumpingAcpJobThreads = new Set<string>();
let ensureDetachedWorkerRunning = ensureAcpWorkerRunning;
let acpExecutionOwnedByCurrentProcess = false;
let acpInterruptPollerStarted = false;
let acpInterruptPollInFlight = false;
let acpSteerPollerStarted = false;
let acpSteerPollInFlight = false;
let acpAutomationPollerStarted = false;
let acpAutomationPollInFlight = false;
const automationStores = new Map<string, Promise<DKV<AcpAutomationRecord>>>();

const INTERRUPT_STATUS_TEXT = "Conversation interrupted.";
const RESTART_INTERRUPTED_NOTICE =
  "**Conversation interrupted because the backend server restarted.**";
const STALE_TURN_INTERRUPTED_NOTICE =
  "**Conversation interrupted because the backend lost the live Codex turn.**";
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
const ACP_LIVE_LOG_PUBLISH_SLOW_MS = envNumber(
  "COCALC_ACP_LIVE_LOG_PUBLISH_SLOW_MS",
  100,
);
const ACP_LIVE_LOG_BATCH_MIN_MS = envNumber(
  "COCALC_ACP_LIVE_LOG_BATCH_MS",
  100,
);
const ACP_LIVE_LOG_BATCH_MAX_MS = envNumber(
  "COCALC_ACP_LIVE_LOG_BATCH_MAX_MS",
  1000,
);
const ACP_LIVE_LOG_BATCH_EWMA_ALPHA = envNumber(
  "COCALC_ACP_LIVE_LOG_BATCH_EWMA_ALPHA",
  0.25,
);
const ACP_LIVE_LOG_BATCH_LATENCY_MULTIPLIER = envNumber(
  "COCALC_ACP_LIVE_LOG_BATCH_LATENCY_MULTIPLIER",
  2,
);
const ACP_LIVE_LOG_BATCH_MAX_EVENTS = envNumber(
  "COCALC_ACP_LIVE_LOG_BATCH_MAX_EVENTS",
  128,
);
const ACP_LIVE_LOG_MAX_BYTES = envNumber(
  "COCALC_ACP_LIVE_LOG_MAX_BYTES",
  8 * 1024 * 1024,
);
const ACP_LIVE_LOG_MAX_MSGS = envNumber("COCALC_ACP_LIVE_LOG_MAX_MSGS", 5_000);
const ACP_PREVIEW_ACTIVITY_TICK_MIN_MS = envNumber(
  "COCALC_ACP_PREVIEW_ACTIVITY_TICK_MS",
  2_000,
);
const ACP_PATCHFLOW_COMMIT_TARGET = envNumber(
  "COCALC_ACP_PATCHFLOW_COMMIT_TARGET",
  6,
);
const ACP_PATCHFLOW_COMMIT_CEILING = envNumber(
  "COCALC_ACP_PATCHFLOW_COMMIT_CEILING",
  10,
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
const ACP_STEER_POLL_MS = envNumber("COCALC_ACP_STEER_POLL_MS", 250);
const ACP_INTERRUPT_MAX_AGE_MS = envNumber(
  "COCALC_ACP_INTERRUPT_MAX_AGE_MS",
  30_000,
);
const ACP_WORKER_HEARTBEAT_MS = envNumber(
  "COCALC_ACP_WORKER_HEARTBEAT_MS",
  2_000,
);
const ACP_WORKER_STALE_MS = envNumber("COCALC_ACP_WORKER_STALE_MS", 15_000);
const ACP_ORPHAN_RECOVERY_POLL_MS = envNumber(
  "COCALC_ACP_ORPHAN_RECOVERY_POLL_MS",
  5_000,
);
const ACP_CURRENT_WORKER_TURN_RECOVERY_GRACE_MS = envNumber(
  "COCALC_ACP_CURRENT_WORKER_TURN_RECOVERY_GRACE_MS",
  10_000,
);
// Detached workers establish acp_jobs state slightly before ChatStreamWriter
// creates the matching acp_turns lease. If a worker dies in that narrow
// pre-lease window, the job is left stuck as `running` forever. Only reclaim
// lease-less jobs after a grace window so we do not steal a turn that another
// worker is still legitimately bootstrapping.
const ACP_JOB_WITHOUT_LEASE_RECOVERY_GRACE_MS = envNumber(
  "COCALC_ACP_JOB_WITHOUT_LEASE_RECOVERY_GRACE_MS",
  15_000,
);
const WORKER_INTERRUPTED_NOTICE =
  "**Conversation interrupted because the ACP worker stopped unexpectedly.**";
const ACP_RECOVERY_CHAT_SENDER_ID = DEFAULT_AUTOMATION_CHAT_SENDER_ID;
const ACP_RECOVERY_VISIBLE_LABEL = "System recovery";

function interruptedNoticeForRecoveryReason(recoveryReason: string): string {
  const normalized = `${recoveryReason ?? ""}`.trim().toLowerCase();
  if (
    normalized === "backend server restarted" ||
    normalized.includes("server restart")
  ) {
    return RESTART_INTERRUPTED_NOTICE;
  }
  if (
    normalized === "backend lost live codex turn" ||
    normalized.includes("lost live codex turn")
  ) {
    return STALE_TURN_INTERRUPTED_NOTICE;
  }
  return WORKER_INTERRUPTED_NOTICE;
}

function buildRecoveryContinuationContent({
  interruptedNotice,
  recoveryCount,
}: {
  interruptedNotice: string;
  recoveryCount: number;
}): string {
  const plain = `${interruptedNotice ?? ""}`.replace(/^\*\*|\*\*$/g, "").trim();
  return `${ACP_RECOVERY_VISIBLE_LABEL}: ${plain} CoCalc is automatically resuming this Codex session (attempt ${recoveryCount}).`;
}

function buildRecoveryContinuationPrompt({
  interruptedNotice,
  recoveryCount,
  originalPrompt,
}: {
  interruptedNotice: string;
  recoveryCount: number;
  originalPrompt: string;
}): string {
  return [
    "The previous Codex turn in this same session was interrupted because the project host or backend restarted.",
    `Recovery attempt: ${recoveryCount}.`,
    `Interruption summary: ${`${interruptedNotice ?? ""}`.replace(/\*\*/g, "").trim()}`,
    "Resume the work from the current workspace state.",
    "Before repeating any expensive, destructive, or externally visible action, inspect what already completed and avoid duplicating side effects.",
    "If commands, calculations, or scripts may have been interrupted, determine their state first and then continue safely.",
    "",
    "Original user request:",
    originalPrompt,
  ].join("\n");
}

function toPlainSyncValue<T>(value: T): T {
  if (value && typeof (value as any).toJS === "function") {
    return (value as any).toJS() as T;
  }
  return value;
}

function normalizeRecoveryLoopResume({
  loopConfig,
  loopState,
  originalPrompt,
}: {
  loopConfig?: AcpLoopConfig;
  loopState?: AcpLoopState;
  originalPrompt: string;
}): {
  prompt: string;
  loopConfig?: AcpLoopConfig;
  loopState?: AcpLoopState;
} {
  if (!loopConfig || !loopState || loopState.status === "stopped") {
    return { prompt: originalPrompt };
  }
  if (
    loopState.status === "scheduled" &&
    `${loopState.next_prompt ?? ""}`.trim()
  ) {
    const nextPrompt = `${loopState.next_prompt ?? ""}`.trim();
    return {
      prompt: nextPrompt,
      loopConfig,
      loopState: {
        ...loopState,
        status: "running",
        next_prompt: undefined,
        stop_reason: undefined,
        iteration: clampLoopNumber(loopState.iteration, 1, 1, 10_000) + 1,
        updated_at_ms: Date.now(),
      },
    };
  }
  return {
    prompt: originalPrompt,
    loopConfig,
    loopState: {
      ...loopState,
      status: "running",
      stop_reason: undefined,
      updated_at_ms: Date.now(),
    },
  };
}

type DetachedWorkerContext = {
  worker_id: string;
  host_id: string;
  bundle_version: string;
  bundle_path: string;
  state: AcpWorkerState;
};

let currentDetachedWorkerContext: DetachedWorkerContext | null = null;

function liteUseDetachedAcpWorker(): boolean {
  const value = `${process.env.COCALC_LITE_ACP_DETACHED_WORKER ?? ""}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function projectHostWorkerContextFromEnv(): DetachedWorkerContext | null {
  if (`${process.env.COCALC_PROJECT_HOST_ACP_WORKER ?? ""}`.trim() !== "1") {
    return null;
  }
  const host_id =
    `${process.env.PROJECT_HOST_ID ?? process.env.COCALC_PROJECT_HOST_ID ?? ""}`.trim();
  const bundle_version =
    `${process.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_VERSION ?? process.env.COCALC_PROJECT_HOST_VERSION ?? ""}`.trim();
  const bundle_path =
    `${process.env.COCALC_PROJECT_HOST_ACP_WORKER_BUNDLE_PATH ?? ""}`.trim();
  const requestedState =
    `${process.env.COCALC_PROJECT_HOST_ACP_WORKER_STATE ?? ""}`.trim() ===
    "draining"
      ? "draining"
      : "active";
  if (!host_id || !bundle_version || !bundle_path) {
    logger.warn("project-host ACP worker environment is incomplete", {
      host_id,
      bundle_version,
      bundle_path,
    });
    return null;
  }
  return {
    worker_id: ACP_INSTANCE_ID,
    host_id,
    bundle_version,
    bundle_path,
    state: requestedState,
  };
}

function detachedWorkerCanClaimQueuedJobs(): boolean {
  return currentDetachedWorkerContext?.state !== "draining";
}

function liveWorkerOwnerIds(host_id: string): Set<string> {
  return new Set(
    listLiveAcpWorkers({
      host_id,
      stale_after_ms: ACP_WORKER_STALE_MS,
    }).map((row) => row.worker_id),
  );
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

function appendInterruptedNoticeToContent(
  content: string | undefined,
  interruptedText: string | undefined,
): string | undefined {
  const base = `${content ?? ""}`.trim();
  const suffix = `${interruptedText ?? INTERRUPT_STATUS_TEXT}`.trim();
  if (!base) return suffix || undefined;
  if (!suffix || base.includes(suffix)) return base;
  return `${base}\n\n${suffix}`;
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

function preferredThreadStateRow(
  syncdb: SyncDB,
  threadId: string,
): Record<string, unknown> | undefined {
  const canonical = threadStateRecordKey(threadId);
  const direct = (syncdb as any)?.get_one?.(canonical);
  if (direct != null) {
    return typeof direct?.toJS === "function" ? direct.toJS() : direct;
  }
  const rows = syncdbRowsMatching(syncdb, {
    event: THREAD_STATE_EVENT,
    thread_id: threadId,
  });
  if (rows.length === 0) return undefined;
  return rows.slice().sort((a, b) => {
    const aUpdated = Date.parse(
      `${syncdbField<string>(a, "updated_at") ?? ""}`,
    );
    const bUpdated = Date.parse(
      `${syncdbField<string>(b, "updated_at") ?? ""}`,
    );
    return (
      (Number.isFinite(bUpdated) ? bUpdated : 0) -
      (Number.isFinite(aUpdated) ? aUpdated : 0)
    );
  })[0];
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

function threadConfigMetadataPatch(opts: {
  thread_id: string;
  updated_by: string;
  updated_at?: string;
}): Record<string, unknown> {
  const key = threadConfigRecordKey(opts.thread_id);
  return {
    event: key.event,
    sender_id: key.sender_id,
    date: key.date,
    thread_id: key.thread_id,
    updated_at: opts.updated_at ?? new Date().toISOString(),
    updated_by: opts.updated_by,
    schema_version: THREAD_STATE_SCHEMA_VERSION,
  };
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
  client,
  chatPath,
  chatKey,
  projectId,
  chatPathKey,
}: {
  client: ConatClient;
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
      apply_head_changes: (context) =>
        applyRotatedChatHeadViaSyncDB({
          client,
          project_id: projectId,
          path: chatPathKey,
          context,
        }),
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

async function applyRotatedChatHeadViaSyncDB({
  client,
  project_id,
  path,
  context,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  context: RotateChatStoreApplyHeadChangesContext;
}): Promise<{ applied: boolean; status: "done"; warning?: string }> {
  await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      for (const change of context.delete_changes) {
        syncdb.delete(change.where);
      }
      for (const row of context.upsert_rows) {
        syncdb.set(row);
      }
      syncdb.commit();
      await syncdb.save();
    },
  });
  return { applied: true, status: "done" };
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

function syncdbVersionCount(syncdb: unknown): number | undefined {
  const versions = (syncdb as any)?.versions;
  if (typeof versions !== "function") return undefined;
  try {
    const value = versions.call(syncdb);
    return Array.isArray(value) ? value.length : undefined;
  } catch {
    return undefined;
  }
}

function logSyncdbPatchflowDelta({
  syncdb,
  before,
  phase,
  extra,
}: {
  syncdb: unknown;
  before?: number;
  phase: string;
  extra?: Record<string, unknown>;
}): void {
  const after = syncdbVersionCount(syncdb);
  if (after == null) return;
  const payload = {
    phase,
    versions: after,
    delta: before == null ? undefined : after - before,
    ...extra,
  };
  if (before != null && after - before > ACP_PATCHFLOW_COMMIT_CEILING) {
    logger.warn("acp chat patchflow delta exceeded ceiling", payload);
  } else {
    logger.debug("acp chat patchflow delta", payload);
  }
}

function chatKey(metadata: AcpChatContext): string {
  return `${metadata.project_id}:${metadata.path}:${metadata.message_date}`;
}

type ThrottledNoArgs = (() => void) & {
  cancel: () => void;
  flush: () => void;
};

function throttleNoArgsWithUnref(
  fn: () => void,
  wait: number,
): ThrottledNoArgs {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let lastInvokeAt = 0;

  const clear = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const invoke = () => {
    lastInvokeAt = Date.now();
    pending = false;
    fn();
  };

  const wrapped = (() => {
    const now = Date.now();
    if (lastInvokeAt === 0 || now - lastInvokeAt >= wait) {
      clear();
      invoke();
      return;
    }
    pending = true;
    if (timer != null) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (pending) {
          invoke();
        }
      },
      Math.max(0, wait - (now - lastInvokeAt)),
    );
    (timer as any)?.unref?.();
  }) as ThrottledNoArgs;

  wrapped.cancel = () => {
    clear();
    pending = false;
  };

  wrapped.flush = () => {
    const shouldInvoke = pending;
    clear();
    if (shouldInvoke) {
      invoke();
    }
  };

  return wrapped;
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
  private lastCommittedStartedAtMs: number | null = null;
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
  private contentBeforeInterrupt?: string;
  private interruptNotified = false;
  private disposeTimer?: NodeJS.Timeout;
  private disposePromise?: Promise<void>;
  private saveChain: Promise<void> = Promise.resolve();
  private sessionKey?: string;
  private logStore?: AKV<AcpStreamMessage[]>;
  private logStoreName: string;
  private logKey: string;
  private logSubject: string;
  private liveLogStream?: AStream<AcpStreamMessage | AcpStreamMessage[]>;
  private liveLogStreamName: string;
  private liveLogInitPromise?: Promise<
    AStream<AcpStreamMessage | AcpStreamMessage[]>
  >;
  private liveLogBatcher!: AdaptiveAsyncBatcher<AcpStreamMessage>;
  private livePreviewStream?: AStream<AcpStreamMessage | AcpStreamMessage[]>;
  private livePreviewStreamName: string;
  private livePreviewInitPromise?: Promise<
    AStream<AcpStreamMessage | AcpStreamMessage[]>
  >;
  private livePreviewBatcher!: AdaptiveAsyncBatcher<AcpStreamMessage>;
  private lastPreviewActivityTickMs = 0;
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
  private patchflowVersionBaseline?: number;
  private patchflowVersionLatest?: number;
  private patchflowVersionPeak?: number;
  private heartbeatLease = throttleNoArgsWithUnref(() => {
    this.touchLease();
  }, LEASE_HEARTBEAT_INTERVAL);
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
      const current = preferredThreadStateRow(this.syncdb, threadId);
      if (
        current != null &&
        this.recordField<string>(current, "state") === state &&
        (this.recordField<string>(current, "active_message_id") ?? null) ===
          (this.metadata.message_id ?? null)
      ) {
        return;
      }
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
      this.observePatchflowVersions(`thread-state:${state}`);
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
    liveLogStreamFactory,
    livePreviewStreamFactory,
  }: {
    metadata: AcpChatContext;
    client: ConatClient;
    approverAccountId: string;
    sessionKey?: string;
    workspaceRoot?: string;
    hostWorkspaceRoot?: string;
    syncdbOverride?: any;
    logStoreFactory?: () => AKV<AcpStreamMessage[]>;
    liveLogStreamFactory?: () => AStream<AcpStreamMessage | AcpStreamMessage[]>;
    livePreviewStreamFactory?: () => AStream<
      AcpStreamMessage | AcpStreamMessage[]
    >;
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
    this.liveLogStreamName = refs.liveStream;
    this.livePreviewStreamName = refs.previewStream;
    this.liveLogBatcher = this.createLiveLogBatcher();
    this.livePreviewBatcher = this.createLivePreviewBatcher();
    // ensure initialization rejections are observed immediately
    this.ready = this.initialize();
    this.waitUntilReady();
    if (logStoreFactory) {
      this.logStore = logStoreFactory();
    }
    if (liveLogStreamFactory) {
      this.liveLogStream = liveLogStreamFactory();
    }
    if (livePreviewStreamFactory) {
      this.livePreviewStream = livePreviewStreamFactory();
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
    this.observePatchflowVersions("init:ready");
    let current = this.findChatRow();
    if (current == null) {
      // Create a placeholder chat row so backend-owned updates don’t race with a missing record.
      const placeholder = buildChatMessage({
        sender_id: this.metadata.sender_id,
        date: this.metadata.message_date,
        prevHistory: [],
        content: ":robot: Thinking...",
        generating: true,
        acp_account_id: this.approverAccountId,
        acp_started_at_ms:
          Number(this.metadata.started_at_ms) > 0
            ? Number(this.metadata.started_at_ms)
            : undefined,
        acp_log_store: this.logStoreName,
        acp_log_key: this.logKey,
        acp_log_subject: this.logSubject,
        acp_live_log_stream: this.liveLogStreamName,
        acp_live_preview_stream: this.livePreviewStreamName,
        message_id: this.metadata.message_id,
        thread_id: this.metadata.thread_id,
        parent_message_id: (this.metadata as any).parent_message_id,
        acp_recovery_parent_op_id: (this.metadata as any).recovery_parent_op_id,
        acp_recovery_reason: (this.metadata as any).recovery_reason,
        acp_recovery_count:
          Number((this.metadata as any).recovery_count) > 0
            ? Number((this.metadata as any).recovery_count)
            : undefined,
      } as any);
      if ((this.metadata as any).parent_message_id) {
        (placeholder as any).parent_message_id = (
          this.metadata as any
        ).parent_message_id;
      }
      db.set(placeholder);
      db.commit();
      this.markIntegrityDirty("init-placeholder");
      this.observePatchflowVersions("init:placeholder");
      current = this.findChatRow();
    }
    const history = this.recordField(current, "history");
    const arr = this.historyToArray(history);
    if (arr.length > 0) {
      this.prevHistory = arr.slice(1);
    }
    this.primeCommittedStateFromRow(current);
    const queued = listAcpPayloads(this.metadata);
    for (const payload of queued) {
      this.processPayload(payload, { persist: false });
    }
    if (this.finished) {
      await this.waitForLiveLogFlush();
      await this.persistLog();
    }
    this.setThreadState("running");
    try {
      await db.save();
      this.observePatchflowVersions("init:save");
    } catch (err) {
      logger.warn("chat syncdb save failed during init", err);
    }
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
      time: (payload as any).time ?? Date.now(),
    };
    const shouldAutoRotate =
      message.type === "summary" || message.type === "error";
    this.processPayload(message, { persist: true });
    const isLastMessage =
      message.type === "summary" || message.type === "error" || this.finished;
    if (isLastMessage) {
      await this.waitForLiveLogFlush();
      await this.waitForLivePreviewFlush();
      await this.persistLog();
      // Live turn output is rendered from the ACP log/DKV path. Reserve
      // durable .chat writes for terminal state so patchflow history stays
      // bounded regardless of streamed word count.
      await this.ensureTerminalChatCommitApplied(
        message.type === "error" ? "error" : "summary",
      );
      await this.waitForScheduledSyncdbSaves();
      if (shouldAutoRotate) {
        await maybeAutoRotateChatStore({
          client: this.client,
          chatPath: this.resolveChatFilePath(),
          chatKey: this.chatKey,
          projectId: this.metadata.project_id,
          chatPathKey: this.metadata.path,
        });
      }
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
      if (payload.threadId != null) {
        const liveThreadId = normalizeCodexSessionId(payload.threadId);
        if (liveThreadId) {
          this.threadId = liveThreadId;
          this.registerThreadKey(liveThreadId);
          void this.persistSessionId(liveThreadId).catch((err) => {
            logger.debug("persistSessionId(status) failed", err);
          });
        }
      }
      // Preserve status updates in the visible ACP log so the frontend can
      // distinguish "turn acknowledged and running" from "still waiting for
      // the first text event".
      this.events = appendStreamMessage(this.events, payload);
      this.publishLiveLog(payload);
      this.publishLivePreview(payload);
      this.commitNow(true);
      return;
    }
    if ((payload as any).type === "usage") {
      // Live usage updates from Codex; stash for commit and don't treat as a user-visible event.
      this.usage = (payload as any).usage ?? null;
      this.commitNow(true);
      return;
    }
    this.events = appendStreamMessage(this.events, payload);
    this.publishLiveLog(payload);
    this.publishLivePreview(payload);
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
      this.commitNow(true);
      return;
    }
    if (payload.type === "summary") {
      if (this.interruptNotified) {
        const liveResponse = getLiveResponseMarkdown(this.events);
        const latestSummary = getLatestSummaryText(this.events);
        const hasSummary =
          typeof latestSummary === "string" && latestSummary.trim().length > 0;
        const summaryText =
          (hasSummary ? latestSummary : undefined) ??
          (typeof payload.finalResponse === "string" &&
          payload.finalResponse.trim().length > 0
            ? payload.finalResponse
            : undefined);
        const latestMessage = getLatestMessageText(this.events);
        const latestNonInterruptMessage =
          typeof latestMessage === "string" &&
          latestMessage.trim().length > 0 &&
          latestMessage !== this.interruptedMessage
            ? latestMessage
            : undefined;
        const preservedContent =
          typeof this.contentBeforeInterrupt === "string" &&
          this.contentBeforeInterrupt.trim().length > 0
            ? this.contentBeforeInterrupt
            : undefined;
        const liveNonInterruptContent =
          typeof liveResponse === "string" &&
          liveResponse.trim().length > 0 &&
          liveResponse !== this.interruptedMessage
            ? liveResponse
            : undefined;
        const currentNonInterruptContent =
          typeof this.content === "string" &&
          this.content.trim().length > 0 &&
          this.content !== this.interruptedMessage
            ? this.content
            : undefined;
        const candidate =
          summaryText ??
          liveNonInterruptContent ??
          latestNonInterruptMessage ??
          currentNonInterruptContent ??
          preservedContent ??
          this.interruptedMessage;
        if (candidate) {
          this.content =
            appendInterruptedNoticeToContent(
              stripLoopContractForDisplay(
                candidate,
                this.metadata.loop_config?.enabled === true,
              ),
              this.interruptedMessage,
            ) ?? candidate;
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
        const liveThreadId = normalizeCodexSessionId(payload.threadId);
        if (liveThreadId) {
          this.threadId = liveThreadId;
          this.registerThreadKey(liveThreadId);
          this.timeTravel?.setThreadId(liveThreadId);
          void this.persistSessionId(liveThreadId).catch((err) => {
            logger.debug("persistSessionId(summary) failed", err);
          });
        }
      }
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.setThreadState(this.interruptNotified ? "interrupted" : "complete");
      this.finalizeLease("completed");
      this.trackTimeTravelOperation("finalize", this.metadata.path, () =>
        this.timeTravel?.finalizeTurn(this.metadata.message_date),
      );
      return;
    }
    if (payload.type === "error") {
      this.content = formatUserFacingAcpError(payload.error);
      this.lastErrorText = stripKnownAcpErrorNoise(payload.error);
      clearAcpPayloads(this.metadata);
      this.finished = true;
      this.finishedBy = "error";
      this.setThreadState("error");
      this.finalizeLease("error", payload.error);
      this.trackTimeTravelOperation("finalize", this.metadata.path, () =>
        this.timeTravel?.finalizeTurn(this.metadata.message_date),
      );
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
      acp_live_log_stream: generating ? this.liveLogStreamName : undefined,
      acp_live_preview_stream: generating
        ? this.livePreviewStreamName
        : undefined,
      acp_thread_id: this.threadId,
      acp_started_at_ms:
        Number(this.metadata.started_at_ms) > 0
          ? Number(this.metadata.started_at_ms)
          : undefined,
      acp_usage: this.usage,
      acp_account_id: this.approverAccountId,
      acp_recovery_parent_op_id: (this.metadata as any).recovery_parent_op_id,
      acp_recovery_reason: (this.metadata as any).recovery_reason,
      acp_recovery_count:
        Number((this.metadata as any).recovery_count) > 0
          ? Number((this.metadata as any).recovery_count)
          : undefined,
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
      acp_live_log_stream: generating ? this.liveLogStreamName : undefined,
      acp_live_preview_stream: generating
        ? this.livePreviewStreamName
        : undefined,
      acp_thread_id: this.threadId,
      acp_started_at_ms:
        Number(this.metadata.started_at_ms) > 0
          ? Number(this.metadata.started_at_ms)
          : undefined,
      acp_usage: this.usage,
      acp_account_id: this.approverAccountId,
      acp_recovery_parent_op_id: (this.metadata as any).recovery_parent_op_id,
      acp_recovery_reason: (this.metadata as any).recovery_reason,
      acp_recovery_count:
        Number((this.metadata as any).recovery_count) > 0
          ? Number((this.metadata as any).recovery_count)
          : undefined,
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

  private normalizeStartedAtMs(value: unknown): number | null {
    const num =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  private observePatchflowVersions(
    phase: string,
    extra?: Record<string, unknown>,
  ): number | undefined {
    const count = syncdbVersionCount(this.syncdb);
    if (count == null) return undefined;
    if (this.patchflowVersionBaseline == null) {
      this.patchflowVersionBaseline = count;
    }
    this.patchflowVersionLatest = count;
    this.patchflowVersionPeak = Math.max(
      this.patchflowVersionPeak ?? count,
      count,
    );
    const delta = count - this.patchflowVersionBaseline;
    const payload = {
      chatKey: this.chatKey,
      path: this.metadata.path,
      message_id: this.metadata.message_id,
      phase,
      versions: count,
      delta,
      target: ACP_PATCHFLOW_COMMIT_TARGET,
      ceiling: ACP_PATCHFLOW_COMMIT_CEILING,
      ...extra,
    };
    if (delta > ACP_PATCHFLOW_COMMIT_CEILING) {
      logger.warn("acp chat patchflow budget exceeded", payload);
    } else {
      logger.debug("acp chat patchflow versions", payload);
    }
    return count;
  }

  private patchflowBudgetSnapshot() {
    if (this.patchflowVersionBaseline == null) return undefined;
    const latest = this.patchflowVersionLatest ?? this.patchflowVersionBaseline;
    const peak = this.patchflowVersionPeak ?? latest;
    return {
      baselineVersions: this.patchflowVersionBaseline,
      latestVersions: latest,
      peakVersions: peak,
      deltaVersions: latest - this.patchflowVersionBaseline,
      peakDeltaVersions: peak - this.patchflowVersionBaseline,
      target: ACP_PATCHFLOW_COMMIT_TARGET,
      ceiling: ACP_PATCHFLOW_COMMIT_CEILING,
    };
  }

  private primeCommittedStateFromRow(row: any): void {
    if (row == null) return;
    this.lastCommittedThreadId =
      this.recordField<string>(row, "acp_thread_id") ?? null;
    this.lastCommittedStartedAtMs = this.normalizeStartedAtMs(
      this.recordField<number | string>(row, "acp_started_at_ms"),
    );
    try {
      this.lastCommittedUsageJson = JSON.stringify(
        this.recordField<any>(row, "acp_usage") ?? null,
      );
    } catch {
      this.lastCommittedUsageJson = "null";
    }
    this.lastCommittedInterrupted =
      this.recordField<boolean>(row, "acp_interrupted") === true;
    this.lastCommittedGenerating = this.recordField<boolean>(row, "generating");
  }

  private hasMetadataDelta(generating: boolean): boolean {
    const usageChanged =
      this.lastCommittedUsageJson !== this.usageFingerprint();
    const startedAtMs = this.normalizeStartedAtMs(this.metadata.started_at_ms);
    return (
      this.lastCommittedThreadId !== this.threadId ||
      this.lastCommittedStartedAtMs !== startedAtMs ||
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
    this.lastCommittedStartedAtMs = this.normalizeStartedAtMs(
      this.metadata.started_at_ms,
    );
    this.lastCommittedUsageJson = this.usageFingerprint();
    this.lastCommittedInterrupted = this.interruptNotified;
    this.lastCommittedGenerating = generating;
  }

  private terminalRowAlreadyPersisted(): boolean {
    if (!this.syncdb) return false;
    const current = this.findChatRow();
    if (current == null) return false;
    const generating = this.recordField<boolean>(current, "generating");
    if (generating !== false) return false;
    const history = this.historyToArray(this.recordField(current, "history"));
    const currentContent = history[0]?.content ?? "";
    const currentThreadId =
      this.recordField<string>(current, "acp_thread_id") ?? null;
    const currentStartedAtMs = this.normalizeStartedAtMs(
      this.recordField<number | string>(current, "acp_started_at_ms"),
    );
    const currentInterrupted =
      this.recordField<boolean>(current, "acp_interrupted") === true;
    let currentUsageJson = "null";
    try {
      currentUsageJson = JSON.stringify(
        this.recordField<any>(current, "acp_usage") ?? null,
      );
    } catch {
      currentUsageJson = "null";
    }
    return (
      currentContent === (this.content ?? "") &&
      currentThreadId === this.threadId &&
      currentStartedAtMs ===
        this.normalizeStartedAtMs(this.metadata.started_at_ms) &&
      currentInterrupted === this.interruptNotified &&
      currentUsageJson === this.usageFingerprint()
    );
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
    if (path.isAbsolute(chatPath)) {
      const absolute = path.resolve(chatPath);
      const workspaceRoot = this.workspaceRoot;
      const hostRoot = this.hostWorkspaceRoot;
      if (
        workspaceRoot &&
        hostRoot &&
        path.isAbsolute(workspaceRoot) &&
        path.isAbsolute(hostRoot) &&
        workspaceRoot !== hostRoot
      ) {
        const rel = path.relative(workspaceRoot, absolute);
        if (!rel.startsWith("..")) {
          return path.resolve(hostRoot, rel);
        }
      }
      return absolute;
    }
    const root = this.hostWorkspaceRoot ?? this.workspaceRoot;
    if (!root || !path.isAbsolute(root)) return;
    return path.resolve(root, chatPath);
  }

  private scheduleSyncdbSave({
    reason,
    generating,
    fullContent,
  }: {
    reason: "throttled" | "terminal-verify" | "dispose";
    generating: boolean;
    fullContent: boolean;
  }): Promise<void> {
    const saveTask = this.saveChain
      .catch(() => {})
      .then(async () => {
        if (this.syncdb == null) return;
        const saveStarted = performance.now();
        try {
          await this.syncdb.save();
          this.observePatchflowVersions("chat-save", {
            reason,
            generating,
            fullContent,
          });
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
      });
    this.saveChain = saveTask;
    return saveTask;
  }

  private async waitForScheduledSyncdbSaves(): Promise<void> {
    try {
      // Detached ACP workers can drain immediately after a turn finishes. If we
      // return before queued save() calls settle, the final generating=false
      // assistant row can be lost even though the thread-state row reached
      // "complete" in memory.
      await this.saveChain;
    } catch {
      // Individual save failures are already logged in scheduleSyncdbSave.
    }
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
      this.observePatchflowVersions("chat-commit", {
        reason,
        generating,
        fullContent,
      });
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
    void this.scheduleSyncdbSave({
      reason,
      generating,
      fullContent,
    });
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

    // Finalize paths cancel the lease heartbeat, but dispose should not rely
    // on that side effect. A writer can reach dispose after terminal handling
    // and still have a trailing throttle timer pending.
    this.heartbeatLease.cancel();

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

    if (!this.finished || !this.terminalRowAlreadyPersisted()) {
      this.commitNow(false, "dispose");
    }
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
    this.disposePromise = (async () => {
      try {
        await this.liveLogBatcher.close();
      } catch {
        // ignore
      }
      try {
        await this.livePreviewBatcher.close();
      } catch {
        // ignore
      }
      try {
        await this.persistLog();
      } catch {
        // ignore
      }
      try {
        this.liveLogStream?.close();
      } catch (err) {
        logger.warn("failed to close live acp log stream", err);
      }
      try {
        this.livePreviewStream?.close();
      } catch (err) {
        logger.warn("failed to close live acp preview stream", err);
      }
      try {
        await this.waitForScheduledSyncdbSaves();
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

  async waitUntilDisposed(): Promise<void> {
    while (this.disposeTimer != null && !this.closed) {
      await sleep(25);
    }
    try {
      await this.disposePromise;
    } catch {
      // Disposal failures are logged at the source.
    }
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
        time: Date.now(),
      };
      this.processPayload(message, { persist: true });
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
    if (
      this.contentBeforeInterrupt == null &&
      typeof this.content === "string" &&
      this.content.trim().length > 0
    ) {
      this.contentBeforeInterrupt = this.content;
    }
    this.interruptedMessage = text;
    if (!this.content || this.content.trim().length === 0) {
      this.content = text;
    }
    this.content =
      appendInterruptedNoticeToContent(
        getInterruptedResponseMarkdown(this.events, text) ?? this.content,
        text,
      ) ?? text;
    this.finishedBy = "interrupt";
    this.setThreadState("interrupted");
    this.commitNow(false, "throttled");
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
      patchflow: this.patchflowBudgetSnapshot(),
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

  private async getLiveLogStream(): Promise<
    AStream<AcpStreamMessage | AcpStreamMessage[]>
  > {
    if (this.liveLogStream) return this.liveLogStream;
    if (this.liveLogInitPromise) return await this.liveLogInitPromise;
    this.liveLogInitPromise = (async () => {
      const stream = astream<AcpStreamMessage>({
        project_id: this.metadata.project_id,
        name: this.liveLogStreamName,
        client: this.client,
        ephemeral: true,
      });
      await stream.config({
        max_bytes: ACP_LIVE_LOG_MAX_BYTES,
        max_msgs: ACP_LIVE_LOG_MAX_MSGS,
        discard_policy: "old",
      });
      this.liveLogStream = stream;
      return stream;
    })();
    try {
      return await this.liveLogInitPromise;
    } finally {
      this.liveLogInitPromise = undefined;
    }
  }

  private async getLivePreviewStream(): Promise<
    AStream<AcpStreamMessage | AcpStreamMessage[]>
  > {
    if (this.livePreviewStream) return this.livePreviewStream;
    if (this.livePreviewInitPromise) return await this.livePreviewInitPromise;
    this.livePreviewInitPromise = (async () => {
      const stream = astream<AcpStreamMessage>({
        project_id: this.metadata.project_id,
        name: this.livePreviewStreamName,
        client: this.client,
        ephemeral: true,
      });
      await stream.config({
        max_bytes: ACP_LIVE_LOG_MAX_BYTES,
        max_msgs: ACP_LIVE_LOG_MAX_MSGS,
        discard_policy: "old",
      });
      this.livePreviewStream = stream;
      return stream;
    })();
    try {
      return await this.livePreviewInitPromise;
    } finally {
      this.livePreviewInitPromise = undefined;
    }
  }

  private createLiveLogBatcher(): AdaptiveAsyncBatcher<AcpStreamMessage> {
    return createAdaptiveAsyncBatcher<AcpStreamMessage>({
      minDelayMs: ACP_LIVE_LOG_BATCH_MIN_MS,
      maxDelayMs: ACP_LIVE_LOG_BATCH_MAX_MS,
      ewmaAlpha: ACP_LIVE_LOG_BATCH_EWMA_ALPHA,
      latencyMultiplier: ACP_LIVE_LOG_BATCH_LATENCY_MULTIPLIER,
      maxItems: ACP_LIVE_LOG_BATCH_MAX_EVENTS,
      flush: async (batch) => {
        try {
          const stream = await this.getLiveLogStream();
          await stream.publish(batch.length === 1 ? batch[0] : batch);
        } catch (err) {
          logger.debug("failed to publish live acp log event", {
            chatKey: this.chatKey,
            path: this.metadata.path,
            seqStart: batch[0]?.seq,
            seqEnd: batch.at(-1)?.seq,
            batchSize: batch.length,
            err,
          });
        }
      },
      onFlushComplete: ({
        batchSize,
        durationMs,
        nextDelayMs,
        estimatedLatencyMs,
      }) => {
        if (durationMs < ACP_LIVE_LOG_PUBLISH_SLOW_MS) {
          return;
        }
        logger.warn("acp live log publish slow", {
          chatKey: this.chatKey,
          path: this.metadata.path,
          events: this.events.length,
          batchSize,
          durationMs: roundMs(durationMs),
          nextDelayMs,
          estimatedLatencyMs:
            estimatedLatencyMs == null
              ? undefined
              : roundMs(estimatedLatencyMs),
        });
      },
    });
  }

  private createLivePreviewBatcher(): AdaptiveAsyncBatcher<AcpStreamMessage> {
    return createAdaptiveAsyncBatcher<AcpStreamMessage>({
      minDelayMs: ACP_LIVE_LOG_BATCH_MIN_MS,
      maxDelayMs: ACP_LIVE_LOG_BATCH_MAX_MS,
      ewmaAlpha: ACP_LIVE_LOG_BATCH_EWMA_ALPHA,
      latencyMultiplier: ACP_LIVE_LOG_BATCH_LATENCY_MULTIPLIER,
      maxItems: ACP_LIVE_LOG_BATCH_MAX_EVENTS,
      flush: async (batch) => {
        try {
          const stream = await this.getLivePreviewStream();
          await stream.publish(batch.length === 1 ? batch[0] : batch);
        } catch (err) {
          logger.debug("failed to publish live acp preview event", {
            chatKey: this.chatKey,
            path: this.metadata.path,
            seqStart: batch[0]?.seq,
            seqEnd: batch.at(-1)?.seq,
            batchSize: batch.length,
            err,
          });
        }
      },
      onFlushComplete: ({
        batchSize,
        durationMs,
        nextDelayMs,
        estimatedLatencyMs,
      }) => {
        if (durationMs < ACP_LIVE_LOG_PUBLISH_SLOW_MS) {
          return;
        }
        logger.warn("acp live preview publish slow", {
          chatKey: this.chatKey,
          path: this.metadata.path,
          events: this.events.length,
          batchSize,
          durationMs: roundMs(durationMs),
          nextDelayMs,
          estimatedLatencyMs:
            estimatedLatencyMs == null
              ? undefined
              : roundMs(estimatedLatencyMs),
        });
      },
    });
  }

  private publishLiveLog(event: AcpStreamMessage): void {
    if (this.closed) return;
    const shouldFlushNow =
      event.type === "status" ||
      event.type === "summary" ||
      event.type === "error";
    this.liveLogBatcher.add(event, {
      flush: shouldFlushNow,
    });
  }

  private publishLivePreview(event: AcpStreamMessage): void {
    if (this.closed) return;
    if (event.type === "summary" || event.type === "error") {
      this.livePreviewBatcher.add(event, { flush: true });
      return;
    }
    if (event.type === "status") {
      this.livePreviewBatcher.add(event, { flush: true });
      return;
    }
    if (
      event.type === "event" &&
      (event.event.type === "message" || event.event.type === "thinking")
    ) {
      this.livePreviewBatcher.add(event);
      return;
    }
    if (event.type === "event" && this.shouldEmitPreviewActivityTick(event)) {
      this.livePreviewBatcher.add(
        {
          type: "status",
          state: "running",
          threadId: this.threadId ?? undefined,
          seq: event.seq,
          time: event.time,
        },
        { flush: true },
      );
    }
  }

  private shouldEmitPreviewActivityTick(event: AcpStreamMessage): boolean {
    if (event.type !== "event") return false;
    if (event.event.type === "message" || event.event.type === "thinking") {
      return false;
    }
    const nowMs =
      typeof event.time === "number" && Number.isFinite(event.time)
        ? event.time
        : Date.now();
    if (
      nowMs - this.lastPreviewActivityTickMs <
      ACP_PREVIEW_ACTIVITY_TICK_MIN_MS
    ) {
      return false;
    }
    this.lastPreviewActivityTickMs = nowMs;
    return true;
  }

  private async waitForLiveLogFlush(): Promise<void> {
    await this.liveLogBatcher.flush();
  }

  private async waitForLivePreviewFlush(): Promise<void> {
    await this.livePreviewBatcher.flush();
  }

  private async persistLog(): Promise<void> {
    if (this.events.length === 0) return;
    try {
      const started = performance.now();
      const store = this.getLogStore();
      await store.set(this.logKey, this.events);
      const durationMs = performance.now() - started;
      if (durationMs >= ACP_LOG_PERSIST_SLOW_MS) {
        logger.warn("acp final log persist slow", {
          chatKey: this.chatKey,
          path: this.metadata.path,
          events: this.events.length,
          durationMs: roundMs(durationMs),
        });
      }
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
        ...threadConfigMetadataPatch({
          thread_id: threadId,
          updated_at: new Date().toISOString(),
          updated_by: this.approverAccountId,
        }),
        ...patch,
      });
      this.syncdb.commit();
      this.markIntegrityDirty("thread-config");
      this.observePatchflowVersions("thread-config");
      await this.syncdb.save();
      this.observePatchflowVersions("thread-config:save");
    } catch (err) {
      logger.debug("patchThreadConfig failed", err);
    }
  }

  public async persistSessionId(sessionId: string): Promise<void> {
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
    this.contentBeforeInterrupt = undefined;
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

function stripKnownAcpErrorNoise(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(
      /\s*time="[^"]+"\s+level=warning\s+msg="(?:The cgroupv2 manager is set to systemd but there is no systemd user session available|For using systemd, you may need to log in using a user session|Alternatively, you can enable lingering with: [^"]+|Falling back to --cgroup-manager=cgroupfs)"/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isUsageLimitError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("llm usage limit") ||
    normalized.includes("usage limit") ||
    normalized.includes("upgrade your membership")
  );
}

function formatUserFacingAcpError(error: string): string {
  const cleaned = stripKnownAcpErrorNoise(`${error ?? ""}`);
  if (!cleaned) {
    return "\n\n<span style='color:#b71c1c'>Unknown ACP error.</span>\n\n";
  }
  if (!isUsageLimitError(cleaned)) {
    return `\n\n<span style='color:#b71c1c'>${cleaned}</span>\n\n`;
  }
  return [
    "**LLM usage limit reached**",
    "",
    cleaned,
    "",
    "Try one of these:",
    "- [Upgrade your membership](/settings/store)",
    "- [Open AI settings](/settings/preferences/ai) to connect a ChatGPT Plan or your own OpenAI API key",
  ].join("\n");
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

function findLatestGeneratingChatRow(
  syncdb: SyncDB,
  threadId: string,
): Record<string, unknown> | undefined {
  const rows = syncdbRowsMatching(syncdb, {
    event: "chat",
    thread_id: threadId,
  }).filter((row) => syncdbField<boolean>(row, "generating") === true);
  if (rows.length === 0) return undefined;
  return rows.slice().sort((a, b) => {
    const aDate = Date.parse(`${syncdbField<string>(a, "date") ?? ""}`);
    const bDate = Date.parse(`${syncdbField<string>(b, "date") ?? ""}`);
    return (
      (Number.isFinite(bDate) ? bDate : 0) -
      (Number.isFinite(aDate) ? aDate : 0)
    );
  })[0];
}

export async function disposeAllChatWritersForTests(): Promise<void> {
  const writers = Array.from(chatWritersByChatKey.values());
  for (const writer of writers) {
    try {
      writer.dispose(true);
    } catch {
      // Ignore best-effort test cleanup errors.
    }
  }
  await Promise.all(
    writers.map(async (writer) => {
      try {
        await writer.waitUntilDisposed();
      } catch {
        // Ignore best-effort test cleanup errors.
      }
    }),
  );
}

function hasLiveChatWriterForTurn(turn: {
  project_id: string;
  path: string;
  message_date: string;
  thread_id?: string | null;
  session_id?: string | null;
}): boolean {
  if (
    chatWritersByChatKey.has(
      chatKey({
        project_id: turn.project_id,
        path: turn.path,
        message_date: turn.message_date,
        sender_id: "",
      }),
    )
  ) {
    return true;
  }
  const ids = new Set<string>();
  const threadId = `${turn.thread_id ?? ""}`.trim();
  const sessionId = `${turn.session_id ?? ""}`.trim();
  if (threadId) ids.add(threadId);
  if (sessionId) ids.add(sessionId);
  for (const id of ids) {
    if (chatWritersByThreadId.has(id)) {
      return true;
    }
  }
  return false;
}

function runningTurnMatchesTarget(
  row: {
    project_id: string;
    path: string;
    message_date?: string | null;
    message_id?: string | null;
    thread_id?: string | null;
  },
  target: {
    project_id: string;
    path: string;
    message_date?: string | null;
    message_id?: string | null;
    thread_id?: string | null;
  },
): boolean {
  if (row.project_id !== target.project_id || row.path !== target.path) {
    return false;
  }
  const targetMessageId = `${target.message_id ?? ""}`.trim();
  if (targetMessageId && `${row.message_id ?? ""}`.trim() === targetMessageId) {
    return true;
  }
  const targetMessageDate = `${target.message_date ?? ""}`.trim();
  if (
    targetMessageDate &&
    `${row.message_date ?? ""}`.trim() === targetMessageDate
  ) {
    return true;
  }
  const targetThreadId = `${target.thread_id ?? ""}`.trim();
  if (targetThreadId && `${row.thread_id ?? ""}`.trim() === targetThreadId) {
    return true;
  }
  return false;
}

export async function repairInterruptedAcpTurn({
  client,
  turn,
  interruptedNotice = INTERRUPT_STATUS_TEXT,
  interruptedReasonId = "interrupt",
  recoveryReason = INTERRUPT_STATUS_TEXT,
  preserveLoopState = false,
}: {
  client: ConatClient;
  turn: {
    project_id: string;
    path: string;
    message_date?: string | null;
    sender_id?: string | null;
    message_id?: string | null;
    thread_id?: string | null;
    owner_instance_id?: string | null;
  };
  interruptedNotice?: string;
  interruptedReasonId?: string;
  recoveryReason?: string;
  preserveLoopState?: boolean;
}): Promise<boolean> {
  const project_id = `${turn.project_id ?? ""}`.trim();
  const path = `${turn.path ?? ""}`.trim();
  if (!project_id || !path) return false;
  const message_date = `${turn.message_date ?? ""}`.trim();
  const sender_id = `${turn.sender_id ?? "openai-codex-agent"}`.trim();
  const message_id = `${turn.message_id ?? ""}`.trim();
  const thread_id = `${turn.thread_id ?? ""}`.trim();

  if (message_date) {
    try {
      clearAcpPayloads({
        project_id,
        path,
        message_date,
        sender_id,
        message_id: message_id || undefined,
        thread_id: thread_id || undefined,
      } as any);
    } catch (err) {
      logger.debug("failed clearing acp queue during stuck-turn repair", {
        project_id,
        path,
        message_date,
        err,
      });
    }
  }

  let repairedChat = false;
  await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      const current =
        findRecoverableChatRow(syncdb as any, {
          message_date,
          sender_id,
          message_id: message_id || undefined,
        }) ??
        (thread_id
          ? findLatestGeneratingChatRow(syncdb, thread_id)
          : undefined);
      const currentThreadId =
        `${syncdbField<string>(current, "thread_id") ?? thread_id}`.trim() ||
        undefined;
      const currentMessageId =
        `${syncdbField<string>(current, "message_id") ?? message_id}`.trim() ||
        undefined;
      const currentState = currentThreadId
        ? syncdbField<string>(
            preferredThreadStateRow(syncdb, currentThreadId),
            "state",
          )
        : undefined;
      const generating = syncdbField<boolean>(current, "generating") === true;
      const interrupted =
        syncdbField<boolean>(current, "acp_interrupted") === true;
      let touched = false;

      if (
        current != null &&
        (generating || !interrupted || currentState === "running")
      ) {
        const history = appendRestartNotice(syncdbField(current, "history"));
        const patchedHistory =
          interruptedNotice === RESTART_INTERRUPTED_NOTICE
            ? history
            : (() => {
                const currentHistory = historyToArray(
                  syncdbField(current, "history"),
                );
                if (currentHistory.length === 0) {
                  return [];
                }
                const first = currentHistory[0] as MessageHistory;
                const content =
                  typeof first?.content === "string"
                    ? first.content
                    : `${(first as any)?.content ?? ""}`;
                if (/conversation interrupted/i.test(content)) {
                  return currentHistory;
                }
                const sep = content.trim().length > 0 ? "\n\n" : "";
                return [
                  {
                    ...first,
                    content: `${content}${sep}${interruptedNotice}`,
                  },
                  ...currentHistory.slice(1),
                ];
              })();
        const rowDate =
          normalizeIsoDateString(syncdbField<string>(current, "date")) ??
          normalizeIsoDateString(message_date) ??
          message_date;
        const rowSender =
          syncdbField<string>(current, "sender_id") ?? sender_id;
        const update: any = {
          event: "chat",
          date: rowDate,
          sender_id: rowSender,
          generating: false,
          acp_interrupted: true,
          acp_interrupted_reason: interruptedReasonId,
          acp_interrupted_text: interruptedNotice,
        };
        if (currentMessageId) {
          update.message_id = currentMessageId;
        }
        if (currentThreadId) {
          update.thread_id = currentThreadId;
        }
        const parentMessageId = syncdbField<string>(
          current,
          "parent_message_id",
        );
        if (parentMessageId) {
          update.parent_message_id = parentMessageId;
        }
        if (patchedHistory.length > 0) {
          update.history = patchedHistory;
        }
        syncdb.set(update);
        touched = true;
      }

      if (currentThreadId) {
        replaceThreadScopedRow(
          syncdb,
          THREAD_STATE_EVENT,
          currentThreadId,
          buildThreadStateRecord({
            thread_id: currentThreadId,
            state: "interrupted",
            active_message_id: currentMessageId,
            updated_at: new Date().toISOString(),
            schema_version: THREAD_STATE_SCHEMA_VERSION,
          }),
        );
        touched = true;
        const cfgRow = preferredThreadConfigRow(syncdb, currentThreadId);
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
          !preserveLoopState &&
          loopCfg?.enabled === true &&
          loopStateCurrent &&
          loopStateCurrent.status !== "stopped"
        ) {
          const cfgObj =
            cfgRow && typeof cfgRow.toJS === "function"
              ? cfgRow.toJS()
              : (cfgRow ?? {});
          replaceThreadScopedRow(syncdb, THREAD_CONFIG_EVENT, currentThreadId, {
            ...cfgObj,
            ...threadConfigMetadataPatch({
              thread_id: currentThreadId,
              updated_at: new Date().toISOString(),
              updated_by: "__system__",
            }),
            loop_config: null,
            loop_state: {
              ...loopStateCurrent,
              status: "stopped",
              stop_reason:
                interruptedReasonId === "interrupt"
                  ? "user_stopped"
                  : "backend_error",
              next_prompt: undefined,
              updated_at_ms: Date.now(),
            },
          });
        }
      }

      if (touched) {
        syncdb.commit();
        await syncdb.save();
        repairedChat = true;
      }
    },
  });

  let repairedBackend = false;
  for (const row of listRunningAcpJobs()) {
    if (
      runningTurnMatchesTarget(row, {
        project_id,
        path,
        message_date: message_date || undefined,
        message_id: message_id || undefined,
        thread_id: thread_id || undefined,
      })
    ) {
      setAcpJobState({
        op_id: row.op_id,
        state: "interrupted",
        error: recoveryReason,
        worker_id: row.worker_id ?? turn.owner_instance_id ?? undefined,
      });
      repairedBackend = true;
    }
  }

  for (const row of listRunningAcpTurnLeases()) {
    if (
      runningTurnMatchesTarget(row, {
        project_id,
        path,
        message_date: message_date || undefined,
        message_id: message_id || undefined,
        thread_id: thread_id || undefined,
      })
    ) {
      finalizeAcpTurnLease({
        key: {
          project_id: row.project_id,
          path: row.path,
          message_date: row.message_date,
        },
        state: "aborted",
        reason: recoveryReason,
        owner_instance_id:
          turn.owner_instance_id ?? row.owner_instance_id ?? undefined,
      });
      repairedBackend = true;
    }
  }

  return repairedChat || repairedBackend;
}

export async function turnNeedsInterruptedRepair({
  client,
  turn,
}: {
  client: ConatClient;
  turn: {
    project_id: string;
    path: string;
    message_date?: string | null;
    sender_id?: string | null;
    message_id?: string | null;
    thread_id?: string | null;
  };
}): Promise<boolean> {
  const project_id = `${turn.project_id ?? ""}`.trim();
  const path = `${turn.path ?? ""}`.trim();
  const thread_id = `${turn.thread_id ?? ""}`.trim();
  const target = {
    project_id,
    path,
    message_date: `${turn.message_date ?? ""}`.trim() || undefined,
    message_id: `${turn.message_id ?? ""}`.trim() || undefined,
    thread_id: thread_id || undefined,
  };
  // A live running job/lease means the detached ACP worker still owns this
  // turn. In that case an interrupt request must be forwarded to the worker,
  // not "repaired" locally as if the turn were orphaned.
  if (
    listRunningAcpJobs().some((row) => runningTurnMatchesTarget(row, target)) ||
    listRunningAcpTurnLeases().some((row) =>
      runningTurnMatchesTarget(row, target),
    )
  ) {
    return false;
  }
  if (!thread_id) {
    return false;
  }
  let needsRepair = false;
  await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      const state = syncdbField<string>(
        preferredThreadStateRow(syncdb, thread_id),
        "state",
      );
      if (state === "running") {
        needsRepair = true;
        return;
      }
      const current =
        findRecoverableChatRow(syncdb as any, {
          message_date: `${turn.message_date ?? ""}`.trim(),
          sender_id: `${turn.sender_id ?? "openai-codex-agent"}`.trim(),
          message_id: `${turn.message_id ?? ""}`.trim() || undefined,
        }) ?? findLatestGeneratingChatRow(syncdb, thread_id);
      needsRepair = syncdbField<boolean>(current, "generating") === true;
    },
  });
  return needsRepair;
}

export async function recoverOrphanedAcpTurns(
  client: ConatClient,
  opts: {
    liveOwnerIds?: Set<string>;
    interruptedNotice?: string;
    recoveryReason?: string;
    autoResume?: boolean;
  } = {},
): Promise<number> {
  let running;
  try {
    running = listRunningAcpTurnLeases();
  } catch (err) {
    logger.warn("failed to list running acp turn leases", err);
    return 0;
  }
  const liveOwnerIds = opts.liveOwnerIds;
  if (liveOwnerIds?.size) {
    running = running.filter((row) => !liveOwnerIds.has(row.owner_instance_id));
  } else {
    running = running.filter(
      (row) => row.owner_instance_id !== ACP_INSTANCE_ID,
    );
  }
  if (!running.length) return 0;
  const interruptedNotice =
    opts.interruptedNotice ?? RESTART_INTERRUPTED_NOTICE;
  const recoveryReason = opts.recoveryReason ?? "server restart recovery";
  const autoResume = opts.autoResume === true;
  const interruptedReasonId =
    interruptedNotice === RESTART_INTERRUPTED_NOTICE
      ? "server_restart"
      : "worker_stopped";
  logger.warn("recovering orphaned acp turns", {
    instance: ACP_INSTANCE_ID,
    count: running.length,
    reason: recoveryReason,
  });
  let recovered = 0;
  for (const turn of running) {
    const recoverySourceJob = listRunningAcpJobs().find((row) =>
      runningTurnMatchesTarget(row, {
        project_id: turn.project_id,
        path: turn.path,
        message_date: turn.message_date,
        message_id: turn.message_id ?? undefined,
        thread_id: turn.thread_id ?? undefined,
      }),
    );
    try {
      if (
        await repairInterruptedAcpTurn({
          client,
          turn,
          interruptedNotice,
          interruptedReasonId,
          recoveryReason,
          preserveLoopState: autoResume,
        })
      ) {
        if (autoResume && recoverySourceJob) {
          try {
            const resumed = await enqueueRecoveryContinuationForJob({
              client,
              job: recoverySourceJob,
              interruptedNotice,
              recoveryReason,
            });
            if (resumed) {
              logger.warn("queued ACP recovery continuation", {
                interrupted_op_id: recoverySourceJob.op_id,
                resumed_op_id: resumed.op_id,
                recovery_count: resumed.recovery_count,
                thread_id: resumed.thread_id,
              });
            }
          } catch (err) {
            logger.warn("failed to enqueue ACP recovery continuation", {
              turn,
              op_id: recoverySourceJob.op_id,
              err,
            });
          }
        }
        recovered += 1;
        continue;
      }
    } catch (err) {
      logger.warn("failed to repair orphaned acp turn via shared path", {
        turn,
        err,
      });
    }
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
          const patchedHistory =
            interruptedNotice === RESTART_INTERRUPTED_NOTICE
              ? history
              : (() => {
                  const currentHistory = historyToArray(
                    syncdbField(current, "history"),
                  );
                  if (currentHistory.length === 0) {
                    return [];
                  }
                  const first = currentHistory[0] as MessageHistory;
                  const content =
                    typeof first?.content === "string"
                      ? first.content
                      : `${(first as any)?.content ?? ""}`;
                  if (/conversation interrupted/i.test(content)) {
                    return currentHistory;
                  }
                  const sep = content.trim().length > 0 ? "\n\n" : "";
                  return [
                    {
                      ...first,
                      content: `${content}${sep}${interruptedNotice}`,
                    },
                    ...currentHistory.slice(1),
                  ];
                })();
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
            acp_interrupted_reason: interruptedReasonId,
            acp_interrupted_text: interruptedNotice,
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
          if (patchedHistory.length > 0) {
            update.history = patchedHistory;
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
              !autoResume &&
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
                ...threadConfigMetadataPatch({
                  thread_id: threadId,
                  updated_at: new Date().toISOString(),
                  updated_by: "__system__",
                }),
                loop_config: null,
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
      if (turn.message_id) {
        setAcpJobState({
          op_id: turn.message_id,
          state: "interrupted",
          error: recoveryReason,
          worker_id: turn.owner_instance_id,
        });
      }
      if (autoResume && recoverySourceJob) {
        try {
          const resumed = await enqueueRecoveryContinuationForJob({
            client,
            job: recoverySourceJob,
            interruptedNotice,
            recoveryReason,
          });
          if (resumed) {
            logger.warn("queued ACP recovery continuation", {
              interrupted_op_id: recoverySourceJob.op_id,
              resumed_op_id: resumed.op_id,
              recovery_count: resumed.recovery_count,
              thread_id: resumed.thread_id,
            });
          }
        } catch (err) {
          logger.warn("failed to enqueue ACP recovery continuation", {
            turn,
            op_id: recoverySourceJob.op_id,
            err,
          });
        }
      }
      finalizeAcpTurnLease({
        key: {
          project_id: turn.project_id,
          path: turn.path,
          message_date: turn.message_date,
        },
        state: "aborted",
        reason: recoveryReason,
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

function acpTurnLeaseKey({
  project_id,
  path,
  message_date,
}: {
  project_id: string;
  path: string;
  message_date: string;
}): string {
  return `${project_id}\u0000${path}\u0000${message_date}`;
}

export async function recoverOrphanedRunningAcpJobsWithoutLease(
  opts: {
    recoveryReason?: string;
    graceMs?: number;
  } = {},
): Promise<number> {
  const recoveryReason =
    opts.recoveryReason ?? "ACP worker stopped before turn startup";
  const graceMs = opts.graceMs ?? ACP_JOB_WITHOUT_LEASE_RECOVERY_GRACE_MS;
  const now = Date.now();
  const runningLeaseKeys = new Set(
    listRunningAcpTurnLeases().map((row) =>
      acpTurnLeaseKey({
        project_id: row.project_id,
        path: row.path,
        message_date: row.message_date,
      }),
    ),
  );
  let recovered = 0;
  for (const job of listRunningAcpJobs()) {
    const messageDate = `${job.assistant_message_date ?? ""}`.trim();
    if (!messageDate) continue;
    if (
      runningLeaseKeys.has(
        acpTurnLeaseKey({
          project_id: job.project_id,
          path: job.path,
          message_date: messageDate,
        }),
      )
    ) {
      continue;
    }
    const startedAt = Number(job.started_at ?? 0);
    if (
      Number.isFinite(startedAt) &&
      startedAt > 0 &&
      now - startedAt < graceMs
    ) {
      continue;
    }
    requeueRunningAcpJob({
      op_id: job.op_id,
      error: recoveryReason,
      worker_id: job.worker_id ?? undefined,
    });
    recovered += 1;
  }
  if (recovered > 0) {
    logger.warn("requeued orphaned ACP jobs without leases", {
      instance: ACP_INSTANCE_ID,
      recovered,
      grace_ms: graceMs,
    });
  }
  return recovered;
}

export async function recoverCurrentWorkerStuckAcpTurns(
  client: ConatClient,
  opts: {
    recoveryReason?: string;
    interruptedNotice?: string;
    graceMs?: number;
  } = {},
): Promise<number> {
  const recoveryReason = opts.recoveryReason ?? "backend lost live Codex turn";
  const interruptedNotice =
    opts.interruptedNotice ?? STALE_TURN_INTERRUPTED_NOTICE;
  const graceMs = opts.graceMs ?? ACP_CURRENT_WORKER_TURN_RECOVERY_GRACE_MS;
  const now = Date.now();
  let recovered = 0;
  for (const turn of listRunningAcpTurnLeases()) {
    if (turn.owner_instance_id !== ACP_INSTANCE_ID) continue;
    if (hasLiveChatWriterForTurn(turn)) continue;
    const heartbeatAt = Number(turn.heartbeat_at ?? 0);
    const startedAt = Number(turn.started_at ?? 0);
    const referenceAt =
      Number.isFinite(heartbeatAt) && heartbeatAt > 0
        ? heartbeatAt
        : Number.isFinite(startedAt) && startedAt > 0
          ? startedAt
          : 0;
    if (referenceAt > 0 && now - referenceAt < graceMs) continue;
    try {
      if (
        await repairInterruptedAcpTurn({
          client,
          turn,
          interruptedNotice,
          interruptedReasonId: "backend_error",
          recoveryReason,
        })
      ) {
        recovered += 1;
      }
    } catch (err) {
      logger.warn("failed recovering current-worker stuck acp turn", {
        turn,
        err,
      });
    }
  }
  if (recovered > 0) {
    logger.warn("recovered current-worker stuck acp turns", {
      instance: ACP_INSTANCE_ID,
      recovered,
      grace_ms: graceMs,
    });
  }
  return recovered;
}

export function shouldStopDetachedWorkerForIdle({
  hasWork,
  idleSince,
  idleExitMs,
  now = Date.now(),
}: {
  hasWork: boolean;
  idleSince: number;
  idleExitMs?: number | null;
  now?: number;
}): boolean {
  if (hasWork) return false;
  if (!idleSince) return false;
  if (idleExitMs == null || idleExitMs < 0) return false;
  return now - idleSince >= idleExitMs;
}

export async function recoverDetachedWorkerStartupState(
  client: ConatClient,
  opts: {
    workerContext?: DetachedWorkerContext | null;
    restartReason?: string;
  } = {},
): Promise<void> {
  const workerContext = opts.workerContext ?? null;
  const restartReason = opts.restartReason ?? "worker restart";
  const recoveryReason =
    workerContext != null
      ? restartReason || "ACP worker stopped unexpectedly"
      : "ACP worker stopped before turn startup";
  if (workerContext) {
    await recoverOrphanedAcpTurns(client, {
      liveOwnerIds: liveWorkerOwnerIds(workerContext.host_id),
      interruptedNotice: interruptedNoticeForRecoveryReason(recoveryReason),
      recoveryReason,
      autoResume: true,
    });
  } else {
    // Local Lite detached workers do not have a host-managed worker registry.
    // On startup, rely on lease-based orphan recovery only. Blindly
    // interrupting every running job here turns benign worker start races into
    // visible failures: a replacement worker can start while another worker is
    // still claiming or beginning a turn, and marking all running jobs
    // interrupted will kill that in-flight turn even though it is not actually
    // orphaned.
    //
    // We still accept a restartReason option so callers/tests can report the
    // intended recovery reason consistently elsewhere, but we intentionally do
    // not apply it as a blanket job-state rewrite here.
    void restartReason;
    await recoverOrphanedAcpTurns(client, {
      interruptedNotice: interruptedNoticeForRecoveryReason(restartReason),
      recoveryReason: restartReason,
      autoResume: true,
    });
  }
  await recoverOrphanedRunningAcpJobsWithoutLease({
    recoveryReason,
  });
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
  startAcpSteerPoller();
  if (typeof (client as any)?.waitUntilSignedIn === "function") {
    await (client as any).waitUntilSignedIn({ timeout: 5000 });
  }
  const idleExitMs =
    options.idleExitMs === undefined
      ? ACP_WORKER_IDLE_EXIT_MS
      : options.idleExitMs;
  const restartReason = options.restartReason ?? "worker restart";
  const workerContext = projectHostWorkerContextFromEnv();
  currentDetachedWorkerContext = workerContext ? { ...workerContext } : null;
  let workerStopReason: string | undefined;
  let workerHeartbeatTimer: NodeJS.Timeout | undefined;
  const syncDetachedWorkerState = (): {
    state: AcpWorkerState;
    runningJobs: number;
  } | null => {
    if (!workerContext || !currentDetachedWorkerContext) {
      return null;
    }
    const persisted = getAcpWorker(workerContext.worker_id);
    const nextState =
      persisted?.state === "draining" || persisted?.state === "stopped"
        ? "draining"
        : currentDetachedWorkerContext.state;
    currentDetachedWorkerContext.state = nextState;
    const runningJobs = countRunningAcpJobsForWorker(workerContext.worker_id);
    heartbeatAcpWorker({
      worker_id: workerContext.worker_id,
      pid: process.pid,
      state: nextState,
      last_seen_running_jobs: runningJobs,
    });
    if (nextState === "draining" && runningJobs === 0) {
      workerStopReason ??=
        persisted?.state === "stopped" ? "stopped" : "drained";
    }
    return { state: nextState, runningJobs };
  };
  try {
    if (workerContext) {
      const now = Date.now();
      upsertAcpWorker({
        worker_id: workerContext.worker_id,
        host_id: workerContext.host_id,
        bundle_version: workerContext.bundle_version,
        bundle_path: workerContext.bundle_path,
        pid: process.pid,
        state: workerContext.state,
        started_at: now,
        last_heartbeat_at: now,
        last_seen_running_jobs: 0,
        exit_requested_at: workerContext.state === "draining" ? now : null,
        stopped_at: null,
        stop_reason: null,
      });
      syncDetachedWorkerState();
      workerHeartbeatTimer = setInterval(() => {
        try {
          syncDetachedWorkerState();
        } catch (err) {
          logger.warn("ACP worker heartbeat failed", {
            instance: ACP_INSTANCE_ID,
            err,
          });
        }
      }, ACP_WORKER_HEARTBEAT_MS);
      workerHeartbeatTimer.unref?.();
    }
    logger.warn("starting ACP queue worker", {
      instance: ACP_INSTANCE_ID,
      pid: process.pid,
      poll_ms: ACP_WORKER_POLL_MS,
      idle_exit_ms: idleExitMs,
    });
    await recoverDetachedWorkerStartupState(client, {
      workerContext,
      restartReason,
    });
    let idleSince = 0;
    let lastRecoveryAt = Date.now();
    while (true) {
      const workerStatus = syncDetachedWorkerState();
      if (Date.now() - lastRecoveryAt >= ACP_ORPHAN_RECOVERY_POLL_MS) {
        lastRecoveryAt = Date.now();
        if (workerContext) {
          await recoverOrphanedAcpTurns(client, {
            liveOwnerIds: liveWorkerOwnerIds(workerContext.host_id),
            interruptedNotice: WORKER_INTERRUPTED_NOTICE,
            recoveryReason: "ACP worker stopped unexpectedly",
          });
        }
        await recoverCurrentWorkerStuckAcpTurns(client, {
          recoveryReason: "backend lost live Codex turn",
        });
        await recoverOrphanedRunningAcpJobsWithoutLease({
          recoveryReason:
            workerContext != null
              ? "ACP worker stopped unexpectedly"
              : "ACP worker stopped before turn startup",
        });
      }
      if (!workerContext || workerStatus?.state === "active") {
        kickAllQueuedAcpJobs();
      }
      const hasWork =
        listQueuedAcpJobs().length > 0 || listRunningAcpJobs().length > 0;
      if (hasWork) {
        idleSince = 0;
      } else if (!idleSince) {
        idleSince = Date.now();
      }
      if (workerStopReason) {
        logger.warn("stopping ACP queue worker after drain", {
          instance: ACP_INSTANCE_ID,
          pid: process.pid,
          reason: workerStopReason,
        });
        return;
      } else if (
        shouldStopDetachedWorkerForIdle({
          hasWork,
          idleSince,
          idleExitMs,
        })
      ) {
        logger.warn("stopping ACP queue worker after idle timeout", {
          instance: ACP_INSTANCE_ID,
          pid: process.pid,
          idle_ms: Date.now() - idleSince,
        });
        workerStopReason = "idle_timeout";
        return;
      }
      await sleep(ACP_WORKER_POLL_MS);
    }
  } finally {
    if (workerHeartbeatTimer != null) {
      clearInterval(workerHeartbeatTimer);
    }
    if (workerContext) {
      stopAcpWorker({
        worker_id: workerContext.worker_id,
        reason: workerStopReason ?? "shutdown",
      });
      currentDetachedWorkerContext = null;
    }
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
  // - container paths to live under the in-container workspace root
  // - host paths to point to the bind mount on the host
  // This lets us distinguish whether an incoming absolute path is host-side or
  // container-side. Warn early if we can't tell the difference.
  if (workspaceRoot === hostRoot && workspaceRoot !== "/") {
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
    logger.debug("ensureAgent: creating codex app-server agent");
    const created = await CodexAppServerAgent.create({
      binaryPath: process.env.COCALC_CODEX_BIN,
      cwd: bindings.workspaceRoot ?? process.cwd(),
    });
    logger.info("codex agent ready", { key, backend: "app-server" });
    agents.set(key, created);
    return created;
  } catch (err) {
    // Fail loudly: use an echo agent that emits an explicit error to the user.
    logger.error("failed to start codex agent; using echo agent", err);
    const echo = new EchoAgent(
      `ERROR: codex failed to start (${(err as Error)?.message ?? "unknown error"})`,
    );
    agents.set(key, echo);
    return echo;
  }
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
  const runtimeEnv = await buildCodexRuntimeEnv({
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
  const { prompt, local_images, cleanup } = await materializeBlobs(
    request.prompt ?? "",
  );
  if (!conatClient) {
    throw Error("conat client must be initialized");
  }
  const chatContext = request.chat
    ? {
        ...request.chat,
        started_at_ms:
          Number(request.chat.started_at_ms) > 0
            ? Number(request.chat.started_at_ms)
            : startedAt,
      }
    : undefined;
  const chatWriter = chatContext
    ? new ChatStreamWriter({
        metadata: chatContext,
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
    const persistConfig =
      loopState &&
      loopState.status !== "stopped" &&
      loopState.status !== "paused"
        ? loopConfig
        : undefined;
    await chatWriter.persistLoopState({
      loopConfig: persistConfig,
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
    let iterationPrompt = ensureLoopContractPrompt(prompt, loopConfig);
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
          local_images,
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

      iterationPrompt = ensureLoopContractPrompt(nextPrompt, loopConfig);
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
    await chatWriter?.waitUntilDisposed();
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
      const versionCountBefore = syncdbVersionCount(syncdb);
      const waitingInLine = threadHasRunningState(syncdb, thread_id);
      const projectedMessageState = queued
        ? waitingInLine
          ? "queued"
          : "running"
        : null;
      let touched = false;
      if (waitingInLine) {
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
        touched = true;
      }

      if (touched) {
        syncdb.commit();
        await syncdb.save();
        logSyncdbPatchflowDelta({
          syncdb,
          before: versionCountBefore,
          phase: "queued-user-projection",
          extra: {
            project_id,
            path,
            thread_id,
            user_message_id,
            queued,
            projectedMessageState,
          },
        });
      }
      return projectedMessageState;
    },
  });
}

function automationMessageLabel(
  row: AcpAutomationRow,
  manual: boolean,
): string {
  const base = `${row.title ?? ""}`.trim() || "Automation";
  const kind = row.run_kind === "command" ? "command run" : "run";
  return manual ? `Manual ${kind}: ${base}` : `Scheduled ${kind}: ${base}`;
}

async function enqueueAutomationRun(
  row: AcpAutomationRow,
  opts: { manual: boolean },
): Promise<AcpAutomationRow> {
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  if (row.run_kind === "command") {
    if (!row.command?.trim()) {
      throw new Error("automation is missing a command");
    }
  } else if (!row.prompt?.trim()) {
    throw new Error("automation is missing a prompt");
  }
  if (row.status === "running") {
    return row;
  }
  const now = Date.now();
  const user_message_id = randomUUID();
  const assistant_message_id = randomUUID();
  const userDate = new Date(now).toISOString();
  const assistantDate = new Date(now + 1).toISOString();
  let automationSenderId = DEFAULT_AUTOMATION_CHAT_SENDER_ID;
  let automationConfig = buildAutomationAcpConfig({ chatPath: row.path });

  await withChatSyncDB({
    client: conatClient,
    project_id: row.project_id,
    path: row.path,
    fn: async (syncdb) => {
      const threadConfig = preferredThreadConfigRow(syncdb, row.thread_id);
      automationSenderId = resolveAutomationChatSenderId(
        syncdbField<string>(threadConfig, "agent_model"),
      );
      automationConfig = buildAutomationAcpConfig({
        chatPath: row.path,
        config: syncdbField(threadConfig, "acp_config"),
      });
      const parent_message_id = latestThreadMessageIdInSyncDB({
        syncdb,
        threadId: row.thread_id,
      });
      syncdb.set(
        buildChatMessage({
          sender_id: automationSenderId,
          date: userDate,
          prevHistory: [],
          content: automationMessageLabel(row, opts.manual),
          generating: false,
          message_id: user_message_id,
          thread_id: row.thread_id,
          parent_message_id,
        }),
      );
      syncdb.commit();
      await syncdb.save();
    },
  });

  const chat: AcpChatContext = {
    project_id: row.project_id,
    path: row.path,
    sender_id: automationSenderId,
    thread_id: row.thread_id,
    parent_message_id: user_message_id,
    message_id: assistant_message_id,
    message_date: assistantDate,
    automation_id: row.automation_id,
    automation_title: row.title ?? undefined,
  };
  const request: AcpJobRequest =
    row.run_kind === "command"
      ? {
          request_kind: "command",
          project_id: row.project_id,
          account_id: row.account_id,
          command: `${row.command ?? ""}`.trim(),
          cwd: row.command_cwd ?? undefined,
          timeout_ms:
            row.command_timeout_ms ?? AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS,
          max_output_bytes:
            row.command_max_output_bytes ??
            AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
          chat,
        }
      : {
          project_id: row.project_id,
          account_id: row.account_id,
          prompt: row.prompt ?? "",
          config: automationConfig,
          chat,
        };

  const job = enqueueAcpJob(request);
  await persistQueuedUserMessageProjection({
    client: conatClient,
    project_id: row.project_id,
    path: row.path,
    thread_id: row.thread_id,
    user_message_id,
    queued: true,
  });

  const updated = upsertAcpAutomation({
    ...row,
    status: "running",
    last_run_started_at: now,
    last_error: null,
    last_job_op_id: job.op_id,
    last_message_id: assistant_message_id,
    updated_at: now,
  });
  await patchThreadAutomationProjection({
    project_id: updated.project_id,
    path: updated.path,
    thread_id: updated.thread_id,
    updated_by: row.account_id,
    automation_config: toAutomationConfig(
      updated,
    ) as ChatThreadAutomationConfig,
    automation_state: toAutomationState(updated) as ChatThreadAutomationState,
  });
  await publishAutomationRecordToProjectIndex(updated);
  if (liteUseDetachedAcpWorker()) {
    await ensureDetachedWorkerRunning({ force: true });
  } else {
    kickAllQueuedAcpJobs();
  }
  return updated;
}

async function finalizeAutomationRun(opts: {
  automation_id?: string;
  terminalState: "completed" | "error" | "interrupted";
  last_job_op_id?: string;
  last_message_id?: string;
  error?: string;
}): Promise<void> {
  const automation_id = `${opts.automation_id ?? ""}`.trim();
  if (!automation_id) return;
  const current = getAcpAutomationById(automation_id);
  if (!current) return;
  const now = Date.now();
  const nextUnacknowledgedRuns = (current.unacknowledged_runs ?? 0) + 1;
  const unattendedLimit =
    current.pause_after_unacknowledged_runs ?? AUTOMATION_DEFAULT_UNACK_LIMIT;
  let status: AcpAutomationRow["status"];
  let paused_reason: string | null = null;
  if (nextUnacknowledgedRuns >= unattendedLimit) {
    status = "paused";
    paused_reason = "unacknowledged_runs_limit";
  } else if (opts.terminalState === "error") {
    status = "error";
  } else {
    status = current.enabled ? "active" : "paused";
  }
  const next_run_at =
    current.enabled && status !== "paused"
      ? (computeNextAutomationRunAt(current, {
          nowMs: now,
          defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
        }) ??
        current.next_run_at ??
        null)
      : (current.next_run_at ?? null);
  const updated = upsertAcpAutomation({
    ...current,
    status,
    next_run_at,
    last_run_finished_at: now,
    unacknowledged_runs: nextUnacknowledgedRuns,
    paused_reason,
    last_error:
      opts.error ??
      (opts.terminalState === "error" ? "automation run failed" : null),
    last_job_op_id: opts.last_job_op_id ?? current.last_job_op_id ?? null,
    last_message_id: opts.last_message_id ?? current.last_message_id ?? null,
    updated_at: now,
  });
  await patchThreadAutomationProjection({
    project_id: updated.project_id,
    path: updated.path,
    thread_id: updated.thread_id,
    updated_by: updated.account_id,
    automation_config: toAutomationConfig(
      updated,
    ) as ChatThreadAutomationConfig,
    automation_state: toAutomationState(updated) as ChatThreadAutomationState,
  });
  await publishAutomationRecordToProjectIndex(updated);
}

async function acknowledgeAutomationFromHumanTurn(
  request: Pick<AcpRequest, "project_id" | "account_id" | "chat">,
): Promise<void> {
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? ""}`.trim();
  const thread_id = `${request.chat?.thread_id ?? ""}`.trim();
  if (!project_id || !path || !thread_id) return;
  if (`${request.chat?.automation_id ?? ""}`.trim()) return;
  const current = getAcpAutomationByThread({ project_id, path, thread_id });
  if (!current) return;
  const now = Date.now();
  const updated = upsertAcpAutomation({
    ...current,
    last_acknowledged_at: now,
    unacknowledged_runs: 0,
    updated_at: now,
  });
  await patchThreadAutomationProjection({
    project_id: updated.project_id,
    path: updated.path,
    thread_id: updated.thread_id,
    updated_by: request.account_id || updated.account_id,
    automation_config: toAutomationConfig(
      updated,
    ) as ChatThreadAutomationConfig,
    automation_state: toAutomationState(updated) as ChatThreadAutomationState,
  });
  await publishAutomationRecordToProjectIndex(updated);
}

async function pollDueAcpAutomations(): Promise<void> {
  if (acpAutomationPollInFlight) return;
  if (!conatClient) return;
  acpAutomationPollInFlight = true;
  try {
    const due = listDueAcpAutomations(Date.now());
    for (const row of due) {
      try {
        await enqueueAutomationRun(row, { manual: false });
      } catch (err) {
        logger.warn("failed to enqueue due automation", {
          automation_id: row.automation_id,
          err,
        });
      }
    }
  } finally {
    acpAutomationPollInFlight = false;
  }
}

function startAcpAutomationPoller(): void {
  if (acpAutomationPollerStarted) return;
  acpAutomationPollerStarted = true;
  void pollDueAcpAutomations();
  const handle = setInterval(() => {
    void pollDueAcpAutomations();
  }, ACP_AUTOMATION_POLL_MS);
  if (typeof handle?.unref === "function") {
    handle.unref();
  }
}

async function republishAcpAutomationProjectIndexes(): Promise<void> {
  for (const row of listAllAcpAutomations()) {
    await publishAutomationRecordToProjectIndex(row);
  }
}

async function handleAcpAutomationRequest(
  request: AcpAutomationRequest,
): Promise<AcpAutomationResponse> {
  const project_id = `${request.project_id ?? ""}`.trim();
  const path = `${request.path ?? ""}`.trim();
  const thread_id = `${request.thread_id ?? ""}`.trim();
  if (!project_id || !path || !thread_id) {
    throw new Error("ACP automation request is missing required fields");
  }
  const existing = getAcpAutomationByThread({ project_id, path, thread_id });
  if (request.action === "delete") {
    deleteAcpAutomationByThread({ project_id, path, thread_id });
    await patchThreadAutomationProjection({
      project_id,
      path,
      thread_id,
      updated_by: request.account_id,
      automation_config: null,
      automation_state: null,
    });
    await deleteAutomationRecordFromProjectIndex({
      project_id,
      path,
      thread_id,
    });
    return { ok: true, config: null, state: null, record: null };
  }
  if (request.action === "upsert") {
    const config = normalizeAcpAutomationConfig(request.config, {
      defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
    });
    if (!config) {
      throw new Error("invalid automation config");
    }
    const automation_id =
      existing?.automation_id ??
      (`${config.automation_id ?? ""}`.trim() || undefined) ??
      randomUUID();
    const enabled = config.enabled !== false;
    const now = Date.now();
    const row = upsertAcpAutomation({
      automation_id,
      project_id,
      path,
      thread_id,
      account_id: existing?.account_id ?? request.account_id,
      enabled,
      title: config.title ?? null,
      run_kind: config.run_kind ?? "codex",
      prompt: config.prompt ?? null,
      command: config.command ?? null,
      command_cwd: config.command_cwd ?? null,
      command_timeout_ms: config.command_timeout_ms ?? null,
      command_max_output_bytes: config.command_max_output_bytes ?? null,
      schedule_type: config.schedule_type ?? "daily",
      days_of_week: config.days_of_week ?? null,
      local_time: config.local_time ?? null,
      interval_minutes: config.interval_minutes ?? null,
      window_start_local_time: config.window_start_local_time ?? null,
      window_end_local_time: config.window_end_local_time ?? null,
      timezone: config.timezone ?? null,
      pause_after_unacknowledged_runs:
        config.pause_after_unacknowledged_runs ??
        AUTOMATION_DEFAULT_UNACK_LIMIT,
      status: enabled ? "active" : "paused",
      next_run_at: enabled
        ? (computeNextAutomationRunAt(config, {
            defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
          }) ?? null)
        : null,
      last_run_started_at: existing?.last_run_started_at ?? null,
      last_run_finished_at: existing?.last_run_finished_at ?? null,
      last_acknowledged_at: existing?.last_acknowledged_at ?? null,
      unacknowledged_runs: existing?.unacknowledged_runs ?? 0,
      paused_reason: enabled ? null : "disabled",
      last_error: existing?.last_error ?? null,
      last_job_op_id: existing?.last_job_op_id ?? null,
      last_message_id: existing?.last_message_id ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    await patchThreadAutomationProjection({
      project_id,
      path,
      thread_id,
      updated_by: request.account_id,
      automation_config: toAutomationConfig(row) as ChatThreadAutomationConfig,
      automation_state: toAutomationState(row) as ChatThreadAutomationState,
    });
    await publishAutomationRecordToProjectIndex(row);
    return {
      ok: true,
      config: toAutomationConfig(row) ?? null,
      state: toAutomationState(row) ?? null,
      record: toAutomationRecord(row) ?? null,
    };
  }
  if (!existing) {
    throw new Error("automation not found");
  }
  if (request.action === "pause") {
    const row = upsertAcpAutomation({
      ...existing,
      enabled: false,
      status: "paused",
      paused_reason: "user_paused",
      updated_at: Date.now(),
    });
    await patchThreadAutomationProjection({
      project_id,
      path,
      thread_id,
      updated_by: request.account_id,
      automation_config: toAutomationConfig(row) as ChatThreadAutomationConfig,
      automation_state: toAutomationState(row) as ChatThreadAutomationState,
    });
    await publishAutomationRecordToProjectIndex(row);
    return {
      ok: true,
      config: toAutomationConfig(row) ?? null,
      state: toAutomationState(row) ?? null,
      record: toAutomationRecord(row) ?? null,
    };
  }
  if (request.action === "resume") {
    const row = upsertAcpAutomation({
      ...existing,
      enabled: true,
      status: "active",
      paused_reason: null,
      next_run_at:
        computeNextAutomationRunAt(existing, {
          defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
        }) ??
        existing.next_run_at ??
        null,
      updated_at: Date.now(),
    });
    await patchThreadAutomationProjection({
      project_id,
      path,
      thread_id,
      updated_by: request.account_id,
      automation_config: toAutomationConfig(row) as ChatThreadAutomationConfig,
      automation_state: toAutomationState(row) as ChatThreadAutomationState,
    });
    await publishAutomationRecordToProjectIndex(row);
    return {
      ok: true,
      config: toAutomationConfig(row) ?? null,
      state: toAutomationState(row) ?? null,
      record: toAutomationRecord(row) ?? null,
    };
  }
  if (request.action === "acknowledge") {
    const row = upsertAcpAutomation({
      ...existing,
      last_acknowledged_at: Date.now(),
      unacknowledged_runs: 0,
      updated_at: Date.now(),
    });
    await patchThreadAutomationProjection({
      project_id,
      path,
      thread_id,
      updated_by: request.account_id,
      automation_config: toAutomationConfig(row) as ChatThreadAutomationConfig,
      automation_state: toAutomationState(row) as ChatThreadAutomationState,
    });
    await publishAutomationRecordToProjectIndex(row);
    return {
      ok: true,
      config: toAutomationConfig(row) ?? null,
      state: toAutomationState(row) ?? null,
      record: toAutomationRecord(row) ?? null,
    };
  }
  if (request.action === "run_now") {
    const row = await enqueueAutomationRun(existing, { manual: true });
    return {
      ok: true,
      config: toAutomationConfig(row) ?? null,
      state: toAutomationState(row) ?? null,
      record: toAutomationRecord(row) ?? null,
    };
  }
  throw new Error(`unsupported ACP automation action: ${request.action}`);
}

function automationRecordKey(opts: {
  path: string;
  thread_id: string;
}): string {
  return `${opts.path}::${opts.thread_id}`;
}

async function getAutomationStore(
  project_id: string,
): Promise<DKV<AcpAutomationRecord>> {
  const existing = automationStores.get(project_id);
  if (existing) return await existing;
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  const promise = conatClient.sync.dkv<AcpAutomationRecord>({
    project_id,
    name: ACP_AUTOMATION_STORE,
  });
  automationStores.set(project_id, promise);
  return await promise;
}

function resetAutomationStoreCache(project_id: string): void {
  automationStores.delete(project_id);
}

function normalizeAcpAutomationRecord(
  record?: AcpAutomationRecord,
): AcpAutomationRow | undefined {
  if (!record) return undefined;
  const automation_id = `${record.automation_id ?? ""}`.trim();
  const project_id = `${record.project_id ?? ""}`.trim();
  const path = `${record.path ?? ""}`.trim();
  const thread_id = `${record.thread_id ?? ""}`.trim();
  const account_id = `${record.account_id ?? ""}`.trim();
  if (!automation_id || !project_id || !path || !thread_id || !account_id) {
    return undefined;
  }
  const config = normalizeAcpAutomationConfig(
    {
      enabled: record.enabled,
      automation_id,
      title: record.title,
      prompt: record.prompt,
      schedule_type: record.schedule_type,
      days_of_week: record.days_of_week,
      local_time: record.local_time,
      interval_minutes: record.interval_minutes,
      window_start_local_time: record.window_start_local_time,
      window_end_local_time: record.window_end_local_time,
      timezone: record.timezone,
      pause_after_unacknowledged_runs:
        record.pause_after_unacknowledged_runs ?? undefined,
    },
    {
      defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
    },
  );
  if (!config) {
    return undefined;
  }
  const parseMs = (value?: number | string): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const enabled = record.enabled !== false && config.enabled !== false;
  const normalizedStatus =
    record.status === "running"
      ? enabled
        ? "active"
        : "paused"
      : record.status === "active" ||
          record.status === "paused" ||
          record.status === "error"
        ? record.status
        : enabled
          ? "active"
          : "paused";
  const next_run_at = enabled
    ? (parseMs(record.next_run_at_ms) ??
      computeNextAutomationRunAt(config, {
        defaultPauseAfterRuns: AUTOMATION_DEFAULT_UNACK_LIMIT,
      }))
    : null;
  return {
    automation_id,
    project_id,
    path,
    thread_id,
    account_id,
    enabled,
    title: config.title ?? null,
    prompt: config.prompt ?? null,
    schedule_type: config.schedule_type ?? "daily",
    days_of_week: config.days_of_week ?? null,
    local_time: config.local_time ?? null,
    interval_minutes: config.interval_minutes ?? null,
    window_start_local_time: config.window_start_local_time ?? null,
    window_end_local_time: config.window_end_local_time ?? null,
    timezone: config.timezone ?? null,
    pause_after_unacknowledged_runs:
      config.pause_after_unacknowledged_runs ?? AUTOMATION_DEFAULT_UNACK_LIMIT,
    status: normalizedStatus,
    next_run_at,
    last_run_started_at: parseMs(record.last_run_started_at_ms) ?? null,
    last_run_finished_at: parseMs(record.last_run_finished_at_ms) ?? null,
    last_acknowledged_at: parseMs(record.last_acknowledged_at_ms) ?? null,
    unacknowledged_runs: clampLoopNumber(record.unacknowledged_runs, 0, 0, 365),
    paused_reason: `${record.paused_reason ?? ""}`.trim() || null,
    last_error: `${record.last_error ?? ""}`.trim() || null,
    last_job_op_id: `${record.last_job_op_id ?? ""}`.trim() || null,
    last_message_id: `${record.last_message_id ?? ""}`.trim() || null,
    created_at:
      parseMs(record.created_at) ?? parseMs(record.updated_at) ?? Date.now(),
    updated_at: parseMs(record.updated_at) ?? Date.now(),
  };
}

export async function rehydrateAcpAutomationsForProject(
  project_id: string,
): Promise<number> {
  const normalizedProjectId = `${project_id ?? ""}`.trim();
  if (!normalizedProjectId) {
    return 0;
  }
  const store = await getAutomationStore(normalizedProjectId);
  const records = Object.values(store.getAll());
  let restored = 0;
  for (const record of records) {
    const row = normalizeAcpAutomationRecord(record);
    if (!row || row.project_id !== normalizedProjectId) {
      continue;
    }
    upsertAcpAutomation(row);
    restored += 1;
  }
  if (restored > 0) {
    logger.debug("rehydrated ACP automations for project", {
      project_id: normalizedProjectId,
      restored,
    });
  }
  return restored;
}

export function clearLocalAcpAutomationsForProject(project_id: string): void {
  const normalizedProjectId = `${project_id ?? ""}`.trim();
  if (!normalizedProjectId) {
    return;
  }
  deleteAcpAutomationsForProject(normalizedProjectId);
  resetAutomationStoreCache(normalizedProjectId);
}

async function publishAutomationRecordToProjectIndex(
  row?: AcpAutomationRow,
): Promise<void> {
  if (!row) return;
  try {
    const store = await getAutomationStore(row.project_id);
    store.set(
      automationRecordKey({ path: row.path, thread_id: row.thread_id }),
      toAutomationRecord(row)!,
    );
  } catch (err) {
    logger.debug("failed to publish automation record", {
      automation_id: row.automation_id,
      err,
    });
  }
}

async function deleteAutomationRecordFromProjectIndex(opts: {
  project_id: string;
  path: string;
  thread_id: string;
}): Promise<void> {
  try {
    const store = await getAutomationStore(opts.project_id);
    store.delete(
      automationRecordKey({ path: opts.path, thread_id: opts.thread_id }),
    );
  } catch (err) {
    logger.debug("failed to delete automation record", { ...opts, err });
  }
}

async function patchThreadAutomationProjection(opts: {
  project_id: string;
  path: string;
  thread_id: string;
  updated_by: string;
  automation_config?: ChatThreadAutomationConfig | null;
  automation_state?: ChatThreadAutomationState | null;
}): Promise<void> {
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  await withChatSyncDB({
    client: conatClient,
    project_id: opts.project_id,
    path: opts.path,
    fn: async (syncdb) => {
      const current = preferredThreadConfigRow(syncdb, opts.thread_id);
      const base = current && typeof current === "object" ? { ...current } : {};
      replaceThreadScopedRow(syncdb, THREAD_CONFIG_EVENT, opts.thread_id, {
        ...base,
        ...threadConfigMetadataPatch({
          thread_id: opts.thread_id,
          updated_at: new Date().toISOString(),
          updated_by: opts.updated_by,
        }),
        automation_config: opts.automation_config ?? null,
        automation_state: opts.automation_state ?? null,
      });
      syncdb.commit();
      await syncdb.save();
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
      const versionCountBefore = syncdbVersionCount(syncdb);
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
          const currentParentMessageId = syncdbField<string>(
            current,
            "parent_message_id",
          );
          const effectiveParentMessageId =
            latestParentMessageId ?? currentParentMessageId;
          if (
            effectiveParentMessageId &&
            effectiveParentMessageId !== currentParentMessageId
          ) {
            const update: Record<string, unknown> = {
              event: "chat",
              date: rowDate,
              sender_id: rowSender,
              message_id: user_message_id,
              thread_id: syncdbField<string>(current, "thread_id") ?? thread_id,
              parent_message_id: effectiveParentMessageId,
            };
            syncdb.set(update);
            syncdb.commit();
            await syncdb.save();
            logSyncdbPatchflowDelta({
              syncdb,
              before: versionCountBefore,
              phase: "queued-user-prepare",
              extra: {
                project_id,
                path,
                thread_id,
                user_message_id,
              },
            });
          }
        }
      }
    },
  });
}

async function enqueueRecoveryContinuationForJob({
  client,
  job,
  interruptedNotice,
  recoveryReason,
}: {
  client: ConatClient;
  job: AcpJobRow;
  interruptedNotice: string;
  recoveryReason: string;
}): Promise<AcpJobRow | undefined> {
  const parentOpId = `${job.op_id ?? ""}`.trim();
  if (!parentOpId) return undefined;
  if (
    listAcpJobsByRecoveryParent({
      recovery_parent_op_id: parentOpId,
    }).length > 0
  ) {
    return undefined;
  }
  const current = getAcpJobByOpId(parentOpId);
  const sourceJob = current ?? job;
  const request = decodeAcpJobRequest(sourceJob);
  if (request.request_kind === "command") {
    return undefined;
  }
  const session_id =
    `${request.session_id ?? sourceJob.session_id ?? ""}`.trim();
  const thread_id =
    `${request.chat?.thread_id ?? sourceJob.thread_id ?? ""}`.trim();
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? sourceJob.project_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? sourceJob.path ?? ""}`.trim();
  if (!project_id || !path || !thread_id || !session_id || !request.chat) {
    return undefined;
  }
  const recoveryCount = Math.max(
    1,
    Math.floor(Number(sourceJob.recovery_count ?? 0)) + 1,
  );
  const user_message_id = randomUUID();
  const assistant_message_id = randomUUID();
  const now = Date.now();
  const userDate = new Date(now).toISOString();
  const assistantDate = new Date(now + 1).toISOString();
  let resumedPrompt = request.prompt;
  let resumedLoopConfig: AcpLoopConfig | undefined;
  let resumedLoopState: AcpLoopState | undefined;
  await withChatSyncDB({
    client,
    project_id,
    path,
    fn: async (syncdb) => {
      const threadCfg = preferredThreadConfigRow(syncdb, thread_id);
      const persistedLoopConfig = toPlainSyncValue(
        syncdbField<AcpLoopConfig | undefined>(threadCfg, "loop_config"),
      );
      const persistedLoopState = toPlainSyncValue(
        syncdbField<AcpLoopState | undefined>(threadCfg, "loop_state"),
      );
      const resumedLoop = normalizeRecoveryLoopResume({
        loopConfig: persistedLoopConfig ?? request.chat?.loop_config,
        loopState: persistedLoopState ?? request.chat?.loop_state,
        originalPrompt: request.prompt,
      });
      resumedPrompt = resumedLoop.prompt;
      resumedLoopConfig = resumedLoop.loopConfig;
      resumedLoopState = resumedLoop.loopState;
      const parent_message_id = latestThreadMessageIdInSyncDB({
        syncdb,
        threadId: thread_id,
      });
      syncdb.set(
        buildChatMessage({
          sender_id: ACP_RECOVERY_CHAT_SENDER_ID,
          date: userDate,
          prevHistory: [],
          content: buildRecoveryContinuationContent({
            interruptedNotice,
            recoveryCount,
          }),
          generating: false,
          message_id: user_message_id,
          thread_id,
          parent_message_id,
        }),
      );
      syncdb.commit();
      await syncdb.save();
    },
  });
  const resumedRequest: AcpJobRequest = {
    ...request,
    prompt: buildRecoveryContinuationPrompt({
      interruptedNotice,
      recoveryCount,
      originalPrompt: resumedPrompt,
    }),
    session_id,
    recovery_parent_op_id: parentOpId,
    recovery_reason: recoveryReason,
    recovery_count: recoveryCount,
    chat: {
      ...request.chat,
      project_id,
      path,
      thread_id,
      parent_message_id: user_message_id,
      message_id: assistant_message_id,
      message_date: assistantDate,
      loop_config: resumedLoopConfig,
      loop_state: resumedLoopState,
      recovery_parent_op_id: parentOpId,
      recovery_reason: recoveryReason,
      recovery_count: recoveryCount,
    },
  };
  const queued = enqueueAcpJob(resumedRequest);
  await persistQueuedUserMessageProjection({
    client,
    project_id,
    path,
    thread_id,
    user_message_id,
    queued: true,
  });
  return queued;
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

async function writeQueuedCommandResultToChat({
  request,
  content,
}: {
  request: AcpCommandRequest;
  content: string;
}): Promise<void> {
  if (!request.chat || !conatClient) return;
  const sender_id =
    `${request.chat.sender_id ?? DEFAULT_AUTOMATION_CHAT_SENDER_ID}`.trim() ||
    DEFAULT_AUTOMATION_CHAT_SENDER_ID;
  await withChatSyncDB({
    client: conatClient,
    project_id: request.chat.project_id,
    path: request.chat.path,
    fn: async (syncdb) => {
      syncdb.set(
        buildChatMessage({
          sender_id,
          date: request.chat?.message_date ?? new Date().toISOString(),
          prevHistory: [],
          content,
          generating: false,
          message_id: request.chat?.message_id,
          thread_id: request.chat?.thread_id,
          parent_message_id: request.chat?.parent_message_id,
        }),
      );
      syncdb.commit();
      await syncdb.save();
    },
  });
}

async function runQueuedCommandJob({
  job,
  request,
}: {
  job: AcpJobRow;
  request: AcpCommandRequest;
}): Promise<void> {
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  const projectId =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  if (!projectId) {
    throw new Error("command automation is missing project id");
  }
  const command = `${request.command ?? ""}`.trim();
  if (!command) {
    throw new Error("command automation is missing command");
  }
  const cwd = resolveAutomationCommandCwd({
    chatPath: `${request.chat?.path ?? job.path ?? ""}`.trim(),
    commandCwd: request.cwd,
  });
  const workspaceRoot = path.isAbsolute(cwd)
    ? cwd
    : resolveWorkspaceRoot(undefined);
  const executor: AcpExecutor = preferContainerExecutor()
    ? new ContainerExecutor({
        projectId,
        workspaceRoot,
        conatClient,
      })
    : new LocalExecutor(workspaceRoot);
  const timeoutMs = Math.max(
    1_000,
    Number(request.timeout_ms ?? AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS),
  );
  const maxOutputBytes = Math.max(
    1_024,
    Number(
      request.max_output_bytes ?? AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
    ),
  );

  try {
    const result = await executor.exec(command, {
      cwd,
      timeoutMs,
      maxOutputBytes,
    });
    const captured = captureCommandAutomationOutput({
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      maxOutputBytes,
      preferStderr: (result.exitCode ?? 0) !== 0 || !!result.signal,
    });
    await writeQueuedCommandResultToChat({
      request,
      content: formatCommandAutomationMarkdown({
        command,
        cwd,
        timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: captured.stdout,
        stderr: captured.stderr,
        truncated: captured.truncated,
        maxOutputBytes,
      }),
    });
    const terminalState =
      (result.exitCode ?? 0) === 0 && !result.signal ? "completed" : "error";
    await finalizeAutomationRun({
      automation_id: request.chat?.automation_id,
      terminalState,
      last_job_op_id: job.op_id,
      last_message_id: request.chat?.message_id,
      error:
        terminalState === "error"
          ? `command exited with ${
              result.signal
                ? `signal ${result.signal}`
                : `code ${result.exitCode ?? "unknown"}`
            }`
          : undefined,
    });
    setAcpJobState({
      op_id: job.op_id,
      state: terminalState,
      error:
        terminalState === "error"
          ? `command exited with ${
              result.signal
                ? `signal ${result.signal}`
                : `code ${result.exitCode ?? "unknown"}`
            }`
          : undefined,
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
    });
  } catch (err) {
    const error = `Command automation failed: ${(err as Error)?.message ?? err}`;
    logger.warn("queued command automation failed", {
      op_id: job.op_id,
      err,
    });
    await writeQueuedCommandResultToChat({
      request,
      content: formatCommandAutomationMarkdown({
        command,
        cwd,
        timeoutMs,
        stderr: error,
        maxOutputBytes,
      }),
    });
    await finalizeAutomationRun({
      automation_id: request.chat?.automation_id,
      terminalState: "error",
      last_job_op_id: job.op_id,
      last_message_id: request.chat?.message_id,
      error,
    });
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error,
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
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
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
    });
    return;
  }
  if (!conatClient) {
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: "conat client must be initialized",
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
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

  if (request.request_kind === "command") {
    await runQueuedCommandJob({ job, request });
    return;
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
    await finalizeAutomationRun({
      automation_id: request.chat?.automation_id,
      terminalState: result.terminalState,
      last_job_op_id: job.op_id,
      last_message_id: request.chat?.message_id,
    });
    setAcpJobState({
      op_id: job.op_id,
      state: result.terminalState,
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
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
    await finalizeAutomationRun({
      automation_id: request.chat?.automation_id,
      terminalState: "error",
      last_job_op_id: job.op_id,
      last_message_id: request.chat?.message_id,
      error: message,
    });
    setAcpJobState({
      op_id: job.op_id,
      state: "error",
      error: message,
      worker_id: job.worker_id ?? currentDetachedWorkerContext?.worker_id,
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
    if (!detachedWorkerCanClaimQueuedJobs()) {
      return;
    }
    const job = claimNextQueuedAcpJobForThread({
      project_id,
      path,
      thread_id,
      worker_id: currentDetachedWorkerContext?.worker_id,
      worker_bundle_version: currentDetachedWorkerContext?.bundle_version,
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
  if (!detachedWorkerCanClaimQueuedJobs()) {
    return;
  }
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
  if (!detachedWorkerCanClaimQueuedJobs()) {
    return;
  }
  const seen = new Set<string>();
  for (const job of listQueuedAcpJobs()) {
    const key = acpJobThreadKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    kickQueuedAcpJobsForThread(job);
  }
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

function resolveSteerCandidateIds({
  project_id,
  path,
  thread_id,
  session_id,
  chat,
}: {
  project_id?: string;
  path?: string;
  thread_id?: string;
  session_id?: string;
  chat?: AcpChatContext;
}): string[] {
  const ids = new Set<string>();
  for (const id of resolveInterruptCandidateIds({
    project_id,
    path,
    thread_id,
  })) {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }
  const sessionId = `${session_id ?? ""}`.trim();
  if (sessionId) {
    ids.add(sessionId);
  }
  const writer = findChatWriter({ threadId: thread_id, chat });
  writer?.getKnownThreadIds().forEach((id) => {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  });
  return [...ids];
}

type AcpSteerAttemptResult = {
  state: "steered" | "missing" | "not_steerable";
  threadId?: string;
};

async function trySteerCandidateIds({
  threadId,
  chat,
  request,
  candidateIds,
}: {
  threadId?: string;
  chat?: AcpChatContext;
  request: AcpSteerRequest;
  candidateIds?: string[];
}): Promise<AcpSteerAttemptResult> {
  const ids = new Set<string>();
  const writer = findChatWriter({ threadId, chat });
  for (const id of candidateIds ?? []) {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }
  if (threadId) {
    ids.add(threadId);
  }
  writer?.getKnownThreadIds().forEach((id) => {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  });

  let firstError: unknown;
  let sawNotSteerable = false;
  for (const id of ids) {
    for (const agent of agents.values()) {
      if (typeof agent.steer !== "function") {
        continue;
      }
      try {
        const result = await agent.steer(id, request);
        if (result.state === "steered") {
          return {
            state: "steered",
            threadId: result.threadId ?? id,
          };
        }
        if (result.state === "not_steerable") {
          sawNotSteerable = true;
        }
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
        logger.warn("failed to steer codex session", {
          threadId: id,
          err,
        });
      }
    }
  }

  if (sawNotSteerable) {
    return { state: "not_steerable" };
  }
  if (firstError !== undefined) {
    throw firstError;
  }
  return { state: "missing" };
}

function hasRemoteRunningAcpTurn({
  project_id,
  path,
  thread_id,
  candidateIds,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  candidateIds?: string[];
}): boolean {
  const ids = new Set<string>();
  const threadId = `${thread_id ?? ""}`.trim();
  if (threadId) {
    ids.add(threadId);
  }
  for (const id of candidateIds ?? []) {
    const trimmed = `${id ?? ""}`.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  }
  for (const row of listRunningAcpTurnLeases({
    exclude_owner_instance_id: ACP_INSTANCE_ID,
  })) {
    if (row.project_id !== project_id || row.path !== path) {
      continue;
    }
    const runningThreadId = `${row.thread_id ?? ""}`.trim();
    const sessionId = `${row.session_id ?? ""}`.trim();
    if (
      (runningThreadId && ids.has(runningThreadId)) ||
      (sessionId && ids.has(sessionId))
    ) {
      return true;
    }
  }
  return false;
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

function enqueueSteerRequestForExecution({
  request,
  candidateIds,
}: {
  request: AcpSteerRequest;
  candidateIds?: string[];
}): void {
  enqueueAcpSteer({
    request,
    candidate_ids: candidateIds,
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

async function processPendingAcpSteersOnce(): Promise<void> {
  if (acpSteerPollInFlight) return;
  acpSteerPollInFlight = true;
  try {
    for (const row of listPendingAcpSteers()) {
      const request = decodeAcpSteerRequest(row);
      try {
        const result = await trySteerCandidateIds({
          threadId: row.thread_id,
          chat: request.chat,
          request,
          candidateIds: resolveSteerCandidateIds({
            project_id: row.project_id,
            path: row.path,
            thread_id: row.thread_id,
            session_id: request.session_id,
            chat: request.chat,
          }).concat(decodeAcpSteerCandidateIds(row)),
        });
        if (result.state === "steered") {
          markAcpSteerHandled({ id: row.id });
          continue;
        }
        await fallbackAcpSteerToQueuedTurn(request);
        markAcpSteerHandled({ id: row.id });
      } catch (err) {
        markAcpSteerError({
          id: row.id,
          error: `${(err as Error)?.message ?? err}`,
        });
      }
    }
  } finally {
    acpSteerPollInFlight = false;
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

function startAcpSteerPoller(): void {
  if (acpSteerPollerStarted) return;
  acpSteerPollerStarted = true;
  const timer = setInterval(() => {
    void processPendingAcpSteersOnce().catch((err) => {
      logger.warn("ACP steer poll failed", err);
    });
  }, ACP_STEER_POLL_MS);
  timer.unref?.();
  void processPendingAcpSteersOnce().catch((err) => {
    logger.warn("ACP initial steer poll failed", err);
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
  await acknowledgeAutomationFromHumanTurn(request);
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

async function fallbackAcpSteerToQueuedTurn(
  request: AcpSteerRequest,
): Promise<AcpSteerResponse> {
  let state: AcpSteerResponse["state"] = "queued";
  let threadId: string | null | undefined;
  await enqueueChatAcpTurn({
    request,
    stream: async (payload?: AcpStreamPayload | null) => {
      if (payload?.type !== "status") {
        return;
      }
      if (payload.state === "running") {
        state = "running";
      } else if (payload.state === "queued") {
        state = "queued";
      }
      threadId = payload.threadId ?? threadId;
    },
  });
  return {
    ok: true,
    state,
    threadId,
  };
}

async function handleAcpSteerRequest(
  request: AcpSteerRequest,
): Promise<AcpSteerResponse> {
  const result = await attemptAcpSteerRequest(request);
  if (result.state === "steered") {
    const threadId = `${request.chat?.thread_id ?? ""}`.trim();
    return {
      ok: true,
      state: "steered",
      threadId: result.threadId ?? threadId,
    };
  }
  if (result.state === "not_steerable") {
    return await fallbackAcpSteerToQueuedTurn(request);
  }
  return await fallbackAcpSteerToQueuedTurn(request);
}

async function attemptAcpSteerRequest(
  request: AcpSteerRequest,
): Promise<AcpSteerAttemptResult> {
  if (!request.chat) {
    throw new Error("chat metadata is required to steer an ACP turn");
  }
  const threadId = `${request.chat.thread_id ?? ""}`.trim();
  if (!threadId) {
    throw new Error("thread_id is required to steer an ACP turn");
  }
  if (!conatClient) {
    throw new Error("conat client must be initialized");
  }
  await acknowledgeAutomationFromHumanTurn(request);

  const projectId = request.chat.project_id ?? request.project_id;
  if (!projectId) {
    throw new Error("project_id must be set");
  }
  const sessionMode = resolveCodexSessionMode(request.config);
  const workspaceRoot = resolveWorkspaceRoot(request.config);
  const executor: AcpExecutor = preferContainerExecutor()
    ? new ContainerExecutor({
        projectId,
        workspaceRoot,
        conatClient,
      })
    : new LocalExecutor(workspaceRoot);
  const useContainer = preferContainerExecutor();
  const hostRoot =
    useContainer && executor instanceof ContainerExecutor
      ? executor.getMountPoint()
      : workspaceRoot;
  const useNativeTerminal = useContainer ? false : sessionMode === "auto";
  const bindings = buildExecutorAdapters(executor, workspaceRoot, hostRoot);
  const agent = await ensureAgent(useNativeTerminal, bindings);
  if (typeof agent.steer !== "function") {
    return { state: "not_steerable" };
  }

  const candidateIds = resolveSteerCandidateIds({
    project_id: projectId,
    path: request.chat.path,
    thread_id: threadId,
    session_id: request.session_id,
    chat: request.chat,
  });
  const result = await trySteerCandidateIds({
    threadId,
    chat: request.chat,
    request,
    candidateIds,
  });
  if (result.state === "steered") {
    return result;
  }
  if (result.state === "not_steerable") {
    return result;
  }
  if (
    liteUseDetachedAcpWorker() &&
    !acpExecutionOwnedByCurrentProcess &&
    hasRemoteRunningAcpTurn({
      project_id: projectId,
      path: request.chat.path,
      thread_id: threadId,
      candidateIds,
    })
  ) {
    enqueueSteerRequestForExecution({
      request,
      candidateIds,
    });
    try {
      await ensureDetachedWorkerRunning({ force: true });
    } catch (err) {
      logger.debug("failed waking detached ACP worker for steer", {
        project_id: projectId,
        path: request.chat.path,
        threadId,
        err,
      });
    }
    return {
      state: "steered",
      threadId: result.threadId ?? candidateIds[0] ?? threadId,
    };
  }

  return result;
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
  const client = conatClient;
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
    const row = cancelQueuedAcpJob({
      project_id,
      path,
      user_message_id,
    });
    if (!row || row.state !== "canceled") {
      return { ok: false, state: row?.state ?? "missing" };
    }

    const restoreQueuedImmediate = async (): Promise<AcpControlResponse> => {
      const resent = resendCanceledAcpJob({
        project_id,
        path,
        user_message_id,
      });
      if (!resent || resent.state !== "queued") {
        return { ok: false, state: resent?.state ?? "missing" };
      }
      reprioritizeAcpJobImmediate({
        project_id,
        path,
        user_message_id,
      });
      await persistQueuedUserMessageProjection({
        client,
        project_id,
        path,
        thread_id,
        user_message_id,
        queued: true,
      });
      if (liteUseDetachedAcpWorker()) {
        await ensureDetachedWorkerRunning({ force: true });
      } else {
        kickAllQueuedAcpJobs();
      }
      return { ok: true, state: "queued" };
    };

    try {
      const queuedRequest = decodeAcpJobRequest(row);
      if (
        queuedRequest.request_kind === "command" ||
        !queuedRequest.chat ||
        !("prompt" in queuedRequest)
      ) {
        return await restoreQueuedImmediate();
      }
      const steerResult = await attemptAcpSteerRequest({
        request_kind: queuedRequest.request_kind,
        project_id: queuedRequest.project_id,
        account_id: queuedRequest.account_id,
        prompt: queuedRequest.prompt,
        session_id: queuedRequest.session_id,
        config: queuedRequest.config,
        runtime_env: queuedRequest.runtime_env,
        chat: queuedRequest.chat,
      });
      if (steerResult.state !== "steered") {
        return await restoreQueuedImmediate();
      }
      await persistQueuedUserMessageProjection({
        client,
        project_id,
        path,
        thread_id,
        user_message_id,
        queued: false,
      });
      return { ok: true, state: "running" };
    } catch (err) {
      const restored = await restoreQueuedImmediate().catch((restoreErr) => {
        logger.warn("failed to restore queued ACP job after steer failure", {
          project_id,
          path,
          thread_id,
          user_message_id,
          err: restoreErr,
        });
        return null;
      });
      logger.debug("failed to steer queued ACP turn", {
        project_id,
        path,
        thread_id,
        user_message_id,
        err,
        restored,
      });
      throw err;
    }
  }
  if (request.action === "resend") {
    const row = resendCanceledAcpJob({
      project_id,
      path,
      user_message_id,
    });
    if (!row || row.state !== "queued") {
      return { ok: false, state: row?.state ?? "missing" };
    }
    await persistQueuedUserMessageProjection({
      client: conatClient,
      project_id,
      path,
      thread_id,
      user_message_id,
      queued: true,
    });
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
      steer: handleAcpSteerRequest,
      forkSession: handleForkSessionRequest,
      control: handleAcpControlRequest,
      automation: handleAcpAutomationRequest,
    },
    client,
  );
  startAcpAutomationPoller();
  void republishAcpAutomationProjectIndexes().catch((err) => {
    logger.warn("failed to republish ACP automation project indexes", err);
  });
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
      startAcpSteerPoller();
      kickAllQueuedAcpJobs();
    }
  } else {
    acpExecutionOwnedByCurrentProcess = false;
  }
}

async function materializeBlobs(prompt: string): Promise<{
  prompt: string;
  local_images: string[];
  cleanup: () => Promise<void>;
}> {
  if (!blobStore) {
    return { prompt, local_images: [], cleanup: async () => {} };
  }
  const refs = extractBlobReferences(prompt);
  if (!refs.length) {
    return { prompt, local_images: [], cleanup: async () => {} };
  }
  const unique = dedupeBlobReferences(refs);
  if (!unique.length) {
    return { prompt, local_images: [], cleanup: async () => {} };
  }
  const started = performance.now();
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `cocalc-blobs-${randomUUID()}-`),
  );
  const attachments: MaterializedBlobAttachment[] = [];
  let bytes = 0;
  try {
    for (const ref of unique) {
      try {
        const data = await blobStore!.get(ref.uuid);
        if (data == null) continue;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const safeName = buildSafeBlobFilename(ref);
        const filePath = path.join(tempDir, safeName);
        await fs.writeFile(filePath, buffer);
        bytes += buffer.byteLength;
        attachments.push({ ref, path: filePath });
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
      return { prompt, local_images: [], cleanup: async () => {} };
    }
    const sanitizedPrompt = rewriteBlobReferencesInPrompt(prompt, attachments);
    const info = attachments
      .map(
        (att, idx) => `Attachment ${idx + 1}: available locally at ${att.path}`,
      )
      .join("\n");
    const augmented = `${sanitizedPrompt}\n\nAttached images are already included with this request. Local fallback paths:\n${info}\n`;
    return {
      prompt: augmented,
      local_images: attachments.map((att) => att.path),
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
    return { prompt, local_images: [], cleanup: async () => {} };
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
    if (project_id && path && threadId) {
      markAcpInterruptsHandledForThread({
        project_id,
        path,
        thread_id: threadId,
      });
    }
    return;
  }
  if (
    conatClient &&
    request.chat &&
    project_id &&
    path &&
    (threadId || `${request.chat.message_id ?? ""}`.trim())
  ) {
    try {
      const repaired = await turnNeedsInterruptedRepair({
        client: conatClient,
        turn: {
          project_id,
          path,
          message_date: request.chat.message_date,
          sender_id: request.chat.sender_id,
          message_id: request.chat.message_id,
          thread_id: threadId || request.chat.thread_id,
        },
      });
      if (
        repaired &&
        (await repairInterruptedAcpTurn({
          client: conatClient,
          turn: {
            project_id,
            path,
            message_date: request.chat.message_date,
            sender_id: request.chat.sender_id,
            message_id: request.chat.message_id,
            thread_id: threadId || request.chat.thread_id,
          },
          interruptedNotice: INTERRUPT_STATUS_TEXT,
          interruptedReasonId: "interrupt",
          recoveryReason: INTERRUPT_STATUS_TEXT,
        }))
      ) {
        markAcpInterruptsHandledForThread({
          project_id,
          path,
          thread_id: threadId,
        });
        return;
      }
    } catch (err) {
      logger.warn("failed to repair stuck chat turn during interrupt", {
        project_id,
        path,
        threadId,
        err,
      });
    }
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
  const sessionId = `${request.sessionId ?? ""}`.trim();
  if (!sessionId) {
    throw Error("sessionId must be a non-empty string");
  }
  return await forkCodexAppServerSession({
    projectId: request.project_id,
    accountId: request.account_id,
    sessionId,
    binaryPath: process.env.COCALC_CODEX_BIN,
  });
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
