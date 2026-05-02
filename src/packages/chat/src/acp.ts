import type {
  AcpStreamEvent,
  AcpStreamMessage,
} from "@cocalc/conat/ai/acp/types";
import type {
  CodexSessionMode,
  CodexReasoningLevel,
} from "@cocalc/util/ai/codex";

// Configuration stored on the chat thread root for Codex/ACP turns.
// This is persisted as `acp_config` on the root message.
export interface CodexThreadConfig {
  sessionId?: string; // Codex session/thread id
  model?: string;
  reasoning?: CodexReasoningLevel["id"];
  workingDirectory?: string;
  envHome?: string;
  envPath?: string;
  sessionMode?: CodexSessionMode;
  allowWrite?: boolean;
  codexPathOverride?: string;
}

export function appendStreamMessage(
  events: AcpStreamMessage[],
  message: AcpStreamMessage,
): AcpStreamMessage[] {
  const next = events.slice();
  appendStreamMessageMutable(next, message);
  return next;
}

export function appendStreamMessages(
  events: AcpStreamMessage[],
  messages: AcpStreamMessage[],
): AcpStreamMessage[] {
  if (!messages.length) {
    return events;
  }
  const next = events.slice();
  for (const message of messages) {
    appendStreamMessageMutable(next, message);
  }
  return next;
}

function appendStreamMessageMutable(
  events: AcpStreamMessage[],
  message: AcpStreamMessage,
): void {
  if (message.type !== "event") {
    events.push(message);
    return;
  }
  const last = events[events.length - 1];
  const nextEvent = message.event;
  if (
    last?.type === "event" &&
    eventHasText(last.event) &&
    eventHasText(nextEvent) &&
    last.event.type === nextEvent.type
  ) {
    const merged: AcpStreamMessage = {
      ...last,
      event: {
        ...last.event,
        text: joinStreamText(last.event.text, nextEvent.text),
      },
      seq: message.seq ?? last.seq,
    };
    events[events.length - 1] = merged;
    return;
  }
  events.push(message);
}

function joinStreamText(previousText: string, nextText: string): string {
  if (!previousText || !nextText) return previousText + nextText;
  const separator = streamJoinSeparator(previousText, nextText);
  if (!separator) {
    return previousText + nextText;
  }
  const left = previousText.replace(/\s+$/, "");
  const right = nextText.replace(/^\s+/, "");
  return `${left}${separator}${right}`;
}

function streamJoinSeparator(
  previousText: string,
  nextText: string,
): "" | " " | "\n\n" {
  if (hasOpenMarkdownCodeFence(previousText)) return "";
  if (needsTextBoundaryParagraph(previousText, nextText)) return "\n\n";
  if (needsTextBoundarySpace(previousText, nextText)) return " ";
  return "";
}

function hasOpenMarkdownCodeFence(text: string): boolean {
  let backticks = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "`") continue;
    if (i > 0 && text[i - 1] === "\\") continue;
    backticks += 1;
  }
  return backticks % 2 === 1;
}

