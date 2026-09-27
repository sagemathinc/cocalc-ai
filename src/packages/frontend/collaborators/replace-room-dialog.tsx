/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Alert, Button, Checkbox } from "antd";
import { uuid } from "@cocalc/util/misc";
import {
  COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { CollaboratorsModal } from "./modal";
import type { DirectoryApi } from "./workspace-api";
import { replaceConversationRoom } from "./replace-room";

export function ReplaceRoomDialog({
  api,
  accountId,
  projectId,
  projectTitle,
  onClose,
  onStart,
}: {
  api: DirectoryApi;
  accountId: string;
  projectId: string;
  projectTitle: string;
  onClose: () => void;
  onStart: () => void;
}) {
  const [request, setRequest] = useState<CollaborationRoomReplacementRequest>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CollaborationRoomReplacementResult>();
  const [savedIntent, setSavedIntent] = useState(false);
  const [registrationRead, setRegistrationRead] = useState(0);
  const [opener] = useState(() =>
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const pending = useRef(false);
  const abort = useRef(new AbortController());
  const confirmation = useRef<ComponentRef<typeof Checkbox>>(null);
  const start = useRef<ComponentRef<typeof Button>>(null);
  const retry = useRef<ComponentRef<typeof Button>>(null);
  const close = useRef<ComponentRef<typeof Button>>(null);
  const key = `collaborators:room-replacement:${accountId}:${projectId}`;
  // This dialog is conditionally mounted; Modal's close animation does not run
  // when its parent unmounts it immediately after Escape.
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus();
    },
    [opener],
  );
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    void (async () => {
      // Account/project-bound metadata only; retries survive a modal close/reload.
      const saved = sessionStorage.getItem(key);
      if (saved) {
        setSavedIntent(true);
        const intent = validateCollaborationRoomReplacementRequest(
          JSON.parse(saved),
        );
        if (intent.project_id !== projectId)
          throw Error("Saved replacement project changed.");
        if (!controller.signal.aborted) setRequest(intent);
        return;
      }
      const room = await api.getRoom({ project_id: projectId });
      if (controller.signal.aborted) return;
      if (!room || room.initialized !== true)
        throw Error(
          "No initialized conversation room is registered. Start a discussion, or retry the original replacement operation.",
        );
      setRequest(
        validateCollaborationRoomReplacementRequest({
          version: 1,
          project_id: projectId,
          request_id: uuid(),
          expected_room_id: room.room_id,
          expected_chat_path: room.chat_path,
        }),
      );
    })().catch((error) => {
      if (!controller.signal.aborted) setError(String(error));
    });
    return () => controller.abort();
  }, [api, key, projectId, registrationRead]);
  useEffect(() => {
    if (request) confirmation.current?.focus();
  }, [request]);
  useEffect(() => {
    if (result?.outcome === "ready") start.current?.focus();
    else if (result?.outcome === "superseded") close.current?.focus();
    else if (error) (request ? retry.current : close.current)?.focus();
  }, [result, error, request]);
  function reloadRegistration() {
    if (pending.current) return;
    try {
      // Forget only this browser's intent, never cancel/rewrite an owner receipt.
      sessionStorage.removeItem(key);
    } catch (error) {
      setError(String(error));
      return;
    }
    abort.current.abort();
    setRequest(undefined);
    setConfirmed(false);
    setResult(undefined);
    setError("");
    setSavedIntent(false);
    setRegistrationRead((value) => value + 1);
  }
  async function replace() {
    if (!request || !confirmed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const controller = abort.current;
    try {
      sessionStorage.setItem(key, JSON.stringify(request));
      setSavedIntent(true);
      const value = await replaceConversationRoom({
        accountId,
        request,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setResult(value);
      if (value.outcome !== "pending") {
        sessionStorage.removeItem(key);
        setSavedIntent(false);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(String(error));
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <CollaboratorsModal
      open
      title="Replace deleted conversation room"
      onCancel={onClose}
      footer={null}
    >
      <KeyboardBoundary boundary="collaborators-replace-room">
        <p>
          Conversation room for{" "}
          <strong>{projectTitle || "this project"}</strong>
        </p>
        <p>
          Project owners may replace a deleted room with a new, empty human-only
          room. Old conversation links remain unavailable. No messages, follows,
          or read state are copied.
        </p>
        <p>
          To restore the original conversations and identity instead, cancel and
          restore the original file from a backup before replacement.
        </p>
        <p>
          Only a confirmed missing file permits replacement. Read errors or
          corrupt files do not. A project retains at most{" "}
          {COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS} replacement
          operations.
        </p>
        {result?.outcome === "ready" ? (
          <>
            <p role="status">
              The new human-only room is ready. Old links have not been
              redirected.
            </p>
            <Button ref={start} type="primary" onClick={onStart}>
              Start a discussion
            </Button>
          </>
        ) : result?.outcome === "superseded" ? (
          <p role="status">
            This replacement has been superseded. It was not recreated. Close
            and refresh the project.
          </p>
        ) : (
          <>
            <Checkbox
              ref={confirmation}
              checked={confirmed}
              disabled={!request || busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            >
              I understand this creates a new identity and does not restore old
              conversations.
            </Checkbox>
            <div className="collaborators-actions">
              <Button
                ref={retry}
                danger
                type="primary"
                disabled={!request || !confirmed || busy}
                onClick={() => void replace()}
              >
                {savedIntent || error || result?.outcome === "pending"
                  ? "Retry same replacement"
                  : "Replace deleted room"}
              </Button>
            </div>
          </>
        )}
        {savedIntent && (
          <>
            <p>
              Retry keeps the saved request, even if its acknowledgement was
              lost. If the room has moved, abandon this saved attempt and read
              the current registration instead. This does not cancel a
              replacement that may already have committed. You must review and
              confirm again before starting a new operation.
            </p>
            <Button disabled={busy} onClick={reloadRegistration}>
              Abandon saved attempt and reload registration
            </Button>
          </>
        )}
        {!savedIntent && !request && error && (
          <Button onClick={reloadRegistration}>
            Reload current registration
          </Button>
        )}
        <Button ref={close} onClick={onClose}>
          {result?.outcome === "ready" || result?.outcome === "superseded"
            ? "Close replacement dialog"
            : "Cancel"}
        </Button>
        <p role="status">
          {busy
            ? "Replacing the room through the project service..."
            : !request && !error
              ? "Reading room registration..."
              : ""}
        </p>
        {request && (
          <details style={{ overflowWrap: "anywhere" }}>
            <summary>Technical details</summary>
            <p>
              Expected room: <code>{request.expected_room_id}</code>
            </p>
            <p>
              Path:{" "}
              <code style={{ overflowWrap: "anywhere" }}>
                {request.expected_chat_path}
              </code>
            </p>
            <p>
              Retry request: <code>{request.request_id}</code>
            </p>
          </details>
        )}
        {error && (
          <Alert
            role="alert"
            type="error"
            title="Replacement not confirmed"
            description={
              <>
                {error}
                <p>
                  Retry uses the same expected identity and request. An
                  acknowledgement may have been lost.
                </p>
              </>
            }
          />
        )}
      </KeyboardBoundary>
    </CollaboratorsModal>
  );
}
