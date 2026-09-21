/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { randomUUID } from "expo-crypto";
import { getActiveSiteSession } from "../cocalc/session-registry";
import type { SpeechAdapter, Recording } from "./controller";
import { markdownToSpeechText, splitSpeechText } from "./text";

// React Native's AbortSignal supports aborted, but not throwIfAborted/reason.
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Speech operation cancelled.");
  error.name = "AbortError";
  throw error;
}

export function nativeSpeechAdapter(
  profile: string,
  project_id: string,
  path: string,
  thread_id: string,
): SpeechAdapter {
  const context = { project_id, path, thread_id };
  const system = async () =>
    (await getActiveSiteSession(profile)).hubApi.system;
  async function request<T>(
    signal: AbortSignal,
    invoke: (
      api: Awaited<ReturnType<typeof system>>,
      request_id: string,
    ) => Promise<T>,
  ) {
    const api = await system();
    throwIfAborted(signal);
    const request_id = randomUUID();
    const cancel = () => {
      void api.cancelChatSpeech({ request_id }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await invoke(api, request_id);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  return {
    capabilities: async () =>
      (await system()).getChatSpeechCapabilities({ project_id }),
    record: async (signal, limitMs) => {
      const { AudioModule, RecordingPresets, setAudioModeAsync } =
        await import("expo-audio");
      const { File } = await import("expo-file-system");
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      throwIfAborted(signal);
      if (!permission.granted)
        throw new Error(
          "Microphone access is disabled. Enable it for CoCalc in iPhone Settings.",
        );
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      throwIfAborted(signal);
      const recorder = new AudioModule.AudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        numberOfChannels: 1,
        bitRate: 64000,
      });
      let disposed = false;
      let stop: Promise<void> | undefined;
      const stopOnce = () =>
        (stop ??= recorder.isRecording ? recorder.stop() : Promise.resolve());
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
          await stopOnce().catch(() => {});
          const uri = recorder.uri;
          if (uri) {
            const file = new File(uri);
            if (file.exists) file.delete();
          }
        } finally {
          recorder.release();
        }
      };
      try {
        await recorder.prepareToRecordAsync();
        throwIfAborted(signal);
        recorder.record({ forDuration: limitMs / 1000 });
        const started = Date.now();
        return {
          finish: async () => {
            const duration = Math.min(
              limitMs,
              Math.max(1, Date.now() - started),
            );
            await stopOnce();
            throwIfAborted(signal);
            if (!recorder.uri)
              throw new Error(
                "The recording was interrupted. Please dictate again.",
              );
            const file = new File(recorder.uri);
            if (file.size > 10 * 1024 * 1024)
              throw new Error("The recording is too large.");
            return { audio: await file.bytes(), duration };
          },
          dispose,
        } satisfies Recording;
      } catch (error) {
        await dispose();
        throw error;
      }
    },
    transcribe: async (audio, duration, signal) =>
      (
        await request(signal, (api, request_id) =>
          api.transcribeChatAudio({
            ...context,
            request_id,
            audio,
            duration_ms: duration,
            content_type: "audio/mp4",
            filename: "dictation.m4a",
            timeout: 130_000,
          }),
        )
      ).text,
    speak: async (markdown, message_id, caps, signal) => {
      const { createAudioPlayer, setAudioModeAsync } =
        await import("expo-audio");
      const { File, Paths } = await import("expo-file-system");
      const limit = Math.min(caps.output.max_characters, 3800);
      if (!(limit > 0))
        throw new Error("The site returned an invalid speech limit.");
      const chunks = splitSpeechText(markdownToSpeechText(markdown), limit);
      if (!chunks.length) throw new Error("This message has no readable text.");
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
      });
      for (const text of chunks) {
        throwIfAborted(signal);
        const result = await request(signal, (api, request_id) =>
          api.synthesizeChatSpeech({
            ...context,
            request_id,
            message_id,
            text,
            voice: caps.output.default_voice,
            speed: 1,
            timeout: 130_000,
          }),
        );
        throwIfAborted(signal);
        const file = new File(Paths.cache, `speech-${randomUUID()}.mp3`);
        let player: ReturnType<typeof createAudioPlayer> | undefined;
        try {
          file.write(result.audio);
          const activePlayer = createAudioPlayer(file.uri);
          player = activePlayer;
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              subscription.remove();
              signal.removeEventListener("abort", abort);
              clearTimeout(timer);
            };
            const abort = () => {
              try {
                activePlayer.pause();
              } finally {
                cleanup();
                reject(new Error("Read-aloud stopped."));
              }
            };
            const subscription = activePlayer.addListener(
              "playbackStatusUpdate",
              (status) => {
                if (status.error) {
                  cleanup();
                  reject(new Error(status.error));
                } else if (status.didJustFinish) {
                  cleanup();
                  resolve();
                }
              },
            );
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error("Audio playback timed out."));
            }, 10 * 60_000);
            signal.addEventListener("abort", abort, { once: true });
            try {
              if (signal.aborted) abort();
              else activePlayer.play();
            } catch (error) {
              cleanup();
              reject(error);
            }
          });
        } finally {
          player?.remove();
          if (file.exists) file.delete();
        }
      }
    },
  };
}
