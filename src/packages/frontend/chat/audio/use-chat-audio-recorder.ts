/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSpeechCapabilities } from "@cocalc/conat/hub/api/system";
import {
  cancelChatSpeech,
  chatSpeechErrorMessage,
  getChatSpeechCapabilities,
  newSpeechRequestId,
  transcribeChatAudio,
} from "./api";

export type RecorderStatus =
  | "loading"
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "error";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

let activeRecorder: { owner: symbol; cancel: () => void } | undefined;

function baseContentType(value: string): string {
  return value.split(";", 1)[0].toLowerCase();
}

export function selectRecorderMimeType(
  supportedByServer: readonly string[],
  isTypeSupported: (value: string) => boolean,
): string | undefined {
  return MIME_CANDIDATES.find(
    (candidate) =>
      supportedByServer.includes(baseContentType(candidate)) &&
      isTypeSupported(candidate),
  );
}

function stopTracks(stream?: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useChatAudioRecorder<T>({
  projectId,
  path,
  threadId,
  onTranscript,
}: {
  projectId?: string;
  path?: string;
  threadId?: string;
  onTranscript: (text: string, context: T) => void;
}) {
  const [status, setStatus] = useState<RecorderStatus>("loading");
  const [capabilities, setCapabilities] = useState<ChatSpeechCapabilities>();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string>();
  const ownerRef = useRef(Symbol("chat-audio-recorder"));
  const cancelCurrentRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const encodedBytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<number | undefined>(undefined);
  const timeoutRef = useRef<number | undefined>(undefined);
  const requestIdRef = useRef<string | undefined>(undefined);
  const canceledRef = useRef(false);
  const contextRef = useRef<T | undefined>(undefined);

  const clearTimers = useCallback(() => {
    if (intervalRef.current != null) window.clearInterval(intervalRef.current);
    if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
    intervalRef.current = undefined;
    timeoutRef.current = undefined;
  }, []);

  const releaseMedia = useCallback(() => {
    clearTimers();
    stopTracks(streamRef.current);
    streamRef.current = undefined;
    recorderRef.current = undefined;
  }, [clearTimers]);

  const releaseActiveOperation = useCallback(() => {
    if (activeRecorder?.owner === ownerRef.current) activeRecorder = undefined;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void getChatSpeechCapabilities(projectId)
      .then((value) => {
        if (!mountedRef.current) return;
        setCapabilities(value);
        setStatus("idle");
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setError(chatSpeechErrorMessage(err));
        setStatus("error");
      });
    return () => {
      mountedRef.current = false;
      canceledRef.current = true;
      const requestId = requestIdRef.current;
      if (requestId) void cancelChatSpeech(requestId).catch(() => undefined);
      if (recorderRef.current?.state !== "inactive") {
        recorderRef.current?.stop();
      }
      releaseMedia();
      releaseActiveOperation();
    };
  }, [projectId, releaseActiveOperation, releaseMedia]);

  const transcribe = useCallback(
    async (blob: Blob, durationMs: number, context: T) => {
      if (canceledRef.current || !mountedRef.current) return;
      if (blob.size === 0) {
        setError("No audio was recorded.");
        setStatus("error");
        releaseActiveOperation();
        return;
      }
      const maximum = capabilities?.input.max_bytes ?? 10 * 1024 * 1024;
      if (blob.size > maximum) {
        setError("The audio recording is too large.");
        setStatus("error");
        releaseActiveOperation();
        return;
      }
      const requestId = newSpeechRequestId();
      requestIdRef.current = requestId;
      setStatus("transcribing");
      try {
        const result = await transcribeChatAudio({
          request_id: requestId,
          project_id: projectId,
          path,
          thread_id: threadId,
          content_type: baseContentType(blob.type),
          filename: `dictation.${baseContentType(blob.type).split("/")[1] || "webm"}`,
          audio: new Uint8Array(await blob.arrayBuffer()),
          duration_ms: Math.max(1, Math.round(durationMs)),
          language_hints:
            typeof navigator === "undefined" || !navigator.language
              ? undefined
              : [navigator.language.split("-")[0]],
        });
        if (!canceledRef.current && mountedRef.current) {
          onTranscript(result.text, context);
          setStatus("idle");
          setElapsedMs(0);
        }
      } catch (err) {
        if (!canceledRef.current && mountedRef.current) {
          setError(chatSpeechErrorMessage(err));
          setStatus("error");
        }
      } finally {
        if (requestIdRef.current === requestId)
          requestIdRef.current = undefined;
        releaseActiveOperation();
      }
    },
    [
      capabilities?.input.max_bytes,
      onTranscript,
      path,
      projectId,
      releaseActiveOperation,
      threadId,
    ],
  );

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    clearTimers();
    recorder.stop();
    stopTracks(streamRef.current);
  }, [clearTimers]);

  const start = useCallback(
    async (context: T) => {
      if (status === "recording") return;
      setError(undefined);
      canceledRef.current = false;
      contextRef.current = context;
      if (!capabilities?.input.enabled) {
        setError(
          capabilities?.input.reason ?? "Chat dictation is unavailable.",
        );
        setStatus("error");
        return;
      }
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        setError("This browser does not support microphone recording.");
        setStatus("error");
        return;
      }
      const mimeType = selectRecorderMimeType(
        capabilities.input.supported_content_types,
        (value) => MediaRecorder.isTypeSupported(value),
      );
      if (!mimeType) {
        setError(
          "No supported audio recording format is available in this browser.",
        );
        setStatus("error");
        return;
      }
      if (activeRecorder?.owner !== ownerRef.current) {
        activeRecorder?.cancel();
      }
      activeRecorder = {
        owner: ownerRef.current,
        cancel: () => cancelCurrentRef.current(),
      };
      setStatus("requesting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (!mountedRef.current || canceledRef.current) {
          stopTracks(stream);
          return;
        }
        const recorder = new MediaRecorder(stream, { mimeType });
        streamRef.current = stream;
        recorderRef.current = recorder;
        chunksRef.current = [];
        encodedBytesRef.current = 0;
        startedAtRef.current = Date.now();
        recorder.ondataavailable = ({ data }) => {
          if (data.size <= 0) return;
          encodedBytesRef.current += data.size;
          if (encodedBytesRef.current > capabilities.input.max_bytes) {
            canceledRef.current = true;
            recorder.stop();
            releaseMedia();
            releaseActiveOperation();
            chunksRef.current = [];
            if (mountedRef.current) {
              setError("The audio recording is too large.");
              setStatus("error");
            }
            return;
          }
          chunksRef.current.push(data);
        };
        recorder.onerror = () => {
          canceledRef.current = true;
          const requestId = requestIdRef.current;
          if (requestId)
            void cancelChatSpeech(requestId).catch(() => undefined);
          chunksRef.current = [];
          encodedBytesRef.current = 0;
          if (recorder.state !== "inactive") {
            try {
              recorder.stop();
            } catch {
              // Some browsers stop the recorder before dispatching onerror.
            }
          }
          releaseMedia();
          releaseActiveOperation();
          if (!mountedRef.current) return;
          setError("Audio recording was interrupted.");
          setStatus("error");
        };
        recorder.onstop = () => {
          const duration = Date.now() - startedAtRef.current;
          const blob = new Blob(chunksRef.current, { type: mimeType });
          const contextAtStart = contextRef.current;
          releaseMedia();
          if (!canceledRef.current && contextAtStart != null) {
            void transcribe(blob, duration, contextAtStart);
          }
        };
        for (const track of stream.getTracks()) {
          track.addEventListener("ended", finishRecording, { once: true });
        }
        recorder.start(250);
        setStatus("recording");
        setElapsedMs(0);
        intervalRef.current = window.setInterval(
          () => setElapsedMs(Date.now() - startedAtRef.current),
          250,
        );
        timeoutRef.current = window.setTimeout(
          finishRecording,
          capabilities.input.max_duration_ms,
        );
      } catch (err) {
        releaseMedia();
        releaseActiveOperation();
        const denied =
          (err as DOMException)?.name === "NotAllowedError" ||
          (err as DOMException)?.name === "SecurityError";
        setError(
          denied
            ? "Microphone access was denied."
            : chatSpeechErrorMessage(err),
        );
        setStatus("error");
      }
    },
    [
      capabilities,
      finishRecording,
      releaseActiveOperation,
      releaseMedia,
      status,
      transcribe,
    ],
  );

  const cancel = useCallback(() => {
    canceledRef.current = true;
    const requestId = requestIdRef.current;
    if (requestId) void cancelChatSpeech(requestId).catch(() => undefined);
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    releaseMedia();
    releaseActiveOperation();
    chunksRef.current = [];
    encodedBytesRef.current = 0;
    requestIdRef.current = undefined;
    setElapsedMs(0);
    setStatus("idle");
  }, [releaseActiveOperation, releaseMedia]);
  cancelCurrentRef.current = cancel;

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && status === "recording") {
        finishRecording();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [finishRecording, status]);

  return {
    status,
    capabilities,
    elapsedMs,
    error,
    start,
    stop: finishRecording,
    cancel,
  };
}
