/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { ProjectedChatMessage } from "@cocalc/chat-client";
import { markdownToSpeechText } from "../speech/text";

export interface LiveEvent {
  type: string;
  event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  offset_ms?: number;
  delegation?: { id: string; target: string };
  error?: { message?: string };
  usage?: { seconds?: number };
}

// Owns only this call's delegation state. It never retries an uncertain send,
// interrupts a task, or treats model output as human permission.
export class LiveDelegation {
  private seen = new Set<string>();
  private delegated = new Set<string>();
  private fragments: { text: string; end: number }[] = [];
  private tasks = new Map<string, string>();
  private closed = false;
  private progress = new Map<string, string>();

  constructor(
    private send: (text: string) => Promise<{ message_id: string }>,
    private append: (
      type: "session.thinking.append" | "session.commentary.append",
      content: string,
      id: string,
    ) => void,
    private report: (message: string) => void,
  ) {}

  async event(event: LiveEvent) {
    if (this.closed) return;
    if (event.event_id) {
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
    }
    if (event.type === "session.input_transcript.delta" && event.delta) {
      if (
        this.fragments.reduce((n, x) => n + x.text.length, 0) +
          event.delta.length >
        12000
      ) {
        this.report("Spoken request is too long. End the call and use text.");
        this.close();
        return;
      }
      this.fragments.push({ text: event.delta, end: event.end_ms ?? Infinity });
    }
    if (
      event.type !== "session.delegation.created" ||
      event.delegation?.target !== "client"
    )
      return;
    const id = event.delegation.id;
    if (this.delegated.has(id)) return;
    this.delegated.add(id);
    // Snapshot only text up to this delegation. Subsequent corrections belong
    // to a later request; they must not mutate an in-flight submission.
    const offset = event.offset_ms ?? Infinity;
    const ready = this.fragments.filter((x) => x.end <= offset);
    this.fragments = this.fragments.filter((x) => x.end > offset);
    const text = ready
      .map((x) => x.text)
      .join("")
      .trim();
    if (!text) {
      this.append(
        "session.commentary.append",
        "No complete spoken request was available. Ask the user to repeat the task.",
        id,
      );
      return;
    }
    try {
      const accepted = await this.send(text);
      if (this.closed) return; // Accepted work remains in the durable chat.
      this.tasks.set(accepted.message_id, id);
      this.append(
        "session.thinking.append",
        "The selected CoCalc agent accepted this request. It has not finished yet.",
        id,
      );
      this.report("Agent accepted your spoken request.");
    } catch (error) {
      if (this.closed) return;
      const detail = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 800);
      this.append(
        "session.commentary.append",
        "Agent submission reported this error: " +
          detail +
          ". Could not confirm acceptance. Explain the error and ask the user to check chat/settings before resending. Do not retry it.",
        id,
      );
      this.report("Submission unconfirmed: " + detail);
    }
  }

  observe(messages: ProjectedChatMessage[]) {
    if (this.closed) return;
    for (const message of messages) {
      const pendingId = this.tasks.get(message.message_id);
      if (pendingId && message.role === "human") {
        if (message.state === "error") {
          this.tasks.delete(message.message_id);
          this.append(
            "session.commentary.append",
            "The submitted agent request failed. Tell the user to inspect the error in chat and check payment settings. Do not claim completion or retry.",
            pendingId,
          );
          this.report("Agent request failed. Check chat and payment settings.");
        } else if (
          ["queued", "running"].includes(message.state ?? "") &&
          this.progress.get(message.message_id) !== message.state
        ) {
          this.progress.set(message.message_id, message.state!);
          this.append(
            "session.thinking.append",
            `The selected agent request is ${message.state}. No final result is available yet.`,
            pendingId,
          );
        }
      }

      if (
        message.role !== "agent" ||
        message.generating ||
        !message.parent_message_id ||
        !message.content
      )
        continue;
      const id = this.tasks.get(message.parent_message_id);
      if (!id) continue;
      this.tasks.delete(message.parent_message_id);
      // Appends have a 500-token limit. UTF-8 bytes upper-bound ordinary BPE
      // tokens; keep a deliberately short spoken excerpt, never raw tool logs.
      let text = markdownToSpeechText(message.content);
      while (new TextEncoder().encode(text).length > 1200)
        text = text.slice(0, -100);
      this.append(
        "session.commentary.append",
        "Agent response (excerpt; full result is in chat): " + text,
        id,
      );
      this.report("Agent result is ready in chat.");
    }
  }

  close() {
    this.closed = true;
    this.fragments = [];
    this.tasks.clear();
    this.progress.clear();
  }
}
