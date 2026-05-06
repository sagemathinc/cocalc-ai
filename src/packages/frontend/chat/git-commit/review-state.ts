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
