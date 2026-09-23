/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  CSSProperties,
  MutableRefObject,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { FormattedMessage } from "react-intl";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import {
  delete_local_storage,
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc";
import ChatInput from "./input";
import type { ChatActions } from "./actions";
import type { SubmitMentionsFn } from "./types";
import { INPUT_HEIGHT } from "./utils";
import type { ThreadMeta } from "./threads";
import { ThreadBadge } from "./thread-badge";
import { CodexGoalControl } from "./codex-goal";
import type { ChatInputControl } from "./input";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import {
  findChatComposerFocusTarget,
  refocusChatComposerInput,
} from "./composer-focus";
import { AcpPromptModal } from "./acp-prompt-modal";
import { isCodexPaymentSourceNeedsUserConfiguration } from "./codex-submit-preflight";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useChatVisualViewport } from "./use-chat-viewport";
import { DictateButton } from "./audio/dictate-button";
import { AgentMentionContext } from "@cocalc/frontend/agents/mention-context";
import { useAgentMentions } from "@cocalc/frontend/agents/use-agent-mentions";
import { NameAgent } from "@cocalc/frontend/agents/name-agent";
import { extractAgentMentions } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import {
  hasUnboundAgentName,
  bindAgentName,
} from "@cocalc/frontend/agents/unbound-mentions";
import { namedAgentReference } from "@cocalc/frontend/agents/api";
import { AgentFileAttachment } from "./agent-file-attachment";
import { CodexConfigButton } from "./codex";
import { useChatEmbeddingOptions } from "./embedding-options";
import { ComposerDeliverySelector } from "./composer-delivery";
import type { ComposerDelivery } from "./composer-delivery";

export interface ChatRoomComposerProps {
  isActive?: boolean;
  actions: ChatActions;
  project_id: string;
  path: string;
  fontSize: number;
  composerDraftKey: number;
  composerSession: number;
  input: string;
  setInput: (value: string, sessionToken?: number) => void;
  acpPrompt?: string;
  setAcpPrompt?: (value: string) => void;
  on_send: (value?: string) => void | Promise<void>;
  on_post?: (value?: string) => void | Promise<void>;
  onPrepareAgentThread?: (draft?: string) => Promise<string | undefined>;
  on_send_immediately?: (value?: string) => void | Promise<void>;
  onIncreaseFontSize?: () => void;
  onDecreaseFontSize?: () => void;
  submitMentionsRef: MutableRefObject<SubmitMentionsFn | undefined>;
  hasInput: boolean;
  isSelectedThreadAI: boolean;
  isNewThreadCodex?: boolean;
  hasActiveAcpTurn?: boolean;
  threads: ThreadMeta[];
  selectedThread?: ThreadMeta | null;
  onEditThreadAppearance?: () => void;
  onComposerFocusChange: (focused: boolean) => void;
  onComposerReady?: (
    control: ChatInputControl | null,
    root: ParentNode | null,
  ) => void;
  codexPaymentSource?: CodexPaymentSourceInfo;
  codexPaymentSourceLoading?: boolean;
  refreshCodexPaymentSource?: () => void;
  onOpenCodexPaymentConfig?: () => void;
  mobile?: boolean;
}

export { findChatComposerFocusTarget, refocusChatComposerInput };

export function allowAgentMentionsInComposer({
  agentKind,
  hasSelectedThread,
  isNewThreadCodex,
}: {
  agentKind?: string | null;
  hasSelectedThread: boolean;
  isNewThreadCodex: boolean;
}): boolean {
  return agentKind === "acp" || (!hasSelectedThread && isNewThreadCodex);
}

export function approvedDraftIsCurrent({
  approvedDraft,
  editorDraft,
}: {
  approvedDraft: string;
  editorDraft?: string;
}): boolean {
  // The controlled value is intentionally debounced. If the editor control is
  // unavailable, do not reject a send based on known-stale React state.
  return editorDraft == null || editorDraft === approvedDraft;
}

