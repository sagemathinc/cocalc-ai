/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { ProjectedChatMessage } from "./types";
import { markdownToSpeechText } from "./speech-text";

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
  private pendingSubmission: Promise<void> | undefined;

  constructor(
    private send: (
      text: string,
    ) => Promise<{ message_id: string; kind?: "guidance" | "work" }>,
    private append: (
      type: "session.thinking.append" | "session.commentary.append",
      content: string,
      id: string,
    ) => void,
    private report: (message: string) => void,
    private answerStatusQuestion?: (text: string) => string | undefined,
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
    const status = this.answerStatusQuestion?.(text);
    if (status) {
      this.append("session.commentary.append", status, id);
      this.report("Progress update shared without starting agent work.");
      return;
    }
    const submit = async () => {
      if (this.closed) return;
      try {
        // ChatSendPipeline coalesces simultaneous sends to one thread. Wait
        // for the previous acknowledgment so every spoken task gets its own ID.
        const accepted = await this.send(text);
        if (this.closed) return; // Accepted work remains in the durable chat.
        if (accepted.kind === "guidance") {
          this.append(
            "session.thinking.append",
            "Guidance was sent to the currently running agent turn. It has not finished yet.",
            id,
          );
          this.report("Guidance sent to the running agent.");
          return;
        }
        this.tasks.set(accepted.message_id, id);
        this.append(
          "session.thinking.append",
          "The selected CoCalc agent accepted this request. It has not finished yet.",
          id,
        );
        this.report("Agent accepted your spoken request.");
      } catch {
        if (this.closed) return;
        // Provider speech must not receive arbitrary backend errors, which can
        // contain paths, snippets, or credential metadata.
        this.append(
          "session.commentary.append",
          "Agent submission could not be confirmed. Ask the user to check chat and payment settings before resending. Do not retry it.",
          id,
        );
        this.report("Submission unconfirmed. Check chat and payment settings.");
      }
    };
    const operation = this.pendingSubmission
      ? this.pendingSubmission.then(submit)
      : submit();
    this.pendingSubmission = operation;
    await operation;
  }

  observe(messages: ProjectedChatMessage[]) {
    if (this.closed) return;
    for (const message of messages) {
      const taskId =
        message.role === "human"
          ? message.message_id
          : message.parent_message_id;
      const failedId = taskId ? this.tasks.get(taskId) : undefined;
      if (
        failedId &&
        (message.state === "error" || message.state === "interrupted")
      ) {
        this.tasks.delete(taskId!);
        this.progress.delete(taskId!);
        const interrupted = message.state === "interrupted";
        this.append(
          "session.commentary.append",
          interrupted
            ? "The submitted agent request was interrupted. Tell the user to inspect chat. Do not claim completion or retry."
            : "The submitted agent request failed. Tell the user to inspect the error in chat and check payment settings. Do not claim completion or retry.",
          failedId,
        );
        this.report(
          interrupted
            ? "Agent request was interrupted. Check chat."
            : "Agent request failed. Check chat and payment settings.",
        );
        continue;
      }
      const pendingId = this.tasks.get(message.message_id);
      if (pendingId && message.role === "human") {
        if (
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
