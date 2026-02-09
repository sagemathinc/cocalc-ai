/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Chat draft text is private in AKV via the shared draft controller.
// For main composer input (date===0), composing presence is published with
// syncdoc cursors, so it is ephemeral and doesn't spam chat rows.

import {
  CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";
import { useDebouncedCallback } from "use-debounce";
import { CSS, redux } from "@cocalc/frontend/app-framework";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { lite } from "@cocalc/frontend/lite";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";
import { SubmitMentionsRef } from "./types";

interface Props {
  on_send: (value: string) => void;
  onChange: (value: string, sessionToken?: number) => void;
  syncdb: ImmerDB | undefined;
  date: number;
  input?: string;
  on_paste?: (e) => void;
  height?: string;
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
  moveCursorToEndOfLine?: boolean;
  sessionToken?: number;
  fixedMode?: "markdown" | "editor";
}

type HistoryEntry = {
  value: string;
  cursor?: { line: number; ch: number };
  at: number;
};

const HISTORY_GROUP_MS = 250;

function debugComposerInput(...args: any[]): void {
  if (typeof window === "undefined") return;
  if (!(window as any).__CHAT_COMPOSER_DEBUG) return;
  console.log("[chat-input]", ...args);
}

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
  editBarStyle,
  fontSize,
  height,
  hideHelp,
  input: propsInput,
  on_send,
  onBlur,
  onChange,
  onFocus,
  placeholder,
  style,
  submitMentionsRef,
  syncdb,
  autoGrowMaxHeight,
  sessionToken,
  fixedMode,
}: Props) {
  const intl = useIntl();
  const { project_id } = useFrameContext();
  const sender_id = useMemo(
    () => redux.getStore("account").get_account_id(),
    [],
  );
  const controlRef = useRef<any>(null);
  const [input, setInput] = useState<string>(propsInput ?? "");
  const mountedRef = useRef<boolean>(true);
  const isFocusedRef = useRef<boolean>(false);
  const historyRef = useRef<HistoryEntry[]>([
    { value: propsInput ?? "", at: Date.now() },
  ]);
  const historyIndexRef = useRef<number>(0);
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const next = propsInput ?? "";
    debugComposerInput("prop-sync:start", {
      cacheId,
      next,
      local: input,
      sessionToken,
    });
    if (next !== input) {
      setInput(next);
      historyRef.current = [{ value: next, at: Date.now() }];
      historyIndexRef.current = 0;
      debugComposerInput("prop-sync:applied", {
        cacheId,
        next,
        prevLocal: input,
        sessionToken,
      });
    }
  }, [propsInput, input]);

  const setComposingPresence = useCallback(
    (value: string): void => {
      if (!syncdb) return;
      const composing = value.trim().length > 0;
      if (!lite && date === 0) {
        syncdb.set_cursor_locs([{ chat_composing: composing }]);
        return;
      }
      syncdb.set({
        event: "draft",
        sender_id,
        date,
        // keep content private; this row is for composing presence only.
        input: "",
        composing,
        active: composing ? Date.now() : 0,
      });
      syncdb.commit();
    },
    [date, sender_id, syncdb],
  );

  const savePresence = useDebouncedCallback(setComposingPresence, SAVE_DEBOUNCE_MS, {
    leading: false,
    trailing: true,
  });

  useEffect(() => {
    return () => {
      savePresence.cancel();
    };
  }, [savePresence]);

  const publishNotComposing = () => {
    if (!syncdb) return;
    if (!lite && date === 0) {
      syncdb.set_cursor_locs([{ chat_composing: false }]);
      return;
    }
    syncdb.set({
      event: "draft",
      sender_id,
      date,
      input: "",
      composing: false,
      active: 0,
    });
    syncdb.commit();
  };

  function getPlaceholder(): string {
    if (placeholder != null) return placeholder;
    const have_llm =
      project_id != null &&
      redux.getStore("projects").hasLanguageModelEnabled(project_id);
    return intl.formatMessage(
      {
        id: "chat.input.placeholder",
        defaultMessage: "Message (@mention)...",
      },
      { have_llm },
    );
  }

  const hasInput = (input ?? "").trim().length > 0;

  const applyHistoryValue = (entry: HistoryEntry) => {
    applyingHistoryRef.current = true;
    const value = entry.value;
    setInput(value);
    onChange(value, sessionToken);
    savePresence(value);
    const pos = entry.cursor ?? markdownEndPosition(value);
    setTimeout(() => {
      controlRef.current?.setSelectionFromMarkdownPosition?.(pos);
    }, 0);
    applyingHistoryRef.current = false;
  };

  return (
    <MarkdownInput
      fixedMode={fixedMode}
      autoFocus={autoFocus}
      saveDebounceMs={0}
      onFocus={() => {
        isFocusedRef.current = true;
        onFocus?.();
      }}
      onBlur={() => {
        isFocusedRef.current = false;
        savePresence.flush?.();
        onBlur?.();
      }}
      cacheId={cacheId}
      value={input}
      controlRef={controlRef}
      enableUpload={true}
      enableMentions={true}
      submitMentionsRef={submitMentionsRef}
      onChange={(value) => {
        if (!mountedRef.current) return;
        debugComposerInput("onChange:recv", {
          cacheId,
          value,
          local: input,
          sessionToken,
        });
        setInput(value);
        onChange(value, sessionToken);
        savePresence(value);
        if (applyingHistoryRef.current) return;
        const history = historyRef.current;
        const idx = historyIndexRef.current;
        const current = history[idx]?.value ?? "";
        if (current === value) {
          history[idx] = {
            ...(history[idx] ?? { value: current, at: Date.now() }),
            cursor: controlRef.current?.getMarkdownPositionForSelection?.(),
            at: Date.now(),
          };
          return;
        }
        const now = Date.now();
        const cursor = controlRef.current?.getMarkdownPositionForSelection?.();
        const trimmed = history.slice(0, idx + 1);
        const last = trimmed[trimmed.length - 1];
        // Group nearby edits into one undo step, rather than per-character.
        if (last && now - last.at <= HISTORY_GROUP_MS) {
          trimmed[trimmed.length - 1] = { value, cursor, at: now };
        } else {
          trimmed.push({ value, cursor, at: now });
        }
        const maxEntries = 200;
        if (trimmed.length > maxEntries) {
          trimmed.splice(0, trimmed.length - maxEntries);
        }
        historyRef.current = trimmed;
        historyIndexRef.current = trimmed.length - 1;
      }}
      onShiftEnter={(value) => {
        if (!mountedRef.current) return;
        debugComposerInput("onShiftEnter", {
          cacheId,
          value,
          local: input,
          sessionToken,
        });
        savePresence.cancel();
        controlRef.current?.allowNextValueUpdateWhileFocused?.();
        controlRef.current?.setValueNow?.("");
        setInput("");
        onChange("", sessionToken);
        historyRef.current = [{ value: "", at: Date.now() }];
        historyIndexRef.current = 0;
        publishNotComposing();
        on_send(value);
      }}
      onUndo={() => {
        const idx = historyIndexRef.current;
        if (idx <= 0) return;
        historyIndexRef.current = idx - 1;
        applyHistoryValue(
          historyRef.current[historyIndexRef.current] ?? {
            value: "",
            at: Date.now(),
          },
        );
      }}
      onRedo={() => {
        const history = historyRef.current;
        const idx = historyIndexRef.current;
        if (idx >= history.length - 1) return;
        historyIndexRef.current = idx + 1;
        applyHistoryValue(
          history[idx + 1] ?? {
            value: "",
            at: Date.now(),
          },
        );
      }}
      height={height}
      autoGrowMaxHeight={autoGrowMaxHeight}
      placeholder={getPlaceholder()}
      fontSize={fontSize}
      hideHelp={hideHelp}
      style={style}
      editBarStyle={editBarStyle}
      overflowEllipsis={true}
      hideModeSwitch={!hasInput}
      modeSwitchStyle={{
        float: "right",
        position: "relative",
        marginBottom: "-5px",
      }}
      autoGrow
    />
  );
}