export function ChatRoomComposer({
  isActive = true,
  actions,
  project_id,
  path,
  fontSize,
  composerDraftKey,
  composerSession,
  input,
  setInput,
  acpPrompt = "",
  setAcpPrompt,
  on_send,
  on_post,
  onPrepareAgentThread,
  on_send_immediately,
  onIncreaseFontSize,
  onDecreaseFontSize,
  submitMentionsRef,
  hasInput,
  isSelectedThreadAI,
  isNewThreadCodex = false,
  hasActiveAcpTurn = false,
  threads: _threads,
  selectedThread,
  onEditThreadAppearance,
  onComposerFocusChange,
  onComposerReady,
  codexPaymentSource,
  codexPaymentSourceLoading = false,
  refreshCodexPaymentSource,
  onOpenCodexPaymentConfig,
  mobile = false,
}: ChatRoomComposerProps) {
  const embeddingOptions = useChatEmbeddingOptions();
  const [delivery, setDelivery] = useState<ComposerDelivery>("agent");
  useEffect(() => setDelivery("agent"), [selectedThread?.key]);
  const visualViewport = useChatVisualViewport(mobile);
  const HEIGHT_STORAGE_KEY = "chat-composer-height-px";
  const DEFAULT_MAX_VH = 0.25;
  const ZEN_MAX_VH = 1.0;
  const DRAG_MAX_VH = 0.9;
  const MIN_DRAG_HEIGHT = 60;
  const IDLE_COLLAPSED_HEIGHT = 60;
  const stripHtml = (value: string): string =>
    value.replace(/<[^>]*>/g, "").trim();

  const threadLabel = selectedThread?.displayLabel ?? selectedThread?.label;
  const threadColor = selectedThread?.threadColor;
  const threadAccentColor = selectedThread?.threadAccentColor;
  const threadIcon = selectedThread?.threadIcon;
  const threadImage = selectedThread?.threadImage;
  const threadMetadata = selectedThread
    ? actions?.getThreadMetadata?.(selectedThread.key)
    : undefined;
  const showGoal =
    threadMetadata?.agent_kind === "acp" ||
    threadMetadata?.acp_config != null ||
    isCodexModelName(`${threadMetadata?.agent_model ?? ""}`.trim());
  const canChooseDelivery =
    on_post != null &&
    (selectedThread
      ? threadMetadata?.agent_kind !== "none" &&
        (isSelectedThreadAI || showGoal)
      : isNewThreadCodex);
  const postOnly = canChooseDelivery && delivery === "post";
  const showComposerCodexConfig =
    isSelectedThreadAI ||
    showGoal ||
    (selectedThread != null &&
      actions.getCodexConfig?.(selectedThread.key) != null);
  const contextThread = useMemo(
    () => selectedThread ?? undefined,
    [selectedThread],
  );
  const composerPlaceholder = useMemo(() => {
    if (!contextThread) {
      return "Ask anything...";
    }
    const metadata = actions?.getThreadMetadata?.(contextThread.key);
    if (metadata?.agent_kind === "none") {
      return "Write a message...";
    }
    if (metadata?.agent_kind === "acp") {
      return "What would you like to work on?";
    }
    const threadMs = parseInt(contextThread.key, 10);
    if (
      Number.isFinite(threadMs) &&
      actions?.isCodexThread?.(new Date(threadMs))
    ) {
      return "What would you like to work on?";
    }
    if (contextThread.isAI) {
      return "What would you like to work on?";
    }
    return "Write a message...";
  }, [contextThread, actions]);
  const presenceThreadKey = useMemo(
    () => selectedThread?.key ?? null,
    [selectedThread?.key],
  );
  const hasAcpPrompt = acpPrompt.trim().length > 0;

  const [viewportHeight, setViewportHeight] = useState<number>(() => {
    if (typeof window === "undefined") return 900;
    return window.innerHeight;
  });
  const [manualHeightPx, setManualHeightPx] = useState<number | null>(() => {
    const stored = get_local_storage(HEIGHT_STORAGE_KEY);
    const parsed =
      typeof stored === "string" || typeof stored === "number"
        ? Number(stored)
        : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const [acpPromptModalOpen, setAcpPromptModalOpen] = useState<boolean>(false);
  const [goalOpenRequest, setGoalOpenRequest] = useState(0);
  const zenContainerRef = useRef<HTMLDivElement | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const chatInputControlRef = useRef<ChatInputControl | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const dragStyleRef = useRef<{ cursor: string; userSelect: string } | null>(
    null,
  );
  const wasFullscreenRef = useRef<boolean>(false);

  const refocusComposerInput = useCallback(() => {
    if (typeof window === "undefined") return;
    window.setTimeout(() => {
      refocusChatComposerInput(
        inputContainerRef.current,
        chatInputControlRef.current,
      );
    }, 0);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active && wasFullscreenRef.current) {
        setIsZenMode(false);
      }
      wasFullscreenRef.current = active;
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const defaultMaxHeight = useMemo(
    () =>
      Math.max(
        MIN_DRAG_HEIGHT,
        Math.round(
          (mobile && visualViewport.height
            ? visualViewport.height
            : viewportHeight) * DEFAULT_MAX_VH,
        ),
      ),
    [viewportHeight, mobile, visualViewport.height],
  );
  const zenHeight = useMemo(
    () =>
      Math.max(
        MIN_DRAG_HEIGHT,
        mobile && visualViewport.height
          ? visualViewport.height - 160
          : Math.round(viewportHeight * ZEN_MAX_VH),
      ),
    [viewportHeight, mobile, visualViewport.height],
  );
  const maxDragHeight = useMemo(
    () => Math.max(MIN_DRAG_HEIGHT, Math.round(viewportHeight * DRAG_MAX_VH)),
    [viewportHeight],
  );

  useEffect(() => {
    if (manualHeightPx == null) {
      delete_local_storage(HEIGHT_STORAGE_KEY);
      return;
    }
    set_local_storage(HEIGHT_STORAGE_KEY, String(manualHeightPx));
  }, [manualHeightPx]);

  useEffect(() => {
    if (manualHeightPx == null) return;
    const clamped = Math.max(
      MIN_DRAG_HEIGHT,
      Math.min(maxDragHeight, Math.round(manualHeightPx)),
    );
    if (clamped !== manualHeightPx) {
      setManualHeightPx(clamped);
    }
  }, [manualHeightPx, maxDragHeight]);

  const clampHeight = useCallback(
    (value: number) =>
      Math.max(MIN_DRAG_HEIGHT, Math.min(maxDragHeight, Math.round(value))),
    [maxDragHeight],
  );

  const startDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isZenMode || IS_MOBILE) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const measured =
        inputContainerRef.current?.getBoundingClientRect().height ??
        defaultMaxHeight;
      const startHeight = manualHeightPx ?? measured;
      dragStateRef.current = {
        startY: event.clientY,
        startHeight,
      };
      setManualHeightPx(clampHeight(startHeight));
      setIsDragging(true);
      if (typeof document !== "undefined") {
        dragStyleRef.current = {
          cursor: document.body.style.cursor,
          userSelect: document.body.style.userSelect,
        };
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      }
      const onMove = (moveEvent: MouseEvent) => {
        if (!dragStateRef.current) return;
        const delta = dragStateRef.current.startY - moveEvent.clientY;
        setManualHeightPx(
          clampHeight(dragStateRef.current.startHeight + delta),
        );
      };
      const onUp = () => {
        dragStateRef.current = null;
        setIsDragging(false);
        if (typeof document !== "undefined" && dragStyleRef.current) {
          document.body.style.cursor = dragStyleRef.current.cursor;
          document.body.style.userSelect = dragStyleRef.current.userSelect;
          dragStyleRef.current = null;
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [IS_MOBILE, clampHeight, defaultMaxHeight, isZenMode, manualHeightPx],
  );

  const collapseWhenIdle = !isZenMode && !hasInput;
  const chatInputHeight = isZenMode
    ? `${zenHeight}px`
    : collapseWhenIdle
      ? `${IDLE_COLLAPSED_HEIGHT}px`
      : !mobile && manualHeightPx != null
        ? `${manualHeightPx}px`
        : INPUT_HEIGHT;
  const autoGrowMaxHeight = collapseWhenIdle
    ? IDLE_COLLAPSED_HEIGHT
    : isZenMode
      ? zenHeight
      : Math.max(defaultMaxHeight, mobile ? 0 : (manualHeightPx ?? 0));

  const toggleZenMode = useCallback(async () => {
    if (isZenMode) {
      if (typeof document !== "undefined" && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // ignore
        }
      }
      setIsZenMode(false);
      return;
    }
    setIsZenMode(true);
    const el = zenContainerRef.current;
    if (!mobile && el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
      } catch {
        // ignore and fall back to in-page zen
      }
    }
  }, [isZenMode, mobile]);

  const agentMentions = useAgentMentions({
    projectId: project_id,
    path,
    threadId: selectedThread?.key,
    threadTitle: threadLabel,
    runnable: allowAgentMentionsInComposer({
      agentKind: threadMetadata?.agent_kind,
      hasSelectedThread: selectedThread != null,
      isNewThreadCodex,
    }),
    restoreFocus: refocusComposerInput,
  });
  const pendingPreparation = useRef<
    | { reference?: AgentMentionReference; value?: string; immediate?: boolean }
    | undefined
  >(undefined);
  const [nameAfterPreparation, setNameAfterPreparation] = useState(false);
  const [preparationError, setPreparationError] = useState("");
  const preparationLock = useRef(false);
  async function prepareAgentThread(
    pending: NonNullable<typeof pendingPreparation.current>,
  ) {
    if (preparationLock.current || !onPrepareAgentThread) return;
    preparationLock.current = true;
    pendingPreparation.current = pending;
    try {
      if (
        !(await onPrepareAgentThread(
          pending.value ?? chatInputControlRef.current?.getValue?.() ?? input,
        ))
      )
        pendingPreparation.current = undefined;
    } catch (err) {
      pendingPreparation.current = undefined;
      setPreparationError(`${err}`);
    } finally {
      preparationLock.current = false;
    }
  }
  useEffect(() => {
    if (!selectedThread || !pendingPreparation.current) return;
    const pending = pendingPreparation.current;
    pendingPreparation.current = undefined;
    setNameAfterPreparation(false);
    if (pending.reference) agentMentions.context.onSelect(pending.reference);
    else if (pending.value)
      void agentMentions.preflight(`${pending.value}\n${acpPrompt}`, () =>
        (pending.immediate ? (on_send_immediately ?? on_send) : on_send)(
          pending.value,
        ),
      );
  }, [
    selectedThread?.key,
    agentMentions.context.onSelect,
    agentMentions.preflight,
  ]);
  const agentMentionContext = {
    ...agentMentions.context,
    source: { projectId: project_id, path, threadId: selectedThread?.key },
    postOnly,
    onSelect: (reference: AgentMentionReference) => {
      if (postOnly) return;
      if (!selectedThread && isNewThreadCodex)
        void prepareAgentThread({ reference });
      else agentMentions.context.onSelect(reference);
    },
  };

  const handleSend = useCallback(
    (value?: string | { preventDefault?: () => void }) => {
      const effective = typeof value === "string" ? value : input;
      if (!effective || !effective.trim()) return;
      if (
        !selectedThread &&
        isNewThreadCodex &&
        extractAgentMentions(`${effective}\n${acpPrompt}`).length
      ) {
        void prepareAgentThread({ value: effective });
        return;
      }
      void agentMentions.preflight(`${effective}\n${acpPrompt}`, () => {
        if (
          !approvedDraftIsCurrent({
            approvedDraft: effective,
            editorDraft: chatInputControlRef.current?.getValue?.(),
          })
        )
          throw new Error(
            "The draft changed during approval. Review it and press Send again.",
          );
        return on_send(effective);
      });
      setIsInputFocused(true);
      refocusComposerInput();
      if (isZenMode) {
        void toggleZenMode();
      }
    },
    [
      input,
      isZenMode,
      on_send,
      refocusComposerInput,
      toggleZenMode,
      agentMentions.preflight,
      selectedThread,
      isNewThreadCodex,
      acpPrompt,
    ],
  );

  const handleSendImmediately = useCallback(
    (value?: string | { preventDefault?: () => void }) => {
      const effective = typeof value === "string" ? value : input;
      if (!effective || !effective.trim()) return;
      if (
        !selectedThread &&
        isNewThreadCodex &&
        extractAgentMentions(`${effective}\n${acpPrompt}`).length
      ) {
        void prepareAgentThread({ value: effective, immediate: true });
        return;
      }
      void agentMentions.preflight(`${effective}\n${acpPrompt}`, () => {
        if (
          !approvedDraftIsCurrent({
            approvedDraft: effective,
            editorDraft: chatInputControlRef.current?.getValue?.(),
          })
        )
          throw new Error(
            "The draft changed during approval. Review it and press Send again.",
          );
        if (on_send_immediately) {
          return on_send_immediately(effective);
        } else {
          return on_send(effective);
        }
      });
      setIsInputFocused(true);
      refocusComposerInput();
      if (isZenMode) {
        void toggleZenMode();
      }
    },
    [
      input,
      isZenMode,
      on_send,
      on_send_immediately,
      refocusComposerInput,
      toggleZenMode,
      agentMentions.preflight,
      selectedThread,
      isNewThreadCodex,
      acpPrompt,
    ],
  );
  const handleFontSizeChange = useMemo(() => {
    if (onDecreaseFontSize == null && onIncreaseFontSize == null) {
      return undefined;
    }
    return (delta: -1 | 1) => {
      if (delta < 0) {
        onDecreaseFontSize?.();
      } else {
        onIncreaseFontSize?.();
      }
    };
  }, [onDecreaseFontSize, onIncreaseFontSize]);

  const showCodexPaymentSourceBanner =
    (isSelectedThreadAI || isNewThreadCodex) &&
    !codexPaymentSourceLoading &&
    isCodexPaymentSourceNeedsUserConfiguration(codexPaymentSource);
  const hasRunningCodexTurn = hasActiveAcpTurn && isSelectedThreadAI;
  const handlePrimarySend = hasRunningCodexTurn
    ? handleSendImmediately
    : handleSend;
  const handlePost = (value?: string | { preventDefault?: () => void }) => {
    const draft =
      typeof value === "string"
        ? value
        : (chatInputControlRef.current?.getValue?.() ?? input);
    if (!draft.trim() || !on_post) return;
    void on_post(draft);
    refocusComposerInput();
  };

  const composerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    margin: isZenMode && isFullscreen ? 0 : "0 8px 8px",
    overflow: "hidden",
    width: isZenMode && isFullscreen ? "100%" : "calc(100% - 16px)",
    height: isZenMode && isFullscreen ? "100%" : undefined,
    padding: isZenMode && isFullscreen ? "12px" : "8px 10px 7px",
    background: UI_COLORS.surface,
    border: `1px solid ${isInputFocused ? UI_COLORS.link : UI_COLORS.border}`,
    borderRadius: isZenMode && isFullscreen ? 0 : 16,
    boxShadow: isInputFocused
      ? `inset 0 0 0 1px ${UI_COLORS.focus}`
      : undefined,
    boxSizing: "border-box",
    ...(mobile && isZenMode
      ? {
          position: "fixed",
          top: visualViewport.top,
          left: visualViewport.left,
          width: visualViewport.width || "100%",
          height: visualViewport.height || "100dvh",
          zIndex: 950,
          padding: "8px",
          justifyContent: "flex-end",
        }
      : {}),
  };

  return (
    <AgentMentionContext.Provider value={agentMentionContext}>
      <div
        ref={zenContainerRef}
        data-testid="chat-composer"
        style={composerStyle}
      >
        <div
          style={{
            flex: mobile ? "0 1 auto" : "1",
            width: "100%",
            padding: 0,
            // Critical flexbox quirk: without minWidth: 0, long unbroken input text
            // forces this flex item to grow instead of shrinking, so the send/toolbar
            // buttons get pushed off-screen. Allow the item to shrink (and text to wrap)
            // by setting minWidth: 0. See https://developer.mozilla.org/en-US/docs/Web/CSS/min-width#flex_items
            minWidth: 0,
          }}
        >
          {!IS_MOBILE && !mobile && hasInput && (
            <Tooltip
              title={
                isZenMode
                  ? "Exit zen mode to resize"
                  : "Drag to resize the composer"
              }
            >
              <div
                onMouseDown={startDrag}
                style={{
                  height: "8px",
                  cursor: isZenMode ? "default" : "row-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: "4px",
                  opacity: isZenMode ? 0.4 : 1,
                }}
              >
                <div
                  style={{
                    width: "42px",
                    height: "3px",
                    borderRadius: "999px",
                    background: isDragging ? "#719ECE" : "#c2c2c2",
                  }}
                />
              </div>
            </Tooltip>
          )}
          {!embeddingOptions.hideComposerIdentity && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 6,
                minWidth: 0,
                flexWrap: "wrap",
              }}
            >
              {showGoal && selectedThread && (
                <NameAgent
                  key={agentMentions.accountId}
                  agent={agentMentions.namedAgent}
                  projectId={project_id}
                  path={path}
                  threadId={selectedThread.key}
                  threadTitle={threadLabel}
                  initiallyOpen={nameAfterPreparation}
                />
              )}
              {!selectedThread && isNewThreadCodex && onPrepareAgentThread && (
                <Button
                  size="small"
                  onClick={() => {
                    setNameAfterPreparation(true);
                    void prepareAgentThread({});
                  }}
                >
                  Name agent
                </Button>
              )}
              {threadLabel && (
                <button
                  type="button"
                  aria-label={`Edit Thread Appearance: ${stripHtml(threadLabel)}`}
                  aria-haspopup="dialog"
                  disabled={!onEditThreadAppearance}
                  onClick={onEditThreadAppearance}
                  style={{
                    background: "none",
                    border: 0,
                    cursor: onEditThreadAppearance ? "pointer" : "default",
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    marginLeft: "auto",
                    minWidth: 0,
                    maxWidth: "100%",
                    gap: "8px",
                    color: UI_COLORS.secondary,
                    fontSize: "12px",
                    padding: "1px 4px",
                  }}
                >
                  <ThreadBadge
                    icon={threadIcon}
                    color={threadColor}
                    accentColor={threadAccentColor}
                    image={threadImage}
                    size={18}
                  />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={stripHtml(threadLabel)}
                  >
                    {stripHtml(threadLabel)}
                  </span>
                </button>
              )}
            </div>
          )}
          {showCodexPaymentSourceBanner && (
            <Alert
              action={
                onOpenCodexPaymentConfig != null ? (
                  <Button
                    onClick={onOpenCodexPaymentConfig}
                    size="small"
                    type="primary"
                  >
                    Connect AI
                  </Button>
                ) : undefined
              }
              showIcon
              style={{ marginBottom: 8 }}
              title="To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key."
              type="info"
            />
          )}
          {preparationError && (
            <div role="alert">
              <Alert
                type="error"
                title="Unable to prepare agent thread"
                description={preparationError}
              />
            </div>
          )}
          {agentMentions.ui}
          {(showGoal || isNewThreadCodex) &&
            agentMentions.agents
              .filter((agent) => hasUnboundAgentName(input, agent.name))
              .map((agent) => (
                <Button
                  key={agent.endpoint.agent_id}
                  size="small"
                  onClick={() => {
                    const reference = namedAgentReference(agent);
                    setInput(bindAgentName(input, reference), composerSession);
                    agentMentionContext.onSelect(reference);
                  }}
                >
                  Resolve @{agent.name} to named agent (
                  {agent.thread_title ?? "Agent thread"} /{" "}
                  {agent.project_title ?? "Project"})
                </Button>
              ))}
          <div ref={inputContainerRef} data-testid="chat-composer-input">
            {isActive && (
              <ChatInput
                key={`${path}${project_id}-draft-${composerDraftKey}`}
                inputControlRef={chatInputControlRef}
                onControlReady={(control) =>
                  onComposerReady?.(control, inputContainerRef.current)
                }
                fontSize={mobile ? Math.max(16, fontSize) : fontSize}
                autoFocus={!mobile}
                isFocused={isInputFocused}
                cacheId={`${path}${project_id}-draft-${composerDraftKey}`}
                input={input}
                presenceThreadKey={presenceThreadKey}
                on_send={handlePrimarySend}
                on_post={on_post ? handlePost : undefined}
                on_font_size_change={handleFontSizeChange}
                height={chatInputHeight}
                autoGrowMaxHeight={autoGrowMaxHeight}
                onChange={(value) => {
                  setInput(value, composerSession);
                }}
                onFocus={() => {
                  setIsInputFocused(true);
                  onComposerFocusChange(true);
                }}
                onBlur={() => {
                  setIsInputFocused(false);
                  onComposerFocusChange(false);
                }}
                submitMentionsRef={submitMentionsRef}
                syncdb={actions.syncdb}
                date={composerDraftKey}
                sessionToken={composerSession}
                editBarStyle={{ overflow: "hidden" }}
                placeholder={
                  postOnly
                    ? "Post a note; @mention people to notify them..."
                    : composerPlaceholder
                }
                externalMultilinePasteAsCodeBlock
                toolbarRightContent={
                  hasInput ? (
                    <Tooltip
                      title={
                        isZenMode
                          ? "Exit zen mode"
                          : "Expand composer for focused writing"
                      }
                    >
                      <Button
                        aria-label={isZenMode ? "Exit Zen" : "Zen"}
                        icon={<Icon name="expand-arrows" />}
                        onClick={toggleZenMode}
                        size="small"
                        type="text"
                      />
                    </Tooltip>
                  ) : null
                }
              />
            )}
          </div>
          {showGoal && selectedThread && (
            <CodexGoalControl
              key={selectedThread.key}
              snapshot={threadMetadata?.acp_goal}
              request={threadMetadata?.acp_goal_request}
              ack={threadMetadata?.acp_goal_ack}
              openRequest={goalOpenRequest}
              hideEmptyTrigger
              onChange={(change) =>
                actions.setCodexGoal(selectedThread.key, change)
              }
            />
          )}
        </div>
        <div
          data-testid="chat-composer-actions"
          role="group"
          aria-label="Message actions"
          style={{
            alignItems: "flex-end",
            borderTop: `1px solid ${UI_COLORS.border}`,
            display: "flex",
            flexDirection: "row",
            flexWrap: "nowrap",
            gap: 4,
            flexShrink: 0,
            minWidth: 0,
            paddingTop: 7,
          }}
        >
          <div
            role="group"
            aria-label="Message options"
            style={{
              display: "flex",
              alignItems: "center",
              flex: "1 1 0",
              flexWrap: "wrap",
              gap: 4,
              minWidth: 0,
              minHeight: 32,
            }}
          >
            <AgentFileAttachment
              projectId={project_id}
              workingDirectory={
                actions.getCodexConfig?.(selectedThread?.key)?.workingDirectory
              }
              onSetGoal={
                showGoal && selectedThread
                  ? () => setGoalOpenRequest((request) => request + 1)
                  : undefined
              }
              onInsert={(markdown) => {
                chatInputControlRef.current?.insertText(markdown);
                refocusComposerInput();
              }}
            />
            <DictateButton
              inputControlRef={chatInputControlRef}
              path={path}
              projectId={project_id}
              session={composerSession}
              threadId={selectedThread?.key}
            />
            {showComposerCodexConfig && selectedThread ? (
              <div
                style={{
                  display: "flex",
                  flex: "1 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                <CodexConfigButton
                  compact={mobile ? "mobile-composer" : "composer"}
                  threadKey={selectedThread.key}
                  chatPath={path}
                  projectId={project_id}
                  actions={actions}
                  threadConfig={threadMetadata?.acp_config ?? null}
                  paymentSource={codexPaymentSource}
                  paymentSourceLoading={codexPaymentSourceLoading}
                  refreshPaymentSource={refreshCodexPaymentSource}
                />
              </div>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {mobile && showComposerCodexConfig && selectedThread && (
              <span style={{ flex: 1 }} />
            )}
            {hasAcpPrompt ? (
              <Tooltip title="View or edit the full prompt that will be sent to the agent">
                <Button
                  size="small"
                  aria-label="Agent Prompt"
                  icon={mobile ? <Icon name="file" /> : undefined}
                  onClick={() => setAcpPromptModalOpen(true)}
                >
                  {mobile ? null : "Agent Prompt"}
                </Button>
              </Tooltip>
            ) : null}
            {hasRunningCodexTurn && !postOnly ? (
              <Tooltip
                title={
                  <FormattedMessage
                    id="chatroom.chat_input.queue_button.tooltip"
                    defaultMessage={"Queue after the running turn"}
                  />
                }
              >
                <Button
                  onClick={handleSend}
                  disabled={!hasInput}
                  size="small"
                  type="text"
                >
                  Queue
                </Button>
              </Tooltip>
            ) : null}
            {canChooseDelivery && (
              <ComposerDeliverySelector
                value={delivery}
                onChange={(value) => {
                  setDelivery(value);
                  refocusComposerInput();
                }}
              />
            )}
          </div>
          <Tooltip
            title={
              postOnly ? (
                "Post without sending to the agent (Ctrl+Enter)"
              ) : hasRunningCodexTurn ? (
                <FormattedMessage
                  id="chatroom.chat_input.steer_button.tooltip"
                  defaultMessage={"Steer running turn (Shift+Enter)"}
                />
              ) : (
                <FormattedMessage
                  id="chatroom.chat_input.send_button.tooltip"
                  defaultMessage={"Send message (Shift+Enter)"}
                />
              )
            }
          >
            <Button
              onClick={postOnly ? handlePost : handlePrimarySend}
              disabled={!hasInput}
              type="primary"
              shape="circle"
              aria-label={
                postOnly
                  ? "Post message"
                  : hasRunningCodexTurn
                    ? "Steer"
                    : "Send"
              }
              data-testid="chat-composer-send"
              icon={<Icon name="arrow-up" />}
              style={{ flex: "0 0 32px", height: 32, minWidth: 32, width: 32 }}
            />
          </Tooltip>
        </div>
        <AcpPromptModal
          open={acpPromptModalOpen}
          value={acpPrompt}
          fontSize={fontSize}
          onChange={(value) => setAcpPrompt?.(value)}
          onClose={() => setAcpPromptModalOpen(false)}
        />
      </div>
    </AgentMentionContext.Provider>
  );
}
