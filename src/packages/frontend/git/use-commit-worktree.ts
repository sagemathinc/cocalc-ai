import { useEffect, useEffectEvent, useRef, useState } from "react";
import { locateCommitWorktree } from "./commit-worktree";
import { projectGitReader } from "./project-read-service";
import type { RepositoryDiscovery } from "./read-service";

type UniqueWorktree = Extract<
  Awaited<ReturnType<typeof locateCommitWorktree>>,
  { kind: "unique" }
>;

export function useCommitWorktree({
  requestKey,
  enabled,
  blocked,
  origin,
  commit,
  onSelect,
}: {
  requestKey: string;
  enabled: boolean;
  blocked: boolean;
  origin?: RepositoryDiscovery;
  commit?: string;
  onSelect: (result: UniqueWorktree) => void;
}) {
  const attempted = useRef<string | undefined>(undefined);
  const [notice, setNotice] = useState<{
    key: string;
    message: string;
    historicalOnly: true;
    locating: boolean;
  }>();
  const select = useEffectEvent((result: UniqueWorktree, key: string) => {
    if (enabled && !blocked && key === requestKey) onSelect(result);
  });
  useEffect(() => {
    if (blocked) {
      attempted.current = requestKey;
      if (enabled)
        setNotice({
          key: requestKey,
          historicalOnly: true,
          locating: false,
          message:
            "Automatic worktree selection was interrupted. Choose a working copy explicitly; history remains read-only.",
        });
      return;
    }
    if (!enabled || !origin || !commit || attempted.current === requestKey)
      return;
    attempted.current = requestKey;
    let cancelled = false,
      finished = false;
    const report = (message: string, locating = false) =>
      setNotice({ key: requestKey, message, historicalOnly: true, locating });
    report(
      "Locating a worktree for this commit; historical viewing remains available.",
      true,
    );
    void locateCommitWorktree(projectGitReader, origin, commit)
      .then((result) => {
        if (cancelled) return;
        finished = true;
        if (result.kind === "unique") select(result, requestKey);
        else if (result.kind === "current") setNotice(undefined);
        else
          report(
            result.kind === "ambiguous"
              ? `Several worktrees contain this commit: ${result.paths.join(", ")}. Choose a working copy explicitly; history remains read-only.`
              : "No available worktree contains this commit. Historical viewing remains available; choose a working copy explicitly before requesting edits.",
          );
      })
      .catch((error) => {
        finished = true;
        if (!cancelled)
          report(`Could not determine a matching worktree: ${String(error)}`);
      });
    return () => {
      cancelled = true;
      if (!finished) {
        attempted.current = undefined;
        report(
          "Automatic worktree selection was interrupted. Choose a working copy explicitly; history remains read-only.",
        );
      }
    };
  }, [requestKey, enabled, blocked, origin, commit]);
  return enabled && notice?.key === requestKey ? notice : undefined;
}
