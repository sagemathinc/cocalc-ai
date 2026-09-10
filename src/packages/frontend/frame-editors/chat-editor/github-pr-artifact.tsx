import { Suspense, useState } from "react";
import { Alert, Button, Space } from "antd";
import type { ArtifactRecord } from "@cocalc/chat";
import { artifactGitHubPRUrl } from "@cocalc/chat";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  fetchPRCommits,
  refreshPR,
  verifyPRCommits,
} from "./github-pr-operations";

const Review = lazyWithRetry(
  () =>
    import("@cocalc/frontend/chat/git-commit-drawer").then((m) => ({
      default: m.GitCommitDrawer,
    })),
  "PR artifact review",
);

export function GitHubPRArtifact({
  artifact,
  projectId,
  sourcePath,
  historical,
  readOnly = false,
  onRefresh,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sourcePath: string;
  historical: boolean;
  readOnly?: boolean;
  onRefresh?: (
    next: Awaited<ReturnType<typeof refreshPR>>,
    expected: ArtifactRecord,
  ) => Promise<void>;
}) {
  const pr = artifact.github_pr!;
  const context = useFileContext();
  const [review, setReview] = useState(false);
  // Pin the opened review even if a later publication changes the current PR data.
  const [reviewTarget, setReviewTarget] = useState(pr);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };
  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{
        padding: 12,
        minHeight: 0,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <Space wrap>
        <strong>{artifact.title}</strong>
        <Button
          href={artifactGitHubPRUrl(pr)}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </Button>
        <Button
          disabled={!pr.local || readOnly || !!busy}
          onClick={() => {
            void perform("Checking local repository", async () => {
              const verified = await verifyPRCommits(projectId, pr);
              setReviewTarget(verified);
              setReview(true);
            });
          }}
        >
          Review locally
        </Button>
        <Button
          disabled={!onRefresh || historical || readOnly || !!busy}
          onClick={() => {
            void perform("Refreshing PR", async () => {
              if (!onRefresh) return;
              await onRefresh(await refreshPR(projectId, pr), artifact);
              setNotice(
                "PR metadata refreshed. Any open review keeps its original revisions.",
              );
            });
          }}
        >
          Refresh
        </Button>
        <Button
          disabled={!pr.local || readOnly || !!busy}
          onClick={() => {
            void perform("Fetching PR commits", async () => {
              await fetchPRCommits(projectId, pr);
              setNotice(
                "PR commits fetched. No branch or working files were changed.",
              );
            });
          }}
        >
          Fetch PR commits
        </Button>
      </Space>
      {busy && <div role="status">{busy}...</div>}
      {error && <Alert type="warning" title={error} />}
      {notice && <div role="status">{notice}</div>}
      <div>
        {pr.repository} #{pr.number} · {pr.draft ? "Draft · " : ""}
        {pr.state} · Checks: {pr.checks}
      </div>
      <div role="note">
        {historical ? "Published metadata" : "Cached metadata"} retrieved{" "}
        {pr.fetched_at}. Status may have changed on GitHub.
      </div>
      {!readOnly && !historical && (
        <div role="note">
          Refresh uses the project's GitHub credentials. Updated metadata is
          visible to this chat's collaborators.
        </div>
      )}
      {!pr.local && (
        <div role="status">
          No local repository is associated with this PR yet.
        </div>
      )}
      <div style={{ overflowWrap: "anywhere" }}>
        Base <code>{pr.base_sha}</code> → Head <code>{pr.head_sha}</code>
      </div>
      <div style={{ overflow: "auto", flex: "1 1 0", minHeight: 0 }}>
        <FileContext.Provider
          value={{
            ...context,
            noSanitize: false,
            disableMarkdownCodebar: true,
            urlTransform: (url, tag) =>
              tag?.toLowerCase() === "img"
                ? ""
                : context.urlTransform?.(url, tag),
          }}
        >
          <StaticMarkdown value={artifact.input} />
        </FileContext.Provider>
      </div>
      {review && reviewTarget.local && (
        <Suspense fallback={<div role="status">Loading Git review...</div>}>
          <Review
            open
            onClose={() => setReview(false)}
            projectId={projectId}
            sourcePath={sourcePath}
            cwdOverride={reviewTarget.local.path}
            inferCommitWorktree={false}
            commitHash={reviewTarget.head_sha}
            initialComparison={{
              commonDirectory: reviewTarget.local.common_directory,
              mode: "merge-base",
              base: reviewTarget.base_sha,
              head: reviewTarget.head_sha,
            }}
          />
        </Suspense>
      )}
    </KeyboardBoundary>
  );
}
