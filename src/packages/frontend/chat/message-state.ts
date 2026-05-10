/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  CodexLiveLogStatus,
  CodexPersistedLogLoadState,
} from "./use-codex-log";

const VIEWER_ONLY_STATES = new Set(["queue", "sending", "sent", "not-sent"]);

export const ACP_THINKING_PLACEHOLDER = ":robot: Thinking...";

export type InlineCodexActivityBlock = {
  kind: "agent" | "guidance";
  text: string;
  time?: number;
  state?: "sending" | "sent" | "queued" | "not-sent";
};

export function computeAcpStateToRender({
  acpState,
  latestThreadInterrupted,
  isViewersMessage,
  generating,
  showViewerRunning,
}: {
  acpState?: string;
  latestThreadInterrupted: boolean;
  isViewersMessage: boolean;
  generating?: boolean;
  showViewerRunning?: boolean;
}): string {
  const state =
    acpState === "running" && latestThreadInterrupted ? "" : acpState;
  if (!state) return "";
  if (VIEWER_ONLY_STATES.has(state)) {
    return isViewersMessage ? state : "";
  }
  if (state === "running" && isViewersMessage) {
    return showViewerRunning ? state : "";
  }
  if (isViewersMessage) {
    return "";
  }
  if (state === "running" && !isViewersMessage && generating !== true) {
    return "";
  }
  return state;
}

export function trimCompletedCachedCodexActivityBlocks(
  blocks: InlineCodexActivityBlock[] | undefined,
  finalResponse?: string,
): InlineCodexActivityBlock[] | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const normalizedFinal = `${finalResponse ?? ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalizedFinal) return blocks;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.kind !== "agent") continue;
    const normalizedBlock = `${block.text ?? ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (
      !normalizedBlock ||
      (!normalizedBlock.includes(normalizedFinal) &&
        !normalizedFinal.includes(normalizedBlock))
    ) {
      return blocks;
    }
    const next = blocks.filter((_, index) => index !== i);
    return next.length > 0 ? next : undefined;
  }
  return blocks;
}

export function resolveEditedMessageForSave(
  mentionSubstituted: string | undefined,
  submittedValue: string | undefined,
  editedValue: string,
): string {
  const fallback = submittedValue ?? editedValue;
  return typeof mentionSubstituted === "string" && mentionSubstituted !== ""
    ? mentionSubstituted
    : fallback;
}

export function resolveRenderedMessageValue({
  rowValue,
  logValue,
  generating,
  interrupted,
}: {
  rowValue: string;
  logValue?: string;
  generating: boolean;
  interrupted?: boolean;
}): string {
  const trimmedRow = rowValue.trim();
  if (
    interrupted &&
    trimmedRow.length > 0 &&
    trimmedRow !== ACP_THINKING_PLACEHOLDER
  ) {
    return rowValue;
  }
  if (
    typeof logValue === "string" &&
    logValue.trim().length > 0 &&
    (interrupted ||
      generating ||
      trimmedRow.length === 0 ||
      trimmedRow === ACP_THINKING_PLACEHOLDER)
  ) {
    return logValue;
  }
  return rowValue;
}

export function resolveMountedCodexRenderedValue({
  renderedValue,
  mountedGeneratingPrefixValue,
  showCodexActivity,
  generating,
  interrupted,
}: {
  renderedValue: string;
  mountedGeneratingPrefixValue?: string;
  showCodexActivity: boolean;
  generating: boolean;
  interrupted?: boolean;
}): string {
  if (
    showCodexActivity &&
    !generating &&
    !interrupted &&
    typeof mountedGeneratingPrefixValue === "string" &&
    mountedGeneratingPrefixValue.trim().length > 0
  ) {
    const rendered = renderedValue.trim();
    if (!rendered) return mountedGeneratingPrefixValue;
    return `${mountedGeneratingPrefixValue.trimEnd()}\n\n${renderedValue.trimStart()}`;
  }
  return renderedValue;
}

export function resolveInlineCodexActivityMode({
  showCodexActivity,
  generating,
  expandedCompletedActivity,
}: {
  showCodexActivity: boolean;
  generating: boolean;
  expandedCompletedActivity: boolean;
}): "hidden" | "live" | "completed" {
  if (!showCodexActivity) return "hidden";
  if (generating) return "live";
  if (expandedCompletedActivity) return "completed";
  return "hidden";
}

export function shouldLoadCodexPreviewBody({
  showCodexActivity,
  projectId,
  generating,
  interrupted,
  allowAsyncCompletedCodexActivityLoad,
  rowMessageValue,
}: {
  showCodexActivity: boolean;
  projectId?: string;
  generating: boolean;
  interrupted: boolean;
  allowAsyncCompletedCodexActivityLoad: boolean;
  rowMessageValue: string;
}): boolean {
  if (!showCodexActivity || !projectId) return false;
  if (generating) return true;
  if (interrupted) return true;
  if (allowAsyncCompletedCodexActivityLoad) return true;
  return rowMessageValue.trim().length === 0;
}

