import { Alert, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { Loading } from "@cocalc/frontend/components";
import { lite } from "@cocalc/frontend/lite";
import { initChat, remove as removeChat } from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";

interface NavigatorShellProps {
  project_id: string;
  defaultTargetProjectId?: string;
}

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function navigatorChatPath(accountId?: string): string {
  if (lite) {
    return ".local/share/cocalc/navigator.chat";
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

export function NavigatorShell({
  project_id,
  defaultTargetProjectId,
}: NavigatorShellProps) {
  void defaultTargetProjectId;

  const account_id = useTypedRedux("account", "account_id");
  const [actions, setActions] = useState<ChatActions | null>(null);
  const [error, setError] = useState<string>("");
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);

  const navigatorPath = useMemo(() => {
    if (!lite && typeof account_id !== "string") {
      return "";
    }
    return navigatorChatPath(account_id);
  }, [account_id]);

  useEffect(() => {
    if (!navigatorPath) return;
    setError("");
    let chatActions: ChatActions;
    try {
      chatActions = initChat(project_id, navigatorPath);
    } catch (err) {
      setActions(null);
      setError(`${err}`);
      return;
    }
    setActions(chatActions);
    setSelectedThreadKey(null);
    return () => {
      setActions((current) => (current === chatActions ? null : current));
      removeChat(navigatorPath, redux, project_id);
    };
  }, [project_id, navigatorPath]);

  useEffect(() => {
    if (!actions?.messageCache) return;
    const onVersion = () => {
      setSelectedThreadKey((current) => current ?? latestThreadKey(actions));
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

  const desc = useMemo(() => {
    if (!selectedThreadKey) return undefined;
    return { "data-selectedThreadKey": selectedThreadKey };
  }, [selectedThreadKey]);

  if (!navigatorPath) {
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
