/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Input } from "antd";
import { uuid } from "@cocalc/util/misc";
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { DirectoryApi } from "./workspace-api";
import { CollaboratorsModal } from "./modal";
import { ConversationFailure } from "./conversation-failure";

export function NewConversation({
  api,
  accountId,
  project,
  onCreated,
  onClose,
  onChangeProject,
  onManageProject,
}: {
  api: DirectoryApi;
  accountId: string;
  project: { id: string; title: string };
  onCreated: (target: CollaborationTarget) => void;
  onClose: () => void;
  onChangeProject: () => void;
  onManageProject?: () => void;
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
  // Keep this across retries: a later routing failure cannot resolve an earlier timeout.
  const dispatched = useRef(false);
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
        onDispatch: () => {
          dispatched.current = true;
        },
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
        {!dispatched.current && !busy && (
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
          <ConversationFailure
            projectId={project.id}
            error={error}
            dispatched={dispatched.current}
            onManageProject={onManageProject}
          />
        )}
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