export function shouldShowCodexShowActivityButton({
  showCodexActivity,
  expandedCodexActivity,
  hasVisibleCompletedActivity,
  canToggle,
  effectiveGenerating,
  isLastMessageInThread,
}: {
  showCodexActivity: boolean;
  expandedCodexActivity: boolean;
  hasVisibleCompletedActivity: boolean;
  canToggle: boolean;
  effectiveGenerating: boolean;
  isLastMessageInThread: boolean;
}): boolean {
  if (!showCodexActivity || !canToggle) return false;
  if (effectiveGenerating && isLastMessageInThread) return false;
  if (expandedCodexActivity && hasVisibleCompletedActivity) return false;
  return true;
}

export function resolveCodexShowActivityButtonState({
  allowAsyncCompletedCodexActivityLoad,
  hasVisibleCompletedActivity,
  hasLoadedActivityEvents,
  hasLogRef,
  loadState,
}: {
  allowAsyncCompletedCodexActivityLoad: boolean;
  hasVisibleCompletedActivity: boolean;
  hasLoadedActivityEvents: boolean;
  hasLogRef: boolean;
  loadState: CodexPersistedLogLoadState;
}): {
  label: string;
  loading: boolean;
  disabled: boolean;
} {
  if (
    allowAsyncCompletedCodexActivityLoad &&
    !hasVisibleCompletedActivity &&
    loadState === "loading"
  ) {
    return {
      label: "Loading activity...",
      loading: true,
      disabled: true,
    };
  }
  if (
    allowAsyncCompletedCodexActivityLoad &&
    !hasVisibleCompletedActivity &&
    hasLoadedActivityEvents &&
    loadState === "loaded"
  ) {
    return {
      label: "No separate activity",
      loading: false,
      disabled: true,
    };
  }
  if (
    allowAsyncCompletedCodexActivityLoad &&
    !hasVisibleCompletedActivity &&
    (!hasLogRef || loadState === "loaded")
  ) {
    return {
      label: "Activity not available",
      loading: false,
      disabled: true,
    };
  }
  return {
    label: "Show activity",
    loading: false,
    disabled: false,
  };
}

export function canUseCompletedCachedCodexActivity({
  liveStatus,
}: {
  liveStatus: CodexLiveLogStatus;
}): boolean {
  return liveStatus !== "reconnecting" && liveStatus !== "error";
}

export function shouldSuppressAcpPlaceholderBody({
  value,
  showCodexActivity,
}: {
  value: string;
  showCodexActivity: boolean;
}): boolean {
  return showCodexActivity && value.trim() === ACP_THINKING_PLACEHOLDER;
}

export function resolveEffectiveGenerating({
  isCodexThread,
  generating,
  acpInterrupted,
}: {
  isCodexThread: boolean;
  generating?: boolean;
  acpInterrupted: boolean;
}): boolean {
  if (!isCodexThread) return generating === true;
  if (acpInterrupted) return false;
  return generating === true;
}

export function shouldUseCodexSelectToolbar({
  isCodexThread,
}: {
  isCodexThread: boolean;
}): boolean {
  return isCodexThread;
}

export function shouldAutoSelectMessageBody({
  useCodexSelectToolbar,
  isLastMessageInThread,
  isEditing,
  showHistory,
  isViewersMessage,
  effectiveGenerating,
}: {
  useCodexSelectToolbar: boolean;
  isLastMessageInThread: boolean;
  isEditing: boolean;
  showHistory: boolean;
  isViewersMessage: boolean;
  effectiveGenerating: boolean;
}): boolean {
  return (
    useCodexSelectToolbar &&
    isLastMessageInThread &&
    !isEditing &&
    !showHistory &&
    !isViewersMessage &&
    !effectiveGenerating
  );
}

export function resolveMessageBodyMode({
  isEditing,
  selectMode,
  autoSelectMode,
  useCodexSelectToolbar,
}: {
  isEditing: boolean;
  selectMode: boolean;
  autoSelectMode?: boolean;
  useCodexSelectToolbar: boolean;
}): "edit" | "select" | "static" {
  if (isEditing) return "edit";
  if ((selectMode || autoSelectMode) && useCodexSelectToolbar) return "select";
  return "static";
}

export function shouldShowQueuedMessageEditedVersionSent({
  acpStateToRender,
  historySize,
}: {
  acpStateToRender?: string;
  historySize: number;
}): boolean {
  return acpStateToRender === "queue" && historySize > 1;
}

export function getQueuedMessageEditHelpText({
  acpStateToRender,
  isEditing,
}: {
  acpStateToRender?: string;
  isEditing: boolean;
}): string | undefined {
  if (acpStateToRender !== "queue" || !isEditing) {
    return undefined;
  }
  return "If you edit and save this message before the next turn, then it will be used.";
}
