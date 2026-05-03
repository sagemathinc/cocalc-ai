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

export function getUserFacingListingError(error: unknown): unknown {
  const message = `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`;
  if (!message.trim()) {
    return error;
  }
  const retrySeconds = parseRetryInAboutSeconds(message);
  if (retrySeconds != null) {
    return `The project host is temporarily retrying authentication. Please wait about ${retrySeconds}s and refresh.`;
  }
  if (isTransientProjectHostAuthError(error)) {
    return "The project connection closed while the file listing was loading. Please wait a moment and refresh.";
  }
  return error;
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
