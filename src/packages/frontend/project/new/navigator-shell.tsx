import { Alert, Button, Popconfirm, Space, Tag, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import {
  upsertAgentSessionRecord,
  type AgentSessionRecord,
  type AgentSessionStatus,
} from "@cocalc/frontend/chat/agent-session-index";
import { Loading } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { initChat, remove as removeChat } from "@cocalc/frontend/chat/register";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
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
  status,
}: {
  project_id: string;
  account_id: string;
  navigatorPath: string;
  threadKey: string;
  thread: any;
  status: AgentSessionStatus;
}): AgentSessionRecord {
  const rootMessage: any = thread?.rootMessage ?? {};
  const acpConfig: any = rootMessage?.acp_config ?? {};
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
    title: summarizeTitle(rootMessage),
    created_at: createdAt,
    updated_at: updatedAt,
    status,
    entrypoint: "global",
    working_directory:
      typeof acpConfig?.workingDirectory === "string"
        ? acpConfig.workingDirectory
        : undefined,
    mode:
      acpConfig?.sessionMode === "read-only" ||
      acpConfig?.sessionMode === "workspace-write" ||
      acpConfig?.sessionMode === "full-access"
        ? acpConfig.sessionMode
        : undefined,
    model: typeof acpConfig?.model === "string" ? acpConfig.model : undefined,
    reasoning:
      typeof acpConfig?.reasoning === "string" ? acpConfig.reasoning : undefined,
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
        chatActions = initChat(project_id, navigatorPath);
        if (!mounted) {
          removeChat(navigatorPath, redux, project_id);
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
        removeChat(navigatorPath, redux, project_id);
      }
    };
  }, [projectActions, project_id, navigatorPath]);

  useEffect(() => {
    if (!actions?.messageCache) return;
    const onVersion = () => {
      const preferred = preferredThreadKeyRef.current;
      setSelectedThreadKey((current) => {
        if (current === "") {
          return current;
        }
        const index = actions.messageCache?.getThreadIndex();
        if (current && index?.has(current)) {
          return current;
        }
        return chooseThreadKey(actions, preferred);
      });
      preferredThreadKeyRef.current = undefined;
      setCacheVersion((v) => v + 1);
    };
    actions.messageCache.on("version", onVersion);
    onVersion();
    return () => {
      actions.messageCache?.removeListener("version", onVersion);
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
    return selectedRootMessage?.acp_config ?? {};
  }, [selectedRootMessage]);

  const selectedSessionRecord = useMemo(() => {
    if (!selectedThreadKey || !selectedThread || typeof account_id !== "string") {
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
      status,
    });
  }, [
    account_id,
    navigatorPath,
    project_id,
    selectedRootMessage,
    selectedThread,
    selectedThreadKey,
  ]);

  useEffect(() => {
    if (!selectedSessionRecord) return;
    const serialized = JSON.stringify(selectedSessionRecord);
    if (lastIndexedValueRef.current === serialized) return;
    lastIndexedValueRef.current = serialized;
    void upsertAgentSessionRecord(selectedSessionRecord).catch((err) => {
      console.warn("unable to update agent session index", err);
    });
  }, [selectedSessionRecord]);

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
      const timeStamp = actions.sendChat({
        input,
        reply_to: replyTo,
        tag: intent.tag ?? "intent:navigator",
        noNotification: true,
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
    [actions, selectedThreadKey],
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
    };
    if (selectedThreadKey !== null) {
      data["data-selectedThreadKey"] = selectedThreadKey;
    }
    return data;
  }, [selectedThreadKey]);

  const threadTitle = useMemo(() => {
    if (!selectedThreadKey) return "New chat";
    return summarizeTitle(selectedRootMessage);
  }, [selectedRootMessage, selectedThreadKey]);

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

  if (!navigatorPath) {
    return <Loading theme="medium" />;
  }

  if (!projectActions) {
    return <Loading theme="medium" />;
  }

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Global navigator shell using the same chat/Codex runtime, backed by a
        hidden chat file.
      </Typography.Paragraph>
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
          {selectedAcpConfig?.model ? <Tag>{selectedAcpConfig.model}</Tag> : null}
          {selectedAcpConfig?.reasoning ? (
            <Tag color="purple">{selectedAcpConfig.reasoning}</Tag>
          ) : null}
          {selectedAcpConfig?.sessionMode ? (
            <Tag color="blue">{selectedAcpConfig.sessionMode}</Tag>
          ) : null}
          {selectedAcpConfig?.workingDirectory ? (
            <Tooltip title={selectedAcpConfig.workingDirectory}>
              <Tag color="geekblue">wd</Tag>
            </Tooltip>
          ) : null}
        </Space>
        <Space size={[4, 4]} wrap>
          <Button size="small" onClick={startNewThread}>
            New
          </Button>
          <Popconfirm
            title="Clear the current thread?"
            description="This deletes all messages in the selected thread."
            okText="Clear"
            okType="danger"
            cancelText="Cancel"
            onConfirm={clearCurrentThread}
            disabled={!selectedThreadKey}
          >
            <Button size="small" disabled={!selectedThreadKey}>
              Clear
            </Button>
          </Popconfirm>
          <Button
            size="small"
            disabled={!selectedSessionRecord}
            loading={isArchiving}
            onClick={() => void archiveCurrentSession()}
          >
            Archive
          </Button>
          <Button size="small" onClick={openChatFile}>
            Open Chat File
          </Button>
        </Space>
      </Space>
      {selectedAcpConfig?.workingDirectory ? (
        <Typography.Text
          type="secondary"
          style={{ display: "block", marginBottom: 8 }}
          ellipsis={{ tooltip: selectedAcpConfig.workingDirectory }}
        >
          Working directory: {selectedAcpConfig.workingDirectory}
        </Typography.Text>
      ) : null}
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
          <SideChat
            actions={actions}
            project_id={project_id}
            path={navigatorPath}
            hideSidebar
            desc={desc}
          />
        ) : (
          <Loading theme="medium" />
        )}
      </div>
    </div>
  );
}

export default NavigatorShell;
