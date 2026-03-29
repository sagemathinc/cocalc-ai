/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Chat draft text is private in AKV via the shared draft controller.
// Composer presence is published with syncdoc cursors, so it is ephemeral
// and doesn't spam chat rows.

import {
  CSSProperties,
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover } from "antd";
import { useIntl } from "react-intl";
import { useDebouncedCallback } from "use-debounce";
import { CSS } from "@cocalc/frontend/app-framework";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { lite } from "@cocalc/frontend/lite";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";
import { shouldIgnoreSentEcho, type SentEchoGuard } from "./send-echo-guard";
import { SubmitMentionsRef } from "./types";

interface Props {
  on_send: (value: string) => void;
  onChange: (value: string, sessionToken?: number) => void;
  syncdb: ImmerDB | undefined;
  date: number;
  presenceThreadKey?: string | null;
  input?: string;
  on_paste?: (e) => void;
  height?: string;
  autoGrowMinHeight?: number;
  autoGrowMaxHeight?: number;
  submitMentionsRef?: SubmitMentionsRef;
  fontSize?: number;
  hideHelp?: boolean;
  style?: CSSProperties;
  cacheId?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  editBarStyle?: CSS;
  placeholder?: string;
  autoFocus?: boolean;
  isFocused?: boolean;
  moveCursorToEndOfLine?: boolean;
  sessionToken?: number;
  fixedMode?: "markdown" | "editor";
  externalMultilinePasteAsCodeBlock?: boolean;
  inputControlRef?: MutableRefObject<ChatInputControl | null>;
  onControlReady?: (control: ChatInputControl | null) => void;
  enableUpload?: boolean;
  enableMentions?: boolean;
}

export interface ChatInputControl {
  focus: () => boolean;
}

const CHAT_INPUT_SAVE_DEBOUNCE_MS = 120;

function markdownEndPosition(value: string): { line: number; ch: number } {
  const lines = value.split("\n");
  const line = Math.max(0, lines.length - 1);
  const ch = lines[line]?.length ?? 0;
  return { line, ch };
}

