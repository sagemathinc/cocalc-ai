/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Button, Checkbox, Input, Select } from "antd";
import type { InputRef } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationPage,
  CollaborationResource,
  CollaborationResourceKind,
} from "@cocalc/util/collaborators";
import { collaborationReferenceFromResource } from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { referencePickerApi } from "./reference-picker-api";
import type { ReferencePickerApi } from "./reference-picker-api";
import { CollaboratorsModal } from "./modal";

export interface ReferencePickerProps {
  open: boolean;
  intent?: "insert" | "share-artifact";
  conversationTitle?: string;
  projectId?: string;
  onSelect: (reference: CollaborationReference) => void;
  onClose: () => void;
  afterClose?: () => void;
  focusTriggerAfterClose?: boolean;
  api?: ReferencePickerApi;
}

/** Selecting never names, collects, opens, grants access to, or invokes a resource. */
export function ReferencePicker({
  open,
  onClose,
  afterClose,
  focusTriggerAfterClose,
  intent = "insert",
  ...props
}: ReferencePickerProps) {
  const accountId = useTypedRedux("account", "account_id");
  const searchRef = useRef<InputRef>(null);
  return (
    <CollaboratorsModal
      open={open}
      title={
        intent === "share-artifact"
          ? "Share to conversation"
          : "Insert a reference"
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
        <ReferencePickerContents
          key={accountId ?? "signed-out"}
          {...props}
          intent={intent}
          accountId={accountId}
          searchRef={searchRef}
          onClose={onClose}
        />
      )}
    </CollaboratorsModal>
  );
}

function ReferencePickerContents({
  projectId,
  onSelect,
  onClose,
  accountId,
  searchRef,
  intent = "insert",
  api = referencePickerApi(),
}: Omit<ReferencePickerProps, "open"> & {
  accountId?: string;
  searchRef: RefObject<InputRef | null>;
}) {
  const id = useId();
  const userMap = useTypedRedux("users", "user_map");
  const [search, setSearch] = useState("");
  const [allProjects, setAllProjects] = useState(false);
  const selectedProjectId = allProjects ? undefined : projectId;
  const [selectedKind, setKind] = useState<CollaborationResourceKind>();
  const kind = intent === "share-artifact" ? "artifact" : selectedKind;
  const [cursor, setCursor] = useState<{ filter: string; after: string }>();
  const [revision, setRevision] = useState(0);
  const filter = JSON.stringify([accountId, selectedProjectId, search, kind]);
  const after = cursor?.filter === filter ? cursor.after : undefined;
  const key = JSON.stringify([filter, after, revision]);
  const [state, setState] = useState<{
    key: string;
    page?: CollaborationPage<CollaborationResource>;
    error?: string;
  }>();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .listResources({
          project_id: selectedProjectId,
          search: search.trim(),
          kind,
          after,
          scope: "all",
          limit: 25,
        })
        .then(
          (page) => {
            if (!cancelled) setState({ key, page });
          },
          () => {
            if (!cancelled)
              setState({ key, error: "Could not load references. Try again." });
          },
        );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, accountId, selectedProjectId, search, kind, after, key]);

  const current = state?.key === key ? state : undefined;
  const loading = !!accountId && !current;
  const page = current?.page;
  return (
    <KeyboardBoundary boundary="collaboration-reference-picker">
      {intent === "share-artifact" ? (
        <p>
          Choose an original artifact, then choose a destination human
          conversation. Its reference will be added to that conversation's
          draft, without sending. This does not publish a copy or grant access.
        </p>
      ) : (
        <p>
          Link to existing work. In human conversations, agent references never
          send messages or start agents. References do not grant access.
        </p>
      )}
      <label htmlFor={`${id}-search`}>Search titles or aliases</label>
      <Input
        ref={searchRef}
        id={`${id}-search`}
        autoFocus
        value={search}
        maxLength={200}
        onChange={(e) => setSearch(e.target.value)}
      />
      <label htmlFor={`${id}-kind`}>Resource type</label>
      <Select<CollaborationResourceKind | "all">
        id={`${id}-kind`}
        disabled={intent === "share-artifact"}
        value={kind ?? "all"}
        onChange={(value) => setKind(value === "all" ? undefined : value)}
        style={{ width: "100%", marginBottom: 12 }}
        options={[
          { value: "all", label: "All resource types" },
          { value: "conversation", label: "Human conversations" },
          { value: "agent", label: "Agents" },
          { value: "artifact", label: "Artifacts" },
        ]}
      />
      {projectId && (
        <Checkbox
          checked={allProjects}
          onChange={(event) => setAllProjects(event.target.checked)}
        >
          Search all accessible projects
        </Checkbox>
      )}
      <h3 ref={heading} tabIndex={-1}>
        References
      </h3>
      <div role="status" aria-live="polite">
        {!accountId
          ? "Sign in to find references."
          : loading
            ? "Searching references..."
            : page
              ? `${page.items.length} references on this page.`
              : ""}
      </div>
      {current?.error && (
        <div role="alert">
          {current.error}{" "}
          <Button onClick={() => setRevision((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {page && (
        <>
          {page.coverage !== "complete" && (
            <p role="status">
              {page.coverage_message ||
                "Some resources are still being indexed. Results may be incomplete."}
            </p>
          )}
          {!page.items.length && <p>No matching references.</p>}
          <ul
            aria-label="References"
            style={{
              listStyle: "none",
              padding: 0,
              maxHeight: "40vh",
              overflowY: "auto",
            }}
          >
            {page.items.map((resource) => {
              const alias = resource.personal?.alias;
              const creatorRecord =
                userMap?.get?.(resource.created_by) ??
                userMap?.[resource.created_by ?? ""];
              const creator =
                displayNameFromUserRecord(creatorRecord) || "Unknown creator";
              const type =
                resource.kind === "conversation"
                  ? "Human conversation"
                  : resource.kind === "agent"
                    ? "Agent"
                    : "Artifact";
              return (
                <li
                  key={collaborationTargetKey(resource)}
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
                      onSelect(collaborationReferenceFromResource(resource));
                      onClose();
                    }}
                  >
                    <strong>
                      {intent === "share-artifact" ? "Share " : ""}
                      {alias ? `@${alias}: ` : ""}
                      {resource.title || type}
                    </strong>
                    <span style={{ display: "block" }}>
                      {type} / {resource.project_title || "Untitled project"} /{" "}
                      {creator}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {page.next && (
            <Button
              onClick={() => {
                setCursor({ filter, after: page.next! });
                heading.current?.focus();
              }}
            >
              Next references
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
    </KeyboardBoundary>
  );
}

export function ReferencePickerButton(
  props: Omit<ReferencePickerProps, "open" | "onClose">,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Insert reference</Button>
      <ReferencePicker {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
