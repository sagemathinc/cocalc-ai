/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { Button } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { ChatInputControl } from "@cocalc/frontend/chat/input";
import type { MarkdownPosition } from "@cocalc/frontend/editors/markdown-input/types";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { ReferencePicker } from "./reference-picker";
import { ShareConversationDialog } from "./share-dialog";
import { shareSessionIsCurrent } from "./share-to-conversation";
import type { CollaborationTarget } from "@cocalc/util/collaborators";

/** Mount keyed by composer session so a picker cannot insert into another draft. */
export function ReferencePickerComposer({
  projectId,
  inputControlRef,
  allowShareToConversation = false,
  conversationTitle,
  conversation,
  renderActions,
}: {
  projectId: string;
  inputControlRef: MutableRefObject<ChatInputControl | null>;
  allowShareToConversation?: boolean;
  conversationTitle?: string;
  conversation?: CollaborationTarget;
  renderActions?: (
    actions: { key: string; label: string; onClick: () => void }[],
  ) => ReactNode;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const [open, setOpen] = useState(false);
  const [shareReference, setShareReference] =
    useState<CollaborationReference>();
  const [shareOpen, setShareOpen] = useState(false);
  const [intent, setIntent] = useState<"insert" | "share-artifact">("insert");
  const [error, setError] = useState("");
  const pending = useRef<
    | {
        control: ChatInputControl;
        position: MarkdownPosition | null;
        accountId: string;
        isCurrent: () => boolean;
      }
    | undefined
  >(undefined);
  const inserted = useRef(false);
  function showPicker(nextIntent: "insert" | "share-artifact") {
    const control = inputControlRef.current;
    if (!control || !accountId) return;
    pending.current = {
      control,
      position: control.captureSelection(),
      accountId,
      isCurrent: shareSessionIsCurrent(accountId),
    };
    setShareReference(undefined);
    inserted.current = false;
    setError("");
    setIntent(nextIntent);
    setOpen(true);
  }
  return (
    <>
      {renderActions ? (
        renderActions([
          {
            key: "reference",
            label: "Insert link",
            onClick: () => showPicker("insert"),
          },
          ...(allowShareToConversation
            ? [
                {
                  key: "share-artifact",
                  label: "Add artifact link to another conversation",
                  onClick: () => showPicker("share-artifact"),
                },
              ]
            : []),
        ])
      ) : (
        <>
          <Button size="small" onClick={() => showPicker("insert")}>
            Insert link
          </Button>
          {allowShareToConversation && (
            <Button size="small" onClick={() => showPicker("share-artifact")}>
              Add artifact link to another conversation
            </Button>
          )}
        </>
      )}
      <ReferencePicker
        open={open}
        intent={intent}
        conversationTitle={conversationTitle}
        conversation={conversation}
        projectId={projectId}
        focusTriggerAfterClose={!shareReference && !renderActions}
        onClose={() => setOpen(false)}
        afterClose={() => {
          if (
            (inserted.current || !!renderActions) &&
            !shareReference &&
            pending.current?.isCurrent() &&
            inputControlRef.current === pending.current.control
          )
            inputControlRef.current?.focus();
        }}
        onSelect={(reference) => {
          const selection = pending.current;
          if (
            !selection ||
            !selection.isCurrent() ||
            accountId !== selection.accountId ||
            inputControlRef.current !== selection.control
          ) {
            setError("The conversation changed. Select the reference again.");
            return;
          }
          if (intent === "share-artifact") {
            setShareReference(reference);
            setShareOpen(true);
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
      {shareReference && pending.current && (
        <ShareConversationDialog
          open={shareOpen}
          accountId={pending.current.accountId}
          reference={shareReference}
          conversation={conversation}
          isCurrent={() =>
            !!pending.current?.isCurrent() &&
            inputControlRef.current === pending.current.control
          }
          onClose={() => setShareOpen(false)}
          afterClose={() => {
            if (
              pending.current?.isCurrent() &&
              inputControlRef.current === pending.current.control
            )
              inputControlRef.current?.focus();
          }}
        />
      )}
      {error && <span role="alert">{error}</span>}
    </>
  );
}
