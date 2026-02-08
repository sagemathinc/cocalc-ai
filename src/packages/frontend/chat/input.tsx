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

  useEffect(() => {
    const next = propsInput ?? "";
    if (next !== input) {
      setInput(next);
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
        setInput(value);
        onChange(value);
        savePresence(value);
      }}
      onShiftEnter={(value) => {
        savePresence.cancel();
        controlRef.current?.allowNextValueUpdateWhileFocused?.();
        setInput("");
        onChange("");
        publishNotComposing();
        on_send(value);
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

