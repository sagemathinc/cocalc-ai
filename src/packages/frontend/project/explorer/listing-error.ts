/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parseRetryInAboutSeconds } from "@cocalc/conat/auth/retry-window";
import {
  getErrorMessage,
  isProjectRootfsUnavailable,
  isProjectHostTemporarilyUnavailable,
} from "@cocalc/frontend/project/listing/project-host-errors";

export function shouldShowWrongAccountListingError(
  error: unknown,
  { archived = false }: { archived?: boolean } = {},
): boolean {
  // An archived project has no filesystem to list until it is started, so a
  // 403 there is expected; the archived notice (with Start) explains it.
  if (archived) return false;
  return (
    `${(error as any)?.code ?? ""}`.trim() === "403" &&
    !isTransientProjectHostListingError(error)
  );
}

export function getUserFacingListingError(error: unknown): unknown {
  const message = getErrorMessage(error);
  if (!message.trim()) {
    return error;
  }
  const retrySeconds = parseRetryInAboutSeconds(message);
  if (retrySeconds != null) {
    return `The project host is temporarily retrying authentication. Please wait about ${retrySeconds}s and refresh.`;
  }
  if (isProjectRootfsUnavailable(error)) {
    return "The project image is still being prepared. Files will appear automatically when the RootFS is ready.";
  }
  if (isTransientProjectHostListingError(error)) {
    return "The project connection closed while the file listing was loading. Please wait a moment.";
  }
  return error;
}

function isTransientProjectHostListingError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (!message.trim()) {
    return false;
  }
  return (
    isProjectHostTemporarilyUnavailable(error) ||
    parseRetryInAboutSeconds(message) != null ||
    message === "closed" ||
    message === "error: closed" ||
    message.includes("connection closed") ||
    message.includes("socket has been disconnected") ||
    message.includes("failed to fetch") ||
    message.includes("disconnected") ||
    message.includes("failed to sign in") ||
    message.includes("missing project-host bearer token") ||
    message.includes('once: "ready" not emitted before "closed"') ||
    message.includes('once: "inbox" not emitted before "closed"')
  );
}
