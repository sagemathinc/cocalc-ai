/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: small pure drawer utilities for review indicators, commit message formatting, file opening, and keyboard/find behavior.

import { backtickSequence } from "@cocalc/frontend/markdown/util";
import type { GitShowSummary } from "./types";

export function getCommitReviewIndicatorState(
  reviewedByCommit: Record<string, boolean>,
  hash: string,
): { reviewed: boolean; known: boolean } {
  const known = Object.prototype.hasOwnProperty.call(reviewedByCommit, hash);
  return {
    reviewed: known ? Boolean(reviewedByCommit[hash]) : false,
    known,
  };
}

export function resolveOpenPath(
  repoRoot: string | undefined,
  filePath: string,
): string {
  if (!filePath) return filePath;
  if (filePath.startsWith("/")) return filePath;
  if (!repoRoot) return filePath;
  const prefix = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${prefix}/${filePath}`.replace(/\/+/g, "/");
}

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(
    target.closest(
      [
        '[contenteditable="true"]',
        '[data-slate-editor="true"]',
        ".slate-editor",
        ".CodeMirror",
        ".CodeMirror-code",
        ".cm-editor",
        ".cm-content",
        '[role="textbox"]',
      ].join(", "),
    ),
  );
}

export function shouldCaptureGitDrawerFindShortcut({
  key,
  altKey,
  ctrlKey,
  metaKey,
  target,
  activeElement,
}: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "target"> & {
  activeElement?: EventTarget | null;
}): boolean {
  if (!(metaKey || ctrlKey) || altKey) return false;
  if (`${key ?? ""}`.toLowerCase() !== "f") return false;
  if (
    isEditableEventTarget(target ?? null) ||
    isEditableEventTarget(activeElement ?? null)
  ) {
    return false;
  }
  return true;
}

export function isNotGitRepoError(message: string): boolean {
  const text = `${message ?? ""}`.toLowerCase();
  return (
    text.includes("not a git repository") ||
    text.includes("stopping at filesystem boundary")
  );
}

export function parseDateSafe(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.valueOf()) ? d : undefined;
}

export function splitCommitMessage(message?: string): {
  subject?: string;
  body?: string;
} {
  const raw = `${message ?? ""}`.replace(/\r\n/g, "\n");
  if (!raw.trim()) return {};
  const lines = raw.split("\n");
  const subject = `${lines[0] ?? ""}`.trim();
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  return {
    subject: subject || undefined,
    body: body.trim() ? body : undefined,
  };
}

export function isMergeCommitSummary(summary?: GitShowSummary): boolean {
  return (
    summary?.extraHeaderLines?.some((line) =>
      /^Merge:\s+/i.test(`${line ?? ""}`),
    ) ?? false
  );
}

export function formatMergeCommitBodyMarkdown(
  body?: string,
): string | undefined {
  const text = `${body ?? ""}`.trim();
  if (!text) return undefined;
  const fence = backtickSequence(text);
  return `${fence}\n${text}\n${fence}`;
}

export function shouldClearGitHeadCommitBusyOnScopeChange({
  headCommitBusy,
  previousScope,
  nextScope,
}: {
  headCommitBusy: boolean;
  previousScope?: string;
  nextScope?: string;
}): boolean {
  return headCommitBusy && previousScope !== nextScope;
}

export function shouldClearGitRepoBootstrapBusyOnScopeChange({
  repoBootstrapBusy,
  previousScope,
  nextScope,
}: {
  repoBootstrapBusy: boolean;
  previousScope?: string;
  nextScope?: string;
}): boolean {
  return repoBootstrapBusy && previousScope !== nextScope;
}

export function shouldApplyGitRepoBootstrapScopedResult({
  actionToken,
  currentActionToken,
  startedScope,
  currentActionScope,
  activeScope,
}: {
  actionToken: number;
  currentActionToken: number;
  startedScope?: string;
  currentActionScope?: string;
  activeScope?: string;
}): boolean {
  return (
    currentActionToken === actionToken &&
    currentActionScope === startedScope &&
    activeScope === startedScope
  );
}

export function shouldFinalizeGitRepoBootstrapAction({
  actionToken,
  currentActionToken,
  startedScope,
  currentActionScope,
}: {
  actionToken: number;
  currentActionToken: number;
  startedScope?: string;
  currentActionScope?: string;
}): boolean {
  return (
    currentActionToken === actionToken && currentActionScope === startedScope
  );
}

export function shouldApplyGitFileOpenScopedResult({
  actionToken,
  currentActionToken,
  startedScope,
  currentActionScope,
  activeScope,
}: {
  actionToken: number;
  currentActionToken: number;
  startedScope?: string;
  currentActionScope?: string;
  activeScope?: string;
}): boolean {
  return (
    currentActionToken === actionToken &&
    currentActionScope === startedScope &&
    activeScope === startedScope
  );
}

export function shouldFinalizeGitFileOpenAction({
  actionToken,
  currentActionToken,
  startedScope,
  currentActionScope,
}: {
  actionToken: number;
  currentActionToken: number;
  startedScope?: string;
  currentActionScope?: string;
}): boolean {
  return (
    currentActionToken === actionToken && currentActionScope === startedScope
  );
}

export function shouldDisableGitReviewSubmission({
  actionableInlineCommentCount,
  reviewSubmitBusy,
  reviewSaving,
  canRequestAgentTurn,
  accountId,
  currentReviewCommit,
  isHeadSelected,
}: {
  actionableInlineCommentCount: number;
  reviewSubmitBusy: boolean;
  reviewSaving: boolean;
  canRequestAgentTurn: boolean;
  accountId?: string;
  currentReviewCommit?: string;
  isHeadSelected: boolean;
}): boolean {
  return (
    actionableInlineCommentCount === 0 ||
    reviewSubmitBusy ||
    reviewSaving ||
    !canRequestAgentTurn ||
    !accountId ||
    !currentReviewCommit ||
    isHeadSelected
  );
}

export function shouldClearGitHeadStatusActionOnScopeChange({
  headStatusAction,
  previousScope,
  nextScope,
}: {
  headStatusAction?: string;
  previousScope?: string;
  nextScope?: string;
}): boolean {
  return Boolean(headStatusAction) && previousScope !== nextScope;
}
