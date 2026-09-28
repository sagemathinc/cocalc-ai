/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import {
  collaborationReferenceLabel,
  encodeCollaborationReference,
  serializeCollaborationReference,
} from "@cocalc/util/collaboration-references";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  openResolvedCollaborationReference,
  resolveCollaborationReference,
} from "@cocalc/frontend/collaborators/reference-picker-api";
import { register } from "./register";
import type { RenderElementProps, SlateElement } from "./register";

export interface CollaborationReferenceElement extends SlateElement {
  type: "collaboration-reference";
  reference: CollaborationReference;
  isInline: true;
  isVoid: true;
}

export function createCollaborationReference(
  reference: CollaborationReference,
): CollaborationReferenceElement {
  return {
    type: "collaboration-reference",
    reference,
    isInline: true,
    isVoid: true,
    children: [{ text: "" }],
  };
}

export function CollaborationReferenceLink({
  reference,
}: {
  reference: CollaborationReference;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const key = JSON.stringify([
    accountId,
    encodeCollaborationReference(reference),
  ]);
  const activeKey = useRef(key);
  activeKey.current = key;
  const requestSequence = useRef(0);
  const [state, setState] = useState<{
    key: string;
    resource?: CollaborationResource | null;
    error?: string;
    busy?: boolean;
  }>();

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const sequence = ++requestSequence.current;
    void resolveCollaborationReference(reference).then(
      (resource) => {
        if (!cancelled && requestSequence.current === sequence)
          setState({ key, resource });
      },
      () => {
        if (!cancelled && requestSequence.current === sequence)
          setState({
            key,
            error: "Could not check reference. Activate to retry.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  useEffect(() => {
    activeKey.current = key;
    return () => {
      activeKey.current = "";
    };
  }, [key]);

  const current = state?.key === key ? state : undefined;
  const resource = current?.resource;
  const label = resource
    ? resource.personal?.alias
      ? `@${resource.personal.alias}`
      : resource.title || resource.kind
    : collaborationReferenceLabel(reference);
  const kind =
    reference.target.kind === "conversation"
      ? "conversation"
      : reference.target.kind;
  async function open() {
    const sequence = ++requestSequence.current;
    setState({ key, resource, busy: true });
    try {
      // Always authorize again: display metadata may predate a membership removal.
      const resolved = await resolveCollaborationReference(reference);
      if (activeKey.current !== key || requestSequence.current !== sequence)
        return;
      setState({ key, resource: resolved });
      if (resolved)
        await openResolvedCollaborationReference(
          resolved,
          () =>
            activeKey.current === key && requestSequence.current === sequence,
        );
    } catch {
      if (activeKey.current === key && requestSequence.current === sequence)
        setState({
          key,
          error:
            "Reference could not be opened. It may be unavailable or you may no longer have access.",
        });
    }
  }
  async function projectAccess() {
    try {
      // Reuse the project landing page's invite acceptance and access-request
      // workflow. Opening it neither grants access nor submits a request.
      await redux
        .getActions("projects")
        .open_project({ project_id: reference.target.project_id });
    } catch {
      if (activeKey.current === key)
        setState({
          key,
          resource: null,
          error: "Could not open project access options. Try again.",
        });
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={!accountId || current?.busy}
        aria-label={`Open ${kind} ${label}`}
        aria-busy={current?.busy || undefined}
        title={`Reference only; does not send messages or grant access. Authored as ${reference.display_fallback}.`}
        onClick={() => void open()}
        style={{
          color: UI_COLORS.link,
          background: UI_COLORS.elevated,
          border: `1px solid ${UI_COLORS.border}`,
          borderRadius: 3,
          font: "inherit",
          cursor: "pointer",
          whiteSpace: "normal",
          overflowWrap: "anywhere",
        }}
      >
        {label}
      </button>
      {(resource === null || current?.error) && (
        <>
          {resource === null && (
            <span role="status"> Unavailable reference. </span>
          )}
          <button
            type="button"
            onClick={() => void projectAccess()}
            title="Open project access options to accept an invitation or request collaborator access."
          >
            Request project access
          </button>
        </>
      )}
      {current?.error && <span role="alert"> {current.error}</span>}
    </>
  );
}

function ReferenceElement({
  attributes,
  element,
  children,
}: RenderElementProps) {
  if (element.type !== "collaboration-reference")
    throw Error("Expected collaboration reference");
  const { reference } = element;
  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CollaborationReferenceLink reference={reference} />
      </span>
      {children}
    </span>
  );
}

register({
  slateType: "collaboration-reference",
  toSlate: ({ token }) => createCollaborationReference(token.reference),
  fromSlate: ({ node }) => serializeCollaborationReference(node.reference),
  Element: ReferenceElement,
  StaticElement: ReferenceElement,
});
