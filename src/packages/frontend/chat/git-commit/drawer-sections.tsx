/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: presentational sections for the git commit drawer, including the title bar, review panels, and commit/diff summary cards.

import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  type MenuProps,
} from "antd";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import type { ReactNode, RefObject } from "react";
import { Virtuoso } from "react-virtuoso";
import { DiffFileSection } from "./diff-components";
import { getRenderedDiffLineLimit } from "./diff-find";
import { buildGitReviewFileSectionId } from "./ids";
import { ReviewNoteEditor } from "./review-editors";
import type {
  CommentAnchor,
  GitDiffFindMatch,
  GitShowFile,
  GitShowSummary,
  HeadStatusEntry,
} from "./types";
import {
  formatMergeCommitBodyMarkdown,
  isMergeCommitSummary,
  parseDateSafe,
  splitCommitMessage,
} from "./utils";
import type { GitReviewCommentV2 } from "../git-review-store";

const CARD_BORDER_COLOR = "#d9d9d9";
const CARD_SHADOW = "0 1px 2px rgba(0,0,0,0.06)";
export const GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT = 72;

type GitCommitDrawerTitleProps = {
  nonRepoError: string;
  commit?: string;
  commitSearch: string;
  logOptions: Array<{
    value: string;
    label: ReactNode;
    search?: string;
  }>;
  onCommitChange: (value: string) => void;
  onCommitSearch: (value: string) => void;
  showOnlyUnreviewedCommits: boolean;
  onToggleShowOnlyUnreviewed: (value: boolean) => void;
  diffFindInputRef: any;
  diffFindQuery: string;
  onDiffFindQueryChange: (value: string) => void;
  onNextDiffFindMatch: () => void;
  onPreviousDiffFindMatch: () => void;
  diffFindMatchesLength: number;
  activeDiffFindMatchIndex: number;
  canGoNewer: boolean;
  canGoOlder: boolean;
  onGoNewer: () => void;
  onGoOlder: () => void;
  canFindInChat: boolean;
  findInChatEnabled: boolean;
  onFindInChat?: () => void;
  contextLines: number;
  contextOptions: Array<{ value: number; label: string }>;
  onContextChange: (value: number) => void;
  reviewMenuItems: NonNullable<MenuProps["items"]>;
  onReviewMenuClick: NonNullable<MenuProps["onClick"]>;
  reviewTransferBusy: boolean;
};

