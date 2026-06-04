/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseRetryInAboutSeconds } from "@cocalc/conat/auth/retry-window";

export function shouldShowWrongAccountListingError(error: unknown): boolean {
  return (
    `${(error as any)?.code ?? ""}`.trim() === "403" &&
    !isTransientProjectHostListingError(error)
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
  if (isTransientProjectHostListingError(error)) {
    return "The project connection closed while the file listing was loading. Please wait a moment and refresh.";
  }
  return error;
}

function isTransientProjectHostListingError(error: unknown): boolean {
  const message =
    `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`
      .trim()
      .toLowerCase();
  if (!message.trim()) {
    return false;
  }
  return (
    parseRetryInAboutSeconds(message) != null ||
    message === "closed" ||
    message === "error: closed" ||
    message.includes("connection closed") ||
    message.includes("socket has been disconnected") ||
    message.includes("disconnected") ||
    message.includes("failed to sign in") ||
    message.includes("missing project-host bearer token") ||
    message.includes('once: "ready" not emitted before "closed"') ||
    message.includes('once: "inbox" not emitted before "closed"')
  );
}
