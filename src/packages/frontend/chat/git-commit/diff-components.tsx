/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: virtualized per-file diff rendering, including inline review comment display and editing controls.

import { Button, Space, Typography } from "antd";
import { useMemo, useRef } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { filenameMode } from "@cocalc/frontend/file-associations";
import { COLORS } from "@cocalc/util/theme";
import { memo } from "react";
import { RENDERED_DIFF_LINES_INCREMENT } from "./diff-find";
import {
  buildDiffLineMetas,
  commentAnchorKey,
  diffLineNumberColumnWidth,
  makeCommentAnchor,
} from "./diff-lines";
import {
  buildGitReviewFileSectionId,
  buildGitReviewLineElementId,
} from "./ids";
import {
  buildGitInlineDraftEditorId,
  buildGitInlineEditEditorId,
  buildGitReviewEditorScope,
  InlineDraftCommentEditor,
  InlineEditCommentEditor,
} from "./review-editors";
import type { CommentAnchor, GitDiffFindMatch, GitShowFile } from "./types";
import { hasExpandedTextSelectionWithin } from "./utils";
import { highlightPrismLines, languageHintFromPath } from "../diff-prism";
import type { GitReviewCommentV2 } from "../git-review-store";

const DIFF_FILE_HEADER_BACKGROUND = COLORS.GRAY_LLL;
const DIFF_FILE_HEADER_BORDER = COLORS.GRAY_LL;
const DIFF_FILE_HEADER_TEXT = COLORS.GRAY_D;
const DIFF_FILE_HEADER_SECONDARY = COLORS.GRAY_M;

