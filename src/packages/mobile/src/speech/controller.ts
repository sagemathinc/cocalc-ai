/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { ChatSpeechCapabilities } from "@cocalc/conat/hub/api/system";
export type SpeechState = {
  phase: "idle" | "preparing" | "recording" | "transcribing" | "speaking";
  error?: string;
  messageId?: string;
  startedAt?: number;
};
export interface Recording {
  finish(): Promise<{ audio: Uint8Array; duration: number }>;
  dispose(): Promise<void>;
}
export interface SpeechAdapter {
  capabilities(): Promise<ChatSpeechCapabilities>;
  record(signal: AbortSignal, limitMs: number): Promise<Recording>;
  transcribe(
    audio: Uint8Array,
    duration: number,
    signal: AbortSignal,
  ): Promise<string>;
  speak(
    text: string,
    messageId: string,
    capabilities: ChatSpeechCapabilities,
    signal: AbortSignal,
  ): Promise<void>;
}
// A single operation owns microphone/playback. Cancellation fences all late results.
export class SpeechController {
  private state: SpeechState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private operation?: AbortController;
  private recording?: Recording;
  private capabilities?: ChatSpeechCapabilities;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private adapter: SpeechAdapter,
    private transcript: (text: string) => void,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(state: SpeechState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  cancel = () => {
    this.operation?.abort();
    this.operation = undefined;
    clearTimeout(this.timer);
    const recording = this.recording;
    this.recording = undefined;
    if (recording) void recording.dispose().catch(() => {});
    this.set({ phase: "idle" });
  };
  private fail(operation: AbortController, error: unknown) {
    if (this.operation !== operation) return;
    this.cancel();
    this.set({
      phase: "idle",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  start = async () => {
    if (this.state.phase !== "idle") return;
    const operation = new AbortController();
    this.operation = operation;
    this.set({ phase: "preparing" });
    try {
      const caps = await this.adapter.capabilities();
      if (operation.signal.aborted) return;
      if (!caps.input.enabled)
        throw new Error(
          caps.input.reason || "Dictation is unavailable for this account.",
        );
      if (!caps.input.supported_content_types.includes("audio/mp4"))
        throw new Error("This site does not support iPhone dictation audio.");
      const limit = Math.min(caps.input.max_duration_ms, 90_000);
      if (!(limit > 0))
        throw new Error("The site returned an invalid recording limit.");
      this.capabilities = caps;
      const recording = await this.adapter.record(operation.signal, limit);
      if (operation.signal.aborted) {
        await recording.dispose();
        return;
      }
      this.recording = recording;
      this.set({ phase: "recording", startedAt: Date.now() });
      this.timer = setTimeout(() => void this.finish(), limit);
    } catch (error) {
      this.fail(operation, error);
    }
  };
  finish = async () => {
    const operation = this.operation,
      recording = this.recording;
    if (!operation || !recording || this.state.phase !== "recording") return;
    clearTimeout(this.timer);
    this.set({ phase: "transcribing" });
    try {
      const { audio, duration } = await recording.finish();
      if (operation.signal.aborted) return;
      if (!audio.length)
        throw new Error("No audio was recorded. Please try again.");
      if (
        audio.length >
        Math.min(this.capabilities?.input.max_bytes ?? 0, 10 * 1024 * 1024)
      )
        throw new Error("The recording is too large. Try a shorter dictation.");
      const text = await this.adapter.transcribe(
        audio,
        duration,
        operation.signal,
      );
      if (operation.signal.aborted) return;
      if (!text.trim())
        throw new Error("No speech was recognized. Please try again.");
      this.transcript(text.trim());
      this.set({ phase: "idle" });
    } catch (error) {
      this.fail(operation, error);
    } finally {
      await recording.dispose().catch(() => {});
      if (this.operation === operation) {
        this.recording = undefined;
        this.operation = undefined;
      }
    }
  };
  read = async (text: string, messageId: string) => {
    if (this.state.phase !== "idle") return;
    const operation = new AbortController();
    this.operation = operation;
    this.set({ phase: "speaking", messageId });
    try {
      const caps = await this.adapter.capabilities();
      if (operation.signal.aborted) return;
      if (!caps.output.enabled)
        throw new Error(
          caps.output.reason || "Read-aloud is unavailable for this account.",
        );
      await this.adapter.speak(text, messageId, caps, operation.signal);
      if (!operation.signal.aborted) {
        this.operation = undefined;
        this.set({ phase: "idle" });
      }
    } catch (error) {
      this.fail(operation, error);
    }
  };
}
