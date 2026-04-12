import {
  Alert,
  Button,
  Dropdown,
  Modal,
  Select,
  Space,
  Typography,
  message as antdMessage,
} from "antd";
import type { MenuProps } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import {
  upsertAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionStatus,
} from "@cocalc/frontend/chat/agent-session-index";
import type { CodexThreadConfig } from "@cocalc/chat";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import { Loading, ThemeEditorModal } from "@cocalc/frontend/components";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { Icon } from "@cocalc/frontend/components/icon";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { useKeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { lite } from "@cocalc/frontend/lite";
import { getChatActions, initChat } from "@cocalc/frontend/chat/register";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import { useAgentChatFontSize } from "@cocalc/frontend/project/page/agent-chat-font-size";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { path_split } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  NAVIGATOR_SUBMIT_PROMPT_EVENT,
  queueNavigatorPromptIntent,
  removeQueuedNavigatorPromptIntent,
  takeQueuedNavigatorPromptIntents,
  type NavigatorSubmitPromptDetail,
} from "./navigator-intents";
import {
  NAVIGATOR_SELECTED_THREAD_EVENT,
  loadNavigatorSelectedThreadKey,
  saveNavigatorSelectedThreadKey,
} from "./navigator-state";

interface NavigatorShellProps {
  project_id: string;
  defaultTargetProjectId?: string;
}

export const NAVIGATOR_CHAT_INSTANCE_KEY = "navigator-shell";
const NAVIGATOR_DEFAULT_THREAD_TITLE = "Navigator";
const NAVIGATOR_DEFAULT_THREAD_ICON = "sitemap";
const NAVIGATOR_DEFAULT_THREAD_COLOR = "#c8e6c9";

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

function latestThreadKey(actions?: ChatActions): string | null {
  const index = actions?.messageCache?.getThreadIndex();
  if (!index?.size) return null;
  let bestKey: string | null = null;
  let bestTime = -Infinity;
  for (const entry of index.values()) {
    const newest = Number(entry?.newestTime ?? -Infinity);
    if (newest > bestTime && typeof entry?.key === "string") {
      bestTime = newest;
      bestKey = entry.key;
    }
  }
  return bestKey;
}

function chooseThreadKey(
  actions: ChatActions,
  preferredThreadKey?: string | null,
): string | null {
  const index = actions.messageCache?.getThreadIndex();
  if (!index?.size) return null;
  if (preferredThreadKey && index.has(preferredThreadKey)) {
    return preferredThreadKey;
  }
  return latestThreadKey(actions);
}

function isThreadArchived(actions: ChatActions, thread: any): boolean {
  const threadKey = typeof thread?.key === "string" ? thread.key : "";
  const threadId =
    typeof thread?.rootMessage?.thread_id === "string"
      ? thread.rootMessage.thread_id
      : undefined;
  if (!threadKey) return false;
  return actions.getThreadMetadata(threadKey, { threadId }).archived === true;
}

function chooseNonArchivedThreadKey(
  actions: ChatActions,
  preferredThreadKey?: string | null,
): string | null {
  const index = actions.messageCache?.getThreadIndex();
  if (!index?.size) return null;
  if (preferredThreadKey && index.has(preferredThreadKey)) {
    const preferred = index.get(preferredThreadKey);
    if (preferred && !isThreadArchived(actions, preferred)) {
      return preferredThreadKey;
    }
  }
  let bestKey: string | null = null;
  let bestTime = -Infinity;
  for (const thread of index.values()) {
    if (isThreadArchived(actions, thread)) continue;
    const newest = Number(thread?.newestTime ?? -Infinity);
    if (typeof thread?.key === "string" && newest > bestTime) {
      bestTime = newest;
      bestKey = thread.key;
    }
  }
  return bestKey;
}

function parseDateISOString(value: unknown): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (!Number.isFinite(d.valueOf())) return undefined;
  return d.toISOString();
}

function summarizeTitle(rootMessage: any): string {
  const name =
    typeof rootMessage?.name === "string" ? rootMessage.name.trim() : "";
  if (name) return name;
  const history0 = rootMessage?.history?.[0];
  const content =
    typeof history0?.content === "string" ? history0.content.trim() : "";
  if (content) return content.slice(0, 140);
  return "Navigator session";
}

