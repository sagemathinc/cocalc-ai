import {
  Alert,
  Button,
  Dropdown,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
  message as antdMessage,
} from "antd";
import type { MenuProps } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { ChatIconPicker } from "@cocalc/frontend/chat/chat-icon-picker";
import {
  upsertAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionStatus,
} from "@cocalc/frontend/chat/agent-session-index";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import { Loading } from "@cocalc/frontend/components";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import { lite } from "@cocalc/frontend/lite";
import {
  initChat,
  removeWithInstance as removeChatWithInstance,
} from "@cocalc/frontend/chat/register";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { path_split } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
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

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function navigatorChatPath(accountId?: string): string {
  if (lite) return ".local/share/cocalc/navigator.chat";
  const key = sanitizeAccountId(accountId?.trim() || "unknown-account");
  return `.local/share/cocalc/navigator-${key}.chat`;
}

function getLiteHomeDirectory(availableFeatures: any): string {
  const homeFromFeatures =
    availableFeatures?.homeDirectory ?? availableFeatures?.get?.("homeDirectory");
  if (typeof homeFromFeatures === "string" && homeFromFeatures.length > 0) {
    return normalizeAbsolutePath(homeFromFeatures);
  }
  return "/";
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

function toReplyDate(threadKey: string | null): Date | undefined {
  if (!threadKey || !/^\d+$/.test(threadKey)) return;
  const ms = Number(threadKey);
  if (!Number.isFinite(ms)) return;
  return new Date(ms);
}

function ensureCodexMention(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  if (/^@codex\b/i.test(trimmed)) return trimmed;
  return `@codex ${trimmed}`;
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
  const acpConfig: any = threadMetadata?.acp_config ?? rootMessage?.acp_config ?? {};
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
      typeof acpConfig?.reasoning === "string" ? acpConfig.reasoning : undefined,
    thread_color:
      typeof threadMetadata?.thread_color === "string"
        ? threadMetadata.thread_color
        : undefined,
    thread_icon:
      typeof threadMetadata?.thread_icon === "string"
        ? threadMetadata.thread_icon
        : undefined,
    thread_image:
      typeof threadMetadata?.thread_image === "string"
        ? threadMetadata.thread_image
        : undefined,
  };
}

