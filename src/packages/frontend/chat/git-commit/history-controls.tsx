import { Alert, Button, Checkbox, Select } from "antd";
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
  const browse = async (choice = draft) => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await resolveHistorySelection(
        projectGitReader,
        origin,
        choice,
      );
      if (request === generation.current)
        onApply(choice, result.discovery, result.tip);
    } catch (err) {
      if (request === generation.current) setError(String(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section
      className="git-review-context"
      aria-label="Repository history"
      style={{ marginBottom: 12 }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div className="git-review-context-field">
          <label htmlFor={`${id}-ref`}>Branch / ref</label>{" "}
          <Select
            id={`${id}-ref`}
            aria-label="Branch / ref"
            showSearch={{ optionFilterProp: "label" }}
            style={{ flex: "1 1 auto", minWidth: 0 }}
            disabled={disabled || busy}
            value={draft.ref}
            onChange={(ref) => {
              const worktree = origin.worktrees.find(
                (tree) =>
                  tree.branch === ref && tree.prunable == null && !tree.bare,
              );
              const choice = {
                ...draft,
                ref,
                worktree: worktree?.path ?? draft.worktree,
              };
              setDraft(choice);
              void browse(choice);
            }}
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
                label: `${ref.name.replace(/^refs\/(heads|remotes)\//, "")}${origin.worktrees.some((tree) => tree.branch === ref.name) ? " (checked out)" : ""}`,
              })),
            ]}
          />
        </div>
        <div className="git-review-context-field git-review-worktree">
          <label htmlFor={`${id}-worktree`}>Working copy</label>{" "}
          <Select
            id={`${id}-worktree`}
            aria-label="Review working copy"
            showSearch={{ optionFilterProp: "label" }}
            style={{ flex: "1 1 auto", minWidth: 0 }}
            size="small"
            variant="borderless"
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
        <details className="git-review-disclosure">
          <summary>History options</summary>
          <Checkbox
            checked={draft.firstParent}
            disabled={disabled || busy}
            onChange={(event) =>
              setDraft({ ...draft, firstParent: event.target.checked })
            }
          >
            First-parent history
          </Checkbox>
          <p>
            Browsing never checks out a branch. Ref tips stay pinned until you
            refresh.
          </p>
        </details>
        {onShowMergesChange && (
          <Checkbox
            checked={showMerges}
            onChange={(event) => onShowMergesChange(event.target.checked)}
          >
            Show merge commits
          </Checkbox>
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
      {disabled && (
        <div style={{ fontSize: 12 }}>
          Save or cancel active edits before changing the review context.
        </div>
      )}
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
