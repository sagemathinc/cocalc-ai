import { Alert, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { upsertAgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { Loading } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { initChat, remove as removeChat } from "@cocalc/frontend/chat/register";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { path_split } from "@cocalc/util/misc";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

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
  const lastIndexedValueRef = useRef<string>("");

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
      setSelectedThreadKey((current) => current ?? latestThreadKey(actions));
      setCacheVersion((v) => v + 1);
    };
    actions.messageCache.on("version", onVersion);
    onVersion();
    return () => {
      actions.messageCache?.removeListener("version", onVersion);
    };
  }, [actions]);

  useEffect(() => {
    if (!actions || !selectedThreadKey) return;
    const timer = setTimeout(() => {
      actions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [actions, selectedThreadKey]);

  useEffect(() => {
    if (!actions || !selectedThreadKey || typeof account_id !== "string") return;
    const thread = actions.messageCache?.getThreadIndex().get(selectedThreadKey);
    if (!thread) return;
    const rootMessage: any = thread.rootMessage ?? {};
    const acpConfig: any = rootMessage?.acp_config ?? {};
    const sessionIdRaw =
      typeof acpConfig?.sessionId === "string" && acpConfig.sessionId.trim()
        ? acpConfig.sessionId.trim()
        : selectedThreadKey;
    const createdAt =
      parseDateISOString(rootMessage?.date) ??
      parseDateISOString(thread.newestTime) ??
      new Date().toISOString();
    const updatedAt =
      parseDateISOString(thread.newestTime) ??
      parseDateISOString(rootMessage?.date) ??
      new Date().toISOString();
    const status = (rootMessage?.generating ? "running" : "active") as
      | "running"
      | "active";
    const nextRecord = {
      session_id: sessionIdRaw,
      project_id,
      account_id,
      chat_path: navigatorPath,
      thread_key: selectedThreadKey,
      title: summarizeTitle(rootMessage),
      created_at: createdAt,
      updated_at: updatedAt,
      status,
      entrypoint: "global" as const,
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
      model:
        typeof acpConfig?.model === "string" ? acpConfig.model : undefined,
      reasoning:
        typeof acpConfig?.reasoning === "string" ? acpConfig.reasoning : undefined,
    };
    const serialized = JSON.stringify(nextRecord);
    if (lastIndexedValueRef.current === serialized) return;
    lastIndexedValueRef.current = serialized;
    void upsertAgentSessionRecord(nextRecord).catch((err) => {
      console.warn("unable to update agent session index", err);
    });
  }, [
    actions,
    account_id,
    project_id,
    navigatorPath,
    selectedThreadKey,
    cacheVersion,
  ]);

  const desc = useMemo(() => {
    if (!selectedThreadKey) return undefined;
    return { "data-selectedThreadKey": selectedThreadKey };
  }, [selectedThreadKey]);

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
