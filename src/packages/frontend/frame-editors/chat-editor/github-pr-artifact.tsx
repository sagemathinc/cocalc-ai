import { Suspense, useState } from "react";
import { Alert, Button, Space, Tooltip } from "antd";
import type { ArtifactRecord } from "@cocalc/chat";
import { artifactGitHubPRUrl } from "@cocalc/chat";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Icon } from "@cocalc/frontend/components/icon";
import { DropdownMenu } from "@cocalc/frontend/components/dropdown-menu";
import { GitHubPRStatus } from "@cocalc/frontend/chat/github-pr-status";
import type { ArtifactReviewRequest } from "@cocalc/frontend/chat/artifact-review-agent";
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
  fontSize,
  onIncreaseFontSize,
  onDecreaseFontSize,
  onRefresh,
  onRequestAgentTurn,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sourcePath: string;
  historical: boolean;
  readOnly?: boolean;
  fontSize?: number;
  onIncreaseFontSize?: () => void;
  onDecreaseFontSize?: () => void;
  onRequestAgentTurn?: ArtifactReviewRequest;
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
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <GitHubPRStatus pr={pr} historical={historical} />
        <Space wrap size={8}>
          <Button
            type="primary"
            icon={<Icon name="github" />}
            href={artifactGitHubPRUrl(pr)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on GitHub
          </Button>
          <Tooltip
            title={
              pr.local
                ? "Compare base and head in the local clone"
                : "Needs a local clone of this repository"
            }
          >
            <Button
              icon={<Icon name="fork-outlined" />}
              disabled={!pr.local || readOnly || !!busy}
              loading={busy === "Checking local repository"}
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
          </Tooltip>
          {!readOnly && !historical && (
            <Tooltip title="Refresh from GitHub using the project's GitHub credentials. The update is visible to this chat's collaborators.">
              <Button
                aria-label="Refresh"
                icon={<Icon name="refresh" />}
                disabled={!onRefresh || !!busy}
                loading={busy === "Refreshing PR"}
                onClick={() => {
                  void perform("Refreshing PR", async () => {
                    if (!onRefresh) return;
                    await onRefresh(await refreshPR(projectId, pr), artifact);
                    setNotice(
                      "PR metadata refreshed. Any open review keeps its original revisions.",
                    );
                  });
                }}
              />
            </Tooltip>
          )}
          {pr.local && !readOnly && (
            <DropdownMenu
              ariaLabel="More PR actions"
              title={<Icon name="ellipsis-vertical" />}
              disabled={!!busy}
              items={[
                {
                  key: "fetch",
                  label: "Fetch PR commits",
                  onClick: () => {
                    void perform("Fetching PR commits", async () => {
                      await fetchPRCommits(projectId, pr);
                      setNotice(
                        "PR commits fetched. No branch or working files were changed.",
                      );
                    });
                  },
                },
              ]}
            />
          )}
        </Space>
        {busy && (
          <div role="status" style={{ color: UI_COLORS.secondary }}>
            {busy}...
          </div>
        )}
        {error && <Alert type="warning" showIcon title={error} />}
        {notice && (
          <div role="status" style={{ color: UI_COLORS.secondary }}>
            {notice}
          </div>
        )}
      </div>
      <div
        style={{
          borderTop: `1px solid ${UI_COLORS.border}`,
          margin: "12px 0 4px",
        }}
      />
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
            fontSize={fontSize}
            onIncreaseFontSize={onIncreaseFontSize}
            onDecreaseFontSize={onDecreaseFontSize}
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
            onRequestAgentTurn={
              readOnly || !onRequestAgentTurn
                ? undefined
                : (prompt, options) =>
                    onRequestAgentTurn(
                      [
                        `Review of ${artifactGitHubPRUrl(reviewTarget)}`,
                        `Base: ${reviewTarget.base_sha}; head: ${reviewTarget.head_sha}`,
                        prompt,
                      ].join("\n\n"),
                      options,
                    )
            }
          />
        </Suspense>
      )}
    </KeyboardBoundary>
  );
}