export default function ChatInput({
  autoFocus,
  cacheId,
  date,
  presenceThreadKey,
  editBarStyle,
  fontSize,
  height,
  autoGrowMinHeight,
  input: propsInput,
  on_send,
  onBlur,
  onChange,
  onFocus,
  placeholder,
  style,
  submitMentionsRef,
  syncdb,
  isFocused,
  autoGrowMaxHeight,
  sessionToken,
  fixedMode,
  externalMultilinePasteAsCodeBlock,
  inputControlRef,
  onControlReady,
  enableUpload = true,
  enableMentions = true,
}: Props) {
  const intl = useIntl();
  const controlRef = useRef<any>(null);
  const [input, setInput] = useState<string>(propsInput ?? "");
  const [mode, setMode] = useState<"markdown" | "editor">(
    fixedMode ?? "editor",
  );
  const mountedRef = useRef<boolean>(true);
  const currentSessionTokenRef = useRef<number | undefined>(sessionToken);
  const previousSessionTokenRef = useRef<number | undefined>(sessionToken);
  const currentInputRef = useRef<string>(propsInput ?? "");
  const previousPropsInputRef = useRef<string>(propsInput ?? "");
  const sentEchoGuardRef = useRef<SentEchoGuard>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentSessionTokenRef.current = sessionToken;
  }, [sessionToken]);

  useEffect(() => {
    if (fixedMode != null) {
      setMode(fixedMode);
    }
  }, [fixedMode]);

  useEffect(() => {
    currentInputRef.current = input;
  }, [input]);

  const isStaleSessionCallback = useCallback((token?: number): boolean => {
    const current = currentSessionTokenRef.current;
    return token != null && current != null && token !== current;
  }, []);

  useEffect(() => {
    const next = propsInput ?? "";
    if (next !== input) {
      setInput(next);
    }
  }, [propsInput, input]);

  const resolvedPresenceThreadKey = useMemo((): string | null | undefined => {
    if (presenceThreadKey === undefined) return undefined;
    if (presenceThreadKey != null) return presenceThreadKey;
    if (date < 0) return `${-date}`;
    if (date > 0) return `${date}`;
    return null;
  }, [presenceThreadKey, date]);

  const setComposingPresence = useCallback(
    (value: string): void => {
      if (!syncdb) return;
      // In lite mode there is only one user, so cross-user presence is useless.
      if (lite) return;
      // Presence is only for the shared chat composer, not edit/reply inputs.
      if (resolvedPresenceThreadKey === undefined) return;
      const composing = value.trim().length > 0;
      syncdb.set_cursor_locs([
        {
          chat_composing: composing,
          chat_thread_key: resolvedPresenceThreadKey,
        },
      ]);
    },
    [resolvedPresenceThreadKey, syncdb],
  );

  const savePresence = useDebouncedCallback(
    setComposingPresence,
    SAVE_DEBOUNCE_MS,
    {
      leading: false,
      trailing: true,
    },
  );

  useEffect(() => {
    return () => {
      savePresence.cancel();
    };
  }, [savePresence]);

  const publishNotComposing = () => {
    if (!syncdb) return;
    if (lite) return;
    if (resolvedPresenceThreadKey === undefined) return;
    syncdb.set_cursor_locs([
      {
        chat_composing: false,
        chat_thread_key: resolvedPresenceThreadKey,
      },
    ]);
  };

  function getPlaceholder(): string {
    if (placeholder != null) return placeholder;
    return intl.formatMessage({
      id: "chat.input.placeholder",
      defaultMessage: "Ask anything...",
    });
  }

  const hasInput = (input ?? "").trim().length > 0;
  const showModeSwitch = hasInput || !!isFocused;

  const focusInput = useCallback((): boolean => {
    const control = controlRef.current;
    control?.allowNextValueUpdateWhileFocused?.();
    if (typeof control?.focus === "function") {
      return control.focus() !== false;
    }
    return (
      control?.setSelectionFromMarkdownPosition?.(
        markdownEndPosition(currentInputRef.current ?? ""),
      ) ?? false
    );
  }, []);

  const markdownHelp = (
    <div
      style={{
        maxWidth: "280px",
        fontSize: "12px",
        lineHeight: 1.5,
        color: "#555",
      }}
    >
      Use Markdown and LaTeX. You can upload or paste images, mention people
      with <code>@name</code>, and press <code>Shift+Enter</code> to send.
    </div>
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const previousSessionToken = previousSessionTokenRef.current;
    const previousPropsInput = previousPropsInputRef.current ?? "";
    previousSessionTokenRef.current = sessionToken;
    previousPropsInputRef.current = propsInput ?? "";
    if (sessionToken == null || previousSessionToken == null) return;
    if (sessionToken === previousSessionToken) return;
    if ((propsInput ?? "").length > 0) return;
    if (previousPropsInput.trim().length === 0) return;
    sentEchoGuardRef.current = {
      raw: previousPropsInput,
      trimmed: previousPropsInput.trim(),
      active: true,
    };
    const id = window.setTimeout(() => {
      focusInput();
    }, 0);
    return () => window.clearTimeout(id);
  }, [focusInput, propsInput, sessionToken]);

  useEffect(() => {
    const control: ChatInputControl = {
      focus: focusInput,
    };
    if (inputControlRef != null) {
      inputControlRef.current = control;
    }
    onControlReady?.(control);
    return () => {
      if (inputControlRef?.current?.focus === focusInput) {
        inputControlRef.current = null;
      }
      onControlReady?.(null);
    };
  }, [focusInput, inputControlRef, onControlReady]);

  return (
    <MarkdownInput
      key={`chat-input-session-${sessionToken ?? "default"}`}
      fixedMode={fixedMode}
      slateExternalMultilinePasteAsCodeBlock={externalMultilinePasteAsCodeBlock}
      autoFocus={autoFocus}
      isFocused={isFocused}
      saveDebounceMs={CHAT_INPUT_SAVE_DEBOUNCE_MS}
      onFocus={() => {
        onFocus?.();
      }}
      onBlur={() => {
        savePresence.flush?.();
        onBlur?.();
      }}
      cacheId={cacheId}
      value={input}
      controlRef={controlRef}
      enableUpload={enableUpload}
      enableMentions={enableMentions}
      submitMentionsRef={submitMentionsRef}
      onChange={(value) => {
        if (!mountedRef.current) return;
        if (isStaleSessionCallback(sessionToken)) {
          const currentInputValue = currentInputRef.current ?? "";
          const suppress = sentEchoGuardRef.current;
          if (
            shouldIgnoreSentEcho({
              suppress,
              incoming: value,
              currentInput: currentInputValue,
            })
          ) {
            return;
          }
          if (!suppress?.active || currentInputValue.trim() !== "") {
            return;
          }
          sentEchoGuardRef.current = null;
        }
        if (value === input) {
          savePresence(value);
          return;
        }
        setInput(value);
        sentEchoGuardRef.current = null;
        onChange(value, sessionToken);
        savePresence(value);
      }}
      onShiftEnter={(value) => {
        if (!mountedRef.current) return;
        if (isStaleSessionCallback(sessionToken)) {
          return;
        }
        savePresence.cancel();
        controlRef.current?.cancelPendingUploads?.();
        publishNotComposing();
        on_send(value);
      }}
      undoMode="local"
      redoMode="local"
      height={height}
      autoGrowMinHeight={autoGrowMinHeight}
      autoGrowMaxHeight={autoGrowMaxHeight}
      clampAutoGrowToHost
      placeholder={getPlaceholder()}
      fontSize={fontSize}
      hideHelp={true}
      style={style}
      editBarStyle={editBarStyle}
      overflowEllipsis={true}
      hideModeSwitch={!showModeSwitch}
      modeSwitchPlacement="toolbar"
      modeSwitchRightContent={
        mode === "markdown" ? (
          <Popover
            content={markdownHelp}
            placement="topRight"
            trigger={["hover", "click"]}
          >
            <span
              aria-label="Markdown help"
              role="button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#777",
                cursor: "pointer",
                fontSize: "13px",
                lineHeight: 1,
                fontWeight: 600,
              }}
            >
              ?
            </span>
          </Popover>
        ) : null
      }
      onModeChange={setMode}
      autoGrow
    />
  );
}
