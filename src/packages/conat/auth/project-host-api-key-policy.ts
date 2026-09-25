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
    return subject.startsWith(`${binding.reply_prefix}.`);
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
