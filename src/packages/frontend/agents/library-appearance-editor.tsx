import { Suspense, lazy } from "react";
import { Alert } from "antd";
import { readArtifact } from "@cocalc/chat";
import ForeignArtifactSource from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type { EntityTheme } from "@cocalc/util/entity-theme";

const Appearance = lazy(
  () => import("@cocalc/frontend/chat/artifact-appearance-editor"),
);

export function LibraryAppearanceEditor({
  target,
  onClose,
  onSaved,
}: {
  target: ForeignArtifactTarget;
  onClose: () => void;
  onSaved?: (theme: EntityTheme, artifactTitle: string) => void;
}) {
  return (
    <ForeignArtifactSource target={target} showForeignContextWarning={false}>
      {(source) => {
        if (source.readOnly)
          return (
            <Alert
              role="alert"
              type="warning"
              title="You cannot edit this artifact's appearance."
              closable
              onClose={onClose}
            />
          );
        let artifact;
        try {
          artifact = readArtifact(source.syncdb, {
            thread_id: target.threadId,
            artifact_id: target.artifactId,
          }).artifact;
        } catch {
          return (
            <Alert
              role="alert"
              type="warning"
              title="Artifact unavailable"
              closable
              onClose={onClose}
            />
          );
        }
        return (
          <Suspense
            fallback={<div role="status">Loading appearance editor...</div>}
          >
            <Appearance
              artifact={artifact}
              syncdb={source.syncdb}
              projectId={target.projectId}
              onClose={onClose}
              onSaved={onSaved}
            />
          </Suspense>
        );
      }}
    </ForeignArtifactSource>
  );
}
