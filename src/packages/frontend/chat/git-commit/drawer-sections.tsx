/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: presentational sections for the git commit drawer, including the title bar, review panels, and commit/diff summary cards.

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popover,
  Progress,
  Select,
  Space,
  Spin,
  Typography,
  type MenuProps,
} from "antd";
import dayjs from "dayjs";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { type ReactNode, type RefObject } from "react";
import { buildGitReviewFileSectionId } from "./ids";
import { ReviewNoteEditor } from "./review-editors";
import { RecoveredNotes } from "./recovered-notes";
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
  shouldDisableGitReviewSubmission,
  splitCommitMessage,
} from "./utils";
import type { GitReviewCommentV2 } from "../git-review-store";
import { UntrustedStaticMarkdown } from "./untrusted-static-markdown";

const CARD_BORDER_COLOR = UI_COLORS.border;
const CARD_BACKGROUND = UI_COLORS.surface;
const CARD_SHADOW = `0 1px 2px ${UI_COLORS.shadow}`;
export const GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT = 72;
const EMPTY_GIT_REVIEW_COMMENTS: GitReviewCommentV2[] = [];

type GitCommitDrawerTitleProps = {
  nonRepoError: string;
  commit?: string;
  commitFilter: string;
  logOptions: Array<{
    value: string;
    label: ReactNode;
    plainLabel?: ReactNode;
    search?: string;
  }>;
  onCommitChange: (value: string) => void;
  onCommitFilterChange: (value: string) => void;
  filteredCommitCount: number;
  recentCommitCount: number;
  reviewedRecentCommitCount: number;
  recentCutoff?: number;
  onRecentCutoffChange: (value: number | undefined) => void;
  gitLogFetchCount: number;
  onGitLogFetchCountChange: (value: number) => void;
  showOnlyUnreviewedCommits: boolean;
  onToggleShowOnlyUnreviewed: (value: boolean) => void;
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
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
};

