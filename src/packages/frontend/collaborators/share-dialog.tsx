/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Button, Checkbox, Input } from "antd";
import type { InputRef } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { collaborationReferenceFromResource } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationPage,
  CollaborationResource,
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
      title="Share to conversation"
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
}: ShareConversationDialogProps & { searchRef: RefObject<InputRef | null> }) {
  const id = useId();
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
  const [search, setSearch] = useState("");
  const [allProjects, setAllProjects] = useState(false);
  const projectId = allProjects ? undefined : reference.target.project_id;
  const [cursor, setCursor] = useState<{ filter: string; after: string }>();
  const [revision, setRevision] = useState(0);
  const filter = JSON.stringify([accountId, projectId, search]);
  const after = cursor?.filter === filter ? cursor.after : undefined;
  const key = JSON.stringify([filter, after, revision]);
  const [state, setState] = useState<{
    key: string;
    page?: CollaborationPage<CollaborationResource>;
    error?: string;
  }>();
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

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!current()) return;
      void api
        .listResources({
          account_id: accountId,
          project_id: projectId,
          kind: "conversation",
          scope: "all",
          search: search.trim(),
          after,
          limit: 25,
        })
        .then(
          (page) => {
            if (!cancelled && current()) setState({ key, page });
          },
          () => {
            if (!cancelled && current())
              setState({
                key,
                error: "Could not load conversations. Try again.",
              });
          },
        );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, key, accountId, projectId, search, after]);

  const page = state?.key === key ? state.page : undefined;
  const loadError = state?.key === key ? state.error : undefined;
  const destinations = page?.items.filter(isHumanDestination);
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
        Reference: <strong>{reference.display_fallback}</strong>
      </p>
      <p>
        Add a link to an existing human conversation's private draft. Nothing is
        sent, copied, or granted access; agents are never invoked.
      </p>
      {completed ? (
        <>
          <h3 ref={heading} tabIndex={-1}>
            Reference added to draft
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
              Add reference to draft
            </Button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor={`${id}-search`}>Search conversations</label>
          <Input
            id={`${id}-search`}
            ref={searchRef}
            autoFocus
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Checkbox
            checked={allProjects}
            onChange={(event) => setAllProjects(event.target.checked)}
          >
            Search all accessible projects
          </Checkbox>
          <h3 ref={heading} tabIndex={-1}>
            Destination conversations
          </h3>
          <p role="status">
            {page
              ? `${destinations!.length} conversations on this page.`
              : loadError
                ? ""
                : "Searching conversations..."}
          </p>
          {loadError && (
            <p role="alert">
              {loadError}{" "}
              <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
            </p>
          )}
          {page && page.coverage !== "complete" && (
            <p role="status">
              {page.coverage_message ||
                "Some conversations are still being indexed. Results may be incomplete."}
            </p>
          )}
          {destinations?.length === 0 && (
            <p>No matching human conversations.</p>
          )}
          <ul
            aria-label="Destination conversations"
            style={{
              padding: 0,
              listStyle: "none",
              maxHeight: "35vh",
              overflowY: "auto",
            }}
          >
            {destinations?.map((destination) => (
              <li
                key={collaborationTargetKey(destination)}
                style={{ marginBottom: 8 }}
              >
                <button
                  type="button"
                  style={{
                    width: "100%",
                    padding: 8,
                    textAlign: "left",
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                    color: UI_COLORS.text,
                    background: UI_COLORS.elevated,
                    border: `1px solid ${UI_COLORS.border}`,
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    if (!current()) {
                      setError("Your session changed. Close and reopen Share.");
                      return;
                    }
                    choose(destination);
                  }}
                >
                  <strong>
                    {destination.personal?.alias
                      ? `@${destination.personal.alias}: `
                      : ""}
                    {destination.title || "Untitled conversation"}
                  </strong>
                  <span style={{ display: "block" }}>
                    Human conversation /{" "}
                    {destination.project_title || "Untitled project"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {page?.next && (
            <Button
              onClick={() => {
                setCursor({ filter, after: page.next! });
                heading.current?.focus();
              }}
            >
              Next conversations
            </Button>
          )}
          {after && (
            <Button
              onClick={() => {
                setCursor(undefined);
                heading.current?.focus();
              }}
            >
              First page
            </Button>
          )}
        </>
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
        <Button onClick={show}>Share to conversation</Button>
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
