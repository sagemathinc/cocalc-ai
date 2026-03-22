import { Alert, Button, Select, Space, Switch, Tooltip } from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Draggable from "react-draggable";
import {
  redux,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { watchAgentSessionsForProject } from "@cocalc/frontend/chat/agent-session-index";
import type { ChatInputControl } from "@cocalc/frontend/chat/input";
import {
  getChatActions,
  initChat,
  removeWithInstance as removeChatWithInstance,
} from "@cocalc/frontend/chat/register";
import SideChat from "@cocalc/frontend/chat/side-chat";
import { refocusChatComposerInput } from "@cocalc/frontend/chat/composer-focus";
import { Loading } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { useKeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { FileContext } from "@cocalc/frontend/lib/file-context";
import {
  queueNavigatorPromptIntent,
  removeQueuedNavigatorPromptIntent,
  resolveThreadIdFromIndex,
  takeQueuedNavigatorPromptIntents,
  type NavigatorSubmitPromptDetail,
} from "@cocalc/frontend/project/new/navigator-intents";
import { saveNavigatorSelectedThreadKey } from "@cocalc/frontend/project/new/navigator-state";
import { useProjectContext } from "@cocalc/frontend/project/context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import type { ProjectActions } from "@cocalc/frontend/project_actions";
import { loadSessionWorkspaceRecord } from "@cocalc/frontend/project/workspaces/selection-runtime";
import {
  AGENT_DOCK_CLOSE_EVENT,
  AGENT_DOCK_OPEN_EVENT,
  type AgentDockCloseDetail,
  type AgentDockOpenDetail,
} from "./agent-dock-state";
import { useAgentChatFontSize } from "./agent-chat-font-size";
import { COLORS } from "@cocalc/util/theme";

const AGENT_DOCK_CHAT_INSTANCE_KEY = "project-agent-dock";
const DEFAULT_POSITION = { x: 24, y: 84 };
const DEFAULT_DOCK_SIZE = { width: 560, height: 520 };
const MIN_DOCK_WIDTH = 380;
const MIN_DOCK_HEIGHT = 320;
const DOCK_SESSION_LABEL_MAX = 42;
const DOCK_HEADER_HEIGHT = 92;
const DOCK_HEADER_BG = COLORS.GRAY_LLL;
const DOCK_BORDER_COLOR = COLORS.GRAY_L;
const DOCK_SUBTEXT_COLOR = COLORS.GRAY_D;
const DOCK_RESIZE_MARK_COLOR = COLORS.GRAY;

type DockResizeMode = "horizontal" | "vertical" | "both";

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

function dockOwnsOtherInputFocus(
  dockRoot: HTMLElement | null,
  composerRoot: ParentNode | null,
): boolean {
  if (typeof document === "undefined" || !dockRoot) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return false;
  if (!dockRoot.contains(active)) return false;
  if (composerRoot instanceof Node && composerRoot.contains(active))
    return false;
  return !!active.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"], .cm-editor',
  );
}

function getDockFocusedInput(dockRoot: HTMLElement | null): HTMLElement | null {
  if (typeof document === "undefined" || !dockRoot) return null;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return null;
  if (!dockRoot.contains(active)) return null;
  if (
    active.matches(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    )
  ) {
    return active;
  }
  return active.closest(".cm-editor");
}

export function AgentDock({ project_id, is_active }: AgentDockProps) {
  const { workspaces } = useProjectContext();
  const projectActions = useActions({ project_id }) as ProjectActions;
  const accountFontSize = useTypedRedux("account", "font_size") ?? 13;
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [session, setSession] = useState<AgentSessionRecord | null>(null);
  const [workspaceScopeId, setWorkspaceScopeId] = useState<string | null>(null);
  const [workspaceOnly, setWorkspaceOnly] = useState(false);
  const [chatActions, setChatActions] = useState<ChatActions | null>(null);
  const [error, setError] = useState<string>("");
  const [intentRetryTick, setIntentRetryTick] = useState(0);
  const [dockOpenNonce, setDockOpenNonce] = useState(0);
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
    mode: DockResizeMode;
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
    setWorkspaceScopeId(null);
    setWorkspaceOnly(false);
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
    const updated =
      sessions.find((item) => item.session_id === session.session_id) ??
      (() => {
        const chatPath = `${session.chat_path ?? ""}`.trim();
        const threadKey = `${session.thread_key ?? ""}`.trim();
        if (!chatPath || !threadKey) return undefined;
        return sessions.find(
          (item) =>
            `${item.chat_path ?? ""}`.trim() === chatPath &&
            `${item.thread_key ?? ""}`.trim() === threadKey,
        );
      })();
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
      setWorkspaceScopeId(detail.workspaceId ?? null);
      setWorkspaceOnly(detail.workspaceOnly === true);
      setDockOpenNonce((value) => value + 1);
      setError("");
    };
    const onClose = (evt: Event) => {
      const detail = (evt as CustomEvent<AgentDockCloseDetail>).detail;
      if (!detail || detail.projectId !== project_id) return;
      setSession(null);
      setWorkspaceScopeId(null);
      setWorkspaceOnly(false);
      setError("");
    };
    window.addEventListener(AGENT_DOCK_OPEN_EVENT, onOpen as EventListener);
    window.addEventListener(AGENT_DOCK_CLOSE_EVENT, onClose as EventListener);
    return () => {
      window.removeEventListener(
        AGENT_DOCK_OPEN_EVENT,
        onOpen as EventListener,
      );
      window.removeEventListener(
        AGENT_DOCK_CLOSE_EVENT,
        onClose as EventListener,
      );
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
    if (!session?.chat_path || !session?.thread_key) return;
    saveNavigatorSelectedThreadKey(session.thread_key, session.chat_path);
  }, [session?.chat_path, session?.thread_key]);

  useEffect(() => {
    if (!chatActions || !session) return;
    let done = false;
    const timers: number[] = [];
    const focusComposer = () => {
      if (done) return;
      done = refocusChatComposerInput(nodeRef.current);
    };
    for (const delayMs of [0, 50, 150, 300, 600]) {
      timers.push(window.setTimeout(focusComposer, delayMs));
    }
    let frame: number | undefined;
    if (typeof window.requestAnimationFrame === "function") {
      frame = window.requestAnimationFrame(focusComposer);
    }
    return () => {
      done = true;
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      if (frame != null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [chatActions, session?.session_id, session?.thread_key]);

  useEffect(() => {
    if (typeof window === "undefined" || !session) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const dockRoot = nodeRef.current;
      const target = event.target;
      if (!(target instanceof Node) || !dockRoot) return;
      if (dockRoot.contains(target)) return;
      const focused = getDockFocusedInput(dockRoot);
      focused?.blur?.();
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("touchstart", onPointerDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("touchstart", onPointerDown, true);
    };
  }, [session?.session_id]);

  const submitQueuedIntent = useCallback(
    (intent: NavigatorSubmitPromptDetail): boolean => {
      if (!chatActions || !session) return false;
      const input = `${intent?.prompt ?? ""}`.trim();
      if (!input) {
        removeQueuedNavigatorPromptIntent(intent.id);
        return true;
      }
      const threadKey = `${session.thread_key ?? ""}`.trim();
      const replyThreadId = resolveThreadIdFromIndex(chatActions, threadKey);
      const model =
        typeof session.model === "string" && session.model.trim().length > 0
          ? session.model.trim()
          : undefined;
      const timeStamp = chatActions.sendChat({
        input,
        reply_thread_id: replyThreadId,
        tag: intent.tag ?? "intent:navigator",
        noNotification: true,
        threadAgent:
          !replyThreadId && intent.forceCodex !== false
            ? {
                mode: "codex",
                model,
                codexConfig: {
                  model,
                  reasoning: session.reasoning as any,
                  sessionMode: session.mode as any,
                  workingDirectory: session.working_directory,
                },
              }
            : undefined,
      });
      if (!timeStamp) return false;
      removeQueuedNavigatorPromptIntent(intent.id);
      if (!replyThreadId && typeof timeStamp === "string") {
        const nextThreadKey = `${new Date(timeStamp).valueOf()}`;
        if (nextThreadKey) {
          setSession((current) =>
            current == null
              ? current
              : {
                  ...current,
                  thread_key: nextThreadKey,
                  updated_at: new Date().toISOString(),
                },
          );
        }
      }
      setTimeout(() => {
        chatActions.scrollToIndex?.(Number.MAX_SAFE_INTEGER);
      }, 100);
      return true;
    },
    [chatActions, session],
  );

  useEffect(() => {
    if (!chatActions || !session) return;
    let retryNeeded = false;
    const queued = takeQueuedNavigatorPromptIntents();
    for (const intent of queued) {
      try {
        const consumed = submitQueuedIntent(intent);
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
      setIntentRetryTick((value) => value + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [chatActions, intentRetryTick, session, submitQueuedIntent]);

  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (evt: MouseEvent) => {
      const resizeState = resizeRef.current;
      if (!resizeState) return;
      const maxWidth = Math.max(MIN_DOCK_WIDTH, window.innerWidth - 24);
      const maxHeight = Math.max(MIN_DOCK_HEIGHT, window.innerHeight - 48);
      const width =
        resizeState.mode === "vertical"
          ? resizeState.startWidth
          : Math.max(
              MIN_DOCK_WIDTH,
              Math.min(
                maxWidth,
                resizeState.startWidth + (evt.clientX - resizeState.startX),
              ),
            );
      const height =
        resizeState.mode === "horizontal"
          ? resizeState.startHeight
          : Math.max(
              MIN_DOCK_HEIGHT,
              Math.min(
                maxHeight,
                resizeState.startHeight + (evt.clientY - resizeState.startY),
              ),
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
    (mode: DockResizeMode) => (evt: ReactMouseEvent<HTMLDivElement>) => {
      if (IS_MOBILE) return;
      evt.preventDefault();
      evt.stopPropagation();
      resizeRef.current = {
        startX: evt.clientX,
        startY: evt.clientY,
        startWidth: dockSize.width,
        startHeight: dockSize.height,
        mode,
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

  const dockScrollCacheId = useMemo(() => {
    if (!session?.chat_path) return undefined;
    return [
      "agent-dock",
      project_id,
      session.chat_path,
      session.thread_key ?? "",
      dockOpenNonce,
    ].join(":");
  }, [dockOpenNonce, project_id, session?.chat_path, session?.thread_key]);

  const handleComposerReady = useCallback(
    (control: ChatInputControl | null, root: ParentNode | null): void => {
      if (!session) return;
      if (dockOwnsOtherInputFocus(nodeRef.current, root)) return;
      refocusChatComposerInput(root ?? nodeRef.current, control ?? undefined);
    },
    [session],
  );

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

  const scopedWorkspaceId = useMemo(() => {
    if (workspaceScopeId) return workspaceScopeId;
    if (!session?.chat_path) return null;
    return (
      workspaces.resolveWorkspaceForPath(session.chat_path)?.workspace_id ??
      null
    );
  }, [session?.chat_path, workspaceScopeId, workspaces]);

  const scopedWorkspace = useMemo(() => {
    if (!scopedWorkspaceId) return null;
    return (
      workspaces.records.find(
        (record) => record.workspace_id === scopedWorkspaceId,
      ) ??
      (() => {
        const cached = loadSessionWorkspaceRecord(project_id);
        if (cached?.workspace_id !== scopedWorkspaceId) return null;
        return cached;
      })()
    );
  }, [project_id, scopedWorkspaceId, workspaces.records]);

  const sessionOptions = useMemo(() => {
    const visibleSessions =
      workspaceOnly && scopedWorkspaceId
        ? sessions.filter(
            (record) =>
              workspaces.resolveWorkspaceForPath(record.chat_path)
                ?.workspace_id === scopedWorkspaceId,
          )
        : sessions;
    const options = visibleSessions.map((record) => ({
      value: record.session_id,
      label: ellipsizeLabel(record.title || "Agent session"),
    }));
    if (
      session?.session_id &&
      !options.some((option) => option.value === session.session_id)
    ) {
      options.unshift({
        value: session.session_id,
        label: ellipsizeLabel(session.title || "Agent session"),
      });
    }
    return options;
  }, [scopedWorkspaceId, session, sessions, workspaceOnly, workspaces]);

  const keyboardBoundaryProps = useKeyboardBoundary<HTMLDivElement>({
    boundary: "dock",
    stopMouseDownPropagation: true,
    stopClickPropagation: true,
  });

  if (!session || !is_active) return null;

  const width = IS_MOBILE
    ? Math.max(MIN_DOCK_WIDTH, viewport.width - 24)
    : dockSize.width;
  const height = IS_MOBILE
    ? Math.max(MIN_DOCK_HEIGHT, Math.round(viewport.height * 0.72))
    : dockSize.height;
  const workspaceColor =
    scopedWorkspace?.theme.color ??
    scopedWorkspace?.theme.accent_color ??
    COLORS.BLUE_D;
  const workspaceLabel = scopedWorkspace?.theme.title?.trim() || "Workspace";
  const sessionTitle = ellipsizeLabel(session.title || "Agent session", 54);

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
          data-selected-thread-key={session.thread_key ?? undefined}
          data-selected-thread-title={session.title ?? undefined}
          data-selected-session-id={session.session_id ?? undefined}
          style={{
            position: "absolute",
            width,
            maxWidth: "calc(100vw - 24px)",
            height,
            minHeight: MIN_DOCK_HEIGHT,
            borderRadius: 12,
            border: `1px solid ${DOCK_BORDER_COLOR}`,
            background: "white",
            boxShadow: "0 18px 48px rgba(0,0,0,0.22)",
            overflow: "visible",
            display: "flex",
            flexDirection: "column",
            pointerEvents: "auto",
          }}
          {...keyboardBoundaryProps}
        >
          <div
            className="cc-agent-dock-handle"
            style={{
              padding: "10px 12px 8px 12px",
              borderBottom: `1px solid ${COLORS.GRAY_LL}`,
              background: DOCK_HEADER_BG,
              cursor: "move",
              userSelect: "none",
            }}
          >
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flex: "1 1 auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    color: DOCK_SUBTEXT_COLOR,
                    flexShrink: 0,
                  }}
                >
                  <Icon name="bars" />
                </div>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: COLORS.GRAY_D,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    Floating Agent Chat
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 12,
                      color: DOCK_SUBTEXT_COLOR,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {sessionTitle}
                    {scopedWorkspace
                      ? ` • ${workspaceLabel}`
                      : " • Project-wide"}
                  </div>
                </div>
              </div>
              <Space size={4} wrap={false} style={{ flexShrink: 0 }}>
                <Tooltip title="Open chat file in the main project page">
                  <Button
                    size="small"
                    type="text"
                    icon={<Icon name="external-link" />}
                    onClick={() =>
                      projectActions?.open_file({
                        path: session.chat_path,
                        foreground: true,
                      })
                    }
                  />
                </Tooltip>
                <Tooltip title="Close floating chat">
                  <Button
                    size="small"
                    type="text"
                    icon={<Icon name="times" />}
                    onClick={() => setSession(null)}
                  />
                </Tooltip>
              </Space>
            </div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
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
                  const next = sessions.find(
                    (item) => item.session_id === value,
                  );
                  if (next) {
                    setSession(next);
                  }
                }}
              />
              <Space
                size={2}
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
                  <div
                    style={{
                      minWidth: 28,
                      textAlign: "center",
                      fontSize: 12,
                      color: DOCK_SUBTEXT_COLOR,
                    }}
                  >
                    {fontSize}px
                  </div>
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
              </Space>
            </div>
            {scopedWorkspace ? (
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontSize: 12,
                    color: workspaceColor,
                    fontWeight: 600,
                  }}
                >
                  Workspace scope: {workspaceLabel}
                </div>
                <Space size={6} align="center" style={{ flexShrink: 0 }}>
                  <div style={{ fontSize: 12, color: DOCK_SUBTEXT_COLOR }}>
                    Only this workspace
                  </div>
                  <Switch
                    size="small"
                    checked={workspaceOnly}
                    onChange={setWorkspaceOnly}
                  />
                </Space>
              </div>
            ) : null}
          </div>
          {error ? (
            <Alert type="error" showIcon title={error} style={{ margin: 8 }} />
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
                  scrollCacheId={dockScrollCacheId}
                  desc={desc}
                  onComposerReady={handleComposerReady}
                />
              </FileContext.Provider>
            ) : (
              <Loading theme="medium" />
            )}
          </div>
          {!IS_MOBILE ? (
            <>
              <div
                onMouseDown={startResize("horizontal")}
                style={{
                  position: "absolute",
                  top: DOCK_HEADER_HEIGHT,
                  right: 0,
                  width: 10,
                  bottom: 20,
                  cursor: "ew-resize",
                }}
              />
              <div
                onMouseDown={startResize("vertical")}
                style={{
                  position: "absolute",
                  left: 20,
                  right: 20,
                  bottom: 0,
                  height: 10,
                  cursor: "ns-resize",
                }}
              />
              <div
                onMouseDown={startResize("both")}
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 22,
                  height: 22,
                  cursor: "nwse-resize",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "flex-end",
                  padding: 4,
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    opacity: 0.7,
                    background: `linear-gradient(135deg, transparent 35%, ${DOCK_RESIZE_MARK_COLOR} 35%, ${DOCK_RESIZE_MARK_COLOR} 43%, transparent 43%, transparent 57%, ${DOCK_RESIZE_MARK_COLOR} 57%, ${DOCK_RESIZE_MARK_COLOR} 65%, transparent 65%)`,
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
      </Draggable>
    </div>
  );
}

export default AgentDock;
