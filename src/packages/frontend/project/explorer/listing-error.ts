/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseRetryInAboutSeconds } from "@cocalc/conat/auth/retry-window";

export function shouldShowWrongAccountListingError(error: unknown): boolean {
  return (
    `${(error as any)?.code ?? ""}`.trim() === "403" &&
    !isTransientProjectHostAuthError(error)
  );
}

function isTransientProjectHostAuthError(error: unknown): boolean {
  const message = `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`;
  if (!message.trim()) {
    return false;
  }
  return (
    parseRetryInAboutSeconds(message) != null ||
    message.toLowerCase().includes("failed to sign in") ||
    message.toLowerCase().includes("missing project-host bearer token") ||
    message.includes('once: "ready" not emitted before "closed"') ||
    message.includes('once: "inbox" not emitted before "closed"')
  );
}