export function GitCommitDrawerTitle({
  nonRepoError,
  commit,
  commitSearch,
  logOptions,
  onCommitChange,
  onCommitSearch,
  showOnlyUnreviewedCommits,
  onToggleShowOnlyUnreviewed,
  diffFindInputRef,
  diffFindQuery,
  onDiffFindQueryChange,
  onNextDiffFindMatch,
  onPreviousDiffFindMatch,
  diffFindMatchesLength,
  activeDiffFindMatchIndex,
  canGoNewer,
  canGoOlder,
  onGoNewer,
  onGoOlder,
  canFindInChat,
  findInChatEnabled,
  onFindInChat,
  contextLines,
  contextOptions,
  onContextChange,
  reviewMenuItems,
  onReviewMenuClick,
  reviewTransferBusy,
}: GitCommitDrawerTitleProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        flexWrap: "wrap",
      }}
    >
      {!nonRepoError ? (
        <>
          <Select
            showSearch
            size="small"
            value={commit}
            searchValue={commitSearch}
            options={logOptions}
            onChange={onCommitChange}
            onSearch={onCommitSearch}
            placeholder="git log"
            style={{ minWidth: 280, flex: "1 1 360px", maxWidth: 620 }}
            optionFilterProp="search"
          />
          <Checkbox
            checked={showOnlyUnreviewedCommits}
            onChange={(evt) => onToggleShowOnlyUnreviewed(evt.target.checked)}
            style={{ whiteSpace: "nowrap" }}
          >
            Only unreviewed
          </Checkbox>
          <Space.Compact size="small">
            <Input
              ref={diffFindInputRef}
              size="small"
              allowClear
              value={diffFindQuery}
              placeholder="Find in diff"
              style={{ width: 220 }}
              onChange={(evt) => onDiffFindQueryChange(evt.target.value)}
              onPressEnter={(evt) => {
                if ((evt as any)?.shiftKey) {
                  onPreviousDiffFindMatch();
                } else {
                  onNextDiffFindMatch();
                }
              }}
            />
            <Button
              size="small"
              disabled={diffFindMatchesLength === 0}
              onClick={onPreviousDiffFindMatch}
            >
              Prev
            </Button>
            <Button
              size="small"
              disabled={diffFindMatchesLength === 0}
              onClick={onNextDiffFindMatch}
            >
              Next
            </Button>
          </Space.Compact>
          {diffFindQuery.trim() ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, whiteSpace: "nowrap" }}
            >
              {diffFindMatchesLength === 0
                ? "0 matches"
                : `${activeDiffFindMatchIndex + 1} / ${diffFindMatchesLength}`}
            </Typography.Text>
          ) : null}
          <Space.Compact size="small">
            <Tooltip title="Newer commit (shortcut: k)">
              <span style={{ display: "inline-flex" }}>
                <Button size="small" onClick={onGoNewer} disabled={!canGoNewer}>
                  Newer
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Older commit (shortcut: j)">
              <span style={{ display: "inline-flex" }}>
                <Button size="small" onClick={onGoOlder} disabled={!canGoOlder}>
                  Older
                </Button>
              </span>
            </Tooltip>
          </Space.Compact>
          {canFindInChat ? (
            <Button
              size="small"
              disabled={!findInChatEnabled}
              onClick={onFindInChat}
            >
              Find in chat
            </Button>
          ) : null}
        </>
      ) : (
        <Typography.Text strong style={{ marginRight: "auto" }}>
          Git browser
        </Typography.Text>
      )}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          marginLeft: "auto",
        }}
      >
        <Tooltip title="Context lines around changes. Shortcuts: [ decrease, ] increase">
          <Select
            size="small"
            value={contextLines}
            options={contextOptions}
            onChange={onContextChange}
            style={{ width: 120 }}
          />
        </Tooltip>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: reviewMenuItems,
            onClick: onReviewMenuClick,
          }}
        >
          <Button
            size="small"
            loading={reviewTransferBusy}
            icon={<Icon name="ellipsis" />}
            aria-label="Review actions"
          />
        </Dropdown>
      </div>
    </div>
  );
}

type DeleteAllReviewModalProps = {
  open: boolean;
  busy: boolean;
  confirmText: string;
  confirmValue: string;
  onConfirmValueChange: (value: string) => void;
  onCancel: () => void;
  onDelete: () => void;
};

export function DeleteAllReviewsModal({
  open,
  busy,
  confirmText,
  confirmValue,
  onConfirmValueChange,
  onCancel,
  onDelete,
}: DeleteAllReviewModalProps) {
  const canDelete = confirmValue.trim().toLowerCase() === confirmText;
  return (
    <Modal
      open={open}
      title="Delete all git reviews?"
      destroyOnHidden
      okText="Delete all reviews"
      okButtonProps={{
        danger: true,
        disabled: busy || !canDelete,
      }}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={onDelete}
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text>
          This will permanently delete all of your saved git review notes,
          review status, and inline review comments on this CoCalc server.
        </Typography.Text>
        <Typography.Text type="secondary">
          Type <code>{confirmText}</code> to confirm.
        </Typography.Text>
        <Input
          value={confirmValue}
          autoFocus
          placeholder={confirmText}
          onChange={(evt) => onConfirmValueChange(evt.target.value)}
          onPressEnter={() => {
            if (!busy && canDelete) {
              onDelete();
            }
          }}
        />
      </Space>
    </Modal>
  );
}

