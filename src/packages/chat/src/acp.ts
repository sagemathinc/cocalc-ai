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
  if (message.type !== "event") {
    return [...events, message];
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
    return [...events.slice(0, -1), merged];
  }
  return [...events, message];
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
  if (leftLast === "]" && rightFirst === "(") {
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
  const messages: Array<{ text: string; hasDelta: boolean }> = [];
  for (const evt of events ?? []) {
    if (evt?.type !== "event" || evt.event?.type !== "message") continue;
    const text = evt.event.text;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const last = messages[messages.length - 1];
    if (last?.text === text) {
      last.hasDelta = last.hasDelta || evt.event.delta === true;
      continue;
    }
    const progressive = mergeProgressiveMessageText(last?.text, text, {
      previousHasDelta: last?.hasDelta === true,
      nextIsDelta: evt.event.delta === true,
    });
    if (typeof progressive === "string") {
      messages[messages.length - 1] = {
        text: progressive,
        hasDelta: (last?.hasDelta ?? false) || evt.event.delta === true,
      };
      continue;
    }
    messages.push({ text, hasDelta: evt.event.delta === true });
  }
  return messages.map(({ text }) => text);
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
    return blocks.join("\n\n");
  }
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary;
  }
  return getLatestEventLineText(events);
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
  return getLatestSummaryText(events) ?? getLatestMessageText(events);
}
