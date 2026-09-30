/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ProjectHostApiKeyBinding } from "./project-host-token";

export function isProjectHostApiKeySubjectAllowed({
  binding,
  subject,
  type,
}: {
  binding: ProjectHostApiKeyBinding;
  subject: string;
  type: "pub" | "sub";
}): boolean {
  if (type === "sub") {
    if (subject.startsWith(`${binding.reply_prefix}.`)) return true;
    const persistRoot = `persist.project-${binding.project_id}.`;
    const persistClient = `${persistRoot}client.`;
    const socketId = subject.slice(persistClient.length);
    if (
      binding.capabilities?.includes("project:exec") === true &&
      binding.subjects.includes(persistRoot) &&
      subject.startsWith(persistClient) &&
      socketId.length > 0 &&
      !/[.*>]/.test(socketId)
    ) {
      return true;
    }
    // Collaborative editors exchange presence on concrete per-document subjects.
    // This is not permission to subscribe to other runtime services or replies.
    const cursors = `project.${binding.project_id}.pubsub-cursors.`;
    const document = subject.slice(cursors.length);
    return (
      binding.capabilities?.includes("project:exec") === true &&
      binding.subjects.includes(cursors) &&
      subject.startsWith(cursors) &&
      document.length > 0 &&
      !/[.*>]/.test(document)
    );
  }
  if (subject.startsWith("_INBOX.") || subject.includes("*")) {
    return false;
  }
  return binding.subjects.some((allowed) =>
    allowed.endsWith(".")
      ? subject.startsWith(allowed) && subject.length > allowed.length
      : subject === allowed,
  );
}