type GitRepoBootstrapPanelProps = {
  cwd: string;
  error: string;
  busy: boolean;
  canAskAgent: boolean;
  onInitialize: () => void;
  onAskAgent: () => void;
};

export function GitRepoBootstrapPanel({
  cwd,
  error,
  busy,
  canAskAgent,
  onInitialize,
  onAskAgent,
}: GitRepoBootstrapPanelProps) {
  return (
    <div
      style={{
        border: `1px solid ${CARD_BORDER_COLOR}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        background: "#fff",
        boxShadow: CARD_SHADOW,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <Typography.Text strong>
        This folder is not a git repository.
      </Typography.Text>
      <Typography.Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
        {error}
      </Typography.Text>
      <Typography.Text type="secondary">
        Path: <code>{cwd}</code>
      </Typography.Text>
      <Space wrap>
        <Button type="primary" onClick={onInitialize} loading={busy}>
          Initialize Git Repo
        </Button>
        <Button onClick={onAskAgent} disabled={!canAskAgent} loading={busy}>
          Ask Agent to Set Up Repo
        </Button>
      </Space>
    </div>
  );
}

type GitHeadCommitPanelProps = {
  message: string;
  busy: boolean;
  error: string;
  hasTrackedChanges: boolean;
  headStatusError: string;
  headStatusLoading: boolean;
  headStatusEntries: HeadStatusEntry[];
  headStatusAction: string;
  onMessageChange: (value: string) => void;
  onCommitWithSummary: () => void;
  onCommit: () => void;
  onClearMessage: () => void;
  onOpenFile: (path: string) => void;
  onAddUntrackedFile: (path: string) => void;
  onIgnoreUntrackedFile: (path: string) => void;
};

export function GitHeadCommitPanel({
  message,
  busy,
  error,
  hasTrackedChanges,
  headStatusError,
  headStatusLoading,
  headStatusEntries,
  headStatusAction,
  onMessageChange,
  onCommitWithSummary,
  onCommit,
  onClearMessage,
  onOpenFile,
  onAddUntrackedFile,
  onIgnoreUntrackedFile,
}: GitHeadCommitPanelProps) {
  return (
    <div
      style={{
        border: `1px solid ${CARD_BORDER_COLOR}`,
        borderRadius: 8,
        borderLeft: `4px solid ${COLORS.BLUE}`,
        padding: 12,
        marginBottom: 12,
        background: "#fff",
        boxShadow: CARD_SHADOW,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 600 }}>Commit changes</div>
      <Input.TextArea
        value={message}
        disabled={busy}
        placeholder="or leave blank to let the agent write the message"
        autoSize={{ minRows: 2, maxRows: 6 }}
        onChange={(e) => onMessageChange(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          size="small"
          type="primary"
          onClick={onCommitWithSummary}
          disabled={busy || !hasTrackedChanges}
        >
          Commit with AI Summary
        </Button>
        <Button size="small" onClick={onCommit} disabled={!hasTrackedChanges}>
          Commit
        </Button>
        <Button
          size="small"
          onClick={onClearMessage}
          disabled={busy || message.length === 0}
        >
          Clear
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Commit uses all tracked changes only (`git commit -a`). Untracked files
        are excluded.
      </Typography.Text>
      {!hasTrackedChanges ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No tracked changes are currently available for one-click commit.
        </Typography.Text>
      ) : null}
      {error ? <Alert type="error" showIcon title={error} /> : null}

      <div style={{ fontWeight: 600 }}>Uncommitted files</div>
      {headStatusError ? (
        <Alert type="warning" showIcon title={headStatusError} />
      ) : null}
      {headStatusLoading ? (
        <div style={{ padding: "12px 0", textAlign: "center" }}>
          <Spin size="small" />
        </div>
      ) : null}
      {!headStatusLoading && headStatusEntries.length === 0 ? (
        <Typography.Text type="secondary">
          No uncommitted changes.
        </Typography.Text>
      ) : null}
      {!headStatusLoading && headStatusEntries.length > 0
        ? headStatusEntries.map((entry) => (
            <div
              key={`${entry.statusCode}:${entry.path}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                border: `1px solid ${COLORS.GRAY_LL}`,
                borderRadius: 6,
                padding: "6px 8px",
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, fontFamily: "monospace" }}
                  onClick={() => onOpenFile(entry.path)}
                >
                  {entry.displayPath}
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {entry.statusLabel}
                  {!entry.tracked ? " (not included by Commit)" : ""}
                </Typography.Text>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Typography.Text code style={{ marginBottom: 0 }}>
                  {entry.statusCode}
                </Typography.Text>
                {!entry.tracked ? (
                  <Space.Compact size="small">
                    <Button
                      size="small"
                      onClick={() => onAddUntrackedFile(entry.path)}
                      loading={headStatusAction === `add:${entry.path}`}
                      disabled={Boolean(headStatusAction)}
                    >
                      Add
                    </Button>
                    <Button
                      size="small"
                      onClick={() => onIgnoreUntrackedFile(entry.path)}
                      loading={headStatusAction === `ignore:${entry.path}`}
                      disabled={Boolean(headStatusAction)}
                    >
                      Ignore
                    </Button>
                  </Space.Compact>
                ) : null}
              </div>
            </div>
          ))
        : null}
    </div>
  );
}

