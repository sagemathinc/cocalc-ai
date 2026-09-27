/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(Error("Resource lookup cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function resolveCollaborationResource(
  api: DirectoryApi,
  target: CollaborationTarget,
  awaitingIndex = false,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < (awaitingIndex ? 7 : 1); attempt++) {
    if (signal?.aborted) throw Error("Resource lookup cancelled");
    const resource = await api.getResource(target);
    if (signal?.aborted) throw Error("Resource lookup cancelled");
    if (resource) {
      if (collaborationTargetKey(resource) !== collaborationTargetKey(target))
        throw Error("The directory returned a different resource.");
      return resource;
    }
    if (awaitingIndex && attempt < 6)
      await pause(Math.min(500 * 2 ** attempt, 2000), signal);
  }
  throw Error(
    awaitingIndex
      ? "The project confirmed this conversation, but its directory entry is not available yet. Retry to check indexing progress; do not create another discussion."
      : "This resource is unavailable or you no longer have access.",
  );
}
