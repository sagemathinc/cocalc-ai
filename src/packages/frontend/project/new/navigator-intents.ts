import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { listAgentSessionsForProject } from "@cocalc/frontend/chat/agent-session-index";
import { redux } from "@cocalc/frontend/app-framework";
import { getChatActions, initChat } from "@cocalc/frontend/chat/register";
import { lite } from "@cocalc/frontend/lite";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { openFloatingAgentSession } from "@cocalc/frontend/project/page/agent-dock-state";
import {
  loadNavigatorSelectedThreadKey,
  saveNavigatorSelectedThreadKey,
} from "./navigator-state";
import { uuid } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { path_split } from "@cocalc/util/misc";

const NAVIGATOR_INTENT_QUEUE_KEY = "cocalc:navigator:intent-queue";
export const NAVIGATOR_SUBMIT_PROMPT_EVENT =
  "cocalc:navigator:submit-prompt";

export interface NavigatorSubmitPromptDetail {
  id: string;
  createdAt: string;
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}

function toReplyDate(threadKey?: string | null): Date | undefined {
  if (!threadKey || !/^\d+$/.test(threadKey)) return;
  const ms = Number(threadKey);
  if (!Number.isFinite(ms)) return;
  return new Date(ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getField(obj: any, key: string): any {
  if (obj == null) return undefined;
  if (typeof obj?.get === "function") return obj.get(key);
  return obj[key];
}

function chooseThreadKeyFromIndex(opts: {
  actions: any;
  preferredThreadKey?: string;
  fallbackThreadKey?: string;
}): string {
  const index = opts.actions?.messageCache?.getThreadIndex?.();
  if (!index?.size) {
    return `${opts.fallbackThreadKey ?? ""}`.trim();
  }
  const preferred = `${opts.preferredThreadKey ?? ""}`.trim();
  if (preferred && index.has(preferred)) {
    return preferred;
  }
  const fallback = `${opts.fallbackThreadKey ?? ""}`.trim();
  if (fallback && index.has(fallback)) {
    return fallback;
  }
  let bestKey = "";
  let bestTime = -Infinity;
  for (const thread of index.values()) {
    const key = `${thread?.key ?? ""}`.trim();
    if (!key) continue;
    const t = Number(thread?.newestTime ?? -Infinity);
    if (t > bestTime) {
      bestKey = key;
      bestTime = t;
    }
  }
  return bestKey || fallback;
}

function hasThreadRootIdentity(actions: any, threadKey?: string): boolean {
  const key = `${threadKey ?? ""}`.trim();
  if (!key || !/^\d+$/.test(key)) return false;
  const root = actions?.getMessageByDate?.(Number(key));
  if (!root) return false;
  const messageId = getField(root, "message_id");
  const threadId = getField(root, "thread_id");
  return (
    typeof messageId === "string" &&
    messageId.length > 0 &&
    typeof threadId === "string" &&
    threadId.length > 0
  );
}

async function waitForThreadReady(opts: {
  actions: any;
  threadKey?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = Math.max(500, opts.timeoutMs ?? 6000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = opts.actions?.syncdb?.get_state?.();
    const ready = state === "ready";
    if (ready) {
      const key = `${opts.threadKey ?? ""}`.trim();
      if (!key || hasThreadRootIdentity(opts.actions, key)) {
        return true;
      }
    }
    await sleep(100);
  }
  return false;
}

function pickNavigatorSession({
  records,
  preferredThreadKey,
}: {
  records: AgentSessionRecord[];
  preferredThreadKey?: string;
}): AgentSessionRecord | undefined {
  const global = records.filter((record) => record.entrypoint === "global");
  if (global.length === 0) return;
  const preferred = `${preferredThreadKey ?? ""}`.trim();
  if (preferred) {
    const match = global.find((record) => record.thread_key === preferred);
    if (match) return match;
  }
  return (
    global.find((record) => record.status !== "archived") ??
    global[0]
  );
}

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function isMacLikeClient(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = `${navigator.platform ?? ""}`.toLowerCase();
  return platform.includes("mac");
}

function navigatorChatPath(accountId?: string): string {
  if (lite) {
    return isMacLikeClient()
      ? "Library/Application Support/cocalc/navigator.chat"
      : ".local/share/cocalc/navigator.chat";
  }
  const key = sanitizeAccountId(accountId?.trim() || "unknown-account");
  return `.local/share/cocalc/navigator-${key}.chat`;
}

function resolveNavigatorChatPath(project_id: string): string {
  const accountId = `${redux.getStore("account")?.get?.("account_id") ?? ""}`;
  const homeDirectory = getProjectHomeDirectory(project_id);
  return normalizeAbsolutePath(navigatorChatPath(accountId), homeDirectory);
}

async function ensureNavigatorChatDirectory(
  project_id: string,
  chat_path: string,
): Promise<void> {
  const fs = redux.getProjectActions(project_id)?.fs?.();
  if (!fs?.mkdir) return;
  try {
    await fs.mkdir(path_split(chat_path).head, { recursive: true });
  } catch {
    // Best effort only; chat initialization may still succeed.
  }
}

function readQueue(): NavigatorSubmitPromptDetail[] {
  try {
    const raw = localStorage.getItem(NAVIGATOR_INTENT_QUEUE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item) =>
        typeof item?.id === "string" && typeof item?.prompt === "string",
    );
  } catch {
    return [];
  }
}

function writeQueue(queue: NavigatorSubmitPromptDetail[]): void {
  try {
    if (queue.length === 0) {
      localStorage.removeItem(NAVIGATOR_INTENT_QUEUE_KEY);
    } else {
      localStorage.setItem(NAVIGATOR_INTENT_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch {}
}

export function queueNavigatorPromptIntent(
  intent: NavigatorSubmitPromptDetail,
): void {
  const queue = readQueue();
  queue.push(intent);
  writeQueue(queue);
}

export function takeQueuedNavigatorPromptIntents(): NavigatorSubmitPromptDetail[] {
  const queue = readQueue();
  writeQueue([]);
  return queue;
}

export function removeQueuedNavigatorPromptIntent(id: string): void {
  const queue = readQueue().filter((item) => item.id !== id);
  writeQueue(queue);
}

export function createNavigatorPromptIntent(opts: {
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}): NavigatorSubmitPromptDetail {
  return {
    id: uuid(),
    createdAt: new Date().toISOString(),
    prompt: opts.prompt,
    tag: opts.tag,
    forceCodex: opts.forceCodex ?? true,
  };
}

export function dispatchNavigatorPromptIntent(opts: {
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
}): NavigatorSubmitPromptDetail {
  const intent = createNavigatorPromptIntent(opts);
  queueNavigatorPromptIntent(intent);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(NAVIGATOR_SUBMIT_PROMPT_EVENT, { detail: intent }),
    );
  }
  return intent;
}

export async function submitNavigatorPromptToCurrentThread(opts: {
  project_id: string;
  prompt: string;
  tag?: string;
  forceCodex?: boolean;
  openFloating?: boolean;
}): Promise<boolean> {
  try {
    const project_id = `${opts.project_id ?? ""}`.trim();
    const basePrompt = `${opts.prompt ?? ""}`.trim();
    if (!project_id || !basePrompt) return false;

    const preferredThreadKey = loadNavigatorSelectedThreadKey(project_id);
    const sessions = await listAgentSessionsForProject({ project_id });
    const indexedSession = pickNavigatorSession({
      records: sessions,
      preferredThreadKey,
    });
    const fallbackSession: AgentSessionRecord | undefined =
      indexedSession == null
        ? {
            session_id: `navigator-${project_id}`,
            project_id,
            account_id: `${redux.getStore("account")?.get?.("account_id") ?? ""}`,
            chat_path: resolveNavigatorChatPath(project_id),
            thread_key: `${preferredThreadKey ?? ""}`.trim(),
            title: "Navigator",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "active",
            entrypoint: "global",
          }
        : undefined;
    const session = indexedSession ?? fallbackSession;
    if (!session?.chat_path) return false;

    await ensureNavigatorChatDirectory(project_id, session.chat_path);

    const threadKey = `${preferredThreadKey ?? session.thread_key ?? ""}`.trim();
    const input = basePrompt;
    if (!input) return false;

    const instanceKey = "navigator-intent-dispatch";
    const actions =
      getChatActions(project_id, session.chat_path, { instanceKey }) ??
      initChat(project_id, session.chat_path, { instanceKey });

    if (!actions) return false;
    const ready = await waitForThreadReady({
      actions,
      timeoutMs: 6000,
    });
    if (!ready) return false;
    const resolvedThreadKey = chooseThreadKeyFromIndex({
      actions,
      preferredThreadKey,
      fallbackThreadKey: threadKey,
    });

    let replyThreadKey = resolvedThreadKey;
    const model =
      typeof session.model === "string" && session.model.trim().length > 0
        ? session.model.trim()
        : undefined;
    if (replyThreadKey) {
      const rootReady = await waitForThreadReady({
        actions,
        threadKey: replyThreadKey,
        timeoutMs: 4000,
      });
      if (!rootReady) {
        // Fall back to opening a new thread rather than failing the intent.
        replyThreadKey = "";
      }
    }
    const replyTo = toReplyDate(replyThreadKey);
    const timeStamp = actions.sendChat({
      input,
      reply_to: replyTo,
      tag: opts.tag ?? "intent:navigator",
      noNotification: true,
      threadAgent:
        !replyTo && opts.forceCodex !== false
          ? {
              mode: "codex",
              model,
              codexConfig: {
                model,
                reasoning: session.reasoning as any,
                sessionMode: session.mode as any,
                workingDirectory: session.working_directory,
              },
            }
          : undefined,
    });
    if (!timeStamp) {
      return false;
    }

    const nextThreadKey =
      replyThreadKey ||
      (typeof timeStamp === "string"
        ? `${new Date(timeStamp).valueOf()}`
        : "");
    if (nextThreadKey) {
      saveNavigatorSelectedThreadKey(nextThreadKey);
    }
    if (opts.openFloating !== false) {
      openFloatingAgentSession(project_id, {
        ...session,
        thread_key: nextThreadKey || session.thread_key,
        updated_at: new Date().toISOString(),
        status: "active",
      });
    }
    setTimeout(() => {
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 50);
    return true;
  } catch {
    return false;
  }
}