export function GitCommitDrawerTitle({
  nonRepoError,
  commit,
  commitFilter,
  logOptions,
  onCommitChange,
  onCommitFilterChange,
  filteredCommitCount,
  recentCommitCount,
  reviewedRecentCommitCount,
  recentCutoff,
  onRecentCutoffChange,
  gitLogFetchCount,
  onGitLogFetchCountChange,
  showOnlyUnreviewedCommits,
  onToggleShowOnlyUnreviewed,
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
  shortcutsOpen,
  onShortcutsOpenChange,
}: GitCommitDrawerTitleProps) {
  const reviewPercent =
    recentCommitCount > 0
      ? Math.round((100 * reviewedRecentCommitCount) / recentCommitCount)
      : 0;
  const reviewComplete =
    recentCommitCount > 0 && reviewedRecentCommitCount >= recentCommitCount;
  const reviewProgressColor = reviewComplete
    ? UI_COLORS.success
    : reviewPercent >= 80
      ? UI_COLORS.success
      : reviewPercent >= 40
        ? UI_COLORS.warning
        : UI_COLORS.danger;
  const progressPopover = (
    <Space vertical size="small" style={{ width: 280 }}>
      <Typography.Text strong>Recent commit review scope</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Progress counts loaded non-merge commits on or after this cutoff date.
      </Typography.Text>
      <DatePicker
        allowClear
        size="small"
        value={recentCutoff != null ? dayjs(recentCutoff) : null}
        style={{ width: "100%" }}
        onChange={(value) => {
          onRecentCutoffChange(value?.startOf("day").valueOf());
        }}
      />
      <InputNumber
        size="small"
        min={50}
        max={5000}
        step={50}
        value={gitLogFetchCount}
        addonBefore="Load"
        addonAfter="commits"
        style={{ width: "100%" }}
        onChange={(value) => {
          if (typeof value === "number") {
            onGitLogFetchCountChange(value);
          }
        }}
      />
    </Space>
  );
  const shortcutsPopover = (
    <Space vertical size={4} style={{ minWidth: 220 }}>
      {[
        ["Space", "Scroll down"],
        ["Shift+Space", "Scroll up"],
        ["j", "Older commit"],
        ["k", "Newer commit"],
        ["y", "Mark commit reviewed"],
        ["Home", "Scroll to top"],
        ["/", "Find in diff"],
      ].map(([key, description]) => (
        <div
          key={key}
          style={{
            display: "grid",
            gridTemplateColumns: "96px 1fr",
            gap: 10,
            fontSize: 12,
          }}
        >
          <Typography.Text
            code
            style={{ display: "inline-block", whiteSpace: "nowrap" }}
          >
            {key}
          </Typography.Text>
          <Typography.Text>{description}</Typography.Text>
        </div>
      ))}
    </Space>
  );
  return (
    <div
      className="git-review-navigation"
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "1 1 100%",
              minWidth: 0,
            }}
          >
            <Select
              aria-label="Commit"
              showSearch={{ optionFilterProp: "search" }}
              size="small"
              value={commit}
              options={logOptions}
              onChange={onCommitChange}
              placeholder="git log"
              style={{ minWidth: 0, flex: "1 1 auto" }}
              optionLabelProp="plainLabel"
            />
            <Space.Compact size="small">
              <Tooltip title="Newer commit (shortcut: k)">
                <span style={{ display: "inline-flex" }}>
                  <Button
                    size="small"
                    onClick={onGoNewer}
                    disabled={!canGoNewer}
                  >
                    Newer
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="Older commit (shortcut: j)">
                <span style={{ display: "inline-flex" }}>
                  <Button
                    size="small"
                    onClick={onGoOlder}
                    disabled={!canGoOlder}
                  >
                    Older
                  </Button>
                </span>
              </Tooltip>
            </Space.Compact>
          </div>
          <Checkbox
            checked={showOnlyUnreviewedCommits}
            onChange={(evt) => onToggleShowOnlyUnreviewed(evt.target.checked)}
            style={{ whiteSpace: "nowrap" }}
          >
            Only unreviewed
          </Checkbox>
          <details className="git-review-disclosure">
            <summary>Review filters &amp; progress</summary>
            <Space size="small" wrap>
              <Input
                size="small"
                allowClear
                value={commitFilter}
                placeholder="Filter commits"
                style={{ width: 200 }}
                onChange={(evt) => onCommitFilterChange(evt.target.value)}
              />

              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, whiteSpace: "nowrap" }}
              >
                {filteredCommitCount.toLocaleString()} /{" "}
                {recentCommitCount.toLocaleString()} recent commits
              </Typography.Text>
              <Popover trigger="click" content={progressPopover}>
                <div
                  role="button"
                  tabIndex={0}
                  style={{
                    width: 120,
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  <Progress
                    size="small"
                    percent={reviewPercent}
                    status={reviewComplete ? "success" : "normal"}
                    strokeColor={reviewProgressColor}
                    format={() => (
                      <span>
                        {reviewComplete ? (
                          <>
                            <Icon name="check" />{" "}
                          </>
                        ) : null}
                        {reviewedRecentCommitCount.toLocaleString()} /{" "}
                        {recentCommitCount.toLocaleString()}
                      </span>
                    )}
                  />
                </div>
              </Popover>
            </Space>
          </details>
          {canFindInChat ? (
            <Button
              size="small"
              disabled={!findInChatEnabled}
              onClick={onFindInChat}
            >
              Find in chat
            </Button>
          ) : null}
          <Popover
            trigger="click"
            open={shortcutsOpen}
            onOpenChange={onShortcutsOpenChange}
            title="Git review shortcuts"
            content={shortcutsPopover}
          >
            <Button size="small">?</Button>
          </Popover>
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
            icon={<Icon name="ellipsis-vertical" />}
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
        background: CARD_BACKGROUND,
        color: UI_COLORS.text,
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
        borderLeft: `4px solid ${UI_COLORS.primary}`,
        padding: 12,
        marginBottom: 12,
        background: CARD_BACKGROUND,
        color: UI_COLORS.text,
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
                border: `1px solid ${UI_COLORS.border}`,
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
  reviewNoteVersions?: string[];
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
  reviewNoteVersions,
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
  const submitDisabled = shouldDisableGitReviewSubmission({
    actionableInlineCommentCount,
    reviewSubmitBusy,
    reviewSaving,
    canRequestAgentTurn,
    accountId: accountId ?? undefined,
    currentReviewCommit: currentReviewCommit ?? undefined,
    isHeadSelected,
  });
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
    <section
      className="git-review-private"
      aria-label="Private review"
      style={{
        borderBlock: `1px solid ${UI_COLORS.border}`,
        color: UI_COLORS.text,
      }}
    >
      <div className="git-review-private-toolbar">
        <div className="git-review-private-label">
          <strong>Private review</strong>
          <span style={{ color: UI_COLORS.secondary }}>Only you</span>
        </div>
        <Checkbox
          checked={reviewed}
          disabled={
            reviewLoading ||
            reviewSaving ||
            !accountId ||
            !currentReviewCommit ||
            isHeadSelected
          }
          onChange={(event) => onToggleReviewed(event.target.checked)}
        >
          Reviewed
        </Checkbox>
        {!reviewNoteEditing && (
          <Button
            size="small"
            type="link"
            disabled={
              reviewSaving ||
              !accountId ||
              !currentReviewCommit ||
              isHeadSelected
            }
            onClick={onStartEditingReviewNote}
          >
            {reviewNote?.trim() ? "Edit private note" : "Add private note"}
          </Button>
        )}
        <div className="git-review-private-send">
          {inlineCommentCount > 0 && (
            <Typography.Text type="secondary">
              {inlineCommentCount} comments
            </Typography.Text>
          )}
          <Tooltip
            title={
              reviewSubmissionHelpText && !canRequestAgentTurn
                ? reviewSubmissionHelpText
                : "Only draft inline comments are sent. Private notes and review status stay private."
            }
          >
            <span style={{ display: "inline-flex" }}>{submitButton}</span>
          </Tooltip>
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
      ) : reviewNote?.trim() ? (
        <div className="git-review-private-note">
          <UntrustedStaticMarkdown
            value={reviewNote}
            style={{ fontSize: Math.max(13, fontSize) }}
            editorTheme={editorTheme}
          />
        </div>
      ) : null}
      <RecoveredNotes versions={reviewNoteVersions} current={reviewNote} />
      {(reviewError || reviewLoading || reviewSaving) && (
        <div role="status" style={{ color: UI_COLORS.secondary }}>
          {reviewError ||
            (reviewLoading ? "Loading review state..." : "Saving...")}
        </div>
      )}
      {resolvedInlineCount > 0 && (
        <Checkbox
          checked={showResolvedComments}
          onChange={(event) =>
            onToggleShowResolvedComments(event.target.checked)
          }
        >
          Show resolved comments ({resolvedInlineCount})
        </Checkbox>
      )}
      {reviewUpdatedAt && (
        <div
          className="git-review-updated"
          style={{ color: UI_COLORS.secondary }}
        >
          Updated <TimeAgo date={new Date(reviewUpdatedAt)} />
        </div>
      )}
    </section>
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
        borderLeft: `4px solid ${UI_COLORS.primary}`,
        padding: "10px 12px",
        background: CARD_BACKGROUND,
        color: UI_COLORS.text,
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
            borderTop: `1px solid ${UI_COLORS.border}`,
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
            <UntrustedStaticMarkdown
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
  onOpenFileDiff: (index: number, behavior: "auto") => void;
};

export function GitChangedFilesPanel({
  files,
  inlineCommentsByFile,
  onOpenFileDiff,
}: GitChangedFilesPanelProps) {
  return (
    <div
      style={{
        padding: "4px 0",
        color: UI_COLORS.text,
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          whiteSpace: "nowrap",
          fontSize: 12,
        }}
      >
        Changed files
        <select
          aria-label="Changed files"
          value=""
          onChange={(event) =>
            onOpenFileDiff(Number(event.target.value), "auto")
          }
          style={{ width: "100%", minWidth: 0 }}
        >
          <option value="" disabled>
            Choose a file ({files.length})
          </option>
          {files.map((file, idx) => {
            const sectionId = buildGitReviewFileSectionId(file.path, idx);
            const fileComments =
              inlineCommentsByFile.get(file.path) ?? EMPTY_GIT_REVIEW_COMMENTS;
            return (
              <option key={`file-index-${sectionId}`} value={idx}>
                {file.path}
                {fileComments.length > 0 ? ` (${fileComments.length})` : ""}
              </option>
            );
          })}
        </select>
      </label>
    </div>
  );
}

export type GitDiffFilesPanelProps = {
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
  onViewFile?: (filePath: string, side?: "old" | "new") => void;
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
