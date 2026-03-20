import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { listAgentSessionsForProject } from "@cocalc/frontend/chat/agent-session-index";
import { redux } from "@cocalc/frontend/app-framework";
import { getChatActions, initChat } from "@cocalc/frontend/chat/register";
import type { CodexThreadConfig } from "@cocalc/chat";
import { lite } from "@cocalc/frontend/lite";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { openFloatingAgentSession } from "@cocalc/frontend/project/page/agent-dock-state";
import {
  ensureWorkspaceChatForPath,
  ensureWorkspaceChatPath,
} from "@cocalc/frontend/project/workspaces/runtime";
import {
  loadSessionSelection,
  loadSessionWorkspaceRecord,
} from "@cocalc/frontend/project/workspaces/selection-runtime";
import {
  loadNavigatorSelectedThreadKey,
  saveNavigatorSelectedThreadKey,
} from "./navigator-state";
import { uuid } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { path_split, tab_to_path } from "@cocalc/util/misc";
import { pathMatchesWorkspaceRoot } from "@cocalc/conat/workspaces";

const NAVIGATOR_INTENT_QUEUE_KEY = "cocalc:navigator:intent-queue";
export const NAVIGATOR_SUBMIT_PROMPT_EVENT = "cocalc:navigator:submit-prompt";
const NAVIGATOR_SYNC_READY_TIMEOUT_MS = 12_000;
const NAVIGATOR_THREAD_IDENTITY_TIMEOUT_MS = 15_000;
const NAVIGATOR_WORKSPACE_RESOLVE_TIMEOUT_MS = 5_000;
const NAVIGATOR_WORKSPACE_RESOLVE_POLL_MS = 150;
let navigatorIntentQueueMemory: NavigatorSubmitPromptDetail[] = [];

export interface NavigatorSubmitPromptDetail {
  id: string;
  createdAt: string;
  prompt: string;
  visiblePrompt?: string;
  title?: string;
  tag?: string;
  forceCodex?: boolean;
  codexConfig?: Partial<CodexThreadConfig>;
  createNewThread?: boolean;
}

function normalizeOptionalTitle(value?: string): string | undefined {
  const title = `${value ?? ""}`.trim();
  return title || undefined;
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

export function resolveThreadIdFromIndex(
  actions: any,
  threadKey?: string,
): string | undefined {
  const key = `${threadKey ?? ""}`.trim();
  if (!key) return;
  const indexEntry = actions?.messageCache?.getThreadIndex?.()?.get?.(key);
  const fromIndexRoot = `${indexEntry?.rootMessage?.thread_id ?? ""}`.trim();
  if (fromIndexRoot) return fromIndexRoot;
  if (/^\d+$/.test(key)) {
    const root = actions?.getMessageByDate?.(Number(key));
    const fromRoot = `${getField(root, "thread_id") ?? ""}`.trim();
    if (fromRoot) return fromRoot;
  }
  return;
}

function hasThreadRootIdentity(actions: any, threadKey?: string): boolean {
  const key = `${threadKey ?? ""}`.trim();
  if (!key) return false;
  const fromIndex = resolveThreadIdFromIndex(actions, key);
  if (typeof fromIndex === "string" && fromIndex.length > 0) {
    return true;
  }
  if (!/^\d+$/.test(key)) return false;
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
  const timeoutMs = Math.max(
    500,
    opts.timeoutMs ?? NAVIGATOR_SYNC_READY_TIMEOUT_MS,
  );
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
  chatPath,
}: {
  records: AgentSessionRecord[];
  preferredThreadKey?: string;
  chatPath?: string;
}): AgentSessionRecord | undefined {
  const candidates = chatPath
    ? records.filter((record) => record.chat_path === chatPath)
    : records.filter((record) => record.entrypoint === "global");
  if (candidates.length === 0) return;
  const preferred = `${preferredThreadKey ?? ""}`.trim();
  if (preferred) {
    const match = candidates.find((record) => record.thread_key === preferred);
    if (match) return match;
  }
  return (
    candidates.find((record) => record.status !== "archived") ?? candidates[0]
  );
}

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function resolveWorkspaceTarget(opts: {
  project_id: string;
  account_id: string;
  path?: string;
}): Promise<Awaited<ReturnType<typeof ensureWorkspaceChatForPath>>> {
  const absolutePaths = resolveWorkspaceTargetPaths(opts.project_id, opts.path);
  if (absolutePaths.length === 0) return null;
  const deadline = Date.now() + NAVIGATOR_WORKSPACE_RESOLVE_TIMEOUT_MS;
  while (true) {
    const selection = loadSessionSelection(opts.project_id);
    const selectedWorkspace = loadSessionWorkspaceRecord(opts.project_id);
    const account_id =
      `${opts.account_id || redux.getStore("account")?.get?.("account_id") || ""}`.trim();
    if (account_id) {
      for (const absolutePath of absolutePaths) {
        const target = await ensureWorkspaceChatForPath({
          project_id: opts.project_id,
          account_id,
          path: absolutePath,
        });
        if (target) return target;
      }
    }
    if (
      selection.kind === "workspace" &&
      selectedWorkspace?.workspace_id === selection.workspace_id &&
      absolutePaths.some((path) =>
        pathMatchesWorkspaceRoot(path, selectedWorkspace.root_path),
      )
    ) {
      const chat_path = `${selectedWorkspace.chat_path ?? ""}`.trim();
      if (chat_path) {
        return {
          workspace: selectedWorkspace,
          chat_path,
          assigned: false,
        };
      }
      if (!account_id) {
        if (Date.now() >= deadline) return null;
        await sleep(NAVIGATOR_WORKSPACE_RESOLVE_POLL_MS);
        continue;
      }
      const resolved = await ensureWorkspaceChatPath({
        project_id: opts.project_id,
        account_id,
        workspace_id: selectedWorkspace.workspace_id,
      });
      return {
        workspace: resolved.workspace,
        chat_path: resolved.chat_path,
        assigned: resolved.assigned,
      };
    }
    if (Date.now() >= deadline) return null;
    await sleep(NAVIGATOR_WORKSPACE_RESOLVE_POLL_MS);
  }
}

