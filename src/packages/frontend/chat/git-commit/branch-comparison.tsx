import { Alert, Button, Select } from "antd";
import { useEffect, useId, useRef, useState } from "react";
import type {
  RepositoryContext,
  ImmutableReviewTarget,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import type { RepositoryDiscovery } from "@cocalc/frontend/git/read-service";
import type { GitHistoryEntry } from "@cocalc/frontend/git/read-parsers";

export function BranchComparison({
  repository,
  disabled,
  onApply,
}: {
  repository: RepositoryContext;
  disabled: boolean;
  onApply: (target: ImmutableReviewTarget) => void;
}) {
  const [origin, setOrigin] = useState<RepositoryDiscovery>();
  const id = useId();
  const [branch, setBranch] = useState("HEAD");
  const [entries, setEntries] = useState<GitHistoryEntry[]>([]);
  const [tip, setTip] = useState("");
  const [base, setBase] = useState<string>();
  const [head, setHead] = useState<string>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setEntries([]);
    setBase(undefined);
    setHead(undefined);
    setTip("");
    setMore(false);
    setError("");
    setBusy(true);
    void (async () => {
      const found = await projectGitReader.discover(
        repository.projectId,
        repository.locator,
      );
      if (found.repository.commonDirectory !== repository.commonDirectory)
        throw Error("Repository changed; reopen the review");
      const resolved = await projectGitReader.resolveCommit(
        found.repository,
        branch,
      );
      const rows = await projectGitReader.history(found.repository, resolved, {
        count: 100,
        firstParent: false,
      });
      if (request !== generation.current) return;
      setOrigin(found);
      setTip(resolved);
      setEntries(rows);
      setMore(rows.length === 100);
    })()
      .catch((err) => {
        if (request === generation.current) setError(String(err));
      })
      .finally(() => {
        if (request === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [repository, branch, disabled]);
  const loadMore = async () => {
    const request = generation.current;
    setBusy(true);
    setError("");
    try {
      const rows = await projectGitReader.history(repository, tip, {
        skip: entries.length,
        count: 100,
        firstParent: false,
      });
      if (request !== generation.current) return;
      setEntries([...entries, ...rows]);
      setMore(rows.length === 100);
    } catch (err) {
      if (request === generation.current) setError(String(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  const compare = async () => {
    if (!base || !head) return;
    const request = generation.current;
    setBusy(true);
    setError("");
    try {
      const target = await projectGitReader.compare(
        repository,
        base,
        head,
        "trees",
      );
      if (request === generation.current) onApply(target);
    } catch (err) {
      if (request === generation.current) setError(String(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  const options = entries.map((entry) => ({
    value: entry.commit,
    label: `${entry.commit.slice(0, 10)} ${entry.subject}`,
    search: `${entry.commit} ${entry.subject}`,
  }));
  return (
    <section
      className="git-review-comparison"
      aria-label="Compare branch commits"
    >
      <div className="git-review-compare-field git-review-compare-branch">
        <label htmlFor={`${id}-branch`}>Branch</label>
        <Select
          id={`${id}-branch`}
          aria-label="Comparison branch"
          showSearch={{ optionFilterProp: "label" }}
          style={{ width: "100%", minWidth: 0 }}
          value={branch}
          disabled={disabled || busy}
          onChange={setBranch}
          options={[
            { value: "HEAD", label: "Current worktree branch (HEAD)" },
            ...(origin?.refs ?? [])
              .filter((ref) => /^refs\/(heads|remotes)\//.test(ref.name))
              .map((ref) => ({
                value: ref.name,
                label: `${ref.name.replace(/^refs\/(heads|remotes)\//, "")}${origin?.worktrees.some((tree) => tree.branch === ref.name) ? " (checked out)" : ""}`,
              })),
          ]}
        />
      </div>
      <div className="git-review-compare-field">
        <label htmlFor={`${id}-before`}>Before</label>
        <Select
          id={`${id}-before`}
          aria-label="Before commit"
          placeholder="Before commit"
          showSearch={{ optionFilterProp: "search" }}
          style={{ width: "100%", minWidth: 0 }}
          options={options}
          value={base}
          onChange={setBase}
          disabled={disabled || busy}
        />
      </div>
      <div className="git-review-compare-field">
        <label htmlFor={`${id}-after`}>After</label>
        <Select
          id={`${id}-after`}
          aria-label="After commit"
          placeholder="After commit"
          showSearch={{ optionFilterProp: "search" }}
          style={{ width: "100%", minWidth: 0 }}
          options={options}
          value={head}
          onChange={setHead}
          disabled={disabled || busy}
        />
      </div>
      <div className="git-review-comparison-actions">
        <Button
          type="primary"
          disabled={disabled || busy || !base || !head}
          onClick={() => void compare()}
        >
          Compare commits
        </Button>
        {more && (
          <Button
            type="link"
            disabled={disabled || busy}
            onClick={() => void loadMore()}
          >
            Load older commits
          </Button>
        )}
        <span role="status">
          {busy ? "Loading..." : `${entries.length} commits loaded`}
        </span>
      </div>
      {error && (
        <Alert
          type="error"
          title="Unable to compare commits"
          description={error}
        />
      )}
    </section>
  );
}