type GitReviewPanelProps = {
  reviewed: boolean;
  reviewLoading: boolean;
  reviewSaving: boolean;
  reviewUpdatedAt?: number;
  accountId?: string;
  currentReviewCommit?: string;
  isHeadSelected: boolean;
  reviewNoteEditing: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewNoteHistoryId: string;
  fontSize: number;
  editorTheme?: string | null;
  reviewError: string;
  inlineCommentCount: number;
  resolvedInlineCount: number;
  showResolvedComments: boolean;
  onToggleReviewed: (value: boolean) => void;
  onToggleShowResolvedComments: (value: boolean) => void;
  onPersistReviewNoteDraft: (value: string) => void;
  onStartEditingReviewNote: () => void;
  onCancelReviewNote: () => void;
  onSaveReviewNote: (value: string) => void;
  actionableInlineCommentCount: number;
  reviewSubmitBusy: boolean;
  canRequestAgentTurn: boolean;
  reviewSubmissionHelpText?: ReactNode;
  onSendInlineReviewToAgent: () => void;
};

export function GitReviewPanel({
  reviewed,
  reviewLoading,
  reviewSaving,
  reviewUpdatedAt,
  accountId,
  currentReviewCommit,
  isHeadSelected,
  reviewNoteEditing,
  reviewNote,
  reviewNoteDraft,
  reviewNoteHistoryId,
  fontSize,
  editorTheme,
  reviewError,
  inlineCommentCount,
  resolvedInlineCount,
  showResolvedComments,
  onToggleReviewed,
  onToggleShowResolvedComments,
  onPersistReviewNoteDraft,
  onStartEditingReviewNote,
  onCancelReviewNote,
  onSaveReviewNote,
  actionableInlineCommentCount,
  reviewSubmitBusy,
  canRequestAgentTurn,
  reviewSubmissionHelpText,
  onSendInlineReviewToAgent,
}: GitReviewPanelProps) {
  const submitDisabled =
    actionableInlineCommentCount === 0 ||
    reviewSubmitBusy ||
    reviewSaving ||
    !canRequestAgentTurn;
  const submitButton = (
    <Button
      size="small"
      type="primary"
      disabled={submitDisabled}
      loading={reviewSubmitBusy}
      onClick={onSendInlineReviewToAgent}
    >
      {`Send inline comments to agent${
        actionableInlineCommentCount > 0
          ? ` (${actionableInlineCommentCount})`
          : ""
      }`}
    </Button>
  );
  return (
    <div
      style={{
        border: `1px solid ${CARD_BORDER_COLOR}`,
        borderRadius: 8,
        borderLeft: `4px solid ${COLORS.BLUE}`,
        padding: 12,
        marginBottom: 12,
        background: "#fff",
        boxShadow: CARD_SHADOW,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 8,
          flexWrap: "wrap",
          overflow: "visible",
        }}
      >
        <Checkbox
          checked={reviewed}
          disabled={
            reviewLoading ||
            reviewSaving ||
            !accountId ||
            !currentReviewCommit ||
            isHeadSelected
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            alignSelf: "flex-start",
            minHeight: 22,
            lineHeight: "20px",
          }}
          onChange={(e) => onToggleReviewed(e.target.checked)}
        >
          <span style={{ fontWeight: 600 }}>Reviewed</span>
        </Checkbox>
        <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
          <Space size={8} align="center">
            {resolvedInlineCount > 0 ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Show resolved
                </Typography.Text>
                <Switch
                  size="small"
                  checked={showResolvedComments}
                  onChange={onToggleShowResolvedComments}
                />
              </>
            ) : null}
            <span>
              {reviewSaving ? "Saving..." : null}
              {!reviewSaving && reviewUpdatedAt ? (
                <>
                  Updated <TimeAgo date={new Date(reviewUpdatedAt)} />
                </>
              ) : null}
            </span>
          </Space>
        </div>
      </div>
      {reviewNoteEditing ? (
        <ReviewNoteEditor
          historyId={reviewNoteHistoryId}
          key={reviewNoteHistoryId}
          value={reviewNoteDraft}
          committedValue={reviewNote}
          fontSize={fontSize}
          saving={reviewSaving}
          disabled={
            reviewLoading ||
            !accountId ||
            isHeadSelected ||
            !currentReviewCommit
          }
          onPersistDraft={onPersistReviewNoteDraft}
          onCancel={onCancelReviewNote}
          onSave={onSaveReviewNote}
        />
      ) : (
        <div
          style={{
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 6,
            padding: "8px 10px",
            background: "#fff",
            minHeight: 40,
          }}
        >
          {reviewNote?.trim() ? (
            <StaticMarkdown
              value={reviewNote}
              style={{ fontSize: Math.max(13, fontSize) }}
              editorTheme={editorTheme}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              No private review note yet.
            </Typography.Text>
          )}
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
        This note and the Reviewed checkbox are private state only. They are not
        sent to the agent.
      </Typography.Text>
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
          {reviewError || (reviewLoading ? "Loading review state..." : "")}
          {!reviewError && !reviewLoading && inlineCommentCount > 0
            ? ` · ${inlineCommentCount} inline comments`
            : ""}
        </div>
        {!reviewNoteEditing ? (
          <Button
            size="small"
            disabled={
              reviewSaving ||
              !accountId ||
              !currentReviewCommit ||
              isHeadSelected
            }
            onClick={onStartEditingReviewNote}
          >
            Edit
          </Button>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 8,
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 6,
          background: "#fff",
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Send only draft inline diff comments (created with the <code>+</code>{" "}
          buttons in the patch below).
        </Typography.Text>
        {reviewSubmissionHelpText && !canRequestAgentTurn ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {reviewSubmissionHelpText}
          </Typography.Text>
        ) : null}
        <Space.Compact size="small">
          {reviewSubmissionHelpText && !canRequestAgentTurn ? (
            <Tooltip title={reviewSubmissionHelpText}>
              <span style={{ display: "inline-flex" }}>{submitButton}</span>
            </Tooltip>
          ) : (
            submitButton
          )}
        </Space.Compact>
      </div>
    </div>
  );
}

type GitCommitDetailsPanelProps = {
  summary: GitShowSummary;
  commit?: string;
  isHeadSelected: boolean;
  fontSize: number;
  editorTheme?: string | null;
  headRefLabel: string;
};

export function GitCommitDetailsPanel({
  summary,
  commit,
  isHeadSelected,
  fontSize,
  editorTheme,
  headRefLabel,
}: GitCommitDetailsPanelProps) {
  const rows: Array<{
    label: string;
    value?: string;
    asDate?: boolean;
    monospace?: boolean;
  }> = [
    {
      label: "Commit",
      value: summary.commit ?? (isHeadSelected ? headRefLabel : (commit ?? "")),
      monospace: true,
    },
    { label: "Author", value: summary.author },
    {
      label: "Author Date",
      value: summary.authorDate,
      asDate: true,
    },
    { label: "Committer", value: summary.committer },
    {
      label: "Commit Date",
      value: summary.commitDate,
      asDate: true,
    },
  ].filter((row) => Boolean(`${row.value ?? ""}`.trim()));
  const commitMessage = splitCommitMessage(summary.message);

  return (
    <div
      style={{
        border: `1px solid ${CARD_BORDER_COLOR}`,
        borderRadius: 8,
        borderLeft: `4px solid ${COLORS.BLUE}`,
        padding: "10px 12px",
        background: "#fff",
        boxShadow: CARD_SHADOW,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <Typography.Text strong style={{ fontSize: 13 }}>
        Commit details
      </Typography.Text>
      {rows.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr",
            columnGap: 12,
            rowGap: 6,
          }}
        >
          {rows.map((row) => (
            <div
              key={`${row.label}:${row.value ?? ""}`}
              style={{ display: "contents" }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.label}
              </Typography.Text>
              <Typography.Text
                style={{
                  fontSize: 12,
                  fontFamily: row.monospace ? "monospace" : undefined,
                  overflowWrap: "anywhere",
                }}
              >
                {row.asDate
                  ? (() => {
                      const parsed = parseDateSafe(row.value);
                      return parsed ? <TimeAgo date={parsed} /> : row.value;
                    })()
                  : row.value}
              </Typography.Text>
            </div>
          ))}
        </div>
      ) : null}
      {summary.message ? (
        <div
          style={{
            borderTop: `1px solid ${COLORS.GRAY_LL}`,
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: commitMessage.body ? 8 : 0,
          }}
        >
          {commitMessage.subject ? (
            <Typography.Text
              strong
              style={{
                fontSize: Math.max(13, fontSize),
                lineHeight: 1.55,
                overflowWrap: "anywhere",
              }}
            >
              {commitMessage.subject}
            </Typography.Text>
          ) : null}
          {commitMessage.body ? (
            <StaticMarkdown
              value={
                isMergeCommitSummary(summary)
                  ? (formatMergeCommitBodyMarkdown(commitMessage.body) ??
                    commitMessage.body)
                  : commitMessage.body
              }
              style={{
                fontSize: Math.max(13, fontSize),
                lineHeight: 1.55,
              }}
              editorTheme={editorTheme}
            />
          ) : null}
        </div>
      ) : summary.extraHeaderLines.length ? (
        <Typography.Paragraph
          style={{
            marginBottom: 0,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            fontSize: Math.max(11, fontSize - 1),
          }}
        >
          {summary.extraHeaderLines.join("\n")}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}

type GitChangedFilesPanelProps = {
  files: GitShowFile[];
  inlineCommentsByFile: Map<string, GitReviewCommentV2[]>;
  onOpenFileDiff: (index: number) => void;
};

export function GitChangedFilesPanel({
  files,
  inlineCommentsByFile,
  onOpenFileDiff,
}: GitChangedFilesPanelProps) {
  return (
    <div
      style={{
        marginBottom: 18,
        padding: "10px 12px",
        border: `1px solid ${CARD_BORDER_COLOR}`,
        borderRadius: 10,
        background: "white",
        boxShadow: CARD_SHADOW,
      }}
    >
      <Typography.Text strong style={{ display: "block", marginBottom: 10 }}>
        Changed files
      </Typography.Text>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {files.map((file, idx) => {
          const sectionId = buildGitReviewFileSectionId(file.path, idx);
          const fileComments = inlineCommentsByFile.get(file.path) ?? [];
          return (
            <Button
              key={`file-index-${sectionId}`}
              size="small"
              style={{
                fontFamily: "monospace",
                maxWidth: "100%",
              }}
              onClick={() => onOpenFileDiff(idx)}
            >
              {file.path}
              {fileComments.length > 0 ? ` (${fileComments.length})` : ""}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

type GitDiffFilesPanelProps = {
  files: GitShowFile[];
  drawerScrollParent: HTMLElement | null;
  virtuosoRef: RefObject<any>;
  fontSize: number;
  editorTheme?: string | null;
  reviewEditorScope: string;
  inlineCommentsByFile: Map<string, GitReviewCommentV2[]>;
  showResolvedComments: boolean;
  isHeadSelected: boolean;
  visibleDiffLinesByFile: Record<string, number>;
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
  diffFindMatchCounts: Map<number, number>;
  diffFindMatchedLineIndexes: Map<number, Set<number>>;
  activeDiffFindMatch?: GitDiffFindMatch;
};

export function GitDiffFilesPanel({
  files,
  drawerScrollParent,
  virtuosoRef,
  fontSize,
  editorTheme,
  reviewEditorScope,
  inlineCommentsByFile,
  showResolvedComments,
  isHeadSelected,
  visibleDiffLinesByFile,
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
  diffFindMatchCounts,
  diffFindMatchedLineIndexes,
  activeDiffFindMatch,
}: GitDiffFilesPanelProps) {
  return (
    <DiffVirtualizedList
      files={files}
      drawerScrollParent={drawerScrollParent}
      virtuosoRef={virtuosoRef}
      itemContent={(idx, file) => {
        const sectionId = buildGitReviewFileSectionId(file.path, idx);
        const fileComments = inlineCommentsByFile.get(file.path) ?? [];
        return (
          <DiffFileSection
            file={file}
            index={idx}
            fontSize={fontSize}
            editorTheme={editorTheme}
            editorHistoryScope={reviewEditorScope}
            fileComments={fileComments}
            showResolvedComments={showResolvedComments}
            isHeadSelected={isHeadSelected}
            visibleLineLimit={getRenderedDiffLineLimit(
              visibleDiffLinesByFile[sectionId],
            )}
            onOpenFile={onOpenFile}
            onShowMoreLines={onShowMoreLines}
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
            matchedFindCount={diffFindMatchCounts.get(idx) ?? 0}
            matchedLineIndexes={diffFindMatchedLineIndexes.get(idx)}
            activeFindMatchKind={
              activeDiffFindMatch?.fileIndex === idx
                ? activeDiffFindMatch.kind
                : undefined
            }
            activeFindLineIndex={
              activeDiffFindMatch?.fileIndex === idx
                ? activeDiffFindMatch.lineIndex
                : undefined
            }
          />
        );
      }}
    />
  );
}

function DiffVirtualizedList({
  files,
  drawerScrollParent,
  virtuosoRef,
  itemContent,
}: {
  files: GitShowFile[];
  drawerScrollParent: HTMLElement | null;
  virtuosoRef: RefObject<any>;
  itemContent: (idx: number, file: GitShowFile) => ReactNode;
}) {
  return (
    <Virtuoso
      ref={virtuosoRef}
      customScrollParent={drawerScrollParent ?? undefined}
      data={files}
      components={{
        Footer: GitDiffListFooterSpacer,
      }}
      computeItemKey={(idx, file) =>
        buildGitReviewFileSectionId(file.path, idx)
      }
      increaseViewportBy={1200}
      itemContent={itemContent}
    />
  );
}

export function GitDiffListFooterSpacer() {
  return (
    <div
      aria-hidden="true"
      data-testid="git-diff-list-footer-spacer"
      style={{
        height: GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT,
        pointerEvents: "none",
      }}
    />
  );
}

export function GitEmptyCommitDiff() {
  return <Empty description="No file changes in this commit." />;
}
