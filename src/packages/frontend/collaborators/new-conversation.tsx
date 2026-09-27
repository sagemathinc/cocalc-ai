/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Input } from "antd";
import { uuid } from "@cocalc/util/misc";
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { DirectoryApi } from "./workspace-api";
import { CollaboratorsModal } from "./modal";

export function NewConversation({
  api,
  accountId,
  project,
  onCreated,
  onClose,
  onChangeProject,
}: {
  api: DirectoryApi;
  accountId: string;
  project: { id: string; title: string };
  onCreated: (target: CollaborationTarget) => void;
  onClose: () => void;
  onChangeProject: () => void;
}) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState("");
  const operation = useRef({
    requestId: uuid(),
    title: undefined as string | undefined,
  });
  const abort = useRef(new AbortController());
  const pending = useRef(false);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current.abort();
  }, []);
  async function create() {
    if (pending.current || !title.trim()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    operation.current.title ??= title.trim();
    try {
      const { createConversation } = await import("./start-conversation");
      const target = await createConversation({
        api,
        accountId,
        projectId: project.id,
        ...operation.current,
        title: operation.current.title,
        signal: abort.current.signal,
        onProgress: setStage,
      });
      if (!abort.current.signal.aborted) onCreated(target);
    } catch (error) {
      if (!abort.current.signal.aborted) setError(String(error));
    } finally {
      pending.current = false;
      if (!abort.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <CollaboratorsModal
      open
      title="New conversation"
      onCancel={onClose}
      footer={null}
    >
      <KeyboardBoundary boundary="collaborators-new-conversation">
        {!operation.current.title && (
          <Button onClick={onChangeProject}>Change project</Button>
        )}
        <p>
          Visible to collaborators in{" "}
          <strong>{project.title || "this project"}</strong>. Starting a
          discussion may start project compute. Agent mentions are references,
          not invocations.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label htmlFor={titleId}>Conversation title</label>
          <Input
            id={titleId}
            autoFocus
            value={title}
            maxLength={200}
            disabled={busy || !!operation.current.title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="collaborators-actions">
            <Button
              htmlType="submit"
              type="primary"
              disabled={busy || !title.trim()}
            >
              {error ? "Retry same conversation" : "Start discussion"}
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </div>
        </form>
        <p role="status">{busy ? stage || "Preparing conversation..." : ""}</p>
        {error && (
          <Alert
            role="alert"
            type="error"
            title="Conversation not confirmed"
            description={
              <>
                {error}
                <p>
                  The request may have reached the project. Retry uses the same
                  room and thread identity; it does not create a duplicate
                  discussion.
                </p>
              </>
            }
          />
        )}
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
