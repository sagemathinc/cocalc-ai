import { Alert, Button, Space, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import Draggable from "react-draggable";
import {
  redux,
  useActions,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import {
  initChat,
  removeWithInstance as removeChatWithInstance,
} from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { Loading } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import {
  AGENT_DOCK_CLOSE_EVENT,
  AGENT_DOCK_OPEN_EVENT,
  type AgentDockCloseDetail,
  type AgentDockOpenDetail,
} from "./agent-dock-state";

const AGENT_DOCK_CHAT_INSTANCE_KEY = "project-agent-dock";
const DEFAULT_POSITION = { x: 24, y: 84 };

function ellipsize(value: string, max = 72): string {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

interface AgentDockProps {
  project_id: string;
  is_active: boolean;
}

export function AgentDock({ project_id, is_active }: AgentDockProps) {
  const projectActions = useActions({ project_id }) as ProjectActions;
  const [session, setSession] = useState<AgentSessionRecord | null>(null);
  const [chatActions, setChatActions] = useState<ChatActions | null>(null);
  const [error, setError] = useState<string>("");
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (is_active) return;
    setSession(null);
    setChatActions(null);
    setError("");
  }, [is_active]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = (evt: Event) => {
      const detail = (evt as CustomEvent<AgentDockOpenDetail>).detail;
      if (!detail || detail.projectId !== project_id) return;
      setSession(detail.session);
      setError("");
    };
    const onClose = (evt: Event) => {
      const detail = (evt as CustomEvent<AgentDockCloseDetail>).detail;
      if (!detail || detail.projectId !== project_id) return;
      setSession(null);
      setError("");
    };
    window.addEventListener(AGENT_DOCK_OPEN_EVENT, onOpen as EventListener);
    window.addEventListener(AGENT_DOCK_CLOSE_EVENT, onClose as EventListener);
    return () => {
      window.removeEventListener(AGENT_DOCK_OPEN_EVENT, onOpen as EventListener);
      window.removeEventListener(AGENT_DOCK_CLOSE_EVENT, onClose as EventListener);
    };
  }, [project_id]);

  useEffect(() => {
    if (!session) {
      setChatActions(null);
      setError("");
      return;
    }
    let mounted = true;
    let actions: ChatActions | undefined;
    setChatActions(null);
    setError("");
    try {
      actions = initChat(project_id, session.chat_path, {
        instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
      });
      if (!mounted) {
        removeChatWithInstance(session.chat_path, redux, project_id, {
          instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
        });
        return;
      }
      setChatActions(actions);
    } catch (err) {
      if (!mounted) return;
      setError(`${err}`);
      setChatActions(null);
    }
    return () => {
      mounted = false;
      if (actions) {
        setChatActions((current) => (current === actions ? null : current));
        removeChatWithInstance(session.chat_path, redux, project_id, {
          instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
        });
      }
    };
  }, [project_id, session]);

  useEffect(() => {
    if (!chatActions || !session?.thread_key) return;
    chatActions.setSelectedThread?.(session.thread_key);
    const timer = setTimeout(() => {
      chatActions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [chatActions, session]);

  const desc = useMemo(() => {
    if (!session?.thread_key) return undefined;
    return {
      "data-selectedThreadKey": session.thread_key,
      "data-preferLatestThread": false,
    };
  }, [session?.thread_key]);

  if (!session || !is_active) return null;

  const width = IS_MOBILE ? "calc(100vw - 24px)" : 560;
  const height = IS_MOBILE ? "72vh" : 520;
  const image = session.thread_image?.trim() || undefined;
  const icon = session.thread_icon?.trim() || undefined;
  const color = session.thread_color?.trim() || undefined;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
      }}
    >
      <Draggable
        bounds="parent"
        handle=".cc-agent-dock-handle"
        nodeRef={nodeRef}
        position={position}
        onStop={(_, data) => setPosition({ x: data.x, y: data.y })}
      >
        <div
          ref={nodeRef}
          style={{
            position: "absolute",
            width,
            maxWidth: "calc(100vw - 24px)",
            height,
            minHeight: 320,
            borderRadius: 10,
            border: "1px solid #d9d9d9",
            background: "white",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            pointerEvents: "auto",
          }}
        >
          <div
            className="cc-agent-dock-handle"
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid #f0f0f0",
              background: "#fafafa",
              cursor: "move",
            }}
          >
            <Space
              wrap
              size={[6, 6]}
              style={{ width: "100%", justifyContent: "space-between" }}
            >
              <Space size={[6, 6]} wrap style={{ minWidth: 0 }}>
                <ThreadBadge
                  image={image}
                  icon={icon}
                  color={color}
                  fallbackIcon="comment"
                  size={24}
                />
                <Tooltip title={session.title || "Agent session"}>
                  <Typography.Text strong>
                    {ellipsize(session.title || "Agent session", 56)}
                  </Typography.Text>
                </Tooltip>
                {session.model ? (
                  <Tag>{ellipsize(session.model, 24)}</Tag>
                ) : null}
              </Space>
              <Space size={[4, 4]} wrap>
                <Button
                  size="small"
                  type="link"
                  style={{ paddingLeft: 0 }}
                  onClick={() =>
                    projectActions?.open_file({
                      path: session.chat_path,
                      foreground: true,
                    })
                  }
                >
                  Open Chat File
                </Button>
                <Button
                  size="small"
                  type="text"
                  onClick={() => setSession(null)}
                >
                  <Icon name="times" />
                </Button>
              </Space>
            </Space>
          </div>
          {error ? (
            <Alert type="error" showIcon message={error} style={{ margin: 8 }} />
          ) : null}
          <div style={{ flex: 1, minHeight: 0 }}>
            {chatActions ? (
              <SideChat
                actions={chatActions}
                project_id={project_id}
                path={session.chat_path}
                hideSidebar
                desc={desc}
              />
            ) : (
              <Loading theme="medium" />
            )}
          </div>
        </div>
      </Draggable>
    </div>
  );
}

export default AgentDock;
