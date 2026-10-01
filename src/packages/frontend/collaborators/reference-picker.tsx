/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import { Button } from "antd";
import type { InputRef } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { collaborationReferenceFromResource } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { referencePickerApi } from "./reference-picker-api";
import type { ReferencePickerApi } from "./reference-picker-api";
import { CollaboratorsModal } from "./modal";
import { ResourcePicker } from "./resource-picker";

export interface ReferencePickerProps {
  open: boolean;
  intent?: "insert" | "share-artifact";
  conversationTitle?: string;
  conversation?: CollaborationTarget;
  projectId?: string;
  onSelect: (reference: CollaborationReference) => void;
  onClose: () => void;
  afterClose?: () => void;
  focusTriggerAfterClose?: boolean;
  api?: ReferencePickerApi;
}

export function ReferencePicker({
  open,
  onClose,
  afterClose,
  focusTriggerAfterClose,
  intent = "insert",
  conversationTitle,
  conversation,
  projectId,
  onSelect,
  api = referencePickerApi(),
}: ReferencePickerProps) {
  const accountId = useTypedRedux("account", "account_id");
  const searchRef = useRef<InputRef>(null);
  return (
    <CollaboratorsModal
      open={open}
      title={
        intent === "share-artifact"
          ? "Choose an artifact to link"
          : "Link to CoCalc content"
      }
      onCancel={onClose}
      afterClose={afterClose}
      focusable={{ focusTriggerAfterClose: focusTriggerAfterClose ?? true }}
      afterOpenChange={(visible) => {
        if (visible) searchRef.current?.focus();
      }}
      footer={<Button onClick={onClose}>Cancel</Button>}
      destroyOnHidden
    >
      {open && (
        <KeyboardBoundary boundary="collaboration-reference-picker">
          <p>
            {intent === "share-artifact" ? (
              "Choose an artifact, then a destination conversation."
            ) : (
              <>
                Adds a link to{" "}
                {conversationTitle ? (
                  <>
                    your draft in <strong>{conversationTitle}</strong>
                  </>
                ) : (
                  "your draft"
                )}
                . Nothing is sent.
              </>
            )}
          </p>
          <ResourcePicker
            key={accountId ?? "signed-out"}
            accountId={accountId}
            projectId={projectId}
            conversation={conversation}
            kind={intent === "share-artifact" ? "artifact" : undefined}
            api={api}
            searchRef={searchRef}
            onSelect={(resource) => {
              onSelect(collaborationReferenceFromResource(resource));
              onClose();
            }}
          />
        </KeyboardBoundary>
      )}
    </CollaboratorsModal>
  );
}

export function ReferencePickerButton(
  props: Omit<ReferencePickerProps, "open" | "onClose">,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Link to CoCalc content</Button>
      <ReferencePicker {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
