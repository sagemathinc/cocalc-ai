/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: buffered markdown editors and scoped editor ids used by git review notes and inline review comments.

import { Button, Space } from "antd";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { ComponentProps } from "react";
import { normalizeCommitSha } from "../git-review-store";

type MarkdownHistoryInputProps = ComponentProps<typeof MarkdownInput> & {
  historyId: string;
};

function normalizeGitReviewEditorIdPart(
  value?: string | null,
  fallback = "none",
): string {
  const normalized = `${value ?? ""}`.trim();
  return normalized || fallback;
}

export function buildGitReviewEditorScope({
  accountId,
  commitSha,
}: {
  accountId?: string | null;
  commitSha?: string | null;
}): string {
  const normalizedCommit =
    normalizeCommitSha(commitSha ?? undefined) ?? commitSha;
  return [
    "git-review",
    "account",
    normalizeGitReviewEditorIdPart(accountId, "anonymous"),
    "commit",
    normalizeGitReviewEditorIdPart(normalizedCommit, "none"),
  ].join(":");
}

export function buildGitReviewNoteEditorId(scope: string): string {
  return `${scope}:note`;
}

export function buildGitInlineDraftEditorId({
  scope,
  filePath,
  anchorId,
}: {
  scope: string;
  filePath: string;
  anchorId: string;
}): string {
  return `${scope}:inline-draft:${filePath}:${anchorId}`;
}

export function buildGitInlineEditEditorId({
  scope,
  filePath,
  commentId,
}: {
  scope: string;
  filePath: string;
  commentId: string;
}): string {
  return `${scope}:inline-edit:${filePath}:${commentId}`;
}

export function MarkdownHistoryInput({
  historyId: _historyId,
  saveDebounceMs = 0,
  ...props
}: MarkdownHistoryInputProps) {
  return (
    <MarkdownInput
      {...props}
      saveDebounceMs={saveDebounceMs}
      undoMode="local"
      redoMode="local"
    />
  );
}

function useBufferedMarkdownValue({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [localValue, setLocalValue] = useState(value);
  const localValueRef = useRef(localValue);
  const syncedValueRef = useRef(value);
  const skipUnmountFlushRef = useRef(false);
  const skipNextBlurFlushRef = useRef(false);
  const pendingActionBlurRecoveryRef = useRef(false);

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);

  useEffect(() => {
    setLocalValue(value);
    localValueRef.current = value;
    syncedValueRef.current = value;
    skipUnmountFlushRef.current = false;
    skipNextBlurFlushRef.current = false;
    pendingActionBlurRecoveryRef.current = false;
  }, [value]);

  const flush = useCallback(
    (nextValue?: string, opts?: { force?: boolean }) => {
      if (!opts?.force && skipNextBlurFlushRef.current) {
        skipNextBlurFlushRef.current = false;
        return;
      }
      pendingActionBlurRecoveryRef.current = false;
      const resolved = nextValue ?? localValueRef.current;
      if (resolved === syncedValueRef.current) return;
      syncedValueRef.current = resolved;
      onChange(resolved);
    },
    [onChange],
  );

  useEffect(() => {
    return () => {
      if (!skipUnmountFlushRef.current) {
        flush();
      }
    };
  }, [flush]);

  const update = useCallback((nextValue: string) => {
    localValueRef.current = nextValue;
    setLocalValue(nextValue);
  }, []);

  const skipNextUnmountFlush = useCallback(() => {
    skipUnmountFlushRef.current = true;
  }, []);

  const prepareForActionFocus = useCallback(() => {
    skipNextBlurFlushRef.current = true;
    pendingActionBlurRecoveryRef.current = true;
  }, []);

  const markActionHandled = useCallback(() => {
    pendingActionBlurRecoveryRef.current = false;
  }, []);

  const recoverPendingActionBlur = useCallback(() => {
    if (!pendingActionBlurRecoveryRef.current) return;
    pendingActionBlurRecoveryRef.current = false;
    skipNextBlurFlushRef.current = false;
    flush(undefined, { force: true });
  }, [flush]);

  return {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  };
}

export function ReviewNoteEditor({
  historyId,
  value,
  committedValue,
  fontSize,
  saving,
  disabled,
  onPersistDraft,
  onCancel,
  onSave,
}: {
  historyId: string;
  value: string;
  committedValue: string;
  fontSize: number;
  saving: boolean;
  disabled: boolean;
  onPersistDraft: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange: onPersistDraft,
  });
  const dirty = localValue !== committedValue;
  return (
    <>
      <MarkdownHistoryInput
        historyId={historyId}
        cacheId={historyId}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next, { force: true });
          onSave(next);
        }}
        placeholder="Private review note (not sent to agent)"
        fontSize={Math.max(13, fontSize)}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
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
        <Button
          size="small"
          disabled={disabled}
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          disabled={!dirty || saving || disabled}
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
        >
          Save note
        </Button>
      </div>
    </>
  );
}

export function InlineDraftCommentEditor({
  historyId,
  value,
  fontSize,
  loading,
  onChange,
  onCancel,
  onSave,
}: {
  historyId: string;
  value: string;
  fontSize: number;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange,
  });
  return (
    <>
      <MarkdownHistoryInput
        historyId={historyId}
        cacheId={historyId}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next);
          onSave(next);
        }}
        placeholder="Add inline review comment..."
        fontSize={fontSize}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
      <div
        style={{
          marginTop: 6,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <Button
          size="small"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
          disabled={!localValue.trim()}
          loading={loading}
        >
          Add comment
        </Button>
      </div>
    </>
  );
}

export function InlineEditCommentEditor({
  historyId,
  value,
  fontSize,
  loading,
  onChange,
  onCancel,
  onSave,
}: {
  historyId: string;
  value: string;
  fontSize: number;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange,
  });
  return (
    <>
      <MarkdownHistoryInput
        historyId={historyId}
        cacheId={historyId}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next);
          onSave(next);
        }}
        placeholder="Edit inline review comment..."
        fontSize={fontSize}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
      <Space.Compact size="small">
        <Button
          size="small"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
          disabled={!localValue.trim()}
          loading={loading}
        >
          Save
        </Button>
      </Space.Compact>
    </>
  );
}
