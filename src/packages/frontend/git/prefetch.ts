/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Reading a commit's diff ahead of time, when the browser is idle, so the
// next one opens at once: its reads land in the reader's caches.

import type { RepositoryContext } from "@cocalc/frontend/components/diff-viewer/review-model";
import type { GitReadService } from "./read-service";
import { readTargetDiff } from "./read-target-diff";

type Reader = Pick<
  GitReadService,
  "pinCommit" | "changedFiles" | "patch" | "commitSummary"
>;

const whenIdle = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 2_000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 300);
  return () => clearTimeout(id);
};

/** Returns a cancel; failures are ignored (it is only a head start). */
export function prefetchCommitDiff(
  reader: Reader,
  repository: RepositoryContext,
  commit: string | null | undefined,
  context: number,
  schedule: (run: () => void) => () => void = whenIdle,
): () => void {
  if (!commit) return () => {};
  return schedule(() => {
    void (async () => {
      try {
        const target = await reader.pinCommit(repository, commit);
        await readTargetDiff(reader, target, context);
      } catch {
        // Opening it later reads it, and says what went wrong then.
      }
    })();
  });
}
