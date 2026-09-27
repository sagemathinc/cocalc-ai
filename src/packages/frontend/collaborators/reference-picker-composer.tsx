/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Button } from "antd";
import type { ChatInputControl } from "@cocalc/frontend/chat/input";
import type { MarkdownPosition } from "@cocalc/frontend/editors/markdown-input/types";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import { ReferencePicker } from "./reference-picker";

/** Mount keyed by composer session so a picker cannot insert into another draft. */
export function ReferencePickerComposer({
  projectId,
  inputControlRef,
  allowShareToConversation = false,
  conversationTitle,
}: {
  projectId: string;
  inputControlRef: MutableRefObject<ChatInputControl | null>;
  allowShareToConversation?: boolean;
  conversationTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<"insert" | "share-artifact">("insert");
  const [error, setError] = useState("");
  const pending = useRef<
    { control: ChatInputControl; position: MarkdownPosition | null } | undefined
  >(undefined);
  const inserted = useRef(false);
  function showPicker(nextIntent: "insert" | "share-artifact") {
    const control = inputControlRef.current;
    if (!control) return;
    pending.current = { control, position: control.captureSelection() };
    inserted.current = false;
    setError("");
    setIntent(nextIntent);
    setOpen(true);
  }
  return (
    <>
      <Button size="small" onClick={() => showPicker("insert")}>
        Insert reference
      </Button>
      {allowShareToConversation && (
        <Button size="small" onClick={() => showPicker("share-artifact")}>
          Share to conversation
        </Button>
      )}
      <ReferencePicker
        open={open}
        intent={intent}
        conversationTitle={conversationTitle}
        projectId={projectId}
        onClose={() => setOpen(false)}
        afterClose={() => {
          if (inserted.current) inputControlRef.current?.focus();
        }}
        onSelect={(reference) => {
          const selection = pending.current;
          if (!selection || inputControlRef.current !== selection.control) {
            setError("The conversation changed. Select the reference again.");
            return;
          }
          inserted.current = selection.control.insertText(
            serializeCollaborationReference(reference) + " ",
            selection.position,
          );
          if (!inserted.current)
            setError("The reference could not be inserted. Try again.");
        }}
      />
      {error && <span role="alert">{error}</span>}
    </>
  );
}