export const DiffBlock = memo(function DiffBlock({
  filePath,
  fileIndex,
  lines,
  languageHint,
  fontSize,
  editorTheme,
  editorHistoryScope = buildGitReviewEditorScope({}),
  comments,
  showResolvedComments,
  commentEnabled,
  commentDisabledMessage,
  activeDraftAnchorId,
  activeDraftBody = "",
  activeEditingId,
  activeEditingBody = "",
  pendingKey = "",
  onOpenDraft = () => {},
  onDraftBodyChange = () => {},
  onCancelDraft = () => {},
  onOpenEdit = () => {},
  onEditingBodyChange = () => {},
  onCancelEdit = () => {},
  onCreateComment,
  onUpdateComment,
  onResolveComment,
  onReopenComment,
  matchedLineIndexes,
  activeMatchedLineIndex,
}: {
  filePath: string;
  fileIndex?: number;
  lines: string[];
  languageHint: string;
  fontSize: number;
  editorTheme?: string | null;
  editorHistoryScope?: string;
  comments: GitReviewCommentV2[];
  showResolvedComments: boolean;
  commentEnabled: boolean;
  commentDisabledMessage?: string;
  activeDraftAnchorId?: string;
  activeDraftBody?: string;
  activeEditingId?: string;
  activeEditingBody?: string;
  pendingKey?: string;
  onOpenDraft?: (anchor: CommentAnchor) => void;
  onDraftBodyChange?: (value: string) => void;
  onCancelDraft?: () => void;
  onOpenEdit?: (comment: GitReviewCommentV2) => void;
  onEditingBodyChange?: (value: string) => void;
  onCancelEdit?: () => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  onUpdateComment: (id: string, body: string) => Promise<void>;
  onResolveComment: (id: string) => Promise<void>;
  onReopenComment: (id: string) => Promise<void>;
  matchedLineIndexes?: Set<number>;
  activeMatchedLineIndex?: number;
}) {
  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const codeFontSize = Math.max(11, fontSize - 1);
  const commentFontSize = Math.max(13, fontSize);
  const commentFontFamily =
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const lineMetas = useMemo(() => buildDiffLineMetas(lines), [lines]);
  const lineNumberWidth = useMemo(() => {
    const maxLine = lineMetas.reduce((max, meta) => {
      const oldVal =
        typeof meta.oldLineNumber === "number" ? meta.oldLineNumber : 0;
      const newVal =
        typeof meta.newLineNumber === "number" ? meta.newLineNumber : 0;
      return Math.max(max, oldVal, newVal);
    }, 0);
    return diffLineNumberColumnWidth(maxLine);
  }, [lineMetas]);
  const highlightedByLine = useMemo(
    () => highlightPrismLines(lineMetas, languageHint),
    [lineMetas, languageHint],
  );
  const commentsByAnchor = useMemo(() => {
    const byAnchor = new Map<string, GitReviewCommentV2[]>();
    for (const comment of comments) {
      if (comment.status === "resolved" && !showResolvedComments) continue;
      const key = commentAnchorKey(comment);
      const existing = byAnchor.get(key) ?? [];
      existing.push(comment);
      byAnchor.set(key, existing);
    }
    return byAnchor;
  }, [comments, showResolvedComments]);
  const commentButtonSlotStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    minWidth: 22,
    height: 22,
  } as const;

  const resolveComment = async (id: string) => {
    await onResolveComment(id);
  };

  const reopenComment = async (id: string) => {
    await onReopenComment(id);
  };

  const shouldSuppressActionForSelection = (): boolean =>
    hasExpandedTextSelectionWithin(diffRootRef.current);

  return (
    <div
      ref={diffRootRef}
      data-git-diff-root="true"
      className="cocalc-slate-code-block"
      style={{
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: 6,
        overflow: "hidden",
        fontFamily: "monospace",
        fontSize: codeFontSize,
        padding: 0,
        marginBottom: 0,
      }}
    >
      {lineMetas.map((meta, idx) => {
        const prefix = meta.raw[0];
        const background =
          prefix === "+" && !meta.raw.startsWith("+++ ")
            ? "#e6ffed"
            : prefix === "-" && !meta.raw.startsWith("--- ")
              ? "#ffeef0"
              : "transparent";
        const html = highlightedByLine[idx] ?? "";
        const anchor = makeCommentAnchor(meta, filePath);
        const anchorId = anchor == null ? "" : commentAnchorKey(anchor);
        const lineElementId = buildGitReviewLineElementId({
          filePath,
          fileIndex: fileIndex ?? 0,
          lineIndex: idx,
        });
        const lineComments =
          anchor == null ? [] : (commentsByAnchor.get(anchorId) ?? []);
        const showDraft =
          activeDraftAnchorId != null &&
          activeDraftAnchorId !== "" &&
          activeDraftAnchorId === anchorId;
        const hasFindMatch = matchedLineIndexes?.has(idx) ?? false;
        const isActiveFindMatch = activeMatchedLineIndex === idx;
        return (
          <div key={idx}>
            <div
              id={lineElementId}
              className="cocalc-git-diff-line"
              style={{
                background,
                padding: "2px 8px",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                boxShadow: isActiveFindMatch
                  ? "inset 0 0 0 2px #faad14"
                  : hasFindMatch
                    ? "inset 0 0 0 1px #ffe58f"
                    : undefined,
              }}
              data-git-anchor-id={anchorId || undefined}
              data-git-hunk-hash={meta.hunkHash || undefined}
            >
              <div
                style={{
                  color: COLORS.GRAY_D,
                  width: lineNumberWidth,
                  minWidth: lineNumberWidth,
                  maxWidth: lineNumberWidth,
                  textAlign: "right",
                  userSelect: "none",
                  fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {meta.oldLineNumber ?? ""}
              </div>
              <div
                style={{
                  color: COLORS.GRAY_D,
                  width: lineNumberWidth,
                  minWidth: lineNumberWidth,
                  maxWidth: lineNumberWidth,
                  textAlign: "right",
                  userSelect: "none",
                  fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {meta.newLineNumber ?? ""}
              </div>
              {anchor ? (
                <span
                  style={commentButtonSlotStyle}
                  className="cocalc-git-diff-line-comment-slot"
                >
                  <Button
                    size="small"
                    type="primary"
                    className="cocalc-git-diff-line-comment-button"
                    style={{
                      padding: 0,
                      minWidth: 22,
                      width: 22,
                      height: 22,
                    }}
                    onMouseDown={(evt) => {
                      if (!shouldSuppressActionForSelection()) return;
                      evt.preventDefault();
                      evt.stopPropagation();
                    }}
                    onClick={() => {
                      if (shouldSuppressActionForSelection()) {
                        return;
                      }
                      if (!commentEnabled) {
                        alert_message({
                          type: "info",
                          message:
                            commentDisabledMessage ??
                            "Please commit first, then comment.",
                          timeout: 4,
                        });
                        return;
                      }
                      onOpenDraft(anchor);
                    }}
                    title={
                      commentEnabled
                        ? "Add inline comment"
                        : (commentDisabledMessage ??
                          "Please commit first, then comment.")
                    }
                  >
                    +
                  </Button>
                </span>
              ) : (
                <span style={commentButtonSlotStyle} />
              )}
              <div
                className="cocalc-git-diff-line-text"
                style={{ flex: 1 }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
            {lineComments.length > 0
              ? lineComments.map((comment) => {
                  const isEditing = activeEditingId === comment.id;
                  return (
                    <div
                      key={comment.id}
                      style={{
                        margin: "0 8px 6px 92px",
                        border: `1px solid #d9d9d9`,
                        borderLeft: `4px solid ${COLORS.BLUE}`,
                        borderRadius: 8,
                        padding: "10px 12px",
                        background: "#fff",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                        fontFamily: commentFontFamily,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          Inline review comment
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                        >
                          {comment.side}:{comment.line ?? "?"}
                        </Typography.Text>
                      </div>
                      {isEditing ? (
                        <InlineEditCommentEditor
                          key={comment.id}
                          historyId={buildGitInlineEditEditorId({
                            scope: editorHistoryScope,
                            filePath,
                            commentId: comment.id,
                          })}
                          value={activeEditingBody}
                          fontSize={commentFontSize}
                          loading={pendingKey === `edit:${comment.id}`}
                          onChange={onEditingBodyChange}
                          onCancel={onCancelEdit}
                          onSave={(value) =>
                            void onUpdateComment(comment.id, value)
                          }
                        />
                      ) : (
                        <StaticMarkdown
                          value={comment.body_md}
                          style={{
                            fontSize: commentFontSize,
                            fontFamily: commentFontFamily,
                            lineHeight: 1.5,
                          }}
                          editorTheme={editorTheme}
                        />
                      )}
                      <div
                        style={{
                          marginTop: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                        >
                          {comment.status === "resolved"
                            ? "Resolved"
                            : comment.status === "submitted"
                              ? "Submitted"
                              : "Draft"}
                        </Typography.Text>
                        {isEditing ? null : (
                          <Space.Compact size="small">
                            <Button
                              size="small"
                              onClick={() => onOpenEdit(comment)}
                            >
                              Edit
                            </Button>
                            {comment.status === "resolved" ? (
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => void reopenComment(comment.id)}
                                loading={pendingKey === `reopen:${comment.id}`}
                              >
                                Reopen
                              </Button>
                            ) : (
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => void resolveComment(comment.id)}
                                loading={pendingKey === `resolve:${comment.id}`}
                              >
                                Resolve
                              </Button>
                            )}
                          </Space.Compact>
                        )}
                      </div>
                    </div>
                  );
                })
              : null}
            {showDraft ? (
              <div
                style={{
                  margin: "0 8px 8px 92px",
                  border: `1px solid #d9d9d9`,
                  borderLeft: `4px solid ${COLORS.BLUE}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: "#fff",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  fontFamily: commentFontFamily,
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Add inline review comment
                </Typography.Text>
                <InlineDraftCommentEditor
                  key={anchorId}
                  historyId={buildGitInlineDraftEditorId({
                    scope: editorHistoryScope,
                    filePath,
                    anchorId,
                  })}
                  value={activeDraftBody}
                  fontSize={commentFontSize}
                  loading={pendingKey === `create:${anchorId}`}
                  onChange={onDraftBodyChange}
                  onCancel={onCancelDraft}
                  onSave={(value) => {
                    if (!anchor) return;
                    void onCreateComment(anchor, value);
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

export const DiffFileSection = memo(function DiffFileSection({
  file,
  index,
  fontSize,
  editorTheme,
  fileComments,
  showResolvedComments,
  isHeadSelected,
  visibleLineLimit,
  editorHistoryScope,
  onOpenFile,
  onShowMoreLines,
  activeDraftAnchorId,
  activeDraftBody,
  activeEditingId,
  activeEditingBody,
  pendingKey,
  onOpenDraft,
  onDraftBodyChange,
  onCancelDraft,
  onOpenEdit,
  onEditingBodyChange,
  onCancelEdit,
  onCreateComment,
  onUpdateComment,
  onResolveComment,
  onReopenComment,
  matchedFindCount,
  matchedLineIndexes,
  activeFindMatchKind,
  activeFindLineIndex,
}: {
  file: GitShowFile;
  index: number;
  fontSize: number;
  editorTheme?: string | null;
  fileComments: GitReviewCommentV2[];
  showResolvedComments: boolean;
  isHeadSelected: boolean;
  visibleLineLimit: number;
  editorHistoryScope: string;
  onOpenFile: (filePath: string) => Promise<void>;
  onShowMoreLines: (sectionId: string) => void;
  activeDraftAnchorId?: string;
  activeDraftBody: string;
  activeEditingId?: string;
  activeEditingBody: string;
  pendingKey: string;
  onOpenDraft: (anchor: CommentAnchor) => void;
  onDraftBodyChange: (value: string) => void;
  onCancelDraft: () => void;
  onOpenEdit: (comment: GitReviewCommentV2) => void;
  onEditingBodyChange: (value: string) => void;
  onCancelEdit: () => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  onUpdateComment: (id: string, body: string) => Promise<void>;
  onResolveComment: (id: string) => Promise<void>;
  onReopenComment: (id: string) => Promise<void>;
  matchedFindCount: number;
  matchedLineIndexes?: Set<number>;
  activeFindMatchKind?: GitDiffFindMatch["kind"];
  activeFindLineIndex?: number;
}) {
  const fileSectionRef = useRef<HTMLDivElement | null>(null);
  const shouldSuppressActionForSelection = (): boolean =>
    hasExpandedTextSelectionWithin(fileSectionRef.current);
  const languageHint = languageHintFromPath(file.path);
  const sectionId = buildGitReviewFileSectionId(file.path, index);
  const visibleLines = file.lines.slice(0, visibleLineLimit);
  const remainingLineCount = Math.max(
    0,
    file.lines.length - visibleLines.length,
  );
  return (
    <div
      ref={fileSectionRef}
      id={sectionId}
      data-git-diff-section="true"
      style={{ marginBottom: 18 }}
    >
      <div
        style={{
          position: "sticky",
          top: -16,
          zIndex: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
          padding: "8px 10px",
          border: `1px solid ${
            activeFindMatchKind === "file" ? "#faad14" : DIFF_FILE_HEADER_BORDER
          }`,
          borderRadius: 8,
          background: DIFF_FILE_HEADER_BACKGROUND,
          boxShadow:
            activeFindMatchKind === "file"
              ? "0 0 0 2px rgba(250, 173, 20, 0.18)"
              : "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <Button
          type="link"
          size="small"
          style={{
            padding: 0,
            height: "auto",
            fontFamily: "monospace",
            fontWeight: 700,
            fontSize: Math.max(13, fontSize),
            color: DIFF_FILE_HEADER_TEXT,
          }}
          onMouseDown={(evt) => {
            if (!shouldSuppressActionForSelection()) return;
            evt.preventDefault();
            evt.stopPropagation();
          }}
          onClick={() => {
            if (shouldSuppressActionForSelection()) {
              return;
            }
            void onOpenFile(file.path);
          }}
        >
          {file.path}
        </Button>
        <Typography.Text
          style={{
            fontSize: 11,
            color: DIFF_FILE_HEADER_SECONDARY,
          }}
        >
          {filenameMode(file.path, "text")}
          {fileComments.length > 0 ? ` · ${fileComments.length} comments` : ""}
          {matchedFindCount > 0 ? ` · ${matchedFindCount} matches` : ""}
          {remainingLineCount > 0
            ? ` · showing ${visibleLines.length.toLocaleString()} / ${file.lines.length.toLocaleString()} diff lines`
            : ""}
        </Typography.Text>
      </div>
      <DiffBlock
        filePath={file.path}
        fileIndex={index}
        lines={visibleLines}
        languageHint={languageHint}
        fontSize={fontSize}
        editorTheme={editorTheme}
        editorHistoryScope={editorHistoryScope}
        comments={fileComments}
        showResolvedComments={showResolvedComments}
        commentEnabled={!isHeadSelected}
        commentDisabledMessage={
          isHeadSelected ? "Please commit first, then comment." : undefined
        }
        activeDraftAnchorId={activeDraftAnchorId}
        activeDraftBody={activeDraftBody}
        activeEditingId={activeEditingId}
        activeEditingBody={activeEditingBody}
        pendingKey={pendingKey}
        onOpenDraft={onOpenDraft}
        onDraftBodyChange={onDraftBodyChange}
        onCancelDraft={onCancelDraft}
        onOpenEdit={onOpenEdit}
        onEditingBodyChange={onEditingBodyChange}
        onCancelEdit={onCancelEdit}
        onCreateComment={onCreateComment}
        onUpdateComment={onUpdateComment}
        onResolveComment={onResolveComment}
        onReopenComment={onReopenComment}
        matchedLineIndexes={matchedLineIndexes}
        activeMatchedLineIndex={activeFindLineIndex}
      />
      {remainingLineCount > 0 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 10,
          }}
        >
          <Button onClick={() => onShowMoreLines(sectionId)}>
            Show{" "}
            {Math.min(
              RENDERED_DIFF_LINES_INCREMENT,
              remainingLineCount,
            ).toLocaleString()}{" "}
            more lines
            {remainingLineCount > RENDERED_DIFF_LINES_INCREMENT
              ? ` (${remainingLineCount.toLocaleString()} remaining)`
              : ""}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
