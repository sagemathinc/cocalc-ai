/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// We keep chat draft text private in AKV via the shared draft controller.
// Syncdb draft rows are still used for lightweight composing presence only,
// so collaborators see "is writing..." without receiving draft content.

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useDebouncedCallback } from "use-debounce";
import { CSS, redux } from "@cocalc/frontend/app-framework";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import type { ImmerDB } from "@cocalc/sync/editor/immer-db";
import { SubmitMentionsRef } from "./types";

interface Props {
  on_send: (value: string) => void;
  onChange: (value: string) => void;
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
}

type HistoryEntry = {
  value: string;
  cursor?: { line: number; ch: number };
  at: number;
};

const HISTORY_GROUP_MS = 250;

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
}: Props) {
  const intl = useIntl();
  const { project_id } = useFrameContext();
  const sender_id = useMemo(
    () => redux.getStore("account").get_account_id(),
    [],
  );
  const controlRef = useRef<any>(null);
  const [input, setInput] = useState<string>(propsInput ?? "");
  const isFocusedRef = useRef<boolean>(false);
  const historyRef = useRef<HistoryEntry[]>([
    { value: propsInput ?? "", at: Date.now() },
  ]);
  const historyIndexRef = useRef<number>(0);
  const applyingHistoryRef = useRef(false);
  const postSendGhostTextRef = useRef<string | null>(null);
  const suppressPropSyncAfterSendRef = useRef<boolean>(false);

  useEffect(() => {
    const next = propsInput ?? "";
    if (suppressPropSyncAfterSendRef.current) {
      // Right after send, parent props can briefly lag with old text.
      // Ignore those stale values until parent catches up to cleared state.
      if (next !== "") {
        return;
      }
      suppressPropSyncAfterSendRef.current = false;
    }
    if (next !== input) {
      if (next === "" && input !== "") {
        postSendGhostTextRef.current = input;
      }
      setInput(next);
      historyRef.current = [{ value: next, at: Date.now() }];
      historyIndexRef.current = 0;
    }
  }, [propsInput, input]);

  const savePresence = useDebouncedCallback(
    (value: string) => {
      if (!syncdb) return;
      const composing = value.trim().length > 0;
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
    SAVE_DEBOUNCE_MS,
    { leading: false, trailing: true },
  );

  useEffect(() => {
    return () => {
      savePresence.cancel();
    };
  }, [savePresence]);

  const publishNotComposing = () => {
    if (!syncdb) return;
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
    onChange(value);
    savePresence(value);
    const pos = entry.cursor ?? markdownEndPosition(value);
    setTimeout(() => {
      controlRef.current?.setSelectionFromMarkdownPosition?.(pos);
    }, 0);
    applyingHistoryRef.current = false;
  };

  return (
    <MarkdownInput
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
        const ghost = postSendGhostTextRef.current;
        if (ghost != null) {
          // After send, the editor can emit stale callbacks with the just-sent value.
          // Ignore those until we see any different value.
          if (input === "" && value === ghost) return;
          if (value !== ghost) {
            postSendGhostTextRef.current = null;
          }
        }
        setInput(value);
        onChange(value);
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
        postSendGhostTextRef.current = value;
        suppressPropSyncAfterSendRef.current = true;
        savePresence.cancel();
        controlRef.current?.allowNextValueUpdateWhileFocused?.();
        setInput("");
        onChange("");
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
