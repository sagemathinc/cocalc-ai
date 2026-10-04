/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agent chats and People conversations live in files named by an id
// (".local/share/cocalc/agents/<uuid>.chat"). A tab should say what the file
// is, not show the id.

import { useNamedAgents } from "@cocalc/frontend/agents/api";
import { useNotificationConversation } from "@cocalc/frontend/notifications/mentions/conversation-lookup";
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

// The title for an id-named chat file, or undefined for any other file (and
// while it is being looked up).
export function useIdChatTitle(
  project_id: string,
  path?: string,
): string | undefined {
  const relevant = isIdNamedChat(path);
  const conversation = useNotificationConversation(
    relevant ? project_id : undefined,
    relevant ? path : undefined,
  );
  const named = useNamedAgents(relevant);
  if (!relevant || !path) return undefined;
  if (conversation) return conversation.title;
  return idChatAgentTitle(named.directory?.agents ?? [], project_id, path);
}
