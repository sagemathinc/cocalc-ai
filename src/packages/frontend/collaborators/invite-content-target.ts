/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import type { PeopleInvitationTarget } from "@cocalc/util/people-invitations";
import { collaborationReference } from "@cocalc/util/collaboration-references";
import { resolveCollaborationResource } from "./resource-query";
import type { DirectoryApi } from "./workspace-api";

export interface NativeInvitationSource {
  project_id: string;
  chat_path: string;
  thread_id: string;
  kind: "agent" | "artifact";
  artifact_id?: string;
}

export type InvitationContentSource =
  | CollaborationTarget
  | NativeInvitationSource;

/** Resolve the indexed identity, including copy namespaces and registered agents.
 * Source paths locate content only; they are never persisted as invitation URLs.
 */
export async function resolveInvitationContent(
  api: DirectoryApi,
  source: InvitationContentSource,
  signal?: AbortSignal,
): Promise<PeopleInvitationTarget> {
  let target: CollaborationTarget | undefined;
  if ("resource_id" in source) target = source;
  else {
    let after: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      if (signal?.aborted) throw Error("Invitation cancelled.");
      const result = await api.listProjectResources({
        project_id: source.project_id,
        kind: source.kind,
        include_archived: true,
        limit: 50,
        after,
      });
      if (signal?.aborted) throw Error("Invitation cancelled.");
      const matches = result.items.filter(
        (item) =>
          item.project_id === source.project_id &&
          item.kind === source.kind &&
          item.chat_path === source.chat_path &&
          item.thread_id === source.thread_id &&
          (source.kind !== "artifact" ||
            (!!source.artifact_id && item.artifact_id === source.artifact_id)),
      );
      if (matches.length > 1)
        throw Error("This content identity is ambiguous.");
      if (matches.length === 1) {
        target = matches[0];
        break;
      }
      if (!result.next || seen.has(result.next)) break;
      seen.add(result.next);
      after = result.next;
    }
  }
  if (!target)
    throw Error(
      "This content is not available in the directory yet. Retry after it has been indexed.",
    );
  const resource = await resolveCollaborationResource(
    api,
    {
      project_id: target.project_id,
      kind: target.kind,
      resource_id: target.resource_id,
    },
    false,
    signal,
  );
  let label = "";
  for (const character of resource.title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim() || resource.kind) {
    if (label.length + character.length > 160) break;
    label += character;
  }
  const reference = collaborationReference({
    version: 1,
    target: resource,
    display_fallback: label,
  });
  if (!reference) throw Error("This content has no valid invitation identity.");
  return { ...reference.target, label };
}