function resolveReplyThreadId(
  actions: ChatActions,
  threadKey: string | null,
): string | undefined {
  if (!threadKey) return;
  const entry = actions.messageCache?.getThreadIndex()?.get(threadKey);
  const fromIndex = `${entry?.rootMessage?.thread_id ?? ""}`.trim();
  if (fromIndex) return fromIndex;
  if (/^\d+$/.test(threadKey)) {
    const root = actions.getMessageByDate?.(Number(threadKey));
    const fromRoot = `${root?.thread_id ?? ""}`.trim();
    if (fromRoot) return fromRoot;
  }
  return;
}

export function resolveSelectedAcpConfig({
  actions,
  selectedThreadKey,
  selectedRootMessage,
}: {
  actions?: ChatActions | null;
  selectedThreadKey?: string | null;
  selectedRootMessage?: any;
}): Partial<CodexThreadConfig> {
  if (!actions || !selectedThreadKey) {
    return selectedRootMessage?.acp_config ?? {};
  }
  const threadId =
    typeof selectedRootMessage?.thread_id === "string"
      ? selectedRootMessage.thread_id
      : undefined;
  const metadata = actions.getThreadMetadata(selectedThreadKey, {
    threadId,
  });
  return metadata?.acp_config ?? selectedRootMessage?.acp_config ?? {};
}

function buildSessionRecord({
  project_id,
  account_id,
  navigatorPath,
  threadKey,
  thread,
  threadMetadata,
  status,
  defaultWorkingDirectory,
}: {
  project_id: string;
  account_id: string;
  navigatorPath: string;
  threadKey: string;
  thread: any;
  threadMetadata?: any;
  status: AgentSessionStatus;
  defaultWorkingDirectory?: string;
}): AgentSessionRecord {
  const rootMessage: any = thread?.rootMessage ?? {};
  const acpConfig: any =
    threadMetadata?.acp_config ?? rootMessage?.acp_config ?? {};
  const titleFromMetadata =
    typeof threadMetadata?.name === "string" ? threadMetadata.name.trim() : "";
  const sessionIdRaw =
    typeof acpConfig?.sessionId === "string" && acpConfig.sessionId.trim()
      ? acpConfig.sessionId.trim()
      : threadKey;
  const createdAt =
    parseDateISOString(rootMessage?.date) ??
    parseDateISOString(thread?.newestTime) ??
    new Date().toISOString();
  const updatedAt =
    parseDateISOString(thread?.newestTime) ??
    parseDateISOString(rootMessage?.date) ??
    new Date().toISOString();
  return {
    session_id: sessionIdRaw,
    project_id,
    account_id,
    chat_path: navigatorPath,
    thread_key: threadKey,
    title: titleFromMetadata || summarizeTitle(rootMessage),
    created_at: createdAt,
    updated_at: updatedAt,
    status,
    entrypoint: "global",
    working_directory:
      typeof acpConfig?.workingDirectory === "string"
        ? acpConfig.workingDirectory
        : defaultWorkingDirectory,
    mode:
      acpConfig?.sessionMode === "read-only" ||
      acpConfig?.sessionMode === "workspace-write" ||
      acpConfig?.sessionMode === "full-access"
        ? acpConfig.sessionMode
        : undefined,
    model: typeof acpConfig?.model === "string" ? acpConfig.model : undefined,
    reasoning:
      typeof acpConfig?.reasoning === "string"
        ? acpConfig.reasoning
        : undefined,
    thread_color:
      typeof threadMetadata?.thread_color === "string"
        ? threadMetadata.thread_color
        : undefined,
    thread_accent_color:
      typeof threadMetadata?.thread_accent_color === "string"
        ? threadMetadata.thread_accent_color
        : undefined,
    thread_icon:
      typeof threadMetadata?.thread_icon === "string"
        ? threadMetadata.thread_icon
        : undefined,
    thread_image:
      typeof threadMetadata?.thread_image === "string"
        ? threadMetadata.thread_image
        : undefined,
    thread_pin:
      threadMetadata?.pin === true ||
      threadMetadata?.pin === "true" ||
      threadMetadata?.pin === 1 ||
      threadMetadata?.pin === "1",
  };
}

