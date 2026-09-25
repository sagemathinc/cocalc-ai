/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button, Input, Modal } from "antd";
import { readArtifact } from "@cocalc/chat";
import type { ArtifactRecord } from "@cocalc/chat";
import { useArtifactChanges } from "@cocalc/frontend/chat/artifacts";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { ActionListArtifact } from "@cocalc/frontend/frame-editors/chat-editor/action-list-artifact";
import { CommitArtifact } from "@cocalc/frontend/frame-editors/chat-editor/commit-artifact";
import { FileArtifact } from "@cocalc/frontend/frame-editors/chat-editor/file-artifact";
import ForeignArtifactSource from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type {
  ArtifactSourceData,
  ForeignArtifactTarget,
} from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { GitHubPRArtifact } from "@cocalc/frontend/frame-editors/chat-editor/github-pr-artifact";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { normalizeArtifactName } from "./artifact-names";

export interface LibraryArtifactViewProps {
  target: ForeignArtifactTarget;
  artifactName?: string;
  onName?: (name: string) => Promise<void>;
  onBack: () => void;
  onShowConversation?: (target: ForeignArtifactTarget) => Promise<void> | void;
  navigation?: ReactNode;
}

/** Navigation and stable URLs belong to the parent, not a chat frame or agent. */
export function LibraryArtifactView(props: LibraryArtifactViewProps) {
  const { projectId, path, threadId, artifactId } = props.target;
  return (
    <LibraryArtifactPage
      key={JSON.stringify([projectId, path, threadId, artifactId])}
      {...props}
    />
  );
}

export default LibraryArtifactView;

function LibraryArtifactPage({
  target,
  artifactName,
  onName,
  onBack,
  onShowConversation,
  navigation,
}: LibraryArtifactViewProps) {
  const [title, setTitle] = useState<string>();
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState("");
  const [naming, setNaming] = useState(false);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    // Route entry owns initial focus; source loading/live updates must not steal it.
    header.current?.focus({ preventScroll: true });
  }, []);

  const openConversation = async () => {
    setError("");
    setOpening(true);
    try {
      await onShowConversation?.(target);
    } catch (err) {
      setError(`Unable to open source conversation: ${err}`);
    } finally {
      setOpening(false);
    }
  };
  const copyLink = async () => {
    setError("");
    setCopied(false);
    try {
      if (!(await copyTextToClipboard({ text: window.location.href })))
        throw Error("Clipboard access is unavailable");
      setCopied(true);
    } catch (err) {
      setError(`Unable to copy link: ${err}`);
    }
  };
  const saveName = async () => {
    if (!onName || naming) return;
    setNaming(true);
    setNameError("");
    try {
      await onName(normalizeArtifactName(nameDraft));
      setNameOpen(false);
    } catch (err) {
      setNameError(`${err}`);
    } finally {
      setNaming(false);
    }
  };
  return (
    <section
      aria-label="Library artifact"
      className="smc-vfill"
      style={{
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        overflow: "auto",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <header
        ref={header}
        role="group"
        aria-label="Library artifact navigation"
        tabIndex={-1}
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: 12,
          borderBottom: `1px solid ${UI_COLORS.border}`,
          flexShrink: 0,
        }}
      >
        {navigation}
        <nav
          aria-label="Breadcrumb"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            flex: "1 1 240px",
            minWidth: 0,
          }}
        >
          <Button type="text" onClick={onBack} aria-label="Back to Library">
            Library
          </Button>
          <span aria-hidden="true">/</span>
          <h1
            aria-current="page"
            style={{
              fontSize: "1.2em",
              margin: 0,
              overflowWrap: "anywhere",
              minWidth: 0,
            }}
          >
            {title ?? "Artifact"}
          </h1>
        </nav>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            maxWidth: "100%",
          }}
        >
          {onShowConversation && (
            <Button disabled={opening} onClick={() => void openConversation()}>
              Conversation
            </Button>
          )}
          {onName && (
            <Button
              onClick={() => {
                setNameDraft(artifactName ?? "");
                setNameError("");
                setNameOpen(true);
              }}
            >
              {artifactName ? `@${artifactName}` : "Name artifact"}
            </Button>
          )}
          <Button onClick={() => void copyLink()}>Copy link</Button>
        </div>
        <span role="status">{copied ? "Link copied" : ""}</span>
      </header>
      {error && <Alert type="error" title={error} />}
      <Modal
        open={nameOpen}
        title="Name artifact"
        okText="Save name"
        confirmLoading={naming}
        onOk={() => void saveName()}
        onCancel={() => {
          if (!naming) setNameOpen(false);
        }}
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        <p>
          This name is personal to your account. Renaming keeps old links valid.
        </p>
        <label htmlFor="library-artifact-name">Artifact name</label>
        <Input
          id="library-artifact-name"
          value={nameDraft}
          maxLength={32}
          autoComplete="off"
          onChange={(event) => setNameDraft(event.target.value)}
          onPressEnter={() => void saveName()}
        />
        {nameError && (
          <Alert
            role="alert"
            type="error"
            title={nameError}
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
      <ForeignArtifactSource target={target} showForeignContextWarning={false}>
        {(source) => (
          <LibraryArtifactContent
            source={source}
            target={target}
            onTitle={setTitle}
          />
        )}
      </ForeignArtifactSource>
    </section>
  );
}

function LibraryArtifactContent({
  source,
  target,
  onTitle,
}: {
  source: ArtifactSourceData;
  target: ForeignArtifactTarget;
  onTitle: (title: string | undefined) => void;
}) {
  useArtifactChanges(source.syncdb);
  const context = useFileContext();
  let artifact: ArtifactRecord | undefined;
  try {
    // A catalog locator (including publication provenance) is not content.
    artifact = readArtifact(source.syncdb, {
      thread_id: target.threadId,
      artifact_id: target.artifactId,
    }).artifact;
  } catch {
    // Missing, deleted, and invalid source records must never become synthetic artifacts.
  }
  const title = artifact?.theme?.title || artifact?.title;
  useEffect(() => {
    onTitle(title);
    return () => onTitle(undefined);
  }, [title, onTitle]);

  if (!artifact)
    return (
      <Alert
        type="warning"
        title="Artifact unavailable"
        description="This artifact is missing or can no longer be read from its source conversation."
      />
    );

  const filePath = artifact.file?.path;
  return (
    <div className="smc-vfill" style={{ minHeight: 0, minWidth: 0 }}>
      {artifact.kind === "file" ? (
        // File and notebook renderers provide normal source-project navigation.
        <FileArtifact
          key={filePath}
          projectId={source.projectId}
          artifact={artifact}
          historical={false}
          localComments={false}
        />
      ) : artifact.kind === "commit" ? (
        <CommitArtifact
          artifact={artifact}
          projectId={source.projectId}
          sourcePath={source.path}
          readOnly={source.readOnly}
        />
      ) : artifact.kind === "github-pr" ? (
        <GitHubPRArtifact
          artifact={artifact}
          projectId={source.projectId}
          sourcePath={source.path}
          historical={false}
          readOnly={source.readOnly}
        />
      ) : artifact.kind === "actions" ? (
        <ActionListArtifact artifact={artifact} historical={false} />
      ) : (
        <KeyboardBoundary
          style={{ overflow: "auto", padding: 12, minHeight: 0 }}
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
            <div role="document" aria-label="Artifact document" tabIndex={0}>
              <StaticMarkdown value={artifact.input} />
            </div>
          </FileContext.Provider>
        </KeyboardBoundary>
      )}
    </div>
  );
}
