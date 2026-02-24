import {
  Alert,
  Button,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Draggable from "react-draggable";
import { redux, useActions } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import {
  watchAgentSessionsForProject,
} from "@cocalc/frontend/chat/agent-session-index";
import {
  getChatActions,
  initChat,
  removeWithInstance as removeChatWithInstance,
} from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { ThreadBadge } from "@cocalc/frontend/chat/thread-badge";
import { Loading } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import { NAVIGATOR_CHAT_INSTANCE_KEY } from "@cocalc/frontend/project/new/navigator-shell";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import {
  AGENT_DOCK_CLOSE_EVENT,
  AGENT_DOCK_OPEN_EVENT,
  type AgentDockCloseDetail,
  type AgentDockOpenDetail,
} from "./agent-dock-state";

const AGENT_DOCK_CHAT_INSTANCE_KEY = "project-agent-dock";
const DEFAULT_POSITION = { x: 24, y: 84 };
const DEFAULT_DOCK_SIZE = { width: 560, height: 520 };
const MIN_DOCK_WIDTH = 380;
const MIN_DOCK_HEIGHT = 320;

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
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [session, setSession] = useState<AgentSessionRecord | null>(null);
  const [chatActions, setChatActions] = useState<ChatActions | null>(null);
  const [error, setError] = useState<string>("");
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const [dockSize, setDockSize] = useState(DEFAULT_DOCK_SIZE);
  const [isResizing, setIsResizing] = useState(false);
  const [viewport, setViewport] = useState(() => {
    if (typeof window === "undefined") {
      return { width: 1200, height: 900 };
    }
    return { width: window.innerWidth, height: window.innerHeight };
  });
  const nodeRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    if (is_active) return;
    setSession(null);
    setChatActions(null);
    setError("");
  }, [is_active]);

  useEffect(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    void watchAgentSessionsForProject({ project_id }, (records) => {
      if (closed) return;
      setSessions(records);
    })
      .then((cleanup) => {
        if (closed) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
      })
      .catch(() => {});
    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [project_id]);

  useEffect(() => {
    if (!session) return;
    const updated = sessions.find((item) => item.session_id === session.session_id);
    if (updated) {
      setSession(updated);
    }
  }, [sessions, session]);

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
    let ownsChatInstance = false;
    setChatActions(null);
    setError("");
    try {
      const sharedActions =
        (redux.getEditorActions(
          project_id,
          session.chat_path,
        ) as ChatActions | undefined) ??
        getChatActions(project_id, session.chat_path, {
          instanceKey: NAVIGATOR_CHAT_INSTANCE_KEY,
        });
      if (sharedActions) {
        setChatActions(sharedActions);
        return () => {
          mounted = false;
        };
      }
      actions = initChat(project_id, session.chat_path, {
        instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
      });
      ownsChatInstance = true;
      if (!mounted) {
        if (ownsChatInstance) {
          removeChatWithInstance(session.chat_path, redux, project_id, {
            instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
          });
        }
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
      if (actions && ownsChatInstance) {
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

  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (evt: MouseEvent) => {
      const resizeState = resizeRef.current;
      if (!resizeState) return;
      const maxWidth = Math.max(MIN_DOCK_WIDTH, window.innerWidth - 24);
      const maxHeight = Math.max(MIN_DOCK_HEIGHT, window.innerHeight - 48);
      const width = Math.max(
        MIN_DOCK_WIDTH,
        Math.min(maxWidth, resizeState.startWidth + (evt.clientX - resizeState.startX)),
      );
      const height = Math.max(
        MIN_DOCK_HEIGHT,
        Math.min(maxHeight, resizeState.startHeight + (evt.clientY - resizeState.startY)),
      );
      setDockSize({
        width: Math.round(width),
        height: Math.round(height),
      });
    };
    const onMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const startResize = useCallback(
    (evt: ReactMouseEvent<HTMLDivElement>) => {
      if (IS_MOBILE) return;
      evt.preventDefault();
      evt.stopPropagation();
      resizeRef.current = {
        startX: evt.clientX,
        startY: evt.clientY,
        startWidth: dockSize.width,
        startHeight: dockSize.height,
      };
      setIsResizing(true);
    },
    [dockSize.height, dockSize.width],
  );

  const desc = useMemo(() => {
    if (!session?.thread_key) return undefined;
    return {
      "data-selectedThreadKey": session.thread_key,
      "data-preferLatestThread": false,
    };
  }, [session?.thread_key]);

  const fileContext = useMemo(() => {
    if (!session?.chat_path) return undefined;
    return {
      project_id,
      path: session.chat_path,
      urlTransform: getUrlTransform({
        project_id,
        path: session.chat_path,
      }),
      AnchorTagComponent: getAnchorTagComponent({
        project_id,
        path: session.chat_path,
      }),
    };
  }, [project_id, session?.chat_path]);

  const sessionOptions = useMemo(() => {
    return sessions.map((record) => ({
      value: record.session_id,
      label: `${record.title || "Agent session"}${
        record.model ? ` (${record.model})` : ""
      }`,
    }));
  }, [sessions]);

  if (!session || !is_active) return null;

  const width = IS_MOBILE ? Math.max(MIN_DOCK_WIDTH, viewport.width - 24) : dockSize.width;
  const height = IS_MOBILE
    ? Math.max(MIN_DOCK_HEIGHT, Math.round(viewport.height * 0.72))
    : dockSize.height;
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
            minHeight: MIN_DOCK_HEIGHT,
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
                    {ellipsize(session.title || "Agent session", 44)}
                  </Typography.Text>
                </Tooltip>
                {session.model ? <Tag>{ellipsize(session.model, 24)}</Tag> : null}
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
                <Button size="small" type="text" onClick={() => setSession(null)}>
                  <Icon name="times" />
                </Button>
              </Space>
            </Space>
            {sessionOptions.length > 1 ? (
              <div style={{ marginTop: 6 }}>
                <Select
                  size="small"
                  style={{ width: "100%" }}
                  value={session.session_id}
                  options={sessionOptions}
                  showSearch
                  optionFilterProp="label"
                  onChange={(value) => {
                    const next = sessions.find((item) => item.session_id === value);
                    if (next) {
                      setSession(next);
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
          {error ? (
            <Alert type="error" showIcon message={error} style={{ margin: 8 }} />
          ) : null}
          <div style={{ flex: 1, minHeight: 0 }}>
            {chatActions ? (
              <FileContext.Provider value={fileContext ?? {}}>
                <SideChat
                  actions={chatActions}
                  project_id={project_id}
                  path={session.chat_path}
                  hideSidebar
                  desc={desc}
                />
              </FileContext.Provider>
            ) : (
              <Loading theme="medium" />
            )}
          </div>
          {!IS_MOBILE ? (
            <div
              onMouseDown={startResize}
              style={{
                position: "absolute",
                right: 0,
                bottom: 0,
                width: 18,
                height: 18,
                cursor: "nwse-resize",
                background:
                  "linear-gradient(135deg, transparent 48%, #bbb 48%, #bbb 52%, transparent 52%)",
              }}
            />
          ) : null}
        </div>
      </Draggable>
    </div>
  );
}

export default AgentDock;
