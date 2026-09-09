/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import type { ArtifactFeedback, ArtifactRecord } from "@cocalc/chat";
import { captureArtifactSelection } from "@cocalc/frontend/chat/artifact-selection";
import { focusChatFrameInput } from "./actions";
import { Alert, Button, Space } from "antd";
import {
  artifactKey,
  readArtifact,
  validateArtifact,
  validateArtifactPublication,
  artifactPublicationKey,
} from "@cocalc/chat";
import type {
  EditorComponentProps,
  EditorDescription,
} from "../frame-tree/types";
import type { Actions } from "./actions";
import { useArtifactChanges } from "@cocalc/frontend/chat/artifacts";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export const workbench: EditorDescription = {
  type: "workbench",
  short: "Artifact",
  name: "Artifact workbench",
  icon: "file",
  hide_public: true,
  hide_frame_type: true,
  component: (props) => <Workbench {...props} />,
};

export function Workbench({
  actions: frameActions,
  desc,
  read_only,
  font_size,
  project_id,
  path,
}: EditorComponentProps) {
  const actions = frameActions as Actions;
  const chat = actions.getChatActions(desc.get("data-origin"));
  const syncdb = chat?.syncdb;
  useArtifactChanges(syncdb);
  const context = useFileContext();
  const [editing, setEditing] = useState(false);
  const [historical, setHistorical] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pinned, setPinned] = useState<ArtifactRecord>();
  const content = useRef<HTMLDivElement>(null);
  const displayed = useRef<ArtifactRecord | undefined>(undefined);
  const selectedFeedback = useRef<ArtifactFeedback | undefined>(undefined);
  useEffect(() => {
    const select = () => {
      const selection = window.getSelection();
      if (
        !editing &&
        content.current &&
        displayed.current &&
        selection &&
        !selection.isCollapsed &&
        content.current.contains(selection.anchorNode) &&
        content.current.contains(selection.focusNode)
      ) {
        try {
          selectedFeedback.current = captureArtifactSelection(
            content.current,
            displayed.current,
            selection,
          );
          setPinned(displayed.current);
        } catch (err) {
          setError(String(err));
        }
      }
    };
    document.addEventListener("selectionchange", select);
    return () => document.removeEventListener("selectionchange", select);
  }, [editing]);
  const target = {
    thread_id: desc.get("data-thread"),
    artifact_id: desc.get("data-artifact"),
  };
  let artifact;
  try {
    if (!syncdb) return <div role="status">Loading artifact...</div>;
    artifact = readArtifact(syncdb, target).artifact;
    if (historical) {
      const pub = validateArtifactPublication(
        syncdb.get_one(
          artifactPublicationKey(target, desc.get("data-publication")),
        ),
      );
      artifact = {
        ...artifact,
        title: pub.snapshot.title,
        input: pub.snapshot.markdown,
      };
    }
  } catch {
    return <Alert type="warning" message="Artifact unavailable" />;
  }
  const value = pinned ?? artifact;
  displayed.current = value;
  return (
    <KeyboardBoundary
      className="smc-vfill"
      style={{
        overflow: "auto",
        padding: 12,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
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
        <Space wrap style={{ marginBottom: 12 }}>
          <strong>{value.title}</strong>
          <Button
            size="small"
            disabled={read_only || historical || !!pinned}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Read" : "Edit"}
          </Button>
          <Button
            size="small"
            disabled={editing || !!pinned}
            onClick={() => setHistorical(!historical)}
          >
            {historical ? "Show current" : "Show published"}
          </Button>
          <Button
            size="small"
            disabled={read_only || editing || !chat?.stageArtifactFeedback}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!content.current || !chat?.stageArtifactFeedback) return;
              try {
                const feedback =
                  selectedFeedback.current ??
                  captureArtifactSelection(
                    content.current,
                    value,
                    window.getSelection(),
                  );
                void chat
                  .stageArtifactFeedback(feedback)
                  .then(() => {
                    actions.set_active_id(desc.get("data-origin"));
                    focusChatFrameInput(desc.get("data-origin"));
                  })
                  .catch((err) => setError(String(err)));
              } catch (err) {
                setError(String(err));
              }
            }}
          >
            Comment
          </Button>
          {pinned && (
            <Button
              size="small"
              onClick={() => {
                window.getSelection()?.removeAllRanges();
                selectedFeedback.current = undefined;
                setPinned(undefined);
              }}
            >
              {artifact.input !== pinned.input
                ? "Show updated document"
                : "Clear selection"}
            </Button>
          )}
          <span role="status">
            {saving
              ? "Syncing..."
              : historical
                ? "Published snapshot"
                : "Live document"}
          </span>
        </Space>
        {error && (
          <Alert
            type="error"
            message={error}
            closable
            onClose={() => setError("")}
          />
        )}
        {editing && !read_only ? (
          <MarkdownInput
            cacheId={`artifact:${project_id}:${path}:${target.thread_id}:${target.artifact_id}`}
            value={value.input}
            fontSize={font_size}
            minimal
            compact
            hideHelp
            enableMentions={false}
            enableUpload={false}
            onChange={(input) => {
              try {
                const current = readArtifact(syncdb, target).artifact;
                const next = validateArtifact({ ...current, input });
                syncdb.set({ ...artifactKey(target), input: next.input });
                syncdb.commit();
                setSaving(true);
                void syncdb
                  .save()
                  .then(() => setSaving(false))
                  .catch((err) => {
                    setSaving(false);
                    setError(String(err));
                  });
              } catch (err) {
                setError(String(err));
              }
            }}
          />
        ) : (
          <div ref={content} tabIndex={0} aria-label="Artifact document">
            <StaticMarkdown value={value.input} />
          </div>
        )}
      </FileContext.Provider>
    </KeyboardBoundary>
  );
}
