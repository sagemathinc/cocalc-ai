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
import { Alert, Button, ConfigProvider } from "antd";
import { FormattedMessage } from "react-intl";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";

import ChatInput from "./input";
import type { ChatActions } from "./actions";
import type { SubmitMentionsFn } from "./types";
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
import { getCodexPaymentSourceOptions } from "./use-codex-payment-source";
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
import { ComposerConnectors } from "@cocalc/frontend/agents/composer-connectors";
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
  voiceOptionsOpen?: boolean;
  onToggleVoiceOptions?: () => void;
  onDictationStartReady?: (start: (() => void) | undefined) => void;
  onDictationBusyChange?: (busy: boolean) => void;
  onDictationAvailabilityChange?: (available: boolean) => void;
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
  voiceOptionsOpen,
  onToggleVoiceOptions,
  onDictationStartReady,
  onDictationBusyChange,
  onDictationAvailabilityChange,
  mobile = false,
}: ChatRoomComposerProps) {
  const embeddingOptions = useChatEmbeddingOptions();
  const [delivery, setDelivery] = useState<ComposerDelivery>("agent");
  useEffect(() => setDelivery("agent"), [selectedThread?.key]);
  const visualViewport = useChatVisualViewport(mobile);

  // Automatic sizing grows to this share of the viewport, then scrolls.
  const AUTO_MAX_VH = mobile ? 0.3 : 0.4;
  const ZEN_MAX_VH = 1.0;
  // Dragging must never push the handle out of reach, and must leave room
  // for the conversation above the composer.
  const DRAG_MAX_VH = 0.6;
  const DRAG_KEEP_VISIBLE_PX = 240;
  // About one line of text.
  const MIN_DRAG_HEIGHT = 40;
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
  const isGenericHarness = threadMetadata?.agent_runtime?.kind === "acp";
  const supportsLiveGuidance =
    !isGenericHarness ||
    (threadMetadata?.agent_runtime?.profile?.version === 2 &&
      threadMetadata.agent_runtime.profile.id === "claude-code");
  const hasAgentControls =
    threadMetadata?.agent_kind === "acp" ||
    threadMetadata?.acp_config != null ||
    isCodexModelName(`${threadMetadata?.agent_model ?? ""}`.trim());
  const showGoal = hasAgentControls && !isGenericHarness;
  const hasRunningCodexTurn = hasActiveAcpTurn && isSelectedThreadAI;
  const canPost =
    on_post != null &&
    (selectedThread
      ? threadMetadata?.agent_kind !== "none" &&
        (isSelectedThreadAI || showGoal)
      : isNewThreadCodex);
  const canChooseDelivery = canPost || hasRunningCodexTurn;
  const postOnly = canPost && delivery === "post";
  const queueOnly = hasRunningCodexTurn && delivery === "queue";
  const selectedDelivery = queueOnly ? "queue" : postOnly ? "post" : "agent";
  useEffect(() => {
    if (!hasRunningCodexTurn) {
      setDelivery((current) => (current === "queue" ? "agent" : current));
    }
  }, [hasRunningCodexTurn]);
  const showComposerCodexConfig =
    isSelectedThreadAI ||
    hasAgentControls ||
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
  // The editor always fits its text. Dragging the handle only reserves room
  // (a minimum height) for the current draft; sending resets it.
  const [manualHeightPx, setManualHeightPx] = useState<number | null>(null);
  useEffect(() => setManualHeightPx(null), [composerSession]);
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

  const autoGrowMaxHeight = useMemo(
    () =>
      Math.max(
        MIN_DRAG_HEIGHT,
        Math.round(
          (mobile && visualViewport.height
            ? visualViewport.height
            : viewportHeight) * AUTO_MAX_VH,
        ),
      ),
    [viewportHeight, mobile, visualViewport.height, AUTO_MAX_VH],
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
    () =>
      Math.max(
        MIN_DRAG_HEIGHT,
        Math.round(
          Math.min(
            viewportHeight * DRAG_MAX_VH,
            viewportHeight - DRAG_KEEP_VISIBLE_PX,
          ),
        ),
      ),
    [viewportHeight],
  );

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
        autoGrowMaxHeight;
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
    [IS_MOBILE, clampHeight, autoGrowMaxHeight, isZenMode, manualHeightPx],
  );

  // undefined: fit the content, between the reserved minimum and the cap.
  const chatInputHeight = isZenMode ? `${zenHeight}px` : undefined;
  const reservedHeight =
    manualHeightPx != null ? clampHeight(manualHeightPx) : MIN_DRAG_HEIGHT;
  const currentInputHeight = () =>
    manualHeightPx ??
    Math.round(
      inputContainerRef.current?.getBoundingClientRect().height ??
        MIN_DRAG_HEIGHT,
    );

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
      // Snapshot the same editor representation that the approval guard reads.
      // Debounced input and keyboard callbacks can differ in trailing newlines.
      const effective =
        chatInputControlRef.current?.getValue?.() ??
        (typeof value === "string" ? value : input);
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
      if (!supportsLiveGuidance) return handleSend(value);
      const effective =
        chatInputControlRef.current?.getValue?.() ??
        (typeof value === "string" ? value : input);
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
      supportsLiveGuidance,
      handleSend,
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
    !isGenericHarness &&
    (isSelectedThreadAI || isNewThreadCodex) &&
    !codexPaymentSourceLoading &&
    isCodexPaymentSourceNeedsUserConfiguration(codexPaymentSource);
  const membershipAvailable = getCodexPaymentSourceOptions(
    codexPaymentSource,
  ).some((option) => option.value === "site-api-key" && !option.disabled);
  const canSteerRunningTurn = hasRunningCodexTurn && supportsLiveGuidance;
  const handlePrimarySend = canSteerRunningTurn
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

  const fullscreenZen = isZenMode && isFullscreen;
  // The wrapper is the fullscreen element, so the settings below the box stay
  // visible in fullscreen.
  const composerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    margin: fullscreenZen ? 0 : !mobile ? "0 auto 6px" : "0 8px 6px",
    width: fullscreenZen ? "100%" : "calc(100% - 16px)",
    maxWidth: !mobile && !isZenMode ? 1120 : undefined,
    height: fullscreenZen ? "100%" : undefined,
    padding: fullscreenZen ? "12px" : undefined,
    background: fullscreenZen ? UI_COLORS.surface : undefined,
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
          background: UI_COLORS.surface,
        }
      : {}),
  };
  // The bordered box holds only the message and actions on it.
  const composerBoxStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    flex: fullscreenZen ? "1 1 auto" : "0 1 auto",
    minHeight: 0,
    overflow: "hidden",
    padding: "6px 10px",
    background: UI_COLORS.surface,
    border: `1px solid ${isInputFocused ? `color-mix(in srgb, ${UI_COLORS.focus} 35%, ${UI_COLORS.border})` : UI_COLORS.border}`,
    borderRadius: 16,
    boxSizing: "border-box",
  };
  const showIdentity =
    !embeddingOptions.hideComposerIdentity &&
    ((hasAgentControls && selectedThread != null) ||
      (!selectedThread && isNewThreadCodex && onPrepareAgentThread != null) ||
      !!threadLabel);
  const showConversationSettings =
    (showComposerCodexConfig && selectedThread != null) || showIdentity;

  const composer = (
    <AgentMentionContext.Provider value={agentMentionContext}>
      <div
        ref={zenContainerRef}
        data-testid="chat-composer"
        style={composerStyle}
      >
        <div data-testid="chat-composer-box" style={composerBoxStyle}>
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
            {!IS_MOBILE && !mobile && (
              <Tooltip
                title={
                  isZenMode
                    ? "Exit fullscreen to resize"
                    : "Drag to make room for this message; double-click to fit the text"
                }
              >
                <div
                  role="separator"
                  tabIndex={isZenMode ? -1 : 0}
                  aria-label="Resize composer"
                  aria-orientation="horizontal"
                  aria-valuemin={MIN_DRAG_HEIGHT}
                  aria-valuemax={maxDragHeight}
                  aria-valuenow={clampHeight(
                    manualHeightPx ?? autoGrowMaxHeight,
                  )}
                  aria-valuetext={
                    manualHeightPx == null
                      ? "Fits the text"
                      : `At least ${clampHeight(manualHeightPx)} pixels`
                  }
                  onKeyDown={(event) => {
                    if (isZenMode) return;
                    const current = currentInputHeight();
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      setManualHeightPx(
                        clampHeight(
                          current + (event.key === "ArrowUp" ? 20 : -20),
                        ),
                      );
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      setManualHeightPx(null);
                    }
                  }}
                  onMouseDown={startDrag}
                  onDoubleClick={() => setManualHeightPx(null)}
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
                      background: isDragging
                        ? UI_COLORS.focus
                        : UI_COLORS.border,
                    }}
                  />
                </div>
              </Tooltip>
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
                      {membershipAvailable ? "Payment settings" : "Connect AI"}
                    </Button>
                  ) : undefined
                }
                showIcon
                style={{ marginBottom: 8 }}
                title={
                  membershipAvailable
                    ? "To continue using this model, connect a ChatGPT plan or OpenAI API key. CoCalc Membership is available for new conversations with its included model."
                    : "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key."
                }
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
            {(hasAgentControls || isNewThreadCodex) &&
              agentMentions.agents
                .filter((agent) => hasUnboundAgentName(input, agent.name))
                .map((agent) => (
                  <Button
                    key={agent.endpoint.agent_id}
                    size="small"
                    onClick={() => {
                      const reference = namedAgentReference(agent);
                      setInput(
                        bindAgentName(input, reference),
                        composerSession,
                      );
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
                  projectId={project_id}
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
                  on_queue={hasRunningCodexTurn ? handleSend : undefined}
                  on_post={on_post ? handlePost : undefined}
                  on_font_size_change={handleFontSizeChange}
                  height={chatInputHeight}
                  autoGrow={chatInputHeight == null}
                  autoGrowMinHeight={reservedHeight}
                  autoGrowMaxHeight={Math.max(
                    autoGrowMaxHeight,
                    reservedHeight,
                  )}
                  compactModeSwitch
                  softFocus
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
                  toolbarMenuContent={(close) => (
                    <Button
                      aria-label={isZenMode ? "Exit fullscreen" : "Fullscreen"}
                      icon={<Icon name="expand-arrows" />}
                      onClick={() => {
                        close();
                        toggleZenMode();
                      }}
                      size="small"
                      type="text"
                    >
                      {isZenMode ? "Exit fullscreen" : "Fullscreen"}
                    </Button>
                  )}
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
              borderTop: undefined,
              display: "flex",
              flexDirection: "row",
              flexWrap: "nowrap",
              gap: 4,
              flexShrink: 0,
              minWidth: 0,
              paddingTop: 2,
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
              <ComposerConnectors
                agent={agentMentions.namedAgent}
                supportsCocalcAccess={
                  threadMetadata != null && !isGenericHarness
                }
              >
                {(extraMenuItems) => (
                  <AgentFileAttachment
                    extraMenuItems={extraMenuItems}
                    projectId={project_id}
                    workingDirectory={
                      actions.getCodexConfig?.(selectedThread?.key)
                        ?.workingDirectory
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
                )}
              </ComposerConnectors>
              <DictateButton
                borderless
                inputControlRef={chatInputControlRef}
                path={path}
                projectId={project_id}
                session={composerSession}
                threadId={selectedThread?.key}
                onOpenVoiceOptions={onToggleVoiceOptions}
                voiceOptionsOpen={voiceOptionsOpen}
                onStartReady={onDictationStartReady}
                onBusyChange={onDictationBusyChange}
                onAvailabilityChange={onDictationAvailabilityChange}
              />
              <span style={{ flex: 1 }} />
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
              {canChooseDelivery && hasInput && (
                <ComposerDeliverySelector
                  value={selectedDelivery}
                  canQueue={hasRunningCodexTurn}
                  canPost={canPost}
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
                ) : queueOnly ? (
                  "Queue after the running turn (Alt+Enter)"
                ) : canSteerRunningTurn ? (
                  <FormattedMessage
                    id="chatroom.chat_input.steer_button.tooltip"
                    defaultMessage={"Steer running turn (Shift+Enter)"}
                  />
                ) : hasRunningCodexTurn ? (
                  "Queue after the running turn (Shift+Enter)"
                ) : (
                  <FormattedMessage
                    id="chatroom.chat_input.send_button.tooltip"
                    defaultMessage={"Send message (Shift+Enter)"}
                  />
                )
              }
            >
              <Button
                onClick={
                  postOnly
                    ? handlePost
                    : queueOnly
                      ? handleSend
                      : handlePrimarySend
                }
                disabled={!hasInput}
                type="primary"
                shape="circle"
                aria-label={
                  postOnly
                    ? "Post message"
                    : queueOnly
                      ? "Queue message"
                      : canSteerRunningTurn
                        ? "Steer"
                        : hasRunningCodexTurn
                          ? "Queue"
                          : "Send"
                }
                data-testid="chat-composer-send"
                icon={<Icon name="arrow-up" />}
                style={{
                  flex: "0 0 32px",
                  height: 32,
                  minWidth: 32,
                  width: 32,
                }}
              />
            </Tooltip>
          </div>
        </div>
        {showConversationSettings && (
          <div
            data-testid="chat-composer-settings"
            role="group"
            aria-label="Conversation settings"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              minWidth: 0,
              padding: "2px 10px 0",
              color: UI_COLORS.secondary,
            }}
          >
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
                  turnRunning={hasRunningCodexTurn}
                />
              </div>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {showIdentity && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flex: "0 1 auto",
                  minWidth: 0,
                }}
              >
                {hasAgentControls && selectedThread && (
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
                {!selectedThread &&
                  isNewThreadCodex &&
                  onPrepareAgentThread && (
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
          </div>
        )}
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

  return (
    <ConfigProvider
      // Body portals are outside the browser's fullscreen top layer.
      getPopupContainer={
        isFullscreen
          ? () => zenContainerRef.current ?? document.body
          : undefined
      }
    >
      {composer}
    </ConfigProvider>
  );
}
