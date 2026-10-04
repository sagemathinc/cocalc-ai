/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agent chats and People conversations live in files named by an id
// (".local/share/cocalc/agents/<uuid>.chat"). A tab should say what the file
// is, not show the id.

import { redux, redux_name } from "@cocalc/frontend/app-framework";
import { useNamedAgents } from "@cocalc/frontend/agents/api";
import {
  findConversation,
  useConversationList,
} from "@cocalc/frontend/notifications/mentions/conversation-lookup";
import { normalizeConversationPath } from "@cocalc/util/people";

const ID_CHAT =
  /(^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.chat$/i;

export function isIdNamedChat(path?: string): boolean {
  return !!path && ID_CHAT.test(path);
}

function samePath(a: string, b: string): boolean {
  try {
    return normalizeConversationPath(a) === normalizeConversationPath(b);
  } catch {
    return a === b;
  }
}

export function idChatAgentTitle(
  agents: {
    name: string;
    path: string;
    thread_title?: string;
    endpoint: { project_id: string };
  }[],
  project_id: string,
  path: string,
): string | undefined {
  const agent = agents.find(
    (a) => a.endpoint.project_id === project_id && samePath(a.path, path),
  );
  if (!agent) return undefined;
  return agent.thread_title?.trim() || `@${agent.name}`;
}

// An open chat that is neither: name it by its most recently active thread.
function openChatThreadTitle(
  project_id: string,
  path: string,
): string | undefined {
  try {
    const actions: any = redux.getActions(redux_name(project_id, path));
    const index = actions?.getThreadIndex?.();
    if (!index?.size) return undefined;
    let newest: [string, number] | undefined;
    for (const [key, entry] of index) {
      const time = entry?.newestTime ?? 0;
      if (!newest || time > newest[1]) newest = [key, time];
    }
    if (!newest) return undefined;
    const name = actions.getThreadMetadata?.(newest[0], {
      threadId: newest[0],
    })?.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Titles for the id-named chat files among `paths` (others are absent).
export function useIdChatTitles(
  project_id: string,
  paths: readonly string[],
): Map<string, string> {
  const relevant = paths.filter(isIdNamedChat);
  const conversations = useConversationList(relevant.length > 0);
  const named = useNamedAgents(relevant.length > 0);
  const titles = new Map<string, string>();
  for (const path of relevant) {
    const title =
      (conversations
        ? findConversation(conversations, project_id, path)?.title
        : undefined) ??
      idChatAgentTitle(named.directory?.agents ?? [], project_id, path) ??
      openChatThreadTitle(project_id, path);
    if (title) titles.set(path, title);
  }
  return titles;
}

export function useIdChatTitle(
  project_id: string,
  path?: string,
): string | undefined {
  return useIdChatTitles(project_id, path ? [path] : []).get(path ?? "");
}
