/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Space, Typography } from "antd";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { COLORS } from "@cocalc/util/theme";
import type { GitReviewCommentV2 } from "../git-review-store";
import type { CommentAnchor } from "./types";
import {
  buildGitInlineDraftEditorId,
  buildGitInlineEditEditorId,
  InlineDraftCommentEditor,
  InlineEditCommentEditor,
} from "./review-editors";

export interface InlineReviewCardsProps {
  filePath: string;
  editorHistoryScope: string;
  fontSize: number;
  editorTheme?: string | null;
  lineComments: GitReviewCommentV2[];
  anchor?: CommentAnchor | null;
  anchorId: string;
  showDraft: boolean;
  activeDraftBody: string;
  activeEditingId?: string;
  activeEditingBody: string;
  pendingKey: string;
  inset?: number;
  onDraftBodyChange: (value: string) => void;
  onCancelDraft: () => void;
  onOpenEdit: (comment: GitReviewCommentV2) => void;
  onEditingBodyChange: (value: string) => void;
  onCancelEdit: () => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  onUpdateComment: (id: string, body: string) => Promise<void>;
  onResolveComment: (id: string) => Promise<void>;
  onReopenComment: (id: string) => Promise<void>;
}

// Both renderers must use the same editor identities and persistence callbacks.
export function InlineReviewCards({
  filePath,
  editorHistoryScope,
  fontSize,
  editorTheme,
  lineComments,
  anchor,
  anchorId,
  showDraft,
  activeDraftBody,
  activeEditingId,
  activeEditingBody,
  pendingKey,
  inset = 0,
  onDraftBodyChange,
  onCancelDraft,
  onOpenEdit,
  onEditingBodyChange,
  onCancelEdit,
  onCreateComment,
  onUpdateComment,
  onResolveComment,
  onReopenComment,
}: InlineReviewCardsProps) {
  const commentFontSize = Math.max(13, fontSize);
  const commentFontFamily =
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  return (
    <>
      {lineComments.length > 0
        ? lineComments.map((comment) => {
            const isEditing = activeEditingId === comment.id;
            return (
              <div
                key={comment.id}
                style={{
                  margin: `0 8px 6px ${inset}px`,
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  borderLeft: `4px solid ${COLORS.BLUE}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: COLORS.WHITE,
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
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
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
                    onSave={(value) => void onUpdateComment(comment.id, value)}
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
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {comment.status === "resolved"
                      ? "Resolved"
                      : comment.status === "submitted"
                        ? "Submitted"
                        : "Draft"}
                  </Typography.Text>
                  {isEditing ? null : (
                    <Space.Compact size="small">
                      <Button size="small" onClick={() => onOpenEdit(comment)}>
                        Edit
                      </Button>
                      {comment.status === "resolved" ? (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => void onReopenComment(comment.id)}
                          loading={pendingKey === `reopen:${comment.id}`}
                        >
                          Reopen
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => void onResolveComment(comment.id)}
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
            margin: `0 8px 8px ${inset}px`,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderLeft: `4px solid ${COLORS.BLUE}`,
            borderRadius: 8,
            padding: "10px 12px",
            background: COLORS.WHITE,
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
    </>
  );
}
