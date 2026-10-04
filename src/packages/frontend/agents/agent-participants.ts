/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agents shared by several people. An agent is a chat thread; each person who
// names it gets it in their own sidebar. Sharing never writes anyone else's
// state: people are invited with a mention notification that opens the
// thread, where they choose "Add to my agents" themselves.

import { redux } from "@cocalc/frontend/app-framework";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { original_path } from "@cocalc/util/misc";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

let requested: string[] = [];

/** Open the New Agent page with these people already chosen. */
export function openNewAgentWith(account_ids: string[]): void {
  requested = [...new Set(account_ids)];
  redux.getActions("page").setState({
    active_agent_id: "new",
    active_agent_name: undefined,
  } as any);
  set_url(getPageUrlPath({ page: "agents", agent_id: "new" }));
  void redux.getActions("page").set_active_tab("agents", false);
}

/** The people requested for the next new agent (read once). */
export function takeRequestedParticipants(): string[] {
  const ids = requested;
  requested = [];
  return ids;
}

/** Whether every one of these accounts is an owner or collaborator. */
export function projectIncludesAll(
  project: any,
  account_ids: readonly string[],
): boolean {
  if (project == null || project.get?.("deleted")) return false;
  return account_ids.every((id) => {
    const group = project.getIn?.(["users", id, "group"]);
    return group === "owner" || group === "collaborator";
  });
}

/** The most recently edited project shared with all of these people. */
export function mostRecentSharedProject(
  project_map: any,
  account_ids: readonly string[],
): string | undefined {
  let best: { id: string; at: number } | undefined;
  project_map?.forEach((project, project_id: string) => {
    if (!projectIncludesAll(project, account_ids)) return;
    const at = new Date(project.get("last_edited") ?? 0).valueOf() || 0;
    if (!best || at > best.at) best = { id: project_id, at };
  });
  return best?.id;
}

function agentUrl(project_id: string, path: string, thread_id: string) {
  const base = `${location.origin}${appBasePath === "/" ? "" : appBasePath}`;
  return `${base}/projects/${project_id}/files/${original_path(path)}#${Fragment.encode({ thread: thread_id })}`;
}

/**
 * Invite people who aren't collaborators yet to the agent's project. They
 * accept the project invitation as usual; its message links to the agent,
 * where they choose "Add to my agents". Returns who was invited.
 */
export async function inviteToAgentProject({
  project_id,
  path,
  thread_id,
  agent_name,
  account_ids,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  agent_name: string;
  account_ids: string[];
}): Promise<string[]> {
  const me =
    (redux.getStore("account")?.get("first_name") as string | undefined) ??
    "A collaborator";
  const message = `${me} shared the agent @${agent_name} with you in this project. After you accept, open it here and choose "Add to my agents": ${agentUrl(project_id, path, thread_id)}`;
  const invited: string[] = [];
  for (const invitee_account_id of account_ids) {
    try {
      await webapp_client.conat_client.hub.projects.createCollabInvite({
        project_id,
        invitee_account_id,
        message,
        browser_id: webapp_client.browser_id,
      });
      invited.push(invitee_account_id);
    } catch (err) {
      console.warn("agent project invitation failed", err);
    }
  }
  return invited;
}

/**
 * Invite people to an agent: a mention notification (in the app, and by
 * email for people who enabled it) that opens the agent's thread. Only
 * collaborators on the project can be notified; returns who was.
 */
export async function inviteToAgent({
  project_id,
  path,
  thread_id,
  agent_name,
  account_ids,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  agent_name: string;
  account_ids: string[];
}): Promise<string[]> {
  if (account_ids.length === 0) return [];
  const me =
    (redux.getStore("account")?.get("first_name") as string | undefined) ??
    "A collaborator";
  const result =
    await webapp_client.conat_client.hub.notifications.createMention({
      source_project_id: project_id,
      source_path: original_path(path),
      source_fragment_id: Fragment.encode({ thread: thread_id }),
      target_account_ids: account_ids,
      description: `${me} shared the agent @${agent_name} with you. Open it and choose "Add to my agents" to keep it in your sidebar.`,
    });
  return (result.targets ?? []).map((target) => target.target_account_id);
}
