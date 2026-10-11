/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Forking an agent thread ("Copy agent", "Fork thread") in two steps, shared by
the browser and the CLI:

1. planThreadFork() decides which agent session must be forked (a harness
   session such as Claude Code, a Codex session, or nothing).
2. The caller forks that session with its own client, then
   buildForkedThread() returns the new thread's root message and thread
   config patch to write into the chat document.
*/

import {
  DEFAULT_CODEX_MODEL_NAME,
  normalizeCodexSessionId,
} from "@cocalc/util/ai/codex";
import {
  parseAcpHarnessRuntime,
  type AcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";

import { messagesSinceContextCleared, resolveHarnessSessionId } from "./acp";
import { CHAT_SCHEMA_V2 } from "./core";

type Row = Record<string, any>;

export interface ThreadForkSource {
  threadId: string;
  /** The source thread's config record (plain object). */
  config?: Row | null;
  /** Chat messages of the source thread, oldest first (plain objects). */
  messages: readonly Row[];
  /** Fallback when no message has a usable date. */
  latestChatDateMs?: number;
  /** Fallback root date, e.g. from thread metadata. */
  rootDateIso?: string;
}

export type ThreadForkPlan =
  | {
      kind: "harness";
      sessionId: string;
      runtime: AcpHarnessRuntime;
      shouldForkAcp: boolean;
    }
  | {
      kind: "codex";
      sessionId: string;
      config: Row;
      shouldForkAcp: true;
    }
  | {
      kind: "copy";
      config?: Row;
      shouldForkAcp: boolean;
    };

// Legacy: replies of the retired scheduled thread automations ran in their
// own sessions, so they never anchor a fork.
function isAutomationMessage(msg: Row | undefined): boolean {
  const id = msg?.acp_automation_id;
  return typeof id === "string" && id.trim().length > 0;
}

function parentId(msg: Row | undefined): string | undefined {
  const parent = msg?.parent_message_id;
  return typeof parent === "string" && parent.trim()
    ? parent.trim()
    : undefined;
}

function iso(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return isNaN(date.valueOf()) ? undefined : date.toISOString();
  }
  if (value instanceof Date && !isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return undefined;
}

function firstContent(msg: Row | undefined): string {
  const history = msg?.history;
  return Array.isArray(history) ? `${history[0]?.content ?? ""}` : "";
}

export function planThreadFork({
  source,
  isAI,
}: {
  source: ThreadForkSource;
  isAI: boolean;
}): ThreadForkPlan {
  const config = source.config ?? {};
  const runtime =
    config.agent_runtime == null
      ? undefined
      : parseAcpHarnessRuntime(config.agent_runtime);
  const inferredSessionId = (() => {
    const current = messagesSinceContextCleared(source.messages).messages;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (isAutomationMessage(current[i])) continue;
      const sessionId = current[i]?.acp_thread_id;
      if (typeof sessionId === "string" && sessionId.trim().length > 0) {
        return sessionId.trim();
      }
    }
    return undefined;
  })();
  const sourceConfig: Row | undefined = runtime
    ? undefined
    : (config.acp_config ?? undefined);
  const shouldForkAcp =
    isAI || config.agent_kind === "acp" || sourceConfig != null;
  if (runtime) {
    const sessionId = resolveHarnessSessionId(
      config.agent_session_id,
      inferredSessionId,
    );
    if (!sessionId) throw Error("This agent has no saved context to copy yet");
    return { kind: "harness", sessionId, runtime, shouldForkAcp };
  }
  if (!shouldForkAcp) return { kind: "copy", shouldForkAcp };
  const withSession =
    !normalizeCodexSessionId(sourceConfig?.sessionId) && inferredSessionId
      ? { ...(sourceConfig ?? {}), sessionId: inferredSessionId }
      : sourceConfig;
  const sessionId = normalizeCodexSessionId(withSession?.sessionId);
  if (sessionId) {
    return {
      kind: "codex",
      sessionId,
      config: withSession!,
      shouldForkAcp: true,
    };
  }
  return {
    kind: "copy",
    config: withSession ? { ...withSession } : undefined,
    shouldForkAcp,
  };
}

