import {
  Alert,
  Button,
  Select,
  Space,
  Tooltip,
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
import { redux, useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
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
import { Loading } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import {
  AGENT_DOCK_CLOSE_EVENT,
  AGENT_DOCK_OPEN_EVENT,
  type AgentDockCloseDetail,
  type AgentDockOpenDetail,
} from "./agent-dock-state";
import { useAgentChatFontSize } from "./agent-chat-font-size";

const AGENT_DOCK_CHAT_INSTANCE_KEY = "project-agent-dock";
const DEFAULT_POSITION = { x: 24, y: 84 };
const DEFAULT_DOCK_SIZE = { width: 560, height: 520 };
const MIN_DOCK_WIDTH = 380;
const MIN_DOCK_HEIGHT = 320;
const DOCK_SESSION_LABEL_MAX = 42;

interface AgentDockProps {
  project_id: string;
  is_active: boolean;
}

function ellipsizeLabel(value: string, max = DOCK_SESSION_LABEL_MAX): string {
  const text = `${value ?? ""}`.trim();
  if (!text) return "Agent session";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}...`;
}

export function AgentDock({ project_id, is_active }: AgentDockProps) {
  const projectActions = useActions({ project_id }) as ProjectActions;
  const accountFontSize = useTypedRedux("account", "font_size") ?? 13;
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
  const {
    fontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncreaseFontSize,
    canDecreaseFontSize,
  } = useAgentChatFontSize(accountFontSize);

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
    const chatPath = session?.chat_path;
    if (!chatPath) {
      setChatActions(null);
      setError("");
      return;
    }
    let mounted = true;
    let actions: ChatActions | undefined;
    let ownsChatInstance = false;
    setError("");
    try {
      const existingDockActions = getChatActions(project_id, chatPath, {
        instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
      });
      if (existingDockActions) {
        setChatActions(existingDockActions);
        return () => {
          mounted = false;
        };
      }
      setChatActions(null);
      actions = initChat(project_id, chatPath, {
        instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
      });
      ownsChatInstance = true;
      if (!mounted) {
        if (ownsChatInstance) {
          removeChatWithInstance(chatPath, redux, project_id, {
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
        removeChatWithInstance(chatPath, redux, project_id, {
          instanceKey: AGENT_DOCK_CHAT_INSTANCE_KEY,
        });
      }
    };
  }, [project_id, session?.chat_path]);

  useEffect(() => {
    if (!chatActions || !session?.thread_key) return;
    chatActions.setSelectedThread?.(session.thread_key);
    const timer = setTimeout(() => {
      chatActions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
    }, 0);
    return () => clearTimeout(timer);
  }, [chatActions, session?.thread_key]);

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
      "data-showThreadImagePreview": false,
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
      label: `${ellipsizeLabel(record.title || "Agent session")} (workspace root)`,
    }));
  }, [sessions]);

  if (!session || !is_active) return null;

  const width = IS_MOBILE ? Math.max(MIN_DOCK_WIDTH, viewport.width - 24) : dockSize.width;
  const height = IS_MOBILE
    ? Math.max(MIN_DOCK_HEIGHT, Math.round(viewport.height * 0.72))
    : dockSize.height;

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
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "nowrap",
              }}
            >
              <Select
                size="small"
                style={{ flex: "1 1 auto", minWidth: 0 }}
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
              <Space
                size={[4, 4]}
                wrap={false}
                style={{ flexShrink: 0, whiteSpace: "nowrap" }}
              >
                <Tooltip title="Decrease chat font size">
                  <Button
                    size="small"
                    type="text"
                    disabled={!canDecreaseFontSize}
                    onClick={decreaseFontSize}
                  >
                    <Icon name="minus" />
                  </Button>
                </Tooltip>
                <Tooltip title={`Agent chat font size: ${fontSize}px`}>
                  <span style={{ minWidth: 24, textAlign: "center", fontSize: 12 }}>
                    {fontSize}
                  </span>
                </Tooltip>
                <Tooltip title="Increase chat font size">
                  <Button
                    size="small"
                    type="text"
                    disabled={!canIncreaseFontSize}
                    onClick={increaseFontSize}
                  >
                    <Icon name="plus" />
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  type="link"
                  style={{ paddingLeft: 0, whiteSpace: "nowrap" }}
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
            </div>
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
                  fontSize={fontSize}
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
