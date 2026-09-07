import { Alert, Modal } from "antd";
import { lazy, Suspense, useState } from "react";
import type {
  ImmutableReviewTarget,
  RepositoryContext,
  GitSource,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import { reviewTargetKey } from "@cocalc/frontend/components/diff-viewer/review-model";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ComparisonControls } from "./comparison-controls";

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
}: {
  repository: RepositoryContext;
  commit: string;
  accountId: string;
  fontSize: number;
  onClose: () => void;
  onView: (source: GitSource) => void;
}) {
  const [target, setTarget] = useState<ImmutableReviewTarget>();
  const [editing, setEditing] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  return (
    <Modal
      open
      title="Compare and review revisions"
      footer={null}
      width="95vw"
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
          repository={repository}
          commit={commit}
          disabled={editing}
          onApply={setTarget}
        />
        {target && (
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
            />
          </Suspense>
        )}
      </KeyboardBoundary>
    </Modal>
  );
}
