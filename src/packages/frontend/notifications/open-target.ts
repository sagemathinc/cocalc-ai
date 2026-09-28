/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";

/** Keep recognized chat threads in Home; other targets retain file navigation. */
export async function openNotificationTarget({
  projectId,
  path,
  threadId,
  fragmentId,
}: {
  projectId: string;
  path: string;
  threadId?: string;
  fragmentId?: FragmentId;
}): Promise<boolean> {
  const accountId = redux.getStore("account")?.get("account_id");
  const tab = redux.getStore("page")?.get("active_top_tab");
  const current = () =>
    redux.getStore("account")?.get("account_id") === accountId &&
    redux.getStore("page")?.get("active_top_tab") === tab;
  const thread = threadId ?? fragmentId?.thread;
  const { openAgentNotification } = await import("../agents/open-notification");
  if (!current()) return false;
  if (await openAgentNotification(projectId, path, thread)) return true;
  if (!current()) return false;
  if (tab === "agents" && accountId && thread && path.endsWith(".chat")) {
    const { boundCollaboratorsApi } =
      await import("../collaborators/workspace-api");
    if (!current()) return false;
    // Do not infer "human" merely from absence in the named-agent directory.
    // The existing lookup verifies both resource kind and current access.
    const resource = await boundCollaboratorsApi(accountId)
      .getResource({
        project_id: projectId,
        kind: "conversation",
        resource_id: thread,
      })
      .catch(() => undefined);
    if (!current()) return false;
    if (
      resource?.kind === "conversation" &&
      resource.project_id === projectId &&
      resource.resource_id === thread &&
      resource.thread_id === thread &&
      resource.chat_path === path
    ) {
      const { openCollaborators, withCollaboratorsAlias } =
        await import("../collaborators/navigation");
      if (!current()) return false;
      await openCollaborators(
        withCollaboratorsAlias(
          {
            view: "conversations",
            projectId,
            resourceKind: "conversation",
            resourceId: thread,
          },
          resource.personal?.alias,
        ),
      );
      return true;
    }
  }
  await ensureProjectReduxRuntime();
  if (!current()) return false;
  await redux.getProjectActions(projectId).open_file({
    path,
    chat: !!fragmentId?.chat,
    fragmentId,
  });
  return true;
}
