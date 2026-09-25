import { useEffect, useRef, useState } from "react";
import { Alert, Input, Modal } from "antd";
import { artifactCatalogKey } from "@cocalc/util/artifact-catalog";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { useArtifactNames, normalizeArtifactName } from "./artifact-names";

export interface ArtifactNameTarget {
  projectId: string;
  chatPath: string;
  threadId: string;
  artifactId: string;
}

export async function artifactNameEntryId(target: ArtifactNameTarget) {
  const key = artifactCatalogKey(
    { project_id: target.projectId, chat_path: target.chatPath },
    { thread_id: target.threadId, artifact_id: target.artifactId },
  );
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function ArtifactNameControl({
  target,
  open,
  onClose,
}: {
  target: ArtifactNameTarget;
  open: boolean;
  onClose: () => void;
}) {
  const { names, setName } = useArtifactNames();
  const [entryId, setEntryId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const edited = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setEntryId(undefined);
    void artifactNameEntryId(target)
      .then((value) => {
        if (!cancelled) setEntryId(value);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [target.projectId, target.chatPath, target.threadId, target.artifactId]);
  const current = names.find(
    (item) =>
      item.active &&
      item.project_id === target.projectId &&
      item.entry_id === entryId,
  )?.name;
  useEffect(() => {
    if (open && !edited.current) {
      setDraft(current ?? "");
      setError("");
    }
  }, [open, current]);
  async function save() {
    if (!entryId || saving) return;
    setSaving(true);
    setError("");
    try {
      await setName(
        { project_id: target.projectId, entry_id: entryId },
        normalizeArtifactName(draft),
      );
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Modal
        open={open}
        title="Name artifact"
        okText="Save name"
        okButtonProps={{ disabled: !entryId }}
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => {
          if (!saving) onClose();
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <p>
          This name is personal to your account. Renaming keeps old links valid.
        </p>
        <label htmlFor="artifact-personal-name">Artifact name</label>
        <Input
          id="artifact-personal-name"
          value={draft}
          maxLength={32}
          autoComplete="off"
          onChange={(event) => {
            edited.current = true;
            setDraft(event.target.value);
          }}
          onPressEnter={() => void save()}
        />
        {error && (
          <Alert
            role="alert"
            type="error"
            title={error}
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
    </>
  );
}