export interface ForkedThread {
  threadId: string;
  rootMessage: Row;
  configPatch: Row;
  /** Copy the account's payment selection from the source thread. */
  copyPaymentSelection: boolean;
}

export function buildForkedThread({
  source,
  plan,
  forkedSessionId,
  title,
  sourceTitle,
  isAI,
  senderId,
  now,
  messageId,
  threadId,
}: {
  source: ThreadForkSource;
  plan: ThreadForkPlan;
  /** The independent session returned by forking plan.sessionId. */
  forkedSessionId?: string;
  title: string;
  sourceTitle?: string;
  isAI: boolean;
  senderId: string;
  now: Date;
  messageId: string;
  threadId: string;
}): ForkedThread {
  if (plan.kind !== "copy") {
    if (!forkedSessionId || forkedSessionId === plan.sessionId) {
      throw Error("The agent did not return an independent copied session");
    }
  }
  const config = source.config ?? {};
  let nextConfig: Row | undefined =
    plan.kind === "codex"
      ? { ...plan.config, sessionId: forkedSessionId }
      : plan.kind === "copy" && plan.config
        ? { ...plan.config }
        : undefined;
  if (nextConfig && !nextConfig.model) {
    nextConfig = { ...nextConfig, model: DEFAULT_CODEX_MODEL_NAME };
  }
  const messages = source.messages;
  const rootMessage = messages.find((msg) => !parentId(msg)) ?? messages[0];
  const rootIso =
    iso(rootMessage?.date) ??
    source.rootDateIso ??
    iso(source.latestChatDateMs);
  const latestMessage = messages.length ? messages[messages.length - 1] : null;
  const latestIso = iso(latestMessage?.date) ?? iso(source.latestChatDateMs);
  const newRootIso = now.toISOString();
  const root: Row = {
    sender_id: senderId,
    event: "chat",
    schema_version: CHAT_SCHEMA_V2,
    message_id: messageId,
    thread_id: threadId,
    history: [{ author_id: senderId, content: "", date: newRootIso }],
    date: newRootIso,
    editing: [],
    name: title,
    forked_from_title:
      sourceTitle?.trim() ||
      rootMessage?.name ||
      config.name ||
      (rootMessage ? firstContent(rootMessage).trim() : "") ||
      "Untitled thread",
  };
  if (rootIso) root.forked_from_root_date = rootIso;
  if (latestIso) root.forked_from_latest_message_date = latestIso;
  const harness = plan.kind === "harness";
  const configPatch: Row = {
    name: title,
    thread_color: config.thread_color ?? null,
    thread_accent_color: config.thread_accent_color ?? null,
    thread_icon: config.thread_icon ?? null,
    thread_image: config.thread_image ?? null,
    agent_kind:
      nextConfig != null
        ? "acp"
        : (config.agent_kind ?? (isAI ? "acp" : "none")),
    agent_model:
      nextConfig?.model ??
      config.agent_model ??
      (plan.shouldForkAcp ? DEFAULT_CODEX_MODEL_NAME : null),
    agent_mode:
      nextConfig != null
        ? "interactive"
        : (config.agent_mode ?? (isAI ? "interactive" : null)),
    acp_config: nextConfig ?? null,
    ...(harness
      ? {
          agent_runtime: plan.runtime,
          agent_session_id: forkedSessionId,
          agent_runtime_controls: config.agent_runtime_controls ?? null,
          agent_model: config.agent_model ?? null,
        }
      : {}),
  };
  return {
    threadId,
    rootMessage: root,
    configPatch,
    copyPaymentSelection: !harness && plan.shouldForkAcp,
  };
}
