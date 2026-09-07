import { Alert, Button } from "antd";
import { useEffect, useRef, useState } from "react";
import type {
  RepositoryContext,
  ImmutableReviewTarget,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";

export function ComparisonControls({
  repository,
  commit,
  disabled,
  onApply,
}: {
  repository: RepositoryContext;
  commit: string;
  disabled: boolean;
  onApply: (target: ImmutableReviewTarget) => void;
}) {
  const [mode, setMode] = useState<"merge-base" | "trees" | "parent">(
    "merge-base",
  );
  const [base, setBase] = useState("");
  const [head, setHead] = useState(commit);
  const [parent, setParent] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [repository, disabled]);
  const apply = async () => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      projectGitReader.invalidateDiscovery(repository.projectId);
      const fresh = await projectGitReader.discover(
        repository.projectId,
        repository.locator,
      );
      if (fresh.repository.commonDirectory !== repository.commonDirectory)
        throw Error(
          "The working directory no longer belongs to this repository",
        );
      const target =
        mode === "parent"
          ? await projectGitReader.pinCommit(fresh.repository, head, parent - 1)
          : await projectGitReader.compare(fresh.repository, base, head, mode);
      if (request === generation.current) onApply(target);
    } catch (err) {
      if (request === generation.current) setError(String(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Compare revisions">
      <fieldset
        disabled={disabled || busy}
        style={{
          border: 0,
          padding: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <label>
          Comparison{" "}
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="merge-base">Branch contribution (merge base)</option>
            <option value="trees">Two trees</option>
            <option value="parent">Commit versus parent</option>
          </select>
        </label>
        {mode !== "parent" ? (
          <label>
            Base ref{" "}
            <input
              value={base}
              onChange={(event) => setBase(event.target.value)}
              placeholder="Choose a base explicitly"
            />
          </label>
        ) : (
          <label>
            Parent number{" "}
            <input
              type="number"
              min={1}
              value={parent}
              onChange={(event) => setParent(Number(event.target.value))}
            />
          </label>
        )}
        <label>
          Head ref{" "}
          <input
            value={head}
            onChange={(event) => setHead(event.target.value)}
          />
        </label>
        <Button
          loading={busy}
          disabled={disabled || !head || (mode !== "parent" && !base)}
          onClick={() => void apply()}
        >
          Compare / Refresh
        </Button>
      </fieldset>
      <p>
        Endpoints are pinned when you compare. No branch is checked out. An
        already merged branch may have an empty contribution; use its merge
        commit and parent instead. Squash/rebase boundaries require original
        endpoints.
      </p>
      {error && (
        <Alert type="error" title="Comparison failed" description={error} />
      )}
    </section>
  );
}