export function NavigatorShell({
  project_id,
  defaultTargetProjectId,
}: NavigatorShellProps) {
  void defaultTargetProjectId;

  const projectActions = useActions({ project_id }) as ProjectActions;
  const account_id = useTypedRedux("account", "account_id");
  const available_features = useTypedRedux({ project_id }, "available_features");
  const [actions, setActions] = useState<ChatActions | null>(null);
  const [error, setError] = useState<string>("");
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [isArchiving, setIsArchiving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsName, setSettingsName] = useState("");
  const [settingsColor, setSettingsColor] = useState<string | undefined>(undefined);
  const [settingsIcon, setSettingsIcon] = useState<string | undefined>(undefined);
  const [settingsImage, setSettingsImage] = useState("");
  const [sessionIndexRetry, setSessionIndexRetry] = useState(0);
  const lastIndexedValueRef = useRef<string>("");
  const preferredThreadKeyRef = useRef<string | undefined>(
    loadNavigatorSelectedThreadKey(project_id),
  );

  const homeDirectory = useMemo(() => {
    if (!lite) {
      return "/root";
    }
    return getLiteHomeDirectory(available_features);
  }, [available_features]);

  const navigatorPath = useMemo(() => {
    if (!lite && typeof account_id !== "string") {
      return "";
    }
    return normalizeAbsolutePath(navigatorChatPath(account_id), homeDirectory);
  }, [account_id, homeDirectory]);

  useEffect(() => {
    if (!navigatorPath || !projectActions) return;
    let mounted = true;
    let chatActions: ChatActions | undefined;
    setError("");
    setActions(null);
    setSelectedThreadKey(null);

    const run = async () => {
      try {
        const fs = projectActions.fs();
        await fs.mkdir(path_split(navigatorPath).head, { recursive: true });
        if (!mounted) return;
        chatActions = initChat(project_id, navigatorPath, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
        if (!mounted) {
          removeChatWithInstance(navigatorPath, redux, project_id, {
            instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
          });
          return;
        }
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
      if (chatActions) {
        setActions((current) => (current === chatActions ? null : current));
        removeChatWithInstance(navigatorPath, redux, project_id, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
      }
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
    saveNavigatorSelectedThreadKey(selectedThreadKey ?? undefined);
  }, [selectedThreadKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onThreadRequested = (evt: Event) => {
      const threadKey =
        (evt as CustomEvent<{ threadKey?: string }>).detail?.threadKey?.trim() ||
        null;
      preferredThreadKeyRef.current = threadKey ?? undefined;
      if (!actions) {
        if (threadKey) {
          setSelectedThreadKey(threadKey);
        }
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

  const selectedAcpConfig = useMemo(() => {
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
  }, [actions, selectedRootMessage, selectedThreadKey]);

  const selectedThreadMetadata = useMemo(() => {
    if (!actions || !selectedThreadKey) return undefined;
    const threadId =
      typeof selectedRootMessage?.thread_id === "string"
        ? selectedRootMessage.thread_id
        : undefined;
    return actions.getThreadMetadata(selectedThreadKey, {
      threadId,
    });
  }, [actions, selectedRootMessage, selectedThreadKey]);

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
    const acpConfig = selectedThreadMetadata?.acp_config ?? selectedRootMessage?.acp_config;
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

  const submitIntent = useCallback(
    (intent: NavigatorSubmitPromptDetail): boolean => {
      if (!actions) return false;
      const basePrompt = `${intent?.prompt ?? ""}`.trim();
      if (!basePrompt) {
        removeQueuedNavigatorPromptIntent(intent.id);
        return true;
      }
      const input = intent.forceCodex === false ? basePrompt : ensureCodexMention(basePrompt);
      const replyTo = toReplyDate(selectedThreadKey);
      const isCodex = intent.forceCodex !== false;
      const model =
        typeof selectedAcpConfig?.model === "string"
          ? selectedAcpConfig.model
          : undefined;
      const timeStamp = actions.sendChat({
        input,
        reply_to: replyTo,
        tag: intent.tag ?? "intent:navigator",
        noNotification: true,
        threadAgent:
          !replyTo && isCodex
            ? {
                mode: "codex",
                model,
                codexConfig: {
                  ...selectedAcpConfig,
                  model,
                  workingDirectory: homeDirectory,
                },
              }
            : undefined,
      });
      removeQueuedNavigatorPromptIntent(intent.id);
      if (!replyTo && timeStamp) {
        const threadTime = new Date(timeStamp).valueOf();
        if (Number.isFinite(threadTime)) {
          setSelectedThreadKey(`${threadTime}`);
        }
      }
      setTimeout(() => actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER), 100);
      return true;
    },
    [actions, homeDirectory, selectedAcpConfig, selectedThreadKey],
  );

  useEffect(() => {
    if (!actions) return;
    const queued = takeQueuedNavigatorPromptIntents();
    for (const intent of queued) {
      try {
        const consumed = submitIntent(intent);
        if (!consumed) {
          queueNavigatorPromptIntent(intent);
          break;
        }
      } catch (err) {
        queueNavigatorPromptIntent(intent);
        setError(`${err}`);
      }
    }
  }, [actions, submitIntent]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPromptIntent = (evt: Event) => {
      const detail = (evt as CustomEvent<NavigatorSubmitPromptDetail>).detail;
      if (!detail?.id) return;
      if (!actions) return;
      try {
        submitIntent(detail);
      } catch (err) {
        setError(`${err}`);
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
        icon: settingsIcon,
        image: settingsImage,
      });
      if (!ok) {
        antdMessage.error("Unable to save thread settings.");
        return;
      }
      antdMessage.success("Thread settings saved.");
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
    setSelectedThreadKey("");
    actions?.setSelectedThread?.(null);
  }

  function clearCurrentThread(): void {
    if (!actions || !selectedThreadKey) return;
    const deleted = actions.deleteThread(selectedThreadKey);
    if (deleted <= 0) return;
    const next = chooseThreadKey(actions);
    setSelectedThreadKey(next);
    actions.setSelectedThread?.(next);
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
        label: "Thread Settings...",
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

  const onActionMenuClick = useCallback<
    NonNullable<MenuProps["onClick"]>
  >(
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
          content: "This deletes all messages in the selected thread.",
          okText: "Clear",
          okType: "danger",
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
    [archiveCurrentSession, clearCurrentThread, openChatFile, openThreadSettings, startNewThread],
  );

  if (!navigatorPath) {
    return <Loading theme="medium" />;
  }

  if (!projectActions) {
    return <Loading theme="medium" />;
  }

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
        </Space>
        <Space size={[4, 4]} wrap>
          <Dropdown
            trigger={["click"]}
            menu={{ items: actionItems, onClick: onActionMenuClick }}
          >
            <Button size="small">Actions</Button>
          </Dropdown>
        </Space>
      </Space>
      <Modal
        title="Thread Settings"
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        onOk={() => void saveThreadSettings()}
        okText="Save"
        confirmLoading={settingsSaving}
        destroyOnHidden
      >
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ThreadBadge
              icon={settingsIcon}
              color={settingsColor}
              image={settingsImage}
              size={28}
              fallbackIcon="comment"
            />
            <Typography.Text type="secondary">
              Customize this navigator thread appearance.
            </Typography.Text>
          </div>
          <div>
            <div style={{ marginBottom: 4, color: "#666" }}>Title</div>
            <Input
              value={settingsName}
              onChange={(e) => setSettingsName(e.target.value)}
              placeholder="Thread title"
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: "#666" }}>Icon</div>
            <ChatIconPicker
              value={settingsIcon}
              onChange={setSettingsIcon}
              modalTitle="Select Thread Icon"
              placeholder="Select an icon"
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ color: "#666" }}>Color</div>
            <ColorButton
              title="Select Thread Color"
              onChange={setSettingsColor}
            />
            {settingsColor ? (
              <Tag
                color={settingsColor}
                style={{ margin: 0, color: "#111", border: "1px solid #ddd" }}
              >
                {settingsColor}
              </Tag>
            ) : null}
            <Button size="small" onClick={() => setSettingsColor(undefined)}>
              Clear
            </Button>
          </div>
          <div>
            <div style={{ marginBottom: 4, color: "#666" }}>Image</div>
            <ThreadImageUpload
              projectId={project_id}
              value={settingsImage}
              onChange={setSettingsImage}
              modalTitle="Select Thread Image"
              uploadText="Click or drag image"
            />
          </div>
        </div>
      </Modal>
      {error ? (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 8 }} />
      ) : null}
      <div
        style={{
          border: "1px solid #eee",
          borderRadius: 8,
          overflow: "hidden",
          background: "white",
          height: "min(70vh, 760px)",
        }}
      >
        {actions ? (
          <FileContext.Provider value={chatFileContext}>
            <SideChat
              actions={actions}
              project_id={project_id}
              path={navigatorPath}
              hideSidebar
              desc={desc}
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
