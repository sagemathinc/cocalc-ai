/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { ChatSnapshot, ProjectedChatMessage } from "./types";
import { getAgentMessageTexts } from "@cocalc/chat";
import { markdownToSpeechText } from "./speech-text";

const MAX_COMMENTARY = 3;
const MAX_COMMENTARY_CHARS = 220;
const MAX_PROGRESS_CHARS = 950;

export interface LiveProgressSnapshot {
  turnId?: string;
  state: string;
  text: string;
  signature: string;
  milestone?: string;
  canGuide: boolean;
}

function concise(text: string, limit: number): string {
  const clean = markdownToSpeechText(text).replace(/\s+/g, " ").trim();
  return clean.length > limit
    ? `${clean.slice(0, limit - 1).trimEnd()}…`
    : clean;
}

function currentAgent(
  messages: readonly ProjectedChatMessage[],
  activeMessageId?: string,
): ProjectedChatMessage | undefined {
  const agents = messages.filter((message) => message.role === "agent");
  return (
    agents.find((message) => message.message_id === activeMessageId) ??
    [...agents].reverse().find((message) => message.generating) ??
    [...agents].reverse()[0]
  );
}

function reportedCommentary(message?: ProjectedChatMessage) {
  const events = (message?.activity?.events ?? []).filter(
    (item) => item.type === "event" && item.event.type === "message",
  );
  const text = getAgentMessageTexts(events).join("\n\n");
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => concise(paragraph, MAX_COMMENTARY_CHARS))
    .filter(Boolean)
    .slice(-MAX_COMMENTARY);
}

/** Only compact, user-visible agent messages enter the voice context. */
export function buildLiveProgress(
  snapshot: ChatSnapshot,
  threadId: string,
): LiveProgressSnapshot {
  const thread = snapshot.threads.find((item) => item.thread_id === threadId);
  const messages = snapshot.messages.filter(
    (item) => item.thread_id === threadId,
  );
  const agent = currentAgent(messages, thread?.active_message_id);
  const latest = messages.at(-1);
  const runtimeState =
    thread?.state ?? agent?.state ?? latest?.state ?? "unknown";
  const canGuide = runtimeState === "running";
  const commentary =
    agent?.activity?.source === "live-preview" ? reportedCommentary(agent) : [];
  const state =
    snapshot.connection !== "connected" ? "disconnected" : runtimeState;
  const details = [...commentary.map((text) => `Reported: ${text}`)].filter(
    Boolean,
  );
  if (!canGuide && agent?.content && !agent.generating && !commentary.length)
    details.push(
      `Latest response: ${concise(agent.content, MAX_COMMENTARY_CHARS)}`,
    );
  const preface =
    state === "disconnected"
      ? "The chat progress feed is disconnected; this is the last known status."
      : `Selected agent turn: ${state}.`;
  if (!commentary.length && canGuide)
    details.push("No recent agent message is available yet.");
  const text = [preface, ...details].join(" ").slice(0, MAX_PROGRESS_CHARS);
  const milestone = commentary.at(-1);
  return {
    turnId: thread?.active_message_id ?? agent?.message_id,
    state,
    text,
    signature: [thread?.active_message_id, state, ...details].join("|"),
    milestone,
    canGuide,
  };
}

export function isProgressQuestion(text: string): boolean {
  const question = text
    .trim()
    .toLowerCase()
    .replace(/[?.!]+$/, "");
  return /^(what(?:'s| is| has| have) (?:happening|happened|going on|the (?:status|progress)|you (?:done|found|working on))|how(?:'s| is) (?:it|the (?:work|task|progress)) (?:going|doing)|which tests? (?:are |is )?(?:still )?running|are you (?:waiting(?: for me)?|blocked|still working)|any (?:updates|progress|blockers)|give me (?:an? )?(?:update|status)|what happened recently|what have you found)$/.test(
    question,
  );
}

/** Call-local, bounded progress context. It never submits Codex work. */
export class LiveProgressContext {
  private latest?: LiveProgressSnapshot;
  private lastSent = "";
  private lastAnnouncement = "";
  private lastUpdateAt = 0;
  private lastAnnouncementAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private append: (
      type: "session.thinking.append" | "session.commentary.append",
      content: string,
      id: string,
    ) => void,
    private proactive = false,
  ) {}

  setProactive(proactive: boolean) {
    this.proactive = proactive;
  }

  observe(snapshot: ChatSnapshot, threadId: string) {
    if (this.closed) return;
    const previous = this.latest;
    const next = buildLiveProgress(snapshot, threadId);
    this.latest = next;
    if (next.signature === this.lastSent) return;
    const urgent =
      previous?.state !== next.state &&
      [
        "awaiting input",
        "error",
        "interrupted",
        "complete",
        "disconnected",
      ].includes(next.state);
    if (urgent || Date.now() - this.lastUpdateAt >= 8_000) {
      this.publish(urgent);
    } else if (!this.timer) {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.publish(false);
        },
        8_000 - (Date.now() - this.lastUpdateAt),
      );
    }
  }

  private publish(urgent: boolean) {
    const next = this.latest;
    if (this.closed || !next || next.signature === this.lastSent) return;
    this.lastSent = next.signature;
    this.lastUpdateAt = Date.now();
    this.append(
      "session.thinking.append",
      `Current CoCalc progress: ${next.text} Answer status questions from this report only; say when details are unavailable.`,
      next.turnId ?? "status",
    );
    if (
      (urgent || this.proactive) &&
      next.signature !== this.lastAnnouncement &&
      (urgent || Date.now() - this.lastAnnouncementAt >= 30_000)
    ) {
      this.lastAnnouncement = next.signature;
      this.lastAnnouncementAt = Date.now();
      this.append(
        "session.commentary.append",
        urgent ? next.text : `Progress update: ${next.milestone ?? next.text}`,
        next.turnId ?? "status",
      );
    }
  }

  answer(text: string): string | undefined {
    if (!isProgressQuestion(text)) return;
    return (
      this.latest?.text ??
      "No current progress is available. Check the chat and try again."
    );
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