function resolveWorkspaceTargetPaths(
  project_id: string,
  preferredPath?: string,
): string[] {
  const homeDirectory = getProjectHomeDirectory(project_id);
  const projectStore = redux.getProjectStore(project_id);
  const candidates = [
    `${preferredPath ?? ""}`.trim(),
    `${tab_to_path(`${projectStore?.get?.("active_project_tab") ?? ""}`) ?? ""}`.trim(),
    `${projectStore?.get?.("current_path_abs") ?? ""}`.trim(),
  ].filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of candidates) {
    const absolutePath = normalizeAbsolutePath(path, homeDirectory);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    result.push(absolutePath);
  }
  return result;
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
    if (!raw) return navigatorIntentQueueMemory.slice();
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return navigatorIntentQueueMemory.slice();
    const queue = value.filter(
      (item) =>
        typeof item?.id === "string" && typeof item?.prompt === "string",
    );
    navigatorIntentQueueMemory = queue.slice();
    return queue;
  } catch {
    return navigatorIntentQueueMemory.slice();
  }
}

function writeQueue(queue: NavigatorSubmitPromptDetail[]): void {
  navigatorIntentQueueMemory = queue.slice();
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
  visiblePrompt?: string;
  title?: string;
  tag?: string;
  forceCodex?: boolean;
  codexConfig?: Partial<CodexThreadConfig>;
  createNewThread?: boolean;
}): NavigatorSubmitPromptDetail {
  return {
    id: uuid(),
    createdAt: new Date().toISOString(),
    prompt: opts.prompt,
    visiblePrompt: `${opts.visiblePrompt ?? ""}`.trim() || undefined,
    title: normalizeOptionalTitle(opts.title),
    tag: opts.tag,
    forceCodex: opts.forceCodex ?? true,
    codexConfig: opts.codexConfig,
    createNewThread: opts.createNewThread ?? false,
  };
}

