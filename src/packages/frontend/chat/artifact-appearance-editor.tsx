import { useState } from "react";
import { ThemeEditorModal } from "@cocalc/frontend/components/theme-editor-modal";
import {
  themeDraftFromTheme,
  themeFromDraft,
} from "@cocalc/frontend/theme/types";
import { artifactKey, readArtifact, validateArtifactTheme } from "@cocalc/chat";
import type { ArtifactRecord } from "@cocalc/chat";

export default function ArtifactAppearanceEditor({
  artifact,
  syncdb,
  projectId,
  onClose,
}: {
  artifact: ArtifactRecord;
  syncdb: any;
  projectId?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    themeDraftFromTheme(artifact.theme, artifact.title),
  );
  const [error, setError] = useState("");
  const [baseTheme] = useState(() => JSON.stringify(artifact.theme));
  const [saving, setSaving] = useState(false);
  return (
    <ThemeEditorModal
      open
      title="Edit Artifact Appearance"
      value={draft}
      projectId={projectId}
      error={error}
      confirmLoading={saving}
      onChange={(patch) => setDraft((old) => ({ ...old, ...patch }))}
      onCancel={onClose}
      onSave={async () => {
        setSaving(true);
        try {
          const current = readArtifact(syncdb, artifact).artifact;
          if (JSON.stringify(current.theme) !== baseTheme)
            throw Error(
              "Appearance changed. Close and reopen to edit the latest theme.",
            );
          syncdb.set({
            ...artifactKey(artifact),
            theme: validateArtifactTheme(themeFromDraft(draft)),
          });
          syncdb.commit();
          await syncdb.save();
          onClose();
        } catch (err) {
          setError(String(err));
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}
