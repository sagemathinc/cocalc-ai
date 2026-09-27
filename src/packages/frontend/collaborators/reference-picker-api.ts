/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { redux } from "@cocalc/frontend/app-framework";

export type ReferencePickerApi = Pick<
  CollaboratorsApi,
  "listResources" | "getResource"
>;

export function referencePickerApi(): ReferencePickerApi {
  return webapp_client.conat_client.hub.collaborators;
}

export async function resolveCollaborationReference(
  reference: CollaborationReference,
  api: ReferencePickerApi = referencePickerApi(),
): Promise<CollaborationResource | null> {
  const resource = await api.getResource(reference.target);
  if (
    !resource ||
    resource.archived ||
    collaborationTargetKey(resource) !==
      collaborationTargetKey(reference.target)
  )
    return null;
  return resource;
}

/** Call only with a freshly authorized getResource result, never a list row. */
export async function openResolvedCollaborationReference(
  resource: CollaborationResource,
  isCurrent: () => boolean,
): Promise<void> {
  if (resource.kind === "artifact" && resource.entry_id) {
    const { openLibrary } =
      await import("@cocalc/frontend/agents/library-navigation");
    if (!isCurrent()) return;
    // Library shares the AI-gated Agents shell. Its existing viewer is also
    // available in Collaborators, without enabling that shell or agent execution.
    if (
      !redux.getStore("account")?.getIn(["other_settings", "openai_disabled"])
    ) {
      openLibrary(resource.project_id, resource.entry_id);
      return;
    }
  }
  const { openCollaborators } = await import("./navigation");
  if (!isCurrent()) return;
  openCollaborators({
    view: "conversations",
    projectId: resource.project_id,
    resourceKind: resource.kind,
    resourceId: resource.resource_id,
  });
}
