/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: pure resolution helpers for merging git review drafts, saved records, and in-flight save completions.

import type {
  GitReviewCommentV2,
  GitReviewRecordV2,
} from "../git-review-store";

export function resolveGitReviewSaveState({
  next = {},
  draft,
  reviewed,
  reviewNote,
  reviewNoteDraft,
  reviewComments,
}: {
  next?: Partial<Pick<GitReviewRecordV2, "reviewed" | "note" | "comments">>;
  draft?: {
    reviewed: boolean;
    note: string;
    comments?: Record<string, GitReviewCommentV2>;
  };
  reviewed: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewComments?: Record<string, GitReviewCommentV2>;
}): {
  reviewed: boolean;
  note: string;
  comments: Record<string, GitReviewCommentV2>;
} {
  const draftComments = draft?.comments;
  return {
    reviewed: next.reviewed ?? draft?.reviewed ?? reviewed,
    note: next.note ?? draft?.note ?? reviewNoteDraft ?? reviewNote,
    comments:
      next.comments ??
      (draftComments && Object.keys(draftComments).length > 0
        ? draftComments
        : (reviewComments ?? {})),
  };
}

export function resolveGitReviewSaveCompletion({
  payload,
  sent,
  current,
}: {
  payload: Pick<GitReviewRecordV2, "reviewed" | "note">;
  sent: {
    reviewed: boolean;
    note: string;
  };
  current: {
    reviewed: boolean;
    noteDraft: string;
  };
}): {
  reviewed: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewDirty: boolean;
} {
  const reviewedChangedSinceSave = current.reviewed !== sent.reviewed;
  const noteChangedSinceSave = current.noteDraft !== sent.note;
  return {
    reviewed: reviewedChangedSinceSave ? current.reviewed : payload.reviewed,
    reviewNote: payload.note,
    reviewNoteDraft: noteChangedSinceSave ? current.noteDraft : payload.note,
    reviewDirty: reviewedChangedSinceSave || noteChangedSinceSave,
  };
}

export function resolveGitReviewLoadFailure({
  draft,
  error,
}: {
  draft?: {
    reviewed: boolean;
    note: string;
    updated_at?: number;
  };
  error: unknown;
}): {
  reviewError: string;
  reviewed: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewUpdatedAt?: number;
} {
  const note = `${draft?.note ?? ""}`;
  return {
    reviewError: `${error ?? "Unable to load review state."}`,
    reviewed: Boolean(draft?.reviewed),
    reviewNote: note,
    reviewNoteDraft: note,
    reviewUpdatedAt:
      typeof draft?.updated_at === "number" ? draft.updated_at : undefined,
  };
}

export function shouldClearGitReviewSavingOnScopeChange({
  reviewSaving,
  previousScope,
  nextScope,
}: {
  reviewSaving: boolean;
  previousScope?: string;
  nextScope?: string;
}): boolean {
  return reviewSaving && previousScope !== nextScope;
}

export function shouldClearGitReviewSubmitOnScopeChange({
  reviewSubmitBusy,
  previousScope,
  nextScope,
}: {
  reviewSubmitBusy: boolean;
  previousScope?: string;
  nextScope?: string;
}): boolean {
  return reviewSubmitBusy && previousScope !== nextScope;
}