function needsTextBoundaryParagraph(
  previousText: string,
  nextText: string,
): boolean {
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return false;
  const left = previousText.replace(/\s+$/, "");
  const right = nextText.replace(/^\s+/, "");
  if (!left || !right) return false;
  if (!/[.!?]$/.test(left)) return false;
  if (isLikelyMarkdownSectionStart(right)) return true;
  if (left.length < 60 || right.length < 30) return false;
  if (!/^(?:[#>*-]|\d+\.|[A-Z`])/.test(right)) return false;
  return true;
}

function isLikelyMarkdownSectionStart(text: string): boolean {
  if (/^(?:[#>*-]|\d+\.)/.test(text)) return true;
  if (/^\*{1,2}\s*[A-Z`#\d]/.test(text)) return true;
  if (/^_{1,2}\s*[A-Z`#\d]/.test(text)) return true;
  if (/^`\s*[A-Z#\d]/.test(text)) return true;
  return false;
}

function needsTextBoundarySpace(
  previousText: string,
  nextText: string,
): boolean {
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return false;
  const left = previousText.replace(/\s+$/, "");
  const right = nextText.replace(/^\s+/, "");
  if (!left || !right) return false;
  if (left.endsWith("**") && right.startsWith("**")) {
    return true;
  }
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  if (
    endsWithMarkdownEmphasisOpener(left) &&
    /[A-Za-z0-9`"'([{]/.test(rightFirst)
  ) {
    return false;
  }
  if (shouldPreservePathLikeDotJoin(left, right)) {
    return false;
  }
  if (leftLast === "]" && rightFirst === "(") {
    return false;
  }
  if (/\d\.$/.test(left) && /^\d/.test(right)) {
    return false;
  }
  if (/[.!?;:]/.test(leftLast) && /[A-Za-z0-9`"'([{]/.test(rightFirst)) {
    return true;
  }
  if (/[)\]}`"'*]/.test(leftLast) && /[A-Za-z0-9`(]/.test(rightFirst)) {
    return true;
  }
  return false;
}

function endsWithMarkdownEmphasisOpener(text: string): boolean {
  const match = text.match(/(\*{1,2}|_{1,2})$/);
  if (!match) return false;
  const marker = match[1];
  const before = text.slice(0, -marker.length).slice(-1);
  return before === "" || /[\s([{'"`]/.test(before);
}

function shouldPreservePathLikeDotJoin(left: string, right: string): boolean {
  if (!left.endsWith(".") || !/^[A-Za-z0-9_~/-]/.test(right)) {
    return false;
  }
  const beforeDot = left.slice(-2, -1);
  if (beforeDot === "" || /[\s([{/\\'"`]/.test(beforeDot)) {
    return true;
  }
  const leftToken = left.match(/([^\s]+)\.$/)?.[1] ?? "";
  if (!leftToken || leftToken.includes(".")) {
    return false;
  }
  if (/[\/[`(_-]/.test(leftToken)) {
    return true;
  }
  if (/[A-Z]/.test(leftToken)) {
    return true;
  }
  return false;
}

export function extractEventText(event?: AcpStreamEvent): string | undefined {
  if (!eventHasText(event)) return;
  return event.text;
}

export function eventHasText(
  event?: AcpStreamEvent,
): event is Extract<AcpStreamEvent, { text: string }> {
  return event?.type === "thinking" || event?.type === "message";
}

function mergeResponseText(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  const prev = typeof previous === "string" ? previous : "";
  const cur = typeof next === "string" ? next : "";
  if (!prev) return cur || undefined;
  if (!cur) return prev;
  if (cur.startsWith(prev)) return cur;
  if (prev.startsWith(cur)) return prev;
  if (prev.endsWith(cur)) return prev;
  return joinStreamText(prev, cur);
}

export function getLatestMessageText(
  events: AcpStreamMessage[],
): string | undefined {
  let latest: string | undefined;
  for (const evt of events ?? []) {
    if (evt?.type === "event" && evt.event?.type === "message") {
      latest = mergeResponseText(latest, evt.event.text);
    }
  }
  return latest;
}

export function getLatestSummaryText(
  events: AcpStreamMessage[],
): string | undefined {
  let latest: string | undefined;
  for (const evt of events ?? []) {
    if (evt?.type === "summary") {
      latest = mergeResponseText(latest, evt.finalResponse);
    }
  }
  return latest;
}

function generatedImageMarkdownBlocks(events: AcpStreamMessage[]): string[] {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const evt of events ?? []) {
    if (evt?.type !== "event" || evt.event?.type !== "image") continue;
    const url = `${evt.event.blob?.url ?? ""}`.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    blocks.push(`![Generated image](${url})`);
  }
  return blocks;
}

export function appendGeneratedImageMarkdown(
  text: string | undefined,
  events: AcpStreamMessage[],
): string | undefined {
  const content = `${text ?? ""}`.trim();
  const blocks = generatedImageMarkdownBlocks(events).filter(
    (block) => !content.includes(block),
  );
  if (!blocks.length) return content || undefined;
  if (!content) return blocks.join("\n\n");
  return `${content}\n\n${blocks.join("\n\n")}`;
}

export function getLatestEventLineText(
  events: AcpStreamMessage[],
): string | undefined {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt?.type !== "event" || !eventHasText(evt.event)) continue;
    const text = evt.event.text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text;
    }
  }
  return undefined;
}

export function getAgentMessageTexts(events: AcpStreamMessage[]): string[] {
  return getAgentMessageBlocks(events).map(({ text }) => text);
}

export function getAgentMessageBlocks(
  events: AcpStreamMessage[],
): Array<{ text: string; time?: number }> {
  const blocks: Array<{ text: string; time?: number; hasDelta: boolean }> = [];
  for (const evt of events ?? []) {
    if (evt?.type !== "event" || evt.event?.type !== "message") continue;
    const text = evt.event.text;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const last = blocks[blocks.length - 1];
    if (last?.text === text) {
      last.hasDelta = last.hasDelta || evt.event.delta === true;
      last.time = evt.time ?? last.time;
      continue;
    }
    const progressive = mergeProgressiveMessageText(last?.text, text, {
      previousHasDelta: last?.hasDelta === true,
      nextIsDelta: evt.event.delta === true,
    });
    if (typeof progressive === "string") {
      blocks[blocks.length - 1] = {
        text: progressive,
        hasDelta: (last?.hasDelta ?? false) || evt.event.delta === true,
        time: evt.time ?? last?.time,
      };
      continue;
    }
    blocks.push({
      text,
      hasDelta: evt.event.delta === true,
      time: evt.time,
    });
  }
  return blocks.map(({ text, time }) => ({ text, time }));
}

export function getLiveResponseBlocks(
  events: AcpStreamMessage[],
  guidance?: Array<{
    date: number;
    text: string;
    state?: "sending" | "sent" | "queued" | "not-sent";
  }>,
): Array<{
  kind: "agent" | "guidance";
  text: string;
  time?: number;
  state?: "sending" | "sent" | "queued" | "not-sent";
}> {
  const timeline = [
    ...(events ?? [])
      .filter(
        (
          evt,
        ): evt is AcpStreamMessage & {
          type: "event";
          event: Extract<AcpStreamEvent, { type: "message"; text: string }>;
        } =>
          evt?.type === "event" &&
          evt.event?.type === "message" &&
          typeof evt.event.text === "string" &&
          evt.event.text.trim().length > 0,
      )
      .map((evt) => ({
        kind: "agent-event" as const,
        text: evt.event.text,
        time: evt.time,
        delta: evt.event.delta === true,
        seq: evt.seq ?? 0,
      })),
    ...(guidance ?? [])
      .filter(
        (item) => typeof item?.text === "string" && item.text.trim().length > 0,
      )
      .map((item, index) => ({
        kind: "guidance" as const,
        text: item.text,
        time: item.date,
        state: item.state,
        seq: Number.MAX_SAFE_INTEGER - (guidance?.length ?? 0) + index,
      })),
  ].sort((a, b) => {
    const aTime = typeof a.time === "number" ? a.time : undefined;
    const bTime = typeof b.time === "number" ? b.time : undefined;
    if (aTime != null && bTime != null && aTime !== bTime) {
      return aTime - bTime;
    }
    if (aTime == null && bTime != null) return 1;
    if (aTime != null && bTime == null) return -1;
    return a.seq - b.seq;
  });

  const blocks: Array<{
    kind: "agent" | "guidance";
    text: string;
    time?: number;
    state?: "sending" | "sent" | "queued" | "not-sent";
  }> = [];
  let latestFullText: string | undefined;
  let latestFullHasDelta = false;
  let activeSegmentBaseText: string | undefined;
  let pendingGuidanceSplitBaseText: string | undefined;

  for (const item of timeline) {
    if (item.kind === "guidance") {
      blocks.push({
        kind: "guidance",
        text: item.text,
        time: item.time,
        state: item.state,
      });
      pendingGuidanceSplitBaseText = latestFullText;
      activeSegmentBaseText = undefined;
      continue;
    }

    const progressive = mergeProgressiveMessageText(latestFullText, item.text, {
      previousHasDelta: latestFullHasDelta,
      nextIsDelta: item.delta,
    });
    if (typeof progressive === "string") {
      latestFullText = progressive;
      latestFullHasDelta = latestFullHasDelta || item.delta;
      const baseText = pendingGuidanceSplitBaseText ?? activeSegmentBaseText;
      const segmentText = getInterleavedAgentSegmentText(baseText, progressive);
      if (segmentText.trim().length === 0) {
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (last?.kind === "agent" && pendingGuidanceSplitBaseText == null) {
        last.text = segmentText;
        last.time = item.time ?? last.time;
      } else {
        blocks.push({
          kind: "agent",
          text: segmentText,
          time: item.time,
        });
      }
      activeSegmentBaseText = baseText ?? "";
      pendingGuidanceSplitBaseText = undefined;
      continue;
    }

    latestFullText = item.text;
    latestFullHasDelta = item.delta;
    blocks.push({
      kind: "agent",
      text: item.text,
      time: item.time,
    });
    activeSegmentBaseText = "";
    pendingGuidanceSplitBaseText = undefined;
  }

  return blocks;
}

export function getMountedIntermediateResponseBlocks(
  events: AcpStreamMessage[],
  guidance?: Array<{
    date: number;
    text: string;
    state?: "sending" | "sent" | "queued" | "not-sent";
  }>,
): Array<{
  kind: "agent" | "guidance";
  text: string;
  time?: number;
  state?: "sending" | "sent" | "queued" | "not-sent";
}> {
  const blocks = getLiveResponseBlocks(events, guidance);
  const normalizedSummary = normalizeProgressiveCompareText(
    getLatestSummaryText(events) ?? "",
  );
  if (!normalizedSummary) {
    return blocks;
  }
  let lastAgentIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (
      block.kind === "agent" &&
      shouldDropMountedAgentBlock(block.text, normalizedSummary)
    ) {
      lastAgentIndex = i;
      break;
    }
  }
  if (lastAgentIndex === -1) {
    return blocks;
  }
  return blocks.filter((_, index) => index !== lastAgentIndex);
}

function shouldDropMountedAgentBlock(
  blockText: string,
  normalizedSummary: string,
): boolean {
  const normalizedBlock = normalizeProgressiveCompareText(blockText);
  if (!normalizedBlock || !normalizedSummary) return false;
  return (
    normalizedBlock.includes(normalizedSummary) ||
    normalizedSummary.includes(normalizedBlock)
  );
}

function getInterleavedAgentSegmentText(
  baseText: string | undefined,
  fullText: string,
): string {
  if (!baseText) return fullText;
  if (fullText === baseText) return "";
  if (!fullText.startsWith(baseText)) return fullText;
  const suffix = fullText.slice(baseText.length);
  if (!suffix) return "";
  if (/^\s+/.test(suffix) && /\S$/.test(baseText)) {
    return suffix.replace(/^\s+/, "");
  }
  return suffix;
}

export function mergeProgressiveMessageText(
  previous: string | undefined,
  next: string | undefined,
  opts?: {
    previousHasDelta?: boolean;
    nextIsDelta?: boolean;
  },
): string | undefined {
  const prev = typeof previous === "string" ? previous : "";
  const cur = typeof next === "string" ? next : "";
  if (!prev || !cur) return undefined;
  if (opts?.nextIsDelta) {
    return mergeResponseText(prev, cur);
  }
  if (cur.startsWith(prev)) return cur;
  if (prev.startsWith(cur)) return prev;
  if (prev.endsWith(cur)) return prev;
  const normalizedPrev = normalizeProgressiveCompareText(prev);
  const normalizedCur = normalizeProgressiveCompareText(cur);
  if (!normalizedPrev || !normalizedCur) return undefined;
  if (normalizedCur.startsWith(normalizedPrev)) return cur;
  if (normalizedPrev.startsWith(normalizedCur)) return prev;
  if (normalizedPrev === normalizedCur) {
    return cur.length >= prev.length ? cur : prev;
  }
  if (opts?.previousHasDelta) {
    return mergeResponseText(prev, cur);
  }
  return undefined;
}

function normalizeProgressiveCompareText(text: string): string {
  return text
    .replace(/`\s+/g, "`")
    .replace(/\s+`/g, "`")
    .replace(/\s+/g, " ")
    .trim();
}

// During a running turn the main chat row should be rendered from the live ACP
// log, not from patchflow-backed chat-row edits. Show all agent message blocks
// seen so far. If there are no agent blocks yet, fall back to the latest
// streamed summary so the row is never blank.
export function getLiveResponseMarkdown(
  events: AcpStreamMessage[],
): string | undefined {
  const blocks = getAgentMessageTexts(events);
  const summary = getLatestSummaryText(events);
  if (blocks.length > 0) {
    return appendGeneratedImageMarkdown(blocks.join("\n\n"), events);
  }
  if (typeof summary === "string" && summary.trim().length > 0) {
    return appendGeneratedImageMarkdown(summary, events);
  }
  return appendGeneratedImageMarkdown(getLatestEventLineText(events), events);
}

// After a Codex turn finishes, keep the mounted intermediate activity visible
// without re-showing the final agent block, since the durable summary is
// rendered separately in the chat row.
export function getMountedIntermediateResponseMarkdown(
  events: AcpStreamMessage[],
): string | undefined {
  const blocks = getAgentMessageTexts(events);
  const normalizedSummary = normalizeProgressiveCompareText(
    getLatestSummaryText(events) ?? "",
  );
  const trimmedBlocks =
    normalizedSummary && blocks.length > 0
      ? trimTrailingMountedResponseBlock(blocks, normalizedSummary)
      : blocks;
  const content = trimmedBlocks.join("\n\n").trim();
  return content.length > 0 ? content : undefined;
}

function trimTrailingMountedResponseBlock(
  blocks: string[],
  normalizedSummary: string,
): string[] {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (!shouldDropMountedAgentBlock(blocks[i], normalizedSummary)) {
      return blocks;
    }
    return blocks.filter((_, index) => index !== i);
  }
  return blocks;
}

export function getInterruptedResponseMarkdown(
  events: AcpStreamMessage[],
  interruptedText?: string,
): string | undefined {
  const base =
    getLiveResponseMarkdown(events) ?? getBestResponseText(events) ?? "";
  const content = `${base}`.trim();
  const suffix = `${interruptedText ?? "Conversation interrupted."}`.trim();
  if (!content) return suffix || undefined;
  if (!suffix || content.includes(suffix)) return content;
  return `${content}\n\n${suffix}`;
}

export function getBestResponseText(
  events: AcpStreamMessage[],
): string | undefined {
  return appendGeneratedImageMarkdown(
    getLatestSummaryText(events) ?? getLatestMessageText(events),
    events,
  );
}
