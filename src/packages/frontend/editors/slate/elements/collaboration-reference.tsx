/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "antd";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import {
  collaborationReferenceLabel,
  encodeCollaborationReference,
  serializeCollaborationReference,
} from "@cocalc/util/collaboration-references";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ProjectAccessDialog } from "@cocalc/frontend/project/access";
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

async function checkReference(reference: CollaborationReference) {
  let lookupFailed = false;
  try {
    const resource = await resolveCollaborationReference(reference);
    if (resource) return { resource };
  } catch {
    lookupFailed = true;
  }
  // A missing resource can also mean deleted/archived content or a network
  // failure. Only claim missing project access after the access API confirms it.
  try {
    const access =
      await webapp_client.project_collaborators.get_access_landing_info({
        project_id: reference.target.project_id,
      });
    if (access.relationship === "none")
      return { resource: null, noProjectAccess: true };
  } catch {
    // Keep the generic retry state; never expose raw server error metadata.
  }
  return {
    resource: null,
    error: lookupFailed
      ? "Could not load this link. Check your connection and try again."
      : undefined,
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
  const [accessDialogKey, setAccessDialogKey] = useState<string>();
  const [state, setState] = useState<{
    key: string;
    resource?: CollaborationResource | null;
    error?: string;
    busy?: boolean;
    noProjectAccess?: boolean;
  }>();

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const sequence = ++requestSequence.current;
    void checkReference(reference).then((result) => {
      if (!cancelled && requestSequence.current === sequence)
        setState({ key, ...result });
    });
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
  async function open(navigate = true) {
    const sequence = ++requestSequence.current;
    setState({ ...current, key, resource, busy: true });
    try {
      // Always authorize again: display metadata may predate a membership removal.
      const result = await checkReference(reference);
      if (activeKey.current !== key || requestSequence.current !== sequence)
        return;
      setState({ key, ...result });
      if (result.resource && navigate)
        await openResolvedCollaborationReference(
          result.resource,
          () =>
            activeKey.current === key && requestSequence.current === sequence,
        );
    } catch {
      if (activeKey.current === key && requestSequence.current === sequence)
        setState({
          key,
          error: "Could not open this link. Try again.",
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
      {current?.noProjectAccess ? (
        <>
          <span role="status"> You do not have access to this project. </span>
          <Button size="small" onClick={() => setAccessDialogKey(key)}>
            Request access
          </Button>
        </>
      ) : current?.error ? (
        <>
          <span role="alert"> {current.error} </span>
          <Button
            size="small"
            disabled={current.busy}
            onClick={() => void open()}
          >
            Retry
          </Button>
        </>
      ) : resource === null ? (
        <span role="status">
          {" "}
          This content is unavailable or you no longer have access.{" "}
        </span>
      ) : null}
      <ProjectAccessDialog
        projectId={reference.target.project_id}
        open={accessDialogKey === key}
        onClose={() => {
          setAccessDialogKey(undefined);
          void open(false);
        }}
      />
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
