import { Alert, Button } from "antd";
import { useEffect, useRef, useState } from "react";
import type { RepositoryDiscovery } from "@cocalc/frontend/git/read-service";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import { resolveHistorySelection } from "@cocalc/frontend/git/history-selection";
import type { GitHistorySelection } from "@cocalc/frontend/git/history-selection";

export function GitHistoryControls({
  origin,
  selection,
  disabled,
  onApply,
}: {
  origin: RepositoryDiscovery;
  selection: GitHistorySelection;
  disabled: boolean;
  onApply: (
    selection: GitHistorySelection,
    discovery: RepositoryDiscovery,
    tip: string,
  ) => void;
}) {
  const [draft, setDraft] = useState(selection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setDraft(selection);
    setError("");
    setBusy(false);
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [selection, origin, disabled]);
  const browse = async () => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await resolveHistorySelection(
        projectGitReader,
        origin,
        draft,
      );
      if (request === generation.current)
        onApply(draft, result.discovery, result.tip);
    } catch (err) {
      if (request === generation.current) setError(String(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Repository history" style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <label>
          Working copy{" "}
          <select
            aria-label="Review working copy"
            style={{ maxWidth: "min(32rem, 70vw)" }}
            disabled={disabled || busy}
            value={draft.worktree}
            onChange={(event) =>
              setDraft({ ...draft, worktree: event.target.value })
            }
          >
            {origin.worktrees.map((tree) => (
              <option
                key={tree.path}
                value={tree.path}
                disabled={tree.prunable != null}
              >
                {tree.path} (
                {tree.bare
                  ? "bare"
                  : tree.detached
                    ? "detached"
                    : tree.branch?.replace(/^refs\/heads\//, "") || "unborn"}
                {tree.locked != null ? "; locked" : ""}
                {tree.prunable != null ? "; unavailable" : ""})
              </option>
            ))}
          </select>
        </label>
        <label>
          History ref{" "}
          <select
            aria-label="History ref"
            style={{ maxWidth: "min(24rem, 70vw)" }}
            disabled={disabled || busy}
            value={draft.ref}
            onChange={(event) =>
              setDraft({ ...draft, ref: event.target.value })
            }
          >
            <option value="HEAD">Selected worktree HEAD</option>
            {draft.ref !== "HEAD" &&
              !origin.refs.some((ref) => ref.name === draft.ref) && (
                <option value={draft.ref}>
                  {draft.ref} (saved ref; no longer listed)
                </option>
              )}
            {origin.refs.map((ref) => (
              <option key={ref.name} value={ref.name}>
                {ref.name.replace(/^refs\//, "")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.firstParent}
            disabled={disabled || busy}
            onChange={(event) =>
              setDraft({ ...draft, firstParent: event.target.checked })
            }
          />{" "}
          First-parent history
        </label>
        <Button
          size="small"
          loading={busy}
          disabled={disabled}
          onClick={() => void browse()}
        >
          Browse / Refresh
        </Button>
      </div>
      <div style={{ fontSize: 12 }}>
        Browsing never checks out a branch.{" "}
        {disabled
          ? "Save or cancel active edits before changing the review context."
          : "Ref tips are pinned when you browse; refresh explicitly to load new commits."}
      </div>
      {error && (
        <Alert
          type="error"
          title="History selection failed"
          description={error}
        />
      )}
    </section>
  );
}
