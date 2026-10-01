/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Button } from "antd";
import type { InputRef } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ResourcePicker } from "./resource-picker";
import { collaborationReferenceFromResource } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationResource,
  CollaborationTarget,
} from "@cocalc/util/collaborators";
import { CollaboratorsModal } from "./modal";
import { openCollaborators } from "./navigation";
import { referencePickerApi } from "./reference-picker-api";
import {
  isHumanDestination,
  shareReferenceToConversation,
  shareSessionIsCurrent,
} from "./share-to-conversation";
import type { ShareConversationApi } from "./share-to-conversation";

export interface ShareConversationDialogProps {
  open: boolean;
  accountId: string;
  reference: CollaborationReference;
  api?: ShareConversationApi;
  conversation?: CollaborationTarget;
  isCurrent?: () => boolean;
  onClose: () => void;
  afterClose?: () => void;
}

export function ShareConversationDialog(props: ShareConversationDialogProps) {
  const accountId = useTypedRedux("account", "account_id");
  const search = useRef<InputRef>(null);
  return (
    <CollaboratorsModal
      open={props.open}
      title="Add link to another conversation"
      onCancel={props.onClose}
      afterClose={props.afterClose}
      footer={null}
      destroyOnHidden
      afterOpenChange={(visible) => {
        if (visible) search.current?.focus();
      }}
    >
      {props.open &&
        (accountId === props.accountId && accountId ? (
          <ShareContents
            key={JSON.stringify([accountId, props.reference])}
            {...props}
            searchRef={search}
          />
        ) : (
          <p role="alert">Your account changed. Close and reopen Share.</p>
        ))}
    </CollaboratorsModal>
  );
}

function ShareContents({
  accountId,
  reference,
  onClose,
  isCurrent: sourceIsCurrent,
  api = referencePickerApi(),
  searchRef,
  conversation,
}: ShareConversationDialogProps & { searchRef: RefObject<InputRef | null> }) {
  const [sessionCurrent] = useState(() => shareSessionIsCurrent(accountId));
  const sourceCurrent = useRef(sourceIsCurrent);
  sourceCurrent.current = sourceIsCurrent;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current && sessionCurrent() && (sourceCurrent.current?.() ?? true);
  const [selection, setSelection] = useState<CollaborationResource>();
  const selected = useRef<CollaborationResource | undefined>(undefined);
  const selectionVersion = useRef(0);
  const [completed, setCompleted] = useState<CollaborationResource>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selection || completed) heading.current?.focus();
  }, [selection, completed]);

  function choose(destination?: CollaborationResource) {
    selectionVersion.current++;
    selected.current = destination;
    setSelection(destination);
    setError("");
  }
  async function addReference() {
    if (!selection || pending.current) return;
    const destination = selection;
    const version = selectionVersion.current;
    const selectionCurrent = () =>
      current() &&
      selected.current === destination &&
      selectionVersion.current === version;
    if (!selectionCurrent()) {
      setError("The account or source changed. Close and reopen Share.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const resource = await shareReferenceToConversation({
        accountId,
        api,
        reference,
        destination,
        isCurrent: selectionCurrent,
      });
      if (selectionCurrent()) setCompleted(resource);
    } catch {
      if (selectionCurrent())
        setError("Could not add the reference. Check access and try again.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <KeyboardBoundary boundary="collaboration-share-dialog">
      <p style={{ overflowWrap: "anywhere" }}>
        Link: <strong>{reference.display_fallback}</strong>
      </p>
      <p>
        Adds a link to your draft in the selected conversation. Nothing is sent.
      </p>
      {completed ? (
        <>
          <h3 ref={heading} tabIndex={-1}>
            Link added to draft
          </h3>
          <p role="status">
            Your existing draft was preserved. Nothing was sent.
          </p>
          <Button
            type="primary"
            onClick={() => {
              if (!current()) {
                setError("Your session changed. Reopen People.");
                return;
              }
              openCollaborators({
                view: "conversations",
                projectId: completed.project_id,
                resourceKind: "conversation",
                resourceId: completed.resource_id,
              });
              onClose();
            }}
          >
            Open conversation
          </Button>
        </>
      ) : selection ? (
        <>
          <h3 ref={heading} tabIndex={-1} style={{ overflowWrap: "anywhere" }}>
            Destination: {selection.title || "Untitled conversation"}
          </h3>
          <p style={{ overflowWrap: "anywhere" }}>
            Sending this draft will make it visible to{" "}
            <strong>
              all collaborators in{" "}
              {selection.project_title || "Untitled project"}
            </strong>
            , not a private recipient list. Recipients still need access to the
            linked resource.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              onClick={() => {
                choose(undefined);
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
            >
              Choose another conversation
            </Button>
            <Button
              type="primary"
              loading={busy}
              onClick={() => void addReference()}
            >
              Add link to draft
            </Button>
          </div>
        </>
      ) : (
        <ResourcePicker
          revalidateOnSelect={false}
          accountId={accountId}
          projectId={reference.target.project_id}
          conversation={
            conversation ??
            (reference.target.kind === "conversation"
              ? reference.target
              : undefined)
          }
          kind="conversation"
          api={api}
          searchRef={searchRef}
          label="Destination conversations"
          accept={(resource) =>
            isHumanDestination(resource) &&
            collaborationTargetKey(resource) !==
              collaborationTargetKey(reference.target)
          }
          onSelect={(destination) => {
            if (!current()) {
              setError("Your session changed. Close and reopen Share.");
              return;
            }
            choose(destination);
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <Button style={{ marginTop: 12 }} onClick={onClose}>
        {completed ? "Done" : "Cancel"}
      </Button>
    </KeyboardBoundary>
  );
}

export function ShareToConversationButton({
  accountId,
  resource,
  api,
  renderTrigger,
}: {
  accountId: string;
  resource: CollaborationResource;
  api: ShareConversationApi;
  renderTrigger?: (open: () => void) => ReactNode;
}) {
  const [reference, setReference] = useState<CollaborationReference>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  function show() {
    try {
      const value = collaborationReferenceFromResource(resource);
      setReference(value);
      setOpen(true);
      setError("");
    } catch {
      setError("This resource cannot be referenced.");
    }
  }
  return (
    <>
      {renderTrigger ? (
        renderTrigger(show)
      ) : (
        <Button onClick={show}>Add link to another conversation</Button>
      )}
      {reference && (
        <ShareConversationDialog
          open={open}
          accountId={accountId}
          api={api}
          reference={reference}
          isCurrent={() =>
            collaborationTargetKey(resource) ===
            collaborationTargetKey(reference.target)
          }
          onClose={() => setOpen(false)}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