export function NavigatorShell({
  project_id,
  defaultTargetProjectId,
}: NavigatorShellProps) {
  void defaultTargetProjectId;

  const projectActions = useActions({ project_id }) as ProjectActions;
  const account_id = useTypedRedux("account", "account_id");
  const accountFontSize = useTypedRedux("account", "font_size") ?? 13;
  const available_features = useTypedRedux(
    { project_id },
    "available_features",
  );

  const homeDirectory = useMemo(() => {
    const resolvedHome = available_features?.get?.("homeDirectory");
    if (typeof resolvedHome === "string" && resolvedHome.length > 0) {
      return normalizeAbsolutePath(resolvedHome);
    }
    return getProjectHomeDirectory(project_id);
  }, [available_features, project_id]);

  const navigatorPath = useMemo(() => {
    if (!lite && typeof account_id !== "string") {
      return "";
    }
    return normalizeAbsolutePath(navigatorChatPath(account_id), homeDirectory);
  }, [account_id, homeDirectory]);

  const [actions, setActions] = useState<ChatActions | null>(() => {
    if (!navigatorPath) return null;
    return (
      getChatActions(project_id, navigatorPath, {
        instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
      }) ?? null
    );
  });
  const [error, setError] = useState<string>("");
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(
    null,
  );
  const [cacheVersion, setCacheVersion] = useState(0);
  const [isArchiving, setIsArchiving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsName, setSettingsName] = useState("");
  const [settingsColor, setSettingsColor] = useState<string | undefined>(
    undefined,
  );
  const [settingsAccentColor, setSettingsAccentColor] = useState<
    string | undefined
  >(undefined);
  const [settingsIcon, setSettingsIcon] = useState<string | undefined>(
    undefined,
  );
  const [settingsImage, setSettingsImage] = useState("");
  const [sessionIndexRetry, setSessionIndexRetry] = useState(0);
  const [intentRetryTick, setIntentRetryTick] = useState(0);
  const lastIndexedValueRef = useRef<string>("");
  const pendingNewThreadDefaultsRef = useRef<boolean>(false);
  const preferredThreadKeyRef = useRef<string | undefined>(
    loadNavigatorSelectedThreadKey(project_id, navigatorPath),
  );
  const {
    fontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncreaseFontSize,
    canDecreaseFontSize,
  } = useAgentChatFontSize(accountFontSize);

  useEffect(() => {
    if (!navigatorPath || !projectActions) return;
    let mounted = true;
    setError("");
    const sharedActions = getChatActions(project_id, navigatorPath, {
      instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
    });
    if (sharedActions) {
      setActions((current) =>
        current === sharedActions ? current : sharedActions,
      );
      return () => {
        mounted = false;
      };
    }

    setActions((current) => {
      const currentPath = current?.store?.get?.("path");
      if (typeof currentPath === "string" && currentPath !== navigatorPath) {
        return null;
      }
      return current;
    });

    const run = async () => {
      try {
        const fs = projectActions.fs();
        await fs.mkdir(path_split(navigatorPath).head, { recursive: true });
        if (!mounted) return;
        const chatActions = initChat(project_id, navigatorPath, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
        if (!mounted) return;
        setActions(chatActions);
      } catch (err) {
        if (!mounted) return;
        setActions(null);
        setError(`${err}`);
      }
    };
    void run();

    return () => {
      mounted = false;
    };
  }, [projectActions, project_id, navigatorPath]);

  useEffect(() => {
    if (!actions) return;
    let detached = false;
    let poller: ReturnType<typeof setInterval> | undefined;
    let detachListener: (() => void) | undefined;

    const attach = (): boolean => {
      if (detached || detachListener) return true;
      const cache = actions.messageCache;
      if (!cache) return false;
      const onVersion = () => {
        const index = cache.getThreadIndex();
        const preferred = preferredThreadKeyRef.current;
        setSelectedThreadKey((current) => {
          if (current === "") {
            return current;
          }
          if (current && index?.has(current)) {
            return current;
          }
          return chooseThreadKey(actions, preferred);
        });
        preferredThreadKeyRef.current = undefined;
        setCacheVersion((v) => v + 1);
      };
      cache.on("version", onVersion);
      onVersion();
      detachListener = () => {
        cache.removeListener("version", onVersion);
      };
      return true;
    };

    if (!attach()) {
      poller = setInterval(() => {
        if (attach() && poller) {
          clearInterval(poller);
          poller = undefined;
        }
      }, 250);
    }

    return () => {
      detached = true;
      if (poller) {
        clearInterval(poller);
      }
      detachListener?.();
    };
  }, [actions]);

  useEffect(() => {
    saveNavigatorSelectedThreadKey(
      selectedThreadKey ?? undefined,
      navigatorPath,
    );
  }, [navigatorPath, selectedThreadKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onThreadRequested = (evt: Event) => {
      const detail = (
        evt as CustomEvent<{ threadKey?: string; chatPath?: string }>
      ).detail;
      const requestedChatPath = `${detail?.chatPath ?? ""}`.trim();
      if (requestedChatPath && requestedChatPath !== navigatorPath) {
        return;
      }
      const threadKey = `${detail?.threadKey ?? ""}`.trim() || null;
      if (!threadKey) {
        preferredThreadKeyRef.current = undefined;
        return;
      }
      preferredThreadKeyRef.current = threadKey ?? undefined;
      if (!actions) {
        setSelectedThreadKey(threadKey);
        return;
      }
      setSelectedThreadKey(chooseThreadKey(actions, threadKey));
    };
    window.addEventListener(
      NAVIGATOR_SELECTED_THREAD_EVENT,
      onThreadRequested as EventListener,
    );
    return () => {
      window.removeEventListener(
        NAVIGATOR_SELECTED_THREAD_EVENT,
        onThreadRequested as EventListener,
      );
    };
  }, [actions]);

  useEffect(() => {
    if (!actions || !selectedThreadKey) return;
    const timer = setTimeout(() => {
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [actions, selectedThreadKey]);

  const selectedThread = useMemo(() => {
    if (!actions || !selectedThreadKey) return;
    return actions.messageCache?.getThreadIndex().get(selectedThreadKey);
  }, [actions, selectedThreadKey, cacheVersion]);

  const selectedRootMessage: any = useMemo(() => {
    return selectedThread?.rootMessage ?? {};
  }, [selectedThread]);

  const selectedThreadMetadata = useMemo(() => {
    if (!actions || !selectedThreadKey) return undefined;
    const threadId =
      typeof selectedRootMessage?.thread_id === "string"
        ? selectedRootMessage.thread_id
        : undefined;
    return actions.getThreadMetadata(selectedThreadKey, {
      threadId,
    });
  }, [actions, selectedRootMessage, selectedThreadKey, cacheVersion]);

  const threadOptions = useMemo(() => {
    if (!actions) return [] as Array<{ value: string; label: string }>;
    const index = actions.messageCache?.getThreadIndex();
    if (!index?.size) return [] as Array<{ value: string; label: string }>;
    const items = Array.from(index.values())
      .filter((thread) => !isThreadArchived(actions, thread))
      .sort((a, b) => Number(b?.newestTime ?? 0) - Number(a?.newestTime ?? 0))
      .map((thread) => {
        const metadata = actions.getThreadMetadata(thread.key, {
          threadId:
            typeof thread?.rootMessage?.thread_id === "string"
              ? thread.rootMessage.thread_id
              : undefined,
        });
        const name =
          typeof metadata?.name === "string" ? metadata.name.trim() : "";
        return {
          value: thread.key,
          label: name || summarizeTitle(thread.rootMessage),
        };
      });
    return items;
  }, [actions, cacheVersion]);

  const selectedSessionRecord = useMemo(() => {
    if (
      !selectedThreadKey ||
      !selectedThread ||
      typeof account_id !== "string" ||
      account_id.trim().length === 0
    ) {
      return;
    }
    const status: AgentSessionStatus = selectedRootMessage?.generating
      ? "running"
      : "active";
    return buildSessionRecord({
      project_id,
      account_id,
      navigatorPath,
      threadKey: selectedThreadKey,
      thread: selectedThread,
      threadMetadata: selectedThreadMetadata,
      status,
      defaultWorkingDirectory: homeDirectory,
    });
  }, [
    account_id,
    navigatorPath,
    project_id,
    selectedThreadMetadata,
    selectedRootMessage,
    selectedThread,
    selectedThreadKey,
  ]);

  useEffect(() => {
    if (!selectedSessionRecord) return;
    const serialized = JSON.stringify(selectedSessionRecord);
    if (lastIndexedValueRef.current === serialized) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setSessionIndexRetry((v) => v + 1);
      }
    }, 2000);
    void upsertAgentSessionRecord(selectedSessionRecord)
      .then(() => {
        if (cancelled) return;
        clearTimeout(timer);
        lastIndexedValueRef.current = serialized;
      })
      .catch(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    account_id,
    project_id,
    selectedSessionRecord,
    selectedThread,
    selectedThreadKey,
    sessionIndexRetry,
  ]);

  useEffect(() => {
    if (!actions || !selectedThreadKey) return;
    const acpConfig =
      selectedThreadMetadata?.acp_config ?? selectedRootMessage?.acp_config;
    if (!acpConfig) return;
    if (acpConfig.workingDirectory === homeDirectory) return;
    actions.setThreadAgentMode(selectedThreadKey, "codex", {
      ...acpConfig,
      workingDirectory: homeDirectory,
    });
  }, [
    actions,
    homeDirectory,
    selectedRootMessage,
    selectedThreadKey,
    selectedThreadMetadata,
  ]);

  useEffect(() => {
    if (!actions || !selectedThreadKey || selectedThreadKey === "") return;
    if (!pendingNewThreadDefaultsRef.current) return;
    const threadId =
      typeof selectedRootMessage?.thread_id === "string"
        ? selectedRootMessage.thread_id
        : undefined;
    if (!threadId) return;
    const metadata = actions.getThreadMetadata(selectedThreadKey, {
      threadId,
    });
    const patch: {
      name?: string;
      color?: string;
      icon?: string;
    } = {};
    if (
      !(typeof metadata?.name === "string" && metadata.name.trim().length > 0)
    ) {
      patch.name = NAVIGATOR_DEFAULT_THREAD_TITLE;
    }
    if (
      !(
        typeof metadata?.thread_color === "string" &&
        metadata.thread_color.trim().length > 0
      )
    ) {
      patch.color = NAVIGATOR_DEFAULT_THREAD_COLOR;
    }
    if (
      !(
        typeof metadata?.thread_icon === "string" &&
        metadata.thread_icon.trim().length > 0
      )
    ) {
      patch.icon = NAVIGATOR_DEFAULT_THREAD_ICON;
    }
    if (Object.keys(patch).length > 0) {
      const ok = actions.setThreadAppearance(selectedThreadKey, patch);
      if (ok) {
        setCacheVersion((v) => v + 1);
      } else {
        return;
      }
    }
    pendingNewThreadDefaultsRef.current = false;
  }, [actions, selectedRootMessage, selectedThreadKey]);

  const submitIntent = useCallback(
    (intent: NavigatorSubmitPromptDetail): boolean => {
      if (!actions) return false;
      const basePrompt = `${intent?.prompt ?? ""}`.trim();
      if (!basePrompt) {
        removeQueuedNavigatorPromptIntent(intent.id);
        return true;
      }
      const input = `${intent.visiblePrompt ?? ""}`.trim() || basePrompt;
      const storedThreadKey = loadNavigatorSelectedThreadKey(
        project_id,
        navigatorPath,
      );
      const resolvedThreadKey =
        intent.createNewThread === true
          ? null
          : chooseNonArchivedThreadKey(
              actions,
              selectedThreadKey ?? storedThreadKey ?? undefined,
            );
      let replyThreadId =
        intent.createNewThread === true
          ? undefined
          : resolveReplyThreadId(actions, resolvedThreadKey);
      if (resolvedThreadKey && !replyThreadId) {
        // If we cannot confidently resolve thread identity yet, open a new
        // thread instead of dropping the prompt.
        replyThreadId = undefined;
      }
      const requestedTitle = `${intent.title ?? ""}`.trim();
      const existingThreadTitle =
        resolvedThreadKey && replyThreadId
          ? `${
              actions.getThreadMetadata(resolvedThreadKey, {
                threadId: replyThreadId,
              })?.name ?? ""
            }`.trim() || undefined
          : undefined;
      const messageThreadTitle =
        requestedTitle && (!replyThreadId || !existingThreadTitle)
          ? requestedTitle
          : undefined;
      const isCodex = intent.forceCodex !== false;
      const launchAcpConfig = resolveSelectedAcpConfig({
        actions,
        selectedThreadKey,
        selectedRootMessage,
      });
      const requestedModel =
        typeof intent.codexConfig?.model === "string" &&
        intent.codexConfig.model.trim().length > 0
          ? intent.codexConfig.model.trim()
          : undefined;
      const selectedModel =
        typeof launchAcpConfig?.model === "string" &&
        launchAcpConfig.model.trim().length > 0
          ? launchAcpConfig.model.trim()
          : undefined;
      const model = requestedModel ?? selectedModel;
      const nextCodexConfig = {
        ...launchAcpConfig,
        ...(intent.codexConfig ?? {}),
        model,
        workingDirectory: homeDirectory,
      };
      let createdThreadKey: string | undefined;
      if (intent.createNewThread === true) {
        createdThreadKey = actions.createEmptyThread?.({
          name: messageThreadTitle,
          threadAgent: isCodex
            ? {
                mode: "codex",
                model,
                codexConfig: nextCodexConfig,
              }
            : undefined,
        });
        if (!createdThreadKey) {
          return false;
        }
        replyThreadId = createdThreadKey;
      }
      if (resolvedThreadKey && isCodex && intent.codexConfig) {
        actions.setThreadAgentMode?.(
          resolvedThreadKey,
          "codex",
          intent.codexConfig,
        );
      }
      const timeStamp = actions.sendChat({
        input,
        acp_prompt: basePrompt,
        name: intent.createNewThread === true ? undefined : messageThreadTitle,
        reply_thread_id: replyThreadId,
        tag: intent.tag ?? "intent:navigator",
        noNotification: true,
        threadAgent:
          !replyThreadId && isCodex
            ? {
                mode: "codex",
                model,
                codexConfig: nextCodexConfig,
              }
            : undefined,
      });
      if (!timeStamp) {
        return false;
      }
      removeQueuedNavigatorPromptIntent(intent.id);
      if (resolvedThreadKey && resolvedThreadKey !== selectedThreadKey) {
        setSelectedThreadKey(resolvedThreadKey);
      }
      if (createdThreadKey) {
        setSelectedThreadKey(createdThreadKey);
      } else if (!replyThreadId) {
        const latest = latestThreadKey(actions);
        if (latest) {
          setSelectedThreadKey(latest);
        }
      }
      setTimeout(() => actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER), 100);
      return true;
    },
    [actions, homeDirectory, selectedRootMessage, selectedThreadKey],
  );

  useEffect(() => {
    if (!actions) return;
    let retryNeeded = false;
    const queued = takeQueuedNavigatorPromptIntents();
    for (const intent of queued) {
      try {
        const consumed = submitIntent(intent);
        if (!consumed) {
          queueNavigatorPromptIntent(intent);
          retryNeeded = true;
          break;
        }
      } catch (err) {
        queueNavigatorPromptIntent(intent);
        setError(`${err}`);
        retryNeeded = true;
      }
    }
    if (!retryNeeded) return;
    const timer = setTimeout(() => {
      setIntentRetryTick((v) => v + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [actions, submitIntent, intentRetryTick]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPromptIntent = (evt: Event) => {
      const detail = (evt as CustomEvent<NavigatorSubmitPromptDetail>).detail;
      if (!detail?.id) return;
      if (!actions) return;
      try {
        const consumed = submitIntent(detail);
        if (!consumed) {
          setIntentRetryTick((v) => v + 1);
        }
      } catch (err) {
        setError(`${err}`);
        setIntentRetryTick((v) => v + 1);
      }
    };
    window.addEventListener(
      NAVIGATOR_SUBMIT_PROMPT_EVENT,
      onPromptIntent as EventListener,
    );
    return () => {
      window.removeEventListener(
        NAVIGATOR_SUBMIT_PROMPT_EVENT,
        onPromptIntent as EventListener,
      );
    };
  }, [actions, submitIntent]);

  const desc = useMemo(() => {
    const data: Record<string, any> = {
      "data-preferLatestThread": true,
      "data-showThreadImagePreview": false,
      "data-hideChatTypeSelector": true,
      "data-newThreadTitleDefault": NAVIGATOR_DEFAULT_THREAD_TITLE,
      "data-newThreadIconDefault": NAVIGATOR_DEFAULT_THREAD_ICON,
      "data-newThreadColorDefault": NAVIGATOR_DEFAULT_THREAD_COLOR,
      // Navigator-only: new Codex threads should start in the project root,
      // not relative to the navigator chat file path under .local/share/cocalc.
      "data-navigatorNewThreadWorkingDirectoryDefault": homeDirectory,
    };
    if (selectedThreadKey !== null) {
      data["data-selectedThreadKey"] = selectedThreadKey;
    }
    return data;
  }, [selectedThreadKey]);

  const chatFileContext = useMemo(
    () => ({
      project_id,
      path: navigatorPath,
      urlTransform: getUrlTransform({ project_id, path: navigatorPath }),
      AnchorTagComponent: getAnchorTagComponent({
        project_id,
        path: navigatorPath,
      }),
    }),
    [project_id, navigatorPath],
  );
  const keyboardBoundaryProps = useKeyboardBoundary<HTMLDivElement>({
    boundary: "navigator",
  });

  const threadTitle = useMemo(() => {
    if (!selectedThreadKey) return "New chat";
    const name =
      typeof selectedThreadMetadata?.name === "string"
        ? selectedThreadMetadata.name.trim()
        : "";
    if (name) return name;
    return summarizeTitle(selectedRootMessage);
  }, [selectedRootMessage, selectedThreadKey, selectedThreadMetadata]);

  function openThreadSettings(): void {
    if (!selectedThreadKey) return;
    const name =
      typeof selectedThreadMetadata?.name === "string"
        ? selectedThreadMetadata.name
        : "";
    setSettingsName(name || "");
    setSettingsColor(
      typeof selectedThreadMetadata?.thread_color === "string"
        ? selectedThreadMetadata.thread_color
        : undefined,
    );
    setSettingsAccentColor(
      typeof selectedThreadMetadata?.thread_accent_color === "string"
        ? selectedThreadMetadata.thread_accent_color
        : undefined,
    );
    setSettingsIcon(
      typeof selectedThreadMetadata?.thread_icon === "string"
        ? selectedThreadMetadata.thread_icon
        : undefined,
    );
    setSettingsImage(
      typeof selectedThreadMetadata?.thread_image === "string"
        ? selectedThreadMetadata.thread_image
        : "",
    );
    setSettingsOpen(true);
  }

  async function saveThreadSettings(): Promise<void> {
    if (!actions || !selectedThreadKey) return;
    setSettingsSaving(true);
    try {
      const ok = actions.setThreadAppearance(selectedThreadKey, {
        name: settingsName,
        color: settingsColor,
        accentColor: settingsAccentColor,
        icon: settingsIcon,
        image: settingsImage,
      });
      if (!ok) {
        antdMessage.error("Unable to save thread appearance.");
        return;
      }
      antdMessage.success("Thread appearance saved.");
      setSettingsOpen(false);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function archiveCurrentSession(): Promise<void> {
    if (!selectedSessionRecord) return;
    setIsArchiving(true);
    setError("");
    try {
      await upsertAgentSessionRecord({
        ...selectedSessionRecord,
        status: "archived",
        updated_at: new Date().toISOString(),
      });
      setSelectedThreadKey(null);
      actions?.setSelectedThread?.(null);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setIsArchiving(false);
    }
  }

  function startNewThread(): void {
    pendingNewThreadDefaultsRef.current = true;
    setSelectedThreadKey("");
    actions?.setSelectedThread?.(null);
  }

  function clearCurrentThread(): void {
    if (!actions || !selectedThreadKey) return;
    const sourceLabel =
      typeof selectedThreadMetadata?.name === "string" &&
      selectedThreadMetadata.name.trim().length > 0
        ? selectedThreadMetadata.name.trim()
        : "Codex";
    const next = actions.resetThread(selectedThreadKey, {
      name: "Codex",
      renameSourceTo: `Previous ${sourceLabel}`,
      pinNewThread: true,
      unpinSourceThread: true,
    });
    if (!next) return;
    setSelectedThreadKey(next);
    actions.setSelectedThread?.(next);
    saveNavigatorSelectedThreadKey(next, navigatorPath);
  }

  function openChatFile(): void {
    projectActions?.open_file({
      path: navigatorPath,
      foreground: true,
    });
  }

  const actionItems = useMemo<MenuProps["items"]>(
    () => [
      { key: "new", label: "New Thread" },
      {
        key: "settings",
        label: "Thread Appearance...",
        disabled: !selectedThreadKey,
      },
      { type: "divider" },
      {
        key: "clear",
        label: "Clear Thread",
        disabled: !selectedThreadKey,
      },
      {
        key: "archive",
        label:
          selectedSessionRecord?.status === "archived"
            ? "Archived"
            : "Archive Thread",
        disabled: !selectedSessionRecord || isArchiving,
      },
      { type: "divider" },
      { key: "open-chat-file", label: "Open Chat File" },
    ],
    [isArchiving, selectedSessionRecord, selectedThreadKey],
  );

  const onActionMenuClick = useCallback<NonNullable<MenuProps["onClick"]>>(
    ({ key }) => {
      if (key === "new") {
        startNewThread();
        return;
      }
      if (key === "settings") {
        openThreadSettings();
        return;
      }
      if (key === "clear") {
        Modal.confirm({
          title: "Clear the current thread?",
          content:
            "This starts a fresh empty thread, keeps the current thread as history, and selects the fresh thread.",
          okText: "Clear",
          cancelText: "Cancel",
          onOk: clearCurrentThread,
        });
        return;
      }
      if (key === "archive") {
        void archiveCurrentSession();
        return;
      }
      if (key === "open-chat-file") {
        openChatFile();
      }
    },
    [
      archiveCurrentSession,
      clearCurrentThread,
      openChatFile,
      openThreadSettings,
      startNewThread,
    ],
  );

  if (!navigatorPath) {
    return <Loading theme="medium" />;
  }

  if (!projectActions) {
    return <Loading theme="medium" />;
  }

  const fontControls = (
    <Space size={[4, 0]} wrap>
      <Tooltip title="Decrease chat font size">
        <Button
          size="small"
          type="text"
          disabled={!canDecreaseFontSize}
          onClick={decreaseFontSize}
          style={{ minWidth: 24, padding: "0 4px" }}
        >
          <Icon name="minus" />
        </Button>
      </Tooltip>
      <Tooltip title={`Agent chat font size: ${fontSize}px`}>
        <Typography.Text style={{ minWidth: 28, textAlign: "center" }}>
          {fontSize}
        </Typography.Text>
      </Tooltip>
      <Tooltip title="Increase chat font size">
        <Button
          size="small"
          type="text"
          disabled={!canIncreaseFontSize}
          onClick={increaseFontSize}
          style={{ minWidth: 24, padding: "0 4px" }}
        >
          <Icon name="plus" />
        </Button>
      </Tooltip>
    </Space>
  );

  return (
    <div>
      <Space
        wrap
        size={[8, 8]}
        style={{
          marginBottom: 8,
          width: "100%",
          justifyContent: "space-between",
        }}
      >
        <Space size={[6, 6]} wrap style={{ minWidth: 0 }}>
          <Typography.Text strong>{threadTitle}</Typography.Text>
          {threadOptions.length > 0 ? (
            <Select
              size="small"
              style={{ minWidth: 190, maxWidth: 320 }}
              placeholder="Select thread"
              value={selectedThreadKey || undefined}
              options={threadOptions}
              onChange={(value) => {
                const threadKey =
                  typeof value === "string" && value.trim().length > 0
                    ? value
                    : null;
                setSelectedThreadKey(threadKey);
                actions?.setSelectedThread?.(threadKey);
              }}
              showSearch
              optionFilterProp="label"
            />
          ) : null}
        </Space>
        <Space size={[4, 4]} wrap>
          {fontControls}
          <Dropdown
            trigger={["click"]}
            menu={{ items: actionItems, onClick: onActionMenuClick }}
          >
            <Button size="small">Actions</Button>
          </Dropdown>
        </Space>
      </Space>
      <ThemeEditorModal
        open={settingsOpen}
        title="Edit Thread Appearance"
        value={{
          title: settingsName,
          description: "",
          color: settingsColor ?? null,
          accent_color: settingsAccentColor ?? null,
          icon: settingsIcon ?? "",
          image_blob: settingsImage,
        }}
        onChange={(patch) => {
          if (patch.title != null) setSettingsName(patch.title);
          if (patch.color !== undefined) {
            setSettingsColor(patch.color ?? undefined);
          }
          if (patch.accent_color !== undefined) {
            setSettingsAccentColor(patch.accent_color ?? undefined);
          }
          if (patch.icon != null) {
            setSettingsIcon(patch.icon || undefined);
          }
          if (patch.image_blob != null) {
            setSettingsImage(patch.image_blob);
          }
        }}
        onCancel={() => setSettingsOpen(false)}
        onSave={saveThreadSettings}
        confirmLoading={settingsSaving}
        defaultIcon="comment"
        showDescription={false}
        previewImageUrl={settingsImage}
        extraBeforeTheme={
          <Typography.Text type="secondary">
            Customize this navigator thread appearance.
          </Typography.Text>
        }
        renderImageInput={() => (
          <div>
            <ThreadImageUpload
              projectId={project_id}
              value={settingsImage}
              onChange={setSettingsImage}
              modalTitle="Select Thread Image"
              uploadText="Click or drag image"
            />
          </div>
        )}
      />
      {error ? (
        <Alert
          type="error"
          title={error}
          showIcon
          style={{ marginBottom: 8 }}
        />
      ) : null}
      <div
        style={{
          border: "1px solid #eee",
          borderRadius: 8,
          overflow: "hidden",
          background: "white",
          height: "min(70vh, 760px)",
        }}
        {...keyboardBoundaryProps}
      >
        {actions ? (
          <FileContext.Provider value={chatFileContext}>
            <SideChat
              actions={actions}
              project_id={project_id}
              path={navigatorPath}
              hideSidebar
              desc={desc}
              fontSize={fontSize}
            />
          </FileContext.Provider>
        ) : (
          <Loading theme="medium" />
        )}
      </div>
    </div>
  );
}

export default NavigatorShell;
