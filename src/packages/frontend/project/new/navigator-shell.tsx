import { Alert, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
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
