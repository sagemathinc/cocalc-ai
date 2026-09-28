/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { ConversationSearch } from "../chat/conversation-search/search";
import type { ConversationSearchHit } from "../chat/conversation-search/runner";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";

export async function humanSearchTargets(
  api: DirectoryApi,
  { projectId, after }: { projectId?: string; after?: string },
) {
  // Content queries never become directory title filters, and the current
  // directory page / "For you" scope must not restrict global search.
  const page = await api.listResources({
    kind: "conversation",
    scope: "all",
    project_id: projectId,
    after,
    limit: 50,
  });
  return {
    targets: page.items.map((resource) => ({
      id: collaborationTargetKey(resource),
      project_id: resource.project_id,
      path: resource.chat_path,
      thread_id: resource.thread_id,
      title: resource.personal?.alias
        ? `@${resource.personal.alias} \u00b7 ${resource.title || "Untitled conversation"}`
        : resource.title || "Untitled conversation",
      project_title: resource.project_title,
      activity: resource.activity,
    })),
    next: page.next,
    notice:
      page.coverage !== "complete"
        ? "Search covers conversations currently available in the directory. Some conversations may be missing."
        : undefined,
  };
}

export function HumanConversationSearch({
  api,
  accountId,
  active,
  projects,
  onSelect,
}: {
  api: DirectoryApi;
  accountId: string;
  active: boolean;
  projects: { value: string; label: string }[];
  onSelect: (
    resource: CollaborationResource,
    hit: ConversationSearchHit,
  ) => void;
}) {
  return (
    <ConversationSearch
      accountId={accountId}
      scope="human"
      active={active}
      projects={projects}
      loadTargets={(options) => humanSearchTargets(api, options)}
      onSelect={async (hit) => {
        const [project_id, kind, resource_id] = JSON.parse(hit.target.id);
        const resource = await api.getResource({
          project_id,
          kind,
          resource_id,
        });
        if (
          !resource ||
          resource.kind !== "conversation" ||
          resource.chat_path !== hit.target.path ||
          resource.thread_id !== hit.threadId
        )
          throw Error(
            "This conversation changed or is unavailable. Search again.",
          );
        onSelect(resource, hit);
      }}
    />
  );
}
