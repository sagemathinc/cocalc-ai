/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Quick Navigation entries for the workspace: the Agents page, Library and
// People; Library artifacts and People conversations (pinned ones first);
// collaborators; and actions (new agent/project/artifact/conversation,
// show or hide the sidebar).

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useSyncExternalStore } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  artifactIdentity,
  catalogResults,
  sharedArtifactCatalog,
  type CatalogEntry,
} from "@cocalc/frontend/agents/artifact-catalog-store";
import { useArtifactPins } from "@cocalc/frontend/chat/use-artifact-pins";
import { useConversations } from "@cocalc/frontend/people/use-conversations";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import type { ListedConversation } from "@cocalc/util/people";
import type { Candidate, WorkspaceAction } from "./model";
import { AGENT_SIDEBAR_HIDDEN_STORAGE_KEY } from "@cocalc/frontend/agents/sidebar-storage";

const MAX_ARTIFACTS = 200;
const MAX_CONVERSATIONS = 200;

export function workspaceCandidates({
  artifacts,
  artifactPins,
  conversations,
  people,
  projectTitle,
  sidebarHidden,
}: {
  artifacts: { hit: ReturnType<typeof catalogResults>[number] }[];
  artifactPins: string[];
  conversations: ListedConversation[];
  people: { account_id: string; name: string }[];
  projectTitle: (id: string) => string;
  sidebarHidden: boolean;
}): Candidate[] {
  const items: Candidate[] = [];
  const pages: [
    Candidate["id"],
    string,
    string,
    "all-agents" | "library" | "people",
  ][] = [
    [
      "app:all-agents",
      "Agents page",
      "all agents shared with me overview",
      "all-agents",
    ],
    [
      "app:library",
      "Library",
      "artifacts documents files pull requests",
      "library",
    ],
    ["app:people", "People", "conversations collaborators invites", "people"],
  ];
  for (const [id, title, keywords, page] of pages)
    items.push({
      id,
      title,
      detail: "Sidebar",
      keywords,
      priority: 34,
      destination: { kind: "app-page", page },
    });
  const actions: [WorkspaceAction, string, string][] = [
    ["new-agent", "New agent", "create start agent"],
    ["new-project", "New project", "create project"],
    [
      "new-artifact",
      "New artifact",
      "create library document pull request decisions",
    ],
    ["new-conversation", "New conversation", "create chat people message"],
    [
      "toggle-sidebar",
      sidebarHidden ? "Show sidebar" : "Hide sidebar",
      "sidebar panel toggle collapse expand",
    ],
  ];
  for (const [action, title, keywords] of actions)
    items.push({
      id: `action:${action}`,
      title,
      detail: "Action",
      keywords,
      priority: 36,
      destination: { kind: "action", action },
    });
  for (const { hit } of artifacts.slice(0, MAX_ARTIFACTS)) {
    if (!hit.catalogEntryId) continue;
    const pinned = artifactPins.includes(artifactIdentity(hit));
    items.push({
      id: `artifact:${hit.agent.endpoint.project_id}/${hit.catalogEntryId}`,
      title: hit.hit.artifact_title || "Untitled artifact",
      detail: `Library › @${hit.agent.name} · ${hit.hit.artifact_kind ?? "artifact"}${pinned ? " · Pinned" : ""}`,
      keywords: projectTitle(hit.agent.endpoint.project_id),
      priority: pinned ? 9 : 18,
      destination: {
        kind: "artifact",
        projectId: hit.agent.endpoint.project_id,
        entryId: hit.catalogEntryId,
      },
    });
  }
  for (const c of [...conversations]
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, MAX_CONVERSATIONS))
    items.push({
      id: `conversation:${c.project_id}/${c.conversation_id}`,
      title: c.title,
      detail: `People › ${projectTitle(c.project_id)}${c.pinned ? " · Pinned" : ""}`,
      keywords: c.alias ? `@${c.alias}` : undefined,
      priority: c.pinned ? 9 : 16,
      recent: c.last_activity,
      destination: {
        kind: "conversation",
        projectId: c.project_id,
        conversationId: c.conversation_id,
      },
    });
  for (const person of people)
    items.push({
      id: `person:${person.account_id}`,
      title: person.name,
      detail: "People › Collaborator",
      priority: 26,
      destination: { kind: "person", accountId: person.account_id },
    });
  return items;
}

const EMPTY_CATALOG = { entries: [] as CatalogEntry[] };

export function useWorkspaceCandidates(
  agents: NamedAgent[],
  enabled: boolean,
): Candidate[] {
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const project_map = useTypedRedux("projects", "project_map");
  const user_map = useTypedRedux("users", "user_map");
  const catalog = accountId
    ? sharedArtifactCatalog(accountId, (opts) =>
        webapp_client.conat_client.hub.artifactCatalog.listProject(opts),
      )
    : undefined;
  const metadata = useSyncExternalStore(
    catalog?.subscribe ?? (() => () => {}),
    catalog?.get ?? (() => EMPTY_CATALOG as any),
  );
  const pins = useArtifactPins();
  const conversations = useConversations(enabled);
  if (!enabled) return [];
  const people: { account_id: string; name: string }[] = [];
  user_map?.forEach((user, account_id: string) => {
    if (account_id === accountId || !user?.get?.("collaborator")) return;
    people.push({
      account_id,
      name: displayNameFromUserRecord(user?.toJS?.() ?? user) || "Unknown",
    });
  });
  let sidebarHidden = false;
  try {
    sidebarHidden =
      localStorage.getItem(AGENT_SIDEBAR_HIDDEN_STORAGE_KEY) === "true";
  } catch {
    // default: shown
  }
  return workspaceCandidates({
    artifacts: catalogResults(metadata.entries, agents, { sort: "recent" }).map(
      (hit) => ({ hit }),
    ),
    artifactPins: pins.pins,
    conversations: conversations.conversations,
    people,
    projectTitle: (id) =>
      (project_map?.getIn([id, "title"]) as string | undefined) ?? "",
    sidebarHidden,
  });
}