export function dispatchNavigatorPromptIntent(opts: {
  prompt: string;
  visiblePrompt?: string;
  title?: string;
  tag?: string;
  forceCodex?: boolean;
  codexConfig?: Partial<CodexThreadConfig>;
  createNewThread?: boolean;
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

export async function stageNavigatorPromptInWorkspaceChat(opts: {
  project_id: string;
  prompt: string;
  visiblePrompt?: string;
  title?: string;
  tag?: string;
  forceCodex?: boolean;
  codexConfig?: Partial<CodexThreadConfig>;
  path?: string;
}): Promise<boolean> {
  try {
    const project_id = `${opts.project_id ?? ""}`.trim();
    const basePrompt = `${opts.prompt ?? ""}`.trim();
    const visiblePrompt = `${opts.visiblePrompt ?? ""}`.trim() || undefined;
    const requestedTitle = normalizeOptionalTitle(opts.title);
    const requestedModel =
      typeof opts.codexConfig?.model === "string" &&
      opts.codexConfig.model.trim().length > 0
        ? opts.codexConfig.model.trim()
        : undefined;
    if (!project_id || !basePrompt) return false;

    const account_id =
      `${redux.getStore("account")?.get?.("account_id") ?? ""}`.trim();
    const workspaceTarget = await resolveWorkspaceTarget({
      project_id,
      account_id,
      path: opts.path,
    });
    if (!workspaceTarget?.chat_path) return false;

    const targetChatPath = workspaceTarget.chat_path;
    const preferredThreadKey = loadNavigatorSelectedThreadKey(
      project_id,
      targetChatPath,
    );
    const sessions = await listAgentSessionsForProject({ project_id });
    const indexedSession = pickNavigatorSession({
      records: sessions,
      preferredThreadKey,
      chatPath: targetChatPath,
    });
    const session: AgentSessionRecord = indexedSession ?? {
      session_id: `workspace-${workspaceTarget.workspace.workspace_id}`,
      project_id,
      account_id,
      chat_path: targetChatPath,
      thread_key: `${preferredThreadKey ?? ""}`.trim(),
      title: workspaceTarget.workspace.theme.title?.trim() || "Navigator",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "active",
      entrypoint: "file",
      model: requestedModel,
      working_directory: workspaceTarget.workspace.root_path,
      thread_color: workspaceTarget.workspace.theme.color ?? undefined,
      thread_accent_color:
        workspaceTarget.workspace.theme.accent_color ?? undefined,
      thread_icon: workspaceTarget.workspace.theme.icon ?? undefined,
      thread_image: workspaceTarget.workspace.theme.image_blob ?? undefined,
    };

    await ensureNavigatorChatDirectory(project_id, targetChatPath);
    await redux
      .getProjectActions(project_id)
      ?.open_file?.({ path: targetChatPath, foreground: true });

    const instanceKey = "navigator-intent-stage";
    const actions =
      getChatActions(project_id, targetChatPath, { instanceKey }) ??
      initChat(project_id, targetChatPath, { instanceKey });
    if (!actions) return false;

    const ready = await waitForThreadReady({
      actions,
      timeoutMs: NAVIGATOR_SYNC_READY_TIMEOUT_MS,
    });
    if (!ready) return false;

    const resolvedThreadKey = chooseThreadKeyFromIndex({
      actions,
      preferredThreadKey,
      fallbackThreadKey: `${session.thread_key ?? ""}`.trim(),
    });
    let replyThreadKey = resolvedThreadKey;
    let replyThreadId = resolveThreadIdFromIndex(actions, replyThreadKey);
    if (replyThreadKey && !replyThreadId) {
      replyThreadKey = "";
    }
    const existingThreadTitle =
      replyThreadKey && replyThreadId
        ? normalizeOptionalTitle(
            actions.getThreadMetadata?.(replyThreadKey, {
              threadId: replyThreadId,
            })?.name,
          )
        : undefined;
    const messageThreadTitle =
      requestedTitle && (!replyThreadId || !existingThreadTitle)
        ? requestedTitle
        : undefined;
    const sessionModel =
      typeof session.model === "string" && session.model.trim().length > 0
        ? session.model.trim()
        : undefined;
    const model = requestedModel ?? sessionModel;
    const threadAgentCodexConfig = {
      model,
      reasoning: session.reasoning as any,
      sessionMode: session.mode as any,
      workingDirectory: session.working_directory,
      ...(opts.codexConfig ?? {}),
    };
    const newThreadAgent =
      opts.forceCodex !== false
        ? {
            mode: "codex" as const,
            model,
            codexConfig: threadAgentCodexConfig,
          }
        : undefined;

    let createdThreadNow = false;
    if (!replyThreadKey) {
      const createdThreadKey = actions.createEmptyThread?.({
        name: messageThreadTitle,
        threadAgent: newThreadAgent,
        threadAppearance: {
          color: session.thread_color,
          icon: session.thread_icon,
          image: session.thread_image,
        },
      });
      if (!createdThreadKey) return false;
      replyThreadKey = createdThreadKey;
      replyThreadId = createdThreadKey;
      createdThreadNow = true;
    } else if (opts.forceCodex !== false) {
      actions.setThreadAgentMode?.(
        replyThreadKey,
        "codex",
        threadAgentCodexConfig,
      );
    }

    const timeStamp = actions.sendChat({
      input: visiblePrompt ?? basePrompt,
      acp_prompt: basePrompt,
      name: createdThreadNow ? undefined : messageThreadTitle,
      reply_thread_id: replyThreadId,
      tag: opts.tag ?? "intent:navigator",
      noNotification: true,
      skipModelDispatch: true,
      threadAgent: !replyThreadId ? newThreadAgent : undefined,
    });
    if (!timeStamp) return false;

    const nextThreadKey = replyThreadKey
      ? replyThreadKey
      : chooseThreadKeyFromIndex({
          actions,
          fallbackThreadKey: `${actions.store?.get?.("selectedThreadKey") ?? ""}`,
        });
    if (nextThreadKey) {
      saveNavigatorSelectedThreadKey(nextThreadKey, targetChatPath);
    }
    if (typeof actions.syncdb?.save === "function") {
      await actions.syncdb.save();
    }
    setTimeout(() => {
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 50);
    return true;
  } catch {
    return false;
  }
}

export async function submitNavigatorPromptToCurrentThread(opts: {
  project_id: string;
  prompt: string;
  visiblePrompt?: string;
  title?: string;
  tag?: string;
  forceCodex?: boolean;
  codexConfig?: Partial<CodexThreadConfig>;
  openFloating?: boolean;
  path?: string;
  createNewThread?: boolean;
}): Promise<boolean> {
  try {
    const project_id = `${opts.project_id ?? ""}`.trim();
    const basePrompt = `${opts.prompt ?? ""}`.trim();
    const visiblePrompt = `${opts.visiblePrompt ?? ""}`.trim() || undefined;
    const requestedTitle = normalizeOptionalTitle(opts.title);
    const requestedModel =
      typeof opts.codexConfig?.model === "string" &&
      opts.codexConfig.model.trim().length > 0
        ? opts.codexConfig.model.trim()
        : undefined;
    if (!project_id || !basePrompt) return false;
    const input = visiblePrompt ?? basePrompt;
    const account_id =
      `${redux.getStore("account")?.get?.("account_id") ?? ""}`.trim();
    const workspaceTarget = await resolveWorkspaceTarget({
      project_id,
      account_id,
      path: opts.path,
    });
    const targetChatPath =
      workspaceTarget?.chat_path ?? resolveNavigatorChatPath(project_id);

    const preferExistingThread = opts.createNewThread !== true;
    const preferredThreadKey = preferExistingThread
      ? loadNavigatorSelectedThreadKey(project_id, targetChatPath)
      : undefined;
    const sessions = await listAgentSessionsForProject({ project_id });
    const indexedSession = preferExistingThread
      ? pickNavigatorSession({
          records: sessions,
          preferredThreadKey,
          chatPath: targetChatPath,
        })
      : undefined;
    const fallbackSession: AgentSessionRecord = {
      session_id:
        workspaceTarget?.workspace.workspace_id != null
          ? `workspace-${workspaceTarget.workspace.workspace_id}`
          : `navigator-${project_id}`,
      project_id,
      account_id,
      chat_path: targetChatPath,
      thread_key: `${preferredThreadKey ?? ""}`.trim(),
      title: workspaceTarget?.workspace.theme.title?.trim() || "Navigator",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "active",
      entrypoint: workspaceTarget ? "file" : "global",
      model: requestedModel,
      working_directory: workspaceTarget?.workspace.root_path,
      thread_color: workspaceTarget?.workspace.theme.color ?? undefined,
      thread_accent_color:
        workspaceTarget?.workspace.theme.accent_color ?? undefined,
      thread_icon: workspaceTarget?.workspace.theme.icon ?? undefined,
      thread_image: workspaceTarget?.workspace.theme.image_blob ?? undefined,
    };
    const session =
      opts.createNewThread === true
        ? fallbackSession
        : (indexedSession ?? fallbackSession);
    if (opts.openFloating !== false) {
      openFloatingAgentSession(
        project_id,
        {
          ...fallbackSession,
          title: requestedTitle ?? fallbackSession.title,
          updated_at: new Date().toISOString(),
          status: "active",
        },
        {
          workspaceId: workspaceTarget?.workspace.workspace_id ?? null,
          workspaceOnly: workspaceTarget != null,
        },
      );
    }
    const queueFallbackIntent = (): boolean => {
      if (workspaceTarget) {
        return false;
      }
      dispatchNavigatorPromptIntent({
        prompt: basePrompt,
        visiblePrompt,
        title: requestedTitle,
        tag: opts.tag ?? "intent:navigator",
        forceCodex: opts.forceCodex ?? true,
        codexConfig: opts.codexConfig,
        createNewThread: opts.createNewThread ?? false,
      });
      if (opts.openFloating !== false) {
        openFloatingAgentSession(
          project_id,
          {
            ...(indexedSession ?? fallbackSession),
            title:
              requestedTitle ?? indexedSession?.title ?? fallbackSession.title,
            thread_key:
              `${preferredThreadKey ?? session.thread_key ?? ""}`.trim() ||
              session.thread_key,
            updated_at: new Date().toISOString(),
            status: "active",
          },
          {
            workspaceId: null,
            workspaceOnly: false,
          },
        );
      }
      return true;
    };
    if (!session?.chat_path) return queueFallbackIntent();

    await ensureNavigatorChatDirectory(project_id, session.chat_path);

    const threadKey =
      opts.createNewThread === true
        ? ""
        : `${preferredThreadKey ?? session.thread_key ?? ""}`.trim();

    const instanceKey = "navigator-intent-dispatch";
    const actions =
      getChatActions(project_id, session.chat_path, { instanceKey }) ??
      initChat(project_id, session.chat_path, { instanceKey });

    if (!actions) return queueFallbackIntent();
    const ready = await waitForThreadReady({
      actions,
      timeoutMs: NAVIGATOR_SYNC_READY_TIMEOUT_MS,
    });
    if (!ready) return queueFallbackIntent();
    const resolvedThreadKey =
      opts.createNewThread === true
        ? ""
        : chooseThreadKeyFromIndex({
            actions,
            preferredThreadKey,
            fallbackThreadKey: threadKey,
          });

    let replyThreadKey = resolvedThreadKey;
    let replyThreadId =
      opts.createNewThread === true
        ? undefined
        : resolveThreadIdFromIndex(actions, replyThreadKey);
    const existingThreadTitle =
      replyThreadKey && replyThreadId
        ? normalizeOptionalTitle(
            actions.getThreadMetadata?.(replyThreadKey, {
              threadId: replyThreadId,
            })?.name,
          )
        : undefined;
    const messageThreadTitle =
      requestedTitle && (!replyThreadId || !existingThreadTitle)
        ? requestedTitle
        : undefined;
    const sessionModel =
      typeof session.model === "string" && session.model.trim().length > 0
        ? session.model.trim()
        : undefined;
    const model = requestedModel ?? sessionModel;
    const threadAgentCodexConfig = {
      model,
      reasoning: session.reasoning as any,
      sessionMode: session.mode as any,
      workingDirectory: session.working_directory,
      ...(opts.codexConfig ?? {}),
    };
    const newThreadAgent =
      opts.forceCodex !== false
        ? {
            mode: "codex" as const,
            model,
            codexConfig: threadAgentCodexConfig,
          }
        : undefined;
    let createdThreadNow = false;
    if (opts.createNewThread === true) {
      const createdThreadKey = actions.createEmptyThread?.({
        name: messageThreadTitle,
        threadAgent: newThreadAgent,
        threadAppearance: {
          color: session.thread_color,
          icon: session.thread_icon,
          image: session.thread_image,
        },
      });
      if (!createdThreadKey) {
        return queueFallbackIntent();
      }
      replyThreadKey = createdThreadKey;
      replyThreadId = createdThreadKey;
      createdThreadNow = true;
    }
    if (!replyThreadKey && workspaceTarget) {
      const createdThreadKey = actions.createEmptyThread?.({
        name: messageThreadTitle,
        threadAgent: newThreadAgent,
        threadAppearance: {
          color: session.thread_color,
          icon: session.thread_icon,
          image: session.thread_image,
        },
      });
      if (createdThreadKey) {
        replyThreadKey = createdThreadKey;
        replyThreadId = createdThreadKey;
        createdThreadNow = true;
        saveNavigatorSelectedThreadKey(createdThreadKey, targetChatPath);
      }
    }
    if (replyThreadKey && opts.createNewThread !== true && !createdThreadNow) {
      const rootReady = await waitForThreadReady({
        actions,
        threadKey: replyThreadKey,
        timeoutMs: NAVIGATOR_THREAD_IDENTITY_TIMEOUT_MS,
      });
      replyThreadId = resolveThreadIdFromIndex(actions, replyThreadKey);
      if (!rootReady || !replyThreadId) {
        // Fall back to opening a new thread rather than failing the intent.
        replyThreadKey = "";
        replyThreadId = undefined;
      }
    }
    if (replyThreadKey && opts.forceCodex !== false && opts.codexConfig) {
      actions.setThreadAgentMode?.(replyThreadKey, "codex", opts.codexConfig);
    }
    const timeStamp = actions.sendChat({
      input,
      acp_prompt: basePrompt,
      name: opts.createNewThread === true ? undefined : messageThreadTitle,
      reply_thread_id: replyThreadId,
      tag: opts.tag ?? "intent:navigator",
      noNotification: true,
      threadAgent:
        !replyThreadId && opts.forceCodex !== false
          ? newThreadAgent
          : undefined,
    });
    if (!timeStamp) {
      return queueFallbackIntent();
    }

    const nextThreadKey = replyThreadKey
      ? replyThreadKey
      : chooseThreadKeyFromIndex({
          actions,
          fallbackThreadKey: `${actions.store?.get?.("selectedThreadKey") ?? ""}`,
        });
    if (nextThreadKey) {
      saveNavigatorSelectedThreadKey(nextThreadKey, targetChatPath);
    }
    if (opts.openFloating !== false) {
      openFloatingAgentSession(
        project_id,
        {
          ...session,
          session_id:
            opts.createNewThread === true && nextThreadKey
              ? nextThreadKey
              : session.session_id,
          title: messageThreadTitle ?? session.title,
          thread_key: nextThreadKey || session.thread_key,
          updated_at: new Date().toISOString(),
          status: "active",
        },
        {
          workspaceId: workspaceTarget?.workspace.workspace_id ?? null,
          workspaceOnly: workspaceTarget != null,
        },
      );
    }
    setTimeout(() => {
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 50);
    return true;
  } catch {
    try {
      const project_id = `${opts.project_id ?? ""}`.trim();
      const input = `${opts.prompt ?? ""}`.trim();
      const visiblePrompt = `${opts.visiblePrompt ?? ""}`.trim() || undefined;
      const requestedTitle = normalizeOptionalTitle(opts.title);
      if (!project_id || !input) return false;
      dispatchNavigatorPromptIntent({
        prompt: input,
        visiblePrompt,
        title: requestedTitle,
        tag: opts.tag ?? "intent:navigator",
        forceCodex: opts.forceCodex ?? true,
        createNewThread: opts.createNewThread ?? false,
      });
      if (opts.openFloating !== false) {
        openFloatingAgentSession(
          project_id,
          {
            session_id: `navigator-${project_id}`,
            project_id,
            account_id: `${redux.getStore("account")?.get?.("account_id") ?? ""}`,
            chat_path: resolveNavigatorChatPath(project_id),
            thread_key: `${
              loadNavigatorSelectedThreadKey(
                project_id,
                resolveNavigatorChatPath(project_id),
              ) ?? ""
            }`.trim(),
            title: requestedTitle ?? "Navigator",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "active",
            entrypoint: "global",
          },
          {
            workspaceId: null,
            workspaceOnly: false,
          },
        );
      }
      return true;
    } catch {
      return false;
    }
  }
}
