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
import { Button, Select, Tooltip } from "antd";
import { FormattedMessage } from "react-intl";
import { Icon } from "@cocalc/frontend/components";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import {
  delete_local_storage,
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc";
import { LLMUsageStatus } from "@cocalc/frontend/misc/llm-cost-estimation";
import ChatInput from "./input";
import type { ChatActions } from "./actions";
import type { SubmitMentionsFn } from "./types";
import { INPUT_HEIGHT } from "./utils";
import type { ThreadMeta } from "./threads";
import { ThreadBadge } from "./thread-badge";

export interface ChatRoomComposerProps {
  actions: ChatActions;
  project_id: string;
  path: string;
  fontSize: number;
  composerDraftKey: number;
  input: string;
  setInput: (value: string) => void;
  on_send: () => void;
  submitMentionsRef: MutableRefObject<SubmitMentionsFn | undefined>;
  hasInput: boolean;
  isSelectedThreadAI: boolean;
  sendMessage: (replyToOverride?: Date | null, extraInput?: string) => void;
  combinedFeedSelected: boolean;
  composerTargetKey: string | null;
  threads: ThreadMeta[];
  selectedThread?: ThreadMeta | null;
  onComposerTargetChange: (key: string | null) => void;
  onComposerFocusChange: (focused: boolean) => void;
}

export function ChatRoomComposer({
  actions,
  project_id,
  path,
  fontSize,
  composerDraftKey,
  input,
  setInput,
  on_send,
  submitMentionsRef,
  hasInput,
  isSelectedThreadAI,
  sendMessage,
  combinedFeedSelected,
  composerTargetKey,
  threads,
  selectedThread,
  onComposerTargetChange,
  onComposerFocusChange,
}: ChatRoomComposerProps) {
  const HEIGHT_STORAGE_KEY = "chat-composer-height-px";
  const DEFAULT_MAX_VH = 0.25;
  const ZEN_MAX_VH = 1.0;
  const DRAG_MAX_VH = 0.9;
  const MIN_DRAG_HEIGHT = 60;

  const stripHtml = (value: string): string =>
    value.replace(/<[^>]*>/g, "").trim();

  const targetOptions = threads.map((thread) => ({
    value: thread.key,
    label: stripHtml(thread.displayLabel ?? thread.label),
  }));
  const targetValue =
    composerTargetKey && targetOptions.some((opt) => opt.value === composerTargetKey)
      ? composerTargetKey
      : undefined;
  const threadLabel = selectedThread?.displayLabel ?? selectedThread?.label;
  const threadColor = selectedThread?.threadColor;
  const threadIcon = selectedThread?.threadIcon;
  const hasCustomAppearance = selectedThread?.hasCustomAppearance ?? false;

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
  const zenContainerRef = useRef<HTMLDivElement | null>(null);
  const inputContainerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  const dragStyleRef = useRef<{ cursor: string; userSelect: string } | null>(
    null,
  );
  const wasFullscreenRef = useRef<boolean>(false);

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
    () => Math.max(MIN_DRAG_HEIGHT, Math.round(viewportHeight * DEFAULT_MAX_VH)),
    [viewportHeight],
  );
  const zenHeight = useMemo(
    () => Math.max(MIN_DRAG_HEIGHT, Math.round(viewportHeight * ZEN_MAX_VH)),
    [viewportHeight],
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

  const chatInputHeight = isZenMode
    ? `${zenHeight}px`
    : manualHeightPx != null
      ? `${manualHeightPx}px`
      : INPUT_HEIGHT;
  const autoGrowMaxHeight = isZenMode
    ? zenHeight
    : Math.max(defaultMaxHeight, manualHeightPx ?? 0);

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
    if (el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
      } catch {
        // ignore and fall back to in-page zen
      }
    }
  }, [isZenMode]);

  const composerStyle: CSSProperties = {
    display: "flex",
    marginBottom: isZenMode && isFullscreen ? 0 : "5px",
    overflow: isZenMode && isFullscreen ? "hidden" : "auto",
    width: "100%",
    height: isZenMode && isFullscreen ? "100%" : undefined,
    padding: isZenMode && isFullscreen ? "12px" : undefined,
    background: isZenMode && isFullscreen ? "white" : undefined,
    boxSizing: "border-box",
  };

  return (
    <div ref={zenContainerRef} style={composerStyle}>
      <div
        style={{
          flex: "1",
          padding: "0px 5px 0px 2px",
          // Critical flexbox quirk: without minWidth: 0, long unbroken input text
          // forces this flex item to grow instead of shrinking, so the send/toolbar
          // buttons get pushed off-screen. Allow the item to shrink (and text to wrap)
          // by setting minWidth: 0. See https://developer.mozilla.org/en-US/docs/Web/CSS/min-width#flex_items
          minWidth: 0,
        }}
      >
        {!IS_MOBILE && (
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
        {combinedFeedSelected && targetOptions.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            <span style={{ marginRight: 8, color: "#666" }}>Replying to:</span>
            <Select
              size="small"
              style={{ minWidth: 220, maxWidth: 420 }}
              options={targetOptions}
              value={targetValue}
              onChange={(value) => onComposerTargetChange(value ?? null)}
              placeholder="Choose a thread"
              showSearch
              optionFilterProp="label"
            />
          </div>
        )}
        {hasCustomAppearance && threadLabel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "#666",
              fontSize: "12px",
              marginBottom: 6,
            }}
          >
            <ThreadBadge icon={threadIcon} color={threadColor} size={18} />
            <span>{stripHtml(threadLabel)}</span>
          </div>
        )}
        <div ref={inputContainerRef}>
          <ChatInput
            fontSize={fontSize}
            autoFocus
            cacheId={`${path}${project_id}-draft-${composerDraftKey}`}
            input={input}
            on_send={on_send}
            height={chatInputHeight}
            autoGrowMaxHeight={autoGrowMaxHeight}
            onChange={(value) => {
              setInput(value);
            }}
            onFocus={() => onComposerFocusChange(true)}
            onBlur={() => onComposerFocusChange(false)}
            submitMentionsRef={submitMentionsRef}
            syncdb={actions.syncdb}
            date={composerDraftKey}
            editBarStyle={{ overflow: "auto" }}
          />
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0",
          marginBottom: "0",
        }}
      >
        <div style={{ flex: 1 }} />
        {!hasInput && isSelectedThreadAI && (
          <div
            style={{
              height: "47.5px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: "5px",
            }}
          >
            <LLMUsageStatus
              variant="compact"
              showHelp={false}
              compactWidth={115}
            />
          </div>
        )}
        {hasInput && (
          <>
            {isSelectedThreadAI ? (
              <div
                style={{
                  height: "47.5px",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <LLMUsageStatus
                  variant="compact"
                  showHelp={false}
                  compactWidth={115}
                />
              </div>
            ) : (
              <div />
            )}
            <div style={{ height: "5px" }} />
            <Tooltip
              title={
                isZenMode
                  ? "Exit zen mode"
                  : "Expand composer for focused writing"
              }
            >
              <Button
                size="small"
                onClick={toggleZenMode}
                style={{ marginBottom: "5px" }}
                icon={<Icon name="expand-arrows" />}
              >
                {isZenMode ? "Exit Zen" : "Zen"}
              </Button>
            </Tooltip>
            <Tooltip
              title={
                <FormattedMessage
                  id="chatroom.chat_input.send_button.tooltip"
                  defaultMessage={"Send message (shift+enter)"}
                />
              }
            >
              <Button
                onClick={() => sendMessage()}
                disabled={!hasInput}
                type="primary"
                icon={<Icon name="paper-plane" />}
              >
                <FormattedMessage
                  id="chatroom.chat_input.send_button.label"
                  defaultMessage={"Send"}
                />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
