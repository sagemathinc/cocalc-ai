import type { SpeechAdapter } from "./controller";
// Explicitly local UI simulation: this does not claim microphone or provider QA.
export function previewSpeechAdapter(): SpeechAdapter {
  return {
    capabilities: async () => ({
      input: {
        enabled: true,
        max_bytes: 1000,
        max_duration_ms: 90_000,
        supported_content_types: ["audio/mp4"],
      },
      output: {
        enabled: true,
        max_characters: 4096,
        voices: ["preview"],
        default_voice: "preview",
        speeds: [1],
      },
    }),
    record: async () => ({
      finish: async () => ({ audio: new Uint8Array([1]), duration: 1000 }),
      dispose: async () => {},
    }),
    transcribe: async () =>
      "Please summarize the result and suggest the next step.",
    speak: async (_text, _message, _caps, signal) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 30_000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      }),
  };
}
