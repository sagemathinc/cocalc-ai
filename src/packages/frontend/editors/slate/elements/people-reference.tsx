/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import { Button } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  serializePeopleReference,
  type PeopleReference,
} from "@cocalc/util/people-references";
import { register } from "./register";
import type { RenderElementProps, SlateElement } from "./register";

export interface PeopleReferenceElement extends SlateElement {
  type: "people-reference";
  reference: PeopleReference;
  isInline: true;
  isVoid: true;
}

export function createPeopleReference(
  reference: PeopleReference,
): PeopleReferenceElement {
  return {
    type: "people-reference",
    reference,
    isInline: true,
    isVoid: true,
    children: [{ text: "" }],
  };
}

// Resolve through the normal, access-checked APIs. Returns false when the
// target is unavailable to this account.
export async function openPeopleReference(
  reference: PeopleReference,
): Promise<boolean> {
  const hub = webapp_client.conat_client.hub;
  const { kind, project_id, id } = reference;
  try {
    if (kind === "conversation") {
      const c = await hub.people.getConversation({
        project_id,
        conversation_id: id,
      });
      if (!c) return false;
      const page = redux.getActions("page");
      page.setState({ people_route: `conversations/${project_id}/${id}` });
      await page.set_active_tab("people");
      return true;
    }
    if (kind === "artifact") {
      const entry = await hub.artifactCatalog.getEntry({
        project_id,
        entry_id: id,
      });
      if (!entry) return false;
      const { openLibrary } =
        await import("@cocalc/frontend/agents/library-navigation");
      await openLibrary(project_id, id);
      return true;
    }
    await hub.agent.getIdentity({ project_id, agent_id: id });
    const page = redux.getActions("page");
    page.setState({ active_agent_id: id, active_agent_name: undefined });
    await page.set_active_tab("agents");
    return true;
  } catch {
    return false;
  }
}

type Status =
  | { state: "idle" | "busy" }
  | { state: "no-access"; title?: string | null; requested?: boolean }
  | { state: "unavailable" }
  | { state: "requested" };

export function PeopleReferenceLink({
  reference,
}: {
  reference: PeopleReference;
}) {
  const [status, setStatus] = useState<Status>({ state: "idle" });

  async function open() {
    setStatus({ state: "busy" });
    if (await openPeopleReference(reference)) {
      setStatus({ state: "idle" });
      return;
    }
    try {
      const info =
        await webapp_client.project_collaborators.get_access_landing_info({
          project_id: reference.project_id,
        });
      if (info.relationship === "none") {
        setStatus({
          state: "no-access",
          title: info.title,
          requested: info.pending_request != null,
        });
        return;
      }
    } catch {
      // fall through: unknown project or no information
    }
    setStatus({ state: "unavailable" });
  }

  async function requestAccess() {
    try {
      await webapp_client.project_collaborators.request_access({
        project_id: reference.project_id,
        requested_role: "collaborator",
        source: "reference",
        message: `To open: ${reference.label}`,
      });
      setStatus({ state: "requested" });
    } catch {
      setStatus({ state: "unavailable" });
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Open ${reference.kind} ${reference.label}`}
        aria-busy={status.state === "busy" || undefined}
        title={`Link to a ${reference.kind}. Opening it checks your access.`}
        onClick={() => void open()}
        style={{
          color: UI_COLORS.link,
          background: UI_COLORS.elevated,
          border: `1px solid ${UI_COLORS.border}`,
          borderRadius: 4,
          padding: "0 4px",
          font: "inherit",
          cursor: "pointer",
          overflowWrap: "anywhere",
        }}
      >
        {reference.label}
      </button>
      {status.state === "no-access" &&
        (status.requested ? (
          <span role="status"> Access requested. </span>
        ) : (
          <>
            <span role="status">
              {" "}
              This is in {status.title ? `"${status.title}"` : "a project"} you
              are not part of.{" "}
            </span>
            <Button size="small" onClick={() => void requestAccess()}>
              Request access
            </Button>
          </>
        ))}
      {status.state === "requested" && (
        <span role="status">
          {" "}
          Access requested; the owner will be notified.{" "}
        </span>
      )}
      {status.state === "unavailable" && (
        <span role="status"> This is unavailable or was removed. </span>
      )}
    </>
  );
}

function ReferenceElement({
  attributes,
  element,
  children,
}: RenderElementProps) {
  if (element.type !== "people-reference") throw Error("bug");
  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <PeopleReferenceLink reference={element.reference} />
      </span>
      {children}
    </span>
  );
}

register({
  slateType: "people-reference",
  toSlate: ({ token }) => createPeopleReference(token.reference),
  fromSlate: ({ node }) => serializePeopleReference(node.reference),
  Element: ReferenceElement,
  StaticElement: ReferenceElement,
});
