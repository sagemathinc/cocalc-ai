/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Suspense, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ArtifactFeedback, ArtifactRecord } from "@cocalc/chat";
import {
  captureArtifactSelection,
  extendArtifactSelection,
} from "@cocalc/frontend/chat/artifact-selection";
import { focusChatFrameInput } from "./actions";
import { Alert, Button, Select, Space } from "antd";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import {
  artifactKey,
  artifactBase,
  readArtifact,
  validateArtifact,
  validateArtifactFeedback,
  validateArtifactPublication,
  artifactPublicationKey,
} from "@cocalc/chat";
import type {
  EditorComponentProps,
  EditorDescription,
} from "../frame-tree/types";
import type { Actions } from "./actions";
import {
  artifactSyncdbReady,
  useArtifactChanges,
} from "@cocalc/frontend/chat/artifacts";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { FileArtifact } from "./file-artifact";
import ContextualReply, {
  LocalCommentButton,
} from "@cocalc/frontend/chat/contextual-reply";
import { GitHubPRArtifact } from "./github-pr-artifact";
import { ActionListArtifact } from "./action-list-artifact";
import { CommitArtifact } from "./commit-artifact";
import { ArtifactIdentity } from "@cocalc/frontend/chat/artifact-card";
import { ArtifactNameControl } from "@cocalc/frontend/agents/artifact-name-control";
import { path_split } from "@cocalc/util/misc";
const AppearanceEditor = lazyWithRetry(
  () => import("@cocalc/frontend/chat/artifact-appearance-editor"),
  "artifact appearance",
);
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { sendArtifactReviewToThread } from "@cocalc/frontend/chat/artifact-review-agent";
import { writeChatComposerDraft } from "@cocalc/frontend/chat/use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "@cocalc/frontend/chat/utils";
import type { ArtifactSourceData } from "./foreign-artifact-source";

const ForeignArtifactSource = lazyWithRetry(
  () => import("./foreign-artifact-source"),
  "artifact source",
);

type WorkbenchProps = EditorComponentProps & { source?: ArtifactSourceData };

function sourceDescriptor(props: EditorComponentProps) {
  const projectId = props.desc.get("data-sourceProject");
  const path = props.desc.get("data-sourcePath");
  return projectId || path
    ? {
        projectId,
        path,
        agentId: props.desc.get("data-sourceAgent"),
        threadId: props.desc.get("data-thread"),
        artifactId: props.desc.get("data-artifact"),
        publicationId: props.desc.get("data-publication"),
      }
    : undefined;
}

const DocumentDiff = lazyWithRetry(
  () => import("@cocalc/frontend/components/diff-viewer/document-diff"),
  "artifact changes",
);

export const workbench: EditorDescription = {
  type: "workbench",
  short: "Artifact",
  name: "Artifact workbench",
  icon: "file",
  hide_public: true,
  hide_frame_type: true,
  component: (props) => <WorkbenchSurface {...props} />,
};

export function WorkbenchSurface(props: WorkbenchProps) {
  const target = sourceDescriptor(props);
  if (target && !props.source)
    return (
      <Suspense fallback={<div role="status">Loading artifact source...</div>}>
        <ForeignArtifactSource key={JSON.stringify(target)} target={target}>
          {(source) => <ResolvedWorkbenchSurface {...props} source={source} />}
        </ForeignArtifactSource>
      </Suspense>
    );
  return <ResolvedWorkbenchSurface {...props} />;
}

