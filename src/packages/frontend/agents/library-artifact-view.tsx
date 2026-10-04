/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { PublicAliasInfo } from "@cocalc/frontend/components/public-alias-info";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Dropdown,
  Input,
  message as antdMessage,
  Modal,
} from "antd";
import { readArtifact } from "@cocalc/chat";
import type { ArtifactRecord } from "@cocalc/chat";
import { useArtifactChanges } from "@cocalc/frontend/chat/artifacts";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { ActionListArtifact } from "@cocalc/frontend/frame-editors/chat-editor/action-list-artifact";
import { CommitArtifact } from "@cocalc/frontend/frame-editors/chat-editor/commit-artifact";
import {
  FileArtifact,
  type FileArtifactAction,
} from "@cocalc/frontend/frame-editors/chat-editor/file-artifact";
import ForeignArtifactSource from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import type {
  ArtifactSourceData,
  ForeignArtifactTarget,
} from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { GitHubPRArtifact } from "@cocalc/frontend/frame-editors/chat-editor/github-pr-artifact";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";
import { Icon } from "@cocalc/frontend/components";
import {
  PAGE_HEADER_CONTEXT_STYLE,
  PAGE_HEADER_TITLE_STYLE,
  PageHeader,
} from "@cocalc/frontend/components/page-header";
import { autoThemeColor } from "@cocalc/frontend/components/identity-color";
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

const ARTIFACT_FONT_SIZE_KEY = "artifact-font-size-v1";
export const ARTIFACT_FONT_MIN = 10;
export const ARTIFACT_FONT_MAX = 28;
const ARTIFACT_FONT_DEFAULT = 14;

export function readArtifactFontSize(): number {
  return clampArtifactFontSize(
    parseInt(`${get_local_storage(ARTIFACT_FONT_SIZE_KEY) ?? ""}`, 10),
  );
}

function writeArtifactFontSize(value: number): number {
  const size = clampArtifactFontSize(value);
  set_local_storage(ARTIFACT_FONT_SIZE_KEY, String(size));
  return size;
}

export function clampArtifactFontSize(value: unknown): number {
  const size =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : ARTIFACT_FONT_DEFAULT;
  return Math.max(ARTIFACT_FONT_MIN, Math.min(ARTIFACT_FONT_MAX, size));
}

