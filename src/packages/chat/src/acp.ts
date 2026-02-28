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
  sessionId?: string; // Codex session/thread id (UUID string)
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
  if (needsMarkdownParagraphBreak(previousText, nextText)) return "\n\n";
  if (needsTextBoundarySpace(previousText, nextText)) return " ";
  return "";
}

function needsMarkdownParagraphBreak(
  previousText: string,
  nextText: string,
): boolean {
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return false;
  const left = previousText.replace(/\s+$/, "");
  const right = nextText.replace(/^\s+/, "");
  return left.endsWith("**") && right.startsWith("**");
}

function needsTextBoundarySpace(
  previousText: string,
  nextText: string,
): boolean {
  if (/\s$/.test(previousText) || /^\s/.test(nextText)) return false;
  const left = previousText.replace(/\s+$/, "");
  const right = nextText.replace(/^\s+/, "");
  if (!left || !right) return false;
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  if (/[.!?;:]/.test(leftLast) && /[A-Za-z0-9`"'([{]/.test(rightFirst)) {
    return true;
  }
  if (/[a-z0-9]/.test(leftLast) && /[A-Z]/.test(rightFirst)) {
    return true;
  }
  if (/[)\]}`"'*]/.test(leftLast) && /[A-Za-z0-9`(]/.test(rightFirst)) {
    return true;
  }
  return false;
}

export function extractEventText(
  event?: AcpStreamEvent,
): string | undefined {
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

export function getBestResponseText(
  events: AcpStreamMessage[],
): string | undefined {
  return getLatestSummaryText(events) ?? getLatestMessageText(events);
}