function ResolvedWorkbenchSurface(props: WorkbenchProps) {
  const actions = props.actions as Actions;
  const syncdb = props.source
    ? props.source.syncdb
    : actions.getArtifactSyncdb();
  const readOnly = props.source ? props.source.readOnly : props.read_only;
  useArtifactChanges(syncdb);
  const [edit, setEdit] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  let record: ArtifactRecord | undefined;
  try {
    record = readArtifact(syncdb, {
      thread_id: props.desc.get("data-thread"),
      artifact_id: props.desc.get("data-artifact"),
    }).artifact;
  } catch {
    /* Loading or removed. */
  }
  const directPath = props.desc.get("data-path");
  const title =
    record?.theme?.title ||
    record?.title ||
    (directPath ? path_split(directPath).tail || directPath : undefined);
  const theme = record?.theme;
  const nameTarget =
    record && (props.source?.path ?? actions.store?.get("path"))
      ? {
          projectId: props.source?.projectId ?? props.project_id,
          chatPath: (props.source?.path ??
            actions.store?.get("path")) as string,
          threadId: record.thread_id,
          artifactId: record.artifact_id,
        }
      : undefined;
  useEffect(() => {
    if (!title) return;
    const label =
      title + (props.desc.get("data-version") ? " (published)" : "");
    if (
      props.desc.get("data-tabLabel") !== label ||
      props.desc.get("data-tabColor") !== theme?.color ||
      props.desc.get("data-tabIcon") !== theme?.icon
    )
      actions.set_frame_data({
        id: props.id,
        tabLabel: label,
        tabColor: theme?.color,
        tabIcon: theme?.icon,
      });
  }, [title, theme?.color, theme?.icon, props.desc, props.id, actions]);
  return (
    <div className="smc-vfill" style={{ minHeight: 0 }}>
      {(record || directPath) && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: `2px solid ${theme?.color ?? UI_COLORS.border}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {record ? (
              <ArtifactIdentity title={record.title} theme={theme} />
            ) : (
              <strong>{title}</strong>
            )}
          </div>
          {!readOnly && record && (
            <Button
              size="small"
              onClick={() => setEdit(true)}
              aria-label="Edit Artifact Appearance"
            >
              Appearance
            </Button>
          )}
          {nameTarget && (
            <Button size="small" onClick={() => setNameOpen(true)}>
              Name artifact
            </Button>
          )}
        </div>
      )}
      {directPath && !props.desc.get("data-artifact") ? (
        <DirectFileWorkbench
          path={directPath}
          projectId={props.project_id}
          threadId={props.desc.get("data-thread")}
        />
      ) : (
        <Workbench {...props} />
      )}
      {edit && record && !readOnly && (
        <Suspense fallback={<div role="status">Loading appearance...</div>}>
          <AppearanceEditor
            artifact={record}
            syncdb={syncdb}
            projectId={props.source?.projectId ?? props.project_id}
            onClose={() => setEdit(false)}
          />
        </Suspense>
      )}
      {nameOpen && nameTarget && (
        <ArtifactNameControl
          target={nameTarget}
          open
          onClose={() => setNameOpen(false)}
        />
      )}
    </div>
  );
}

function DirectFileWorkbench({
  path,
  projectId,
  threadId,
}: {
  path: string;
  projectId: string;
  threadId?: string;
}) {
  const artifact = {
    event: "chat-artifact",
    schema_version: 1,
    thread_id: threadId ?? "project-file",
    artifact_id: `project-file:${path}`,
    title: path_split(path).tail || path,
    kind: "file",
    input: "",
    file: { path },
  } as ArtifactRecord;
  return (
    <FileArtifact
      projectId={projectId}
      artifact={artifact}
      historical={false}
    />
  );
}

export function Workbench(props: WorkbenchProps) {
  const target = sourceDescriptor(props);
  if (target && !props.source)
    return (
      <Suspense fallback={<div role="status">Loading artifact source...</div>}>
        <ForeignArtifactSource key={JSON.stringify(target)} target={target}>
          {(source) => <WorkbenchDocument {...props} source={source} />}
        </ForeignArtifactSource>
      </Suspense>
    );
  return (
    <WorkbenchDocument
      key={JSON.stringify([
        props.source?.projectId,
        props.source?.path,
        props.desc.get("data-thread"),
        props.desc.get("data-artifact"),
      ])}
      {...props}
    />
  );
}

function WorkbenchDocument({
  actions: frameActions,
  desc,
  read_only: destinationReadOnly,
  font_size,
  project_id: destinationProjectId,
  path: destinationPath,
  id,
  source,
}: WorkbenchProps) {
  const actions = frameActions as Actions;
  const destinationChat = actions.getChatActions(desc.get("data-origin"));
  // A foreign descriptor is explicit even within the same chat or project.
  // Never use the destination composer for source feedback.
  const chat = source ? undefined : destinationChat;
  const syncdb = source
    ? source.syncdb
    : (actions.getArtifactSyncdb() ?? chat?.syncdb);
  const project_id = source?.projectId ?? destinationProjectId;
  const path = source?.path ?? destinationPath;
  const read_only = source ? source.readOnly : destinationReadOnly;
  useArtifactChanges(syncdb);
  const context = useFileContext();
  const accountId = useTypedRedux("account", "account_id");
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState<string | undefined>(
    desc.get("data-version") ?? undefined,
  );
  const descriptorVersion = desc.get("data-version");
  useEffect(() => {
    setVersion(descriptorVersion ?? undefined);
  }, [descriptorVersion]);
  const historical = version !== undefined;
  const [showChanges, setShowChanges] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pinned, setPinned] = useState<ArtifactRecord>();
  const content = useRef<HTMLDivElement>(null);
  const displayed = useRef<ArtifactRecord | undefined>(undefined);
  const selectedFeedback = useRef<ArtifactFeedback | undefined>(undefined);
  const getEditorValue = useRef<() => string>(() => "");
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
  let publications: ReturnType<typeof validateArtifactPublication>[] = [];
  try {
    if (!artifactSyncdbReady(syncdb))
      return <div role="status">Loading artifact...</div>;
    artifact = readArtifact(syncdb, target).artifact;
    const rows = syncdb.get({
      event: "chat-artifact-publication",
      thread_id: target.thread_id,
    });
    publications = (rows?.toJS?.() ?? rows ?? [])
      .filter((row) => row.artifact_id === target.artifact_id)
      .map(validateArtifactPublication)
      .sort(
        (a, b) =>
          (a.published_at ?? "").localeCompare(b.published_at ?? "") ||
          a.operation_id.localeCompare(b.operation_id),
      );
    if (historical) {
      const pub = validateArtifactPublication(
        syncdb.get_one(artifactPublicationKey(target, version!)),
      );
      artifact = {
        ...artifact,
        title: pub.snapshot.title,
        input: pub.snapshot.markdown,
        actions: pub.snapshot.actions,
        kind: pub.snapshot.actions
          ? "actions"
          : pub.snapshot.github_pr
            ? "github-pr"
            : pub.snapshot.file
              ? "file"
              : "markdown",
        github_pr: pub.snapshot.github_pr,
        file: pub.snapshot.file,
        commit: pub.snapshot.commit,
        theme: pub.snapshot.theme,
      };
      if (pub.snapshot.commit) artifact.kind = "commit";
    }
  } catch {
    return <Alert type="warning" title="Artifact unavailable" />;
  }
  const value = pinned ?? artifact;
  const selectedIndex = publications.findIndex(
    (pub) => pub.operation_id === version,
  );
  const latest = publications[publications.length - 1];
  const before = historical
    ? publications[selectedIndex - 1]
    : publications[
        publications.length -
          (latest?.snapshot.markdown === value.input ? 2 : 1)
      ];
  displayed.current = value;
  const saveInput = (input: string, explicit = false) => {
    if (read_only) throw Error("Artifact is read-only");
    source?.assertWritable();
    const current = readArtifact(syncdb, target).artifact;
    const next = validateArtifact({ ...current, input });
    if (next.input === current.input) {
      if (!explicit) return;
    } else {
      syncdb.set({ ...artifactKey(target), input: next.input });
      syncdb.commit();
    }
    setSaving(true);
    void syncdb.save().then(
      () => setSaving(false),
      (err) => {
        setSaving(false);
        setError(String(err));
      },
    );
  };
  const flushEditor = () => saveInput(getEditorValue.current(), true);
  const stageFeedback = async (value: ArtifactFeedback) => {
    if (!chat || read_only) throw Error("Chat feedback is unavailable");
    if (chat.stageArtifactFeedback) {
      await chat.stageArtifactFeedback(value);
      return;
    }
    // Maximizing the workbench unmounts the composer and its staging hook.
    // Persist to the same thread draft before bringing that composer back.
    const feedback = validateArtifactFeedback(value);
    readArtifact(syncdb, feedback);
    await writeChatComposerDraft({
      account_id: accountId,
      project_id,
      path,
      composerDraftKey: stableDraftKeyFromThreadKey(feedback.thread_id),
      suffix: "artifact-feedback",
      text: JSON.stringify(feedback),
    });
    chat.setSelectedThread?.(feedback.thread_id);
  };
  const returnToChat = () => {
    const origin = desc.get("data-origin");
    // The composer must be visible before focusing it, especially when maximized.
    flushSync(() => {
      if (
        window.innerWidth < 768 ||
        actions.store?.getIn(["local_view_state", "full_id"]) === id
      ) {
        actions.set_frame_full(origin);
      } else {
        actions.set_active_id(origin);
      }
    });
    focusChatFrameInput(origin, { waitForInput: true });
  };
  if (artifact.kind === "file")
    return (
      <ContextualReply
        fill
        actions={chat}
        projectId={project_id}
        path={path}
        disabled={read_only || !!source}
        source={{
          kind: "artifact",
          thread_id: artifact.thread_id,
          id: artifact.artifact_id,
          title: artifact.title,
          file: artifact.file?.path,
          revision: version,
        }}
      >
        <FileArtifact
          projectId={project_id}
          key={`${artifact.thread_id}:${artifact.artifact_id}`}
          artifact={artifact}
          historical={historical}
          localComments={!source}
        />
      </ContextualReply>
    );
  if (artifact.kind === "commit")
    return (
      <CommitArtifact
        artifact={artifact}
        projectId={project_id}
        sourcePath={path}
        readOnly={read_only}
        onRequestAgentTurn={
          read_only || !chat
            ? undefined
            : (prompt, options) => {
                sendArtifactReviewToThread({
                  actions: chat,
                  threadId: artifact.thread_id,
                  prompt,
                  workingDirectory: options?.workingDirectory,
                });
              }
        }
      />
    );
  if (artifact.kind === "github-pr")
    return (
      <GitHubPRArtifact
        key={`${artifact.thread_id}:${artifact.artifact_id}`}
        artifact={artifact}
        projectId={project_id}
        sourcePath={path}
        historical={historical}
        readOnly={read_only}
        onRequestAgentTurn={
          read_only || !chat
            ? undefined
            : (prompt, options) => {
                sendArtifactReviewToThread({
                  actions: chat,
                  threadId: artifact.thread_id,
                  prompt,
                  workingDirectory: options?.workingDirectory,
                });
              }
        }
        onRefresh={
          read_only || historical
            ? undefined
            : async (next, expected) => {
                source?.assertWritable();
                const current = readArtifact(syncdb, target).artifact;
                if (artifactBase(current) !== artifactBase(expected))
                  throw Error(
                    "Artifact changed while refreshing. Retry to avoid overwriting newer changes.",
                  );
                const updated = validateArtifact({ ...current, ...next });
                syncdb.set({
                  ...artifactKey(target),
                  title: updated.title,
                  input: updated.input,
                  github_pr: updated.github_pr,
                });
                syncdb.commit();
                await syncdb.save();
              }
        }
      />
    );
  if (artifact.kind === "actions")
    return (
      <ActionListArtifact
        key={`${accountId}:${artifact.thread_id}:${artifact.artifact_id}:${version ?? "current"}`}
        artifact={artifact}
        historical={historical}
        storageKey={
          accountId && !read_only && !source
            ? `chat-action-review:${JSON.stringify([accountId, project_id, path, artifact.thread_id, artifact.artifact_id])}`
            : undefined
        }
        onReview={
          read_only || !chat
            ? undefined
            : async (feedback) => {
                await stageFeedback(feedback);
                returnToChat();
              }
        }
      />
    );
  return (
    <ContextualReply
      fill
      actions={chat}
      projectId={project_id}
      path={path}
      disabled={read_only || !!source || editing || showChanges}
      source={{
        kind: "artifact",
        thread_id: value.thread_id,
        id: value.artifact_id,
        title: value.title,
        revision: version,
      }}
    >
      <KeyboardBoundary
        className="smc-vfill"
        style={{
          overflow: "auto",
          padding: 12,
          paddingBottom: editing && !read_only && !showChanges ? 0 : 12,
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
          <Space wrap style={{ marginBottom: 12, flexShrink: 0 }}>
            <Button
              size="small"
              disabled={!destinationChat}
              onClick={(event) => {
                event.stopPropagation();
                try {
                  if (editing) flushEditor();
                  returnToChat();
                } catch (err) {
                  setError(String(err));
                }
              }}
            >
              Back to chat
            </Button>
            <strong>{value.title}</strong>
            <Button
              size="small"
              disabled={read_only || historical || !!pinned || showChanges}
              onClick={() => {
                try {
                  if (editing) flushEditor();
                  setEditing(!editing);
                } catch (err) {
                  setError(String(err));
                }
              }}
            >
              {editing ? "Read" : "Edit"}
            </Button>
            <Select
              aria-label="Artifact revision"
              size="small"
              style={{ width: 190, maxWidth: "100%" }}
              value={
                version === undefined ? "__current__" : `publication:${version}`
              }
              disabled={editing || !!pinned}
              options={[
                { value: "__current__", label: "Current document" },
                ...publications.map((pub, index) => ({
                  value: `publication:${pub.operation_id}`,
                  label: `Message version ${index + 1}: ${pub.operation_id.slice(0, 12)}`,
                })),
              ]}
              onChange={(next) => {
                const selected =
                  next === "__current__"
                    ? undefined
                    : next.slice("publication:".length);
                setVersion(selected);
                actions.set_frame_data({ id, version: selected ?? null });
              }}
            />
            <Button
              size="small"
              disabled={editing || !!pinned}
              onClick={() => setShowChanges(!showChanges)}
            >
              {showChanges ? "Show document" : "See changes"}
            </Button>
            <LocalCommentButton
              size="small"
              disabled={read_only || editing || showChanges || !chat}
            />
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
                  ? "Message version"
                  : "Live document"}
            </span>
          </Space>
          {!chat && !source && (
            <div role="status">
              The originating chat frame is closed. Reopen this artifact from
              its thread to comment; you can still read and edit it here.
            </div>
          )}
          {error && (
            <Alert
              type="error"
              title={error}
              closable
              onClose={() => setError("")}
            />
          )}
          {showChanges ? (
            <div style={{ minHeight: 280, flex: 1 }}>
              <Suspense fallback={<div role="status">Loading changes...</div>}>
                <DocumentDiff
                  before={before?.snapshot.markdown ?? ""}
                  after={value.input}
                  path="artifact.md"
                  label="Changes since preceding message version"
                  fontSize={font_size}
                />
              </Suspense>
            </div>
          ) : editing && !read_only ? (
            <div
              className="smc-vfill"
              style={{ minHeight: 0, overflow: "hidden" }}
            >
              <MarkdownInput
                cacheId={`artifact:${project_id}:${path}:${target.thread_id}:${target.artifact_id}`}
                value={value.input}
                mergeRemoteValues
                getRemoteValue={() =>
                  readArtifact(syncdb, target).artifact.input
                }
                fontSize={font_size}
                height="100%"
                autoGrow={false}
                modeSwitchPlacement="toolbar"
                getValueRef={getEditorValue}
                onSave={() => {
                  try {
                    flushEditor();
                  } catch (err) {
                    setError(String(err));
                  }
                }}
                minimal
                compact
                hideHelp
                enableMentions={false}
                enableUpload={false}
                onChange={(input) => {
                  try {
                    saveInput(input);
                  } catch (err) {
                    setError(String(err));
                  }
                }}
              />
            </div>
          ) : (
            <div
              ref={content}
              data-contextual-source
              tabIndex={0}
              aria-label="Artifact document"
              aria-description="Use Shift and arrow keys to select text, then activate Comment."
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  event.shiftKey &&
                  !event.altKey &&
                  extendArtifactSelection(
                    event.currentTarget,
                    window.getSelection(),
                    event.key,
                    event.ctrlKey || event.metaKey,
                  )
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
            >
              <StaticMarkdown value={value.input} />
            </div>
          )}
        </FileContext.Provider>
      </KeyboardBoundary>
    </ContextualReply>
  );
}