function LibraryArtifactPage({
  target,
  artifactName,
  onName,
  onBack,
  onShowConversation,
  navigation,
}: LibraryArtifactViewProps) {
  const [title, setTitle] = useState<string>();
  const [filePath, setFilePath] = useState<string>();
  const [themeColor, setThemeColor] = useState<string>();
  // Text size for reading artifacts, separate from the whole-page zoom.
  // Per device (a phone wants a different size than a laptop).
  const [fontSize, setFontSizeState] = useState(readArtifactFontSize);
  const setFontSize = (value: number) =>
    setFontSizeState(writeArtifactFontSize(value));
  // The file preview's tools: the primary one is a button in this row, the
  // rest are in its menu.
  const [fileActions, setFileActions] = useState<FileArtifactAction[]>([]);
  const projectTitle = useTypedRedux("projects", "project_map")?.getIn([
    target.projectId,
    "title",
  ]) as string | undefined;
  const context = [projectTitle, filePath].filter(Boolean).join(" · ");
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
      // The action is in a menu, so say so where it can be seen.
      void antdMessage.success("Link copied");
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
      <PageHeader
        ref={header}
        role="group"
        aria-label="Library artifact navigation"
        tabIndex={-1}
        identityColor={themeColor ?? autoThemeColor(target.artifactId)}
      >
        {navigation}
        <nav
          aria-label="Breadcrumb"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: "1 1 0",
            minWidth: 0,
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <Button
            type="text"
            size="small"
            onClick={onBack}
            aria-label="Back to Artifacts"
          >
            Artifacts
          </Button>
          <span aria-hidden="true">/</span>
          <h1 aria-current="page" title={title} style={PAGE_HEADER_TITLE_STYLE}>
            {title ?? "Artifact"}
          </h1>
          {context && (
            <span title={context} style={PAGE_HEADER_CONTEXT_STYLE}>
              {context}
            </span>
          )}
        </nav>
        {onName && (
          <Button
            type="text"
            size="small"
            title={artifactName ? "Rename this artifact" : "Name this artifact"}
            onClick={() => {
              setNameDraft(artifactName ?? "");
              setNameError("");
              setNameOpen(true);
            }}
          >
            {artifactName ? `@${artifactName}` : "Name artifact"}
          </Button>
        )}
        {fileActions
          .filter((action) => action.primary)
          .map((action) => (
            <Button
              key={action.key}
              size="small"
              icon={<Icon name={action.icon} />}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              ...fileActions
                .filter((action) => !action.primary)
                .map((action) => ({
                  key: action.key,
                  label: action.label,
                  icon: <Icon name={action.icon} />,
                  disabled: action.disabled,
                })),
              ...(onShowConversation
                ? [
                    {
                      key: "conversation",
                      label: "Open conversation",
                      icon: <Icon name="comments" />,
                      disabled: opening,
                    },
                  ]
                : []),
              {
                key: "copy-link",
                label: "Copy link",
                icon: <Icon name="link" />,
              },
              { type: "divider" as const },
              {
                key: "text-smaller",
                label: "Smaller text",
                icon: <Icon name="minus" />,
                disabled: fontSize <= ARTIFACT_FONT_MIN,
              },
              {
                key: "text-larger",
                label: `Larger text (${fontSize}px)`,
                icon: <Icon name="plus" />,
                disabled: fontSize >= ARTIFACT_FONT_MAX,
              },
            ],
            onClick: ({ key }) => {
              const file = fileActions.find((action) => action.key === key);
              if (file) file.onClick();
              else if (key === "conversation") void openConversation();
              else if (key === "copy-link") void copyLink();
              else if (key === "text-smaller") setFontSize(fontSize - 1);
              else if (key === "text-larger") setFontSize(fontSize + 1);
            },
          }}
        >
          <Button
            type="text"
            size="small"
            aria-label="More artifact actions"
            icon={<Icon name="ellipsis" />}
          />
        </Dropdown>
        <span
          role="status"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
          }}
        >
          {copied ? "Link copied" : ""}
        </span>
      </PageHeader>
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
          This name is personal to your account and appears in your public link
          to the artifact. Renaming keeps old links valid.{" "}
          <PublicAliasInfo kind="artifacts" />
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
            onPath={setFilePath}
            onColor={setThemeColor}
            fontSize={fontSize}
            onToolbarActions={setFileActions}
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
  onPath,
  onColor,
  onToolbarActions,
  fontSize,
}: {
  source: ArtifactSourceData;
  target: ForeignArtifactTarget;
  onTitle: (title: string | undefined) => void;
  onPath: (path: string | undefined) => void;
  onColor: (color: string | undefined) => void;
  onToolbarActions: (actions: FileArtifactAction[]) => void;
  fontSize: number;
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
  const color =
    artifact?.theme?.color?.trim() ||
    artifact?.theme?.accent_color?.trim() ||
    undefined;
  useEffect(() => {
    onColor(color);
    return () => onColor(undefined);
  }, [color, onColor]);
  const artifactPath = artifact?.file?.path;
  useEffect(() => {
    onPath(artifactPath);
    return () => onPath(undefined);
  }, [artifactPath, onPath]);

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
          onToolbarActions={onToolbarActions}
          fontSize={fontSize}
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
            <div
              role="document"
              aria-label="Artifact document"
              tabIndex={0}
              style={{ fontSize }}
            >
              <StaticMarkdown value={artifact.input} />
            </div>
          </FileContext.Provider>
        </KeyboardBoundary>
      )}
    </div>
  );
}
