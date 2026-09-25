/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type { LiveVoiceResult } from "@cocalc/conat/hub/api/live-voice";
import type { LiveEvent } from "./delegation";
import type { LiveConnection } from "./native";

export const previewLiveCapabilities: LiveVoiceResult = {
  enabled: true,
  max_seconds: 120,
  usd_per_minute: 0.05,
};
export type PreviewScenario = "task" | "disconnect";

// No native audio, credentials, network, or real chat clients.
export async function connectPreviewLive(
  signal: AbortSignal,
  receive: (event: LiveEvent) => void,
): Promise<LiveConnection> {
  let closed = false,
    muted = false,
    sequence = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const close = async () => {
    closed = true;
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    await close();
    throw new Error("Live call cancelled.");
  }
  deadline = setTimeout(() => {
    if (closed) return;
    receive({ type: "session.closed" });
    void close();
  }, 120_000);
  return {
    close,
    mute: (value) => {
      muted = value;
    },
    send: (event) => {
      if (closed) return;
      if (event.type === "session.commentary.append")
        receive({
          type: "session.output_transcript.delta",
          delta: String(event.content),
        });
    },
    simulate: (scenario) => {
      if (closed) return;
      if (scenario === "disconnect") {
        receive({
          type: "error",
          error: {
            message:
              "Simulated connection lost. Accepted preview work continues in chat.",
          },
        });
        void close();
        return;
      }
      if (muted) return;
      const id = String(++sequence);
      receive({
        type: "session.input_transcript.delta",
        event_id: "input-" + id,
        delta: "Please check this local preview task.",
        end_ms: sequence * 1000,
      });
      const event: LiveEvent = {
        type: "session.delegation.created",
        event_id: "delegation-" + id,
        offset_ms: sequence * 1000,
        delegation: { id, target: "client" },
      };
      receive(event);
      receive(event); // Intentional duplicate: one visible task must result.
    },
  };
}
