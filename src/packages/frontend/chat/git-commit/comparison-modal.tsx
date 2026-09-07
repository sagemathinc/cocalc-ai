import { Alert, Modal } from "antd";
import { lazy, Suspense, useEffect, useState } from "react";
import type { GitComparisonRoute } from "@cocalc/frontend/git/review-route";
import {
  comparisonRoute,
  restoreComparisonRoute,
} from "@cocalc/frontend/git/comparison-route";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import type {
  ImmutableReviewTarget,
  RepositoryContext,
  GitSource,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import { reviewTargetKey } from "@cocalc/frontend/components/diff-viewer/review-model";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ComparisonControls } from "./comparison-controls";
import type { RequestComparisonAgentTurn } from "./comparison-feedback";

const TargetReviewPane = lazy(() =>
  import("./target-review-pane").then((module) => ({
    default: module.TargetReviewPane,
  })),
);

export function ComparisonModal({
  repository,
  commit,
  accountId,
  fontSize,
  onClose,
  onView,
  initialComparison,
  onTargetChange,
  onRequestAgentTurn,
}: {
  repository: RepositoryContext;
  commit: string;
  accountId: string;
  fontSize: number;
  onClose: () => void;
  onView: (source: GitSource) => void;
  initialComparison?: GitComparisonRoute;
  onTargetChange?: (route: GitComparisonRoute) => void;
  onRequestAgentTurn?: RequestComparisonAgentTurn;
}) {
  const [target, setTarget] = useState<ImmutableReviewTarget>();
  const [layoutReady, setLayoutReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const [restoring, setRestoring] = useState(!!initialComparison);
  const [restoreError, setRestoreError] = useState("");
  useEffect(() => {
    if (!initialComparison) return;
    let cancelled = false;
    setRestoring(true);
    setRestoreError("");
    restoreComparisonRoute(projectGitReader, repository, initialComparison)
      .then(
        (next) => {
          if (!cancelled) setTarget(next);
        },
        (error) => {
          if (!cancelled) setRestoreError(String(error));
        },
      )
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repository, initialComparison]);
  return (
    <Modal
      open
      title="Compare and review revisions"
      footer={null}
      width="95vw"
      afterOpenChange={setLayoutReady}
      onCancel={() => {
        if (editing) setCloseWarning(true);
        else onClose();
      }}
    >
      <KeyboardBoundary
        boundary="git-comparison"
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        {closeWarning && editing && (
          <Alert
            type="info"
            title="Save your review and finish the active comment before closing"
          />
        )}
        <ComparisonControls
          initialComparison={initialComparison}
          repository={repository}
          commit={commit}
          disabled={editing || restoring}
          onApply={(next) => {
            setTarget(next);
            setRestoreError("");
            onTargetChange?.(comparisonRoute(next));
          }}
        />
        {restoring && <div role="status">Restoring pinned comparison...</div>}
        {restoreError && (
          <Alert
            type="error"
            title="Cannot restore comparison"
            description={restoreError}
          />
        )}
        {/* Do not measure virtualized rows during the modal scale animation. */}
        {target && layoutReady && (
          <Suspense
            fallback={<div role="status">Loading comparison renderer...</div>}
          >
            <TargetReviewPane
              key={JSON.stringify([accountId, reviewTargetKey(target)])}
              target={target}
              accountId={accountId}
              fontSize={fontSize}
              onView={onView}
              onEditing={setEditing}
              onLeave={onClose}
              onRequestAgentTurn={onRequestAgentTurn}
            />
          </Suspense>
        )}
      </KeyboardBoundary>
    </Modal>
  );
}
