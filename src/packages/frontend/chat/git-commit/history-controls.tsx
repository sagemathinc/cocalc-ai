import { Alert, Button, Select } from "antd";
import { useEffect, useId, useRef, useState } from "react";
import type { RepositoryDiscovery } from "@cocalc/frontend/git/read-service";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import { resolveHistorySelection } from "@cocalc/frontend/git/history-selection";
import type { GitHistorySelection } from "@cocalc/frontend/git/history-selection";

export function GitHistoryControls({
  origin,
  selection,
  disabled,
  onApply,
  showMerges = false,
  onShowMergesChange,
}: {
  origin: RepositoryDiscovery;
  selection: GitHistorySelection;
  disabled: boolean;
  showMerges?: boolean;
  onShowMergesChange?: (show: boolean) => void;
  onApply: (
    selection: GitHistorySelection,
    discovery: RepositoryDiscovery,
    tip: string,
  ) => void;
}) {
  const [draft, setDraft] = useState(selection);
  const id = useId();
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
        <div>
          <label htmlFor={`${id}-worktree`}>Working copy</label>{" "}
          <Select
            id={`${id}-worktree`}
            aria-label="Review working copy"
            showSearch={{ optionFilterProp: "label" }}
            style={{ width: "min(32rem, 70vw)" }}
            disabled={disabled || busy}
            value={draft.worktree}
            onChange={(worktree) => setDraft({ ...draft, worktree })}
            options={origin.worktrees.map((tree) => ({
              value: tree.path,
              disabled: tree.prunable != null,
              label: `${tree.path} (${
                tree.bare
                  ? "bare"
                  : tree.detached
                    ? "detached"
                    : tree.branch?.replace(/^refs\/heads\//, "") || "unborn"
              }${tree.locked != null ? "; locked" : ""}${tree.prunable != null ? "; unavailable" : ""})`,
            }))}
          />
        </div>
        <div>
          <label htmlFor={`${id}-ref`}>History ref</label>{" "}
          <Select
            id={`${id}-ref`}
            aria-label="History ref"
            showSearch={{ optionFilterProp: "label" }}
            style={{ width: "min(24rem, 70vw)" }}
            disabled={disabled || busy}
            value={draft.ref}
            onChange={(ref) => setDraft({ ...draft, ref })}
            options={[
              { value: "HEAD", label: "Selected worktree HEAD" },
              ...(draft.ref !== "HEAD" &&
              !origin.refs.some((ref) => ref.name === draft.ref)
                ? [
                    {
                      value: draft.ref,
                      label: `${draft.ref} (saved ref; no longer listed)`,
                    },
                  ]
                : []),
              ...origin.refs.map((ref) => ({
                value: ref.name,
                label: ref.name.replace(/^refs\//, ""),
              })),
            ]}
          />
        </div>
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
        {onShowMergesChange && (
          <label>
            <input
              type="checkbox"
              checked={showMerges}
              onChange={(event) => onShowMergesChange(event.target.checked)}
            />{" "}
            Show merge commits
          </label>
        )}
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
