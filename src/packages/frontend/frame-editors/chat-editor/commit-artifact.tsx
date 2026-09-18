import { Suspense, useState } from "react";
import { Alert, Button } from "antd";
import type { ArtifactRecord, ArtifactCommit } from "@cocalc/chat";
import { validateArtifactCommit } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import type { ArtifactReviewRequest } from "@cocalc/frontend/chat/artifact-review-agent";
const Review = lazyWithRetry(
  () =>
    import("@cocalc/frontend/chat/git-commit-drawer").then((m) => ({
      default: m.GitCommitDrawer,
    })),
  "commit artifact review",
);

export async function verifyArtifactCommit(
  projectId: string,
  value: ArtifactCommit,
) {
  const commit = validateArtifactCommit(value);
  const git = async (args: string[]) => {
    const result = await webapp_client.project_client.exec({
      project_id: projectId,
      path: commit.path,
      command: "git",
      args,
      bash: false,
      err_on_exit: false,
      max_output: 32768,
      timeout: 30,
    });
    if (result.exit_code !== 0)
      throw Error(
        "Commit or repository unavailable. Check the recorded worktree path; no checkout or fetch was performed.",
      );
    return result.stdout.trim();
  };
  if (
    (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
    commit.common_directory
  )
    throw Error(
      "Repository identity changed. Update this artifact's repository association before reviewing.",
    );
  await git(["cat-file", "-e", `${commit.sha}^{commit}`]);
  return commit;
}

export function CommitArtifact({
  artifact,
  projectId,
  sourcePath,
  readOnly,
  onRequestAgentTurn,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sourcePath: string;
  readOnly?: boolean;
  onRequestAgentTurn?: ArtifactReviewRequest;
}) {
  const commit = artifact.commit!;
  const [review, setReview] = useState<ArtifactCommit>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div style={{ padding: 16, overflow: "auto", overflowWrap: "anywhere" }}>
      <h3>{artifact.title}</h3>
      <p>{artifact.input}</p>
      <p>
        <code>{commit.sha}</code>
      </p>
      <p>{commit.path}</p>
      {commit.branch && <p>Branch context: {commit.branch}</p>}
      <p>Review is pinned to this commit, not the current branch HEAD.</p>
      <Button
        disabled={readOnly || busy}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setReview(await verifyArtifactCommit(projectId, commit));
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Review commit
      </Button>
      {error && <Alert type="warning" title={error} />}
      {review && (
        <Suspense fallback={<div role="status">Loading Git review...</div>}>
          <Review
            open
            onClose={() => setReview(undefined)}
            projectId={projectId}
            sourcePath={sourcePath}
            cwdOverride={review.path}
            inferCommitWorktree={false}
            commitHash={review.sha}
            onRequestAgentTurn={
              !readOnly && onRequestAgentTurn
                ? (prompt, options) =>
                    onRequestAgentTurn(
                      `Commit artifact ${artifact.artifact_id}\nRepository: ${review.common_directory}\nWorktree: ${review.path}\nCommit: ${review.sha}\n\n${prompt}`,
                      options,
                    )
                : undefined
            }
          />
        </Suspense>
      )}
    </div>
  );
}
