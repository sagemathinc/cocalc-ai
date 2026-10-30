/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// people_route is "", "conversations/<project_id>/<conversation_id>",
// "messages", "messages/<conversation_id>" (direct conversations),
// "collaborators" or "collaborators/<account_id>".
export function parsePeopleRoute(route?: string): {
  tab: "conversations" | "messages" | "collaborators" | "invites";
  project_id?: string;
  conversation_id?: string;
  direct_id?: string;
  account_id?: string;
} {
  const [head, a, b] = (route ?? "").split("/");
  if (head === "messages")
    return { tab: "messages", direct_id: a || undefined };
  if (head === "collaborators") return { tab: "collaborators", account_id: a };
  if (head === "invites") return { tab: "invites" };
  if (head === "conversations" && a && b) {
    return { tab: "conversations", project_id: a, conversation_id: b };
  }
  return { tab: "conversations" };
}
