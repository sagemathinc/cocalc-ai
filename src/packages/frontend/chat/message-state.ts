/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  CodexLiveLogStatus,
  CodexPersistedLogLoadState,
} from "./use-codex-log";
import { trimFinalResponseFromActivity } from "@cocalc/chat";

const VIEWER_ONLY_STATES = new Set(["queue", "sending", "sent", "not-sent"]);

export const ACP_THINKING_PLACEHOLDER = ":robot: Thinking...";

export function acpMessageStatePresentation({
  state,
  runtimeKind,
  isViewersMessage,
  agentName,
}: {
  state: string;
  runtimeKind: "acp" | "codex";
  isViewersMessage: boolean;
  agentName?: string;
}): { label: string; canSteer: boolean } {
  const name = runtimeKind === "acp" ? agentName || "ACP agent" : "Codex";
  return {
    label:
      state === "sending"
        ? `submitting to ${name}`
        : state === "sent"
          ? `waiting for ${name}`
          : state === "running" && isViewersMessage
            ? `${name} is working`
            : state,
    canSteer: state === "queue" && runtimeKind === "codex",
  };
}

export function hasAcpGuidanceReceipt(deliveredAtMs: unknown): boolean {
  const time = Number(deliveredAtMs);
  return Number.isFinite(time) && time > 0;
}

export function getAcpMessageDeliveryLabel({
  postOnly,
  attentionResponse,
  deliveredAtMs,
}: {
  postOnly?: boolean;
  attentionResponse?: unknown;
  deliveredAtMs?: unknown;
}): string | undefined {
  // Sync answers are post-only to prevent a second turn, not because the
  // answer wasn't delivered through the pending question's response channel.
  if (hasAcpGuidanceReceipt(deliveredAtMs)) {
    return attentionResponse ? "Answer received by agent" : "Received by agent";
  }
  if (postOnly) {
    return attentionResponse
      ? "Answer saved · Receipt unconfirmed"
      : "Posted · Not sent to agent";
  }
}

export type InlineCodexActivityBlock = {
  kind: "agent" | "guidance";
  text: string;
  time?: number;
  state?: "saved" | "sending" | "sent" | "queued" | "not-sent";
};

function guidanceFence(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`{3,}/g)) {
    length = Math.max(length, match[0].length + 1);
  }
  return "`".repeat(length);
}

// Guidance is shown as a `guidance` fence, which the Markdown renderer draws
// as a labeled guidance card with its delivery state.
export function guidanceMarkdown(
  text: string,
  state?: InlineCodexActivityBlock["state"],
): string {
  const fence = guidanceFence(text);
  const label = state && state !== "sent" ? ` ${state}` : "";
  return `${fence}guidance${label}\n${text}\n${fence}`;
}

function activityTextLength(blocks: InlineCodexActivityBlock[]): number {
  let length = 0;
  for (const block of blocks) length += `${block.text ?? ""}`.length;
  return length;
}

export function resolveLiveCodexActivityBlocks({
  previewBlocks,
  cachedBlocks,
}: {
  previewBlocks?: InlineCodexActivityBlock[];
  cachedBlocks?: InlineCodexActivityBlock[];
}): InlineCodexActivityBlock[] | undefined {
  const reconciledCachedBlocks =
    cachedBlocks && previewBlocks
      ? reconcileActivityGuidance(cachedBlocks, previewBlocks)
      : cachedBlocks;
  let selected: InlineCodexActivityBlock[] | undefined;
  let selectedLength = 0;
  for (const blocks of [reconciledCachedBlocks, previewBlocks]) {
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    const length = activityTextLength(blocks);
    if (length < selectedLength) continue;
    selected = blocks;
    selectedLength = length;
  }
  return selected;
}

// The preview may contain less agent output than the cache, but its message
// projections are current. Never lose new messages by choosing the longer log.
export function reconcileActivityGuidance(
  blocks: InlineCodexActivityBlock[],
  current: InlineCodexActivityBlock[],
): InlineCodexActivityBlock[] {
  const remaining = current.filter(({ kind }) => kind === "guidance");
  const next = blocks.flatMap((block) => {
    if (block.kind !== "guidance") return [block];
    const index = remaining.findIndex(
      ({ time, text }) => time === block.time && text === block.text,
    );
    if (index < 0) return [];
    return remaining.splice(index, 1);
  });
  for (const block of remaining) {
    const index = next.findIndex(
      ({ time }) => time != null && block.time != null && time > block.time,
    );
    if (index < 0) next.push(block);
    else next.splice(index, 0, block);
  }
  return next;
}

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
  const next = trimFinalResponseFromActivity(blocks, finalResponse);
  return next.length > 0 ? next : undefined;
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

export function shouldUseSelectableMessageBody({
  useCodexSelectToolbar,
  isEditing,
  showHistory,
  isViewersMessage,
}: {
  useCodexSelectToolbar: boolean;
  isEditing: boolean;
  showHistory: boolean;
  isViewersMessage: boolean;
}): boolean {
  return (
    useCodexSelectToolbar && !isEditing && !showHistory && !isViewersMessage
  );
}

export function resolveMessageBodyMode({
  isEditing,
  useSelectableMessageBody,
}: {
  isEditing: boolean;
  useSelectableMessageBody: boolean;
}): "edit" | "select" | "static" {
  if (isEditing) return "edit";
  if (useSelectableMessageBody) return "select";
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

export type CodexOverflowMenuLocation = "header" | "footer" | "hidden";

export function resolveCodexOverflowMenuLocation({
  generating,
  isAgentMessage,
}: {
  generating: boolean;
  isAgentMessage: boolean;
}): CodexOverflowMenuLocation {
  if (!isAgentMessage) return "header";
  return generating ? "hidden" : "footer";
}

export function shouldShowAcpResubmitToAgentButton({
  hasActions,
  hasParentMessage,
  isTurnRunning,
  isViewersMessage,
  parentAcpState,
  readOnly,
  renderedValue,
  terminalThreadErrorActive,
}: {
  hasActions: boolean;
  hasParentMessage: boolean;
  isTurnRunning?: boolean;
  isViewersMessage: boolean;
  parentAcpState?: string;
  readOnly: boolean;
  renderedValue: string;
  terminalThreadErrorActive?: boolean;
}): boolean {
  if (
    !hasActions ||
    readOnly ||
    isViewersMessage ||
    !hasParentMessage ||
    isTurnRunning
  ) {
    return false;
  }
  if (parentAcpState !== "not-sent" && terminalThreadErrorActive !== true) {
    return false;
  }
  return renderedValue.trim().length > 0;
}
