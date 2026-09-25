/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Space, message as antdMessage } from "antd";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import type { ChatInputControl } from "../input";
import { useChatAudioRecorder } from "./use-chat-audio-recorder";
import { lite } from "@cocalc/frontend/lite";
import type { MarkdownPosition } from "@cocalc/frontend/editors/markdown-input/types";

const DISCLOSURE_KEY = "cocalc-chat-speech-input-disclosed";

interface DictationContext {
  session: number;
  selection: MarkdownPosition | null;
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, "0")}`;
}

function recordingTimeLabel(elapsedMs: number, maximumMs?: number): string {
  const remainingMs = Math.max(0, (maximumMs ?? 0) - elapsedMs);
  if (maximumMs != null && remainingMs <= 10_000) {
    return `${Math.ceil(remainingMs / 1_000)}s left`;
  }
  return elapsedLabel(elapsedMs);
}

function DictationLiveStatus({ label }: { label: string }) {
  return (
    <span
      aria-live="polite"
      style={{
        clip: "rect(0 0 0 0)",
        height: 1,
        overflow: "hidden",
        position: "absolute",
        width: 1,
      }}
    >
      {label}
    </span>
  );
}

interface DictateButtonProps {
  projectId?: string;
  path?: string;
  threadId?: string;
  session: number;
  inputControlRef: MutableRefObject<ChatInputControl | null>;
  onOpenVoiceOptions?: () => void;
  voiceOptionsOpen?: boolean;
  onStartReady?: (start: (() => void) | undefined) => void;
  onBusyChange?: (busy: boolean) => void;
  onAvailabilityChange?: (available: boolean) => void;
}

export function DictateButton(props: DictateButtonProps) {
  return lite ? null : <EnabledDictateButton {...props} />;
}

function EnabledDictateButton({
  projectId,
  path,
  threadId,
  session,
  inputControlRef,
  onOpenVoiceOptions,
  voiceOptionsOpen,
  onStartReady,
  onBusyChange,
  onAvailabilityChange,
}: DictateButtonProps) {
  const currentSessionRef = useRef(session);
  currentSessionRef.current = session;

  const onTranscript = useCallback(
    (text: string, context: DictationContext) => {
      if (context.session === currentSessionRef.current) {
        if (inputControlRef.current?.insertText(text, context.selection))
          return;
      }
      Modal.confirm({
        title: "Dictation is ready",
        content:
          "The active chat changed while the recording was transcribed. Insert it into the current draft or copy it.",
        okText: "Insert into current draft",
        cancelText: "Copy",
        onOk: () => {
          inputControlRef.current?.insertText(text);
        },
        onCancel: () => {
          void copyTextToClipboard({ text }).then((ok) => {
            if (ok) antdMessage.success("Transcript copied.");
          });
        },
      });
    },
    [inputControlRef],
  );

  const recorder = useChatAudioRecorder<DictationContext>({
    projectId,
    path,
    threadId,
    onTranscript,
  });

  useEffect(() => {
    if (recorder.status === "error" && recorder.error) {
      antdMessage.error(recorder.error);
    }
  }, [recorder.error, recorder.status]);

  const begin = useCallback(() => {
    void recorder.start({
      session: currentSessionRef.current,
      selection: inputControlRef.current?.captureSelection() ?? null,
    });
  }, [inputControlRef, recorder]);

  const requestStart = useCallback(() => {
    let disclosed = false;
    try {
      disclosed = localStorage.getItem(DISCLOSURE_KEY) === "yes";
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    if (disclosed) {
      begin();
      return;
    }
    Modal.confirm({
      title: "Dictate a message",
      content:
        "Your recording is sent to the configured AI provider for transcription. CoCalc does not retain the recording.",
      okText: "Start recording",
      cancelText: "Cancel",
      onOk: () => {
        try {
          localStorage.setItem(DISCLOSURE_KEY, "yes");
        } catch {
          // The disclosure still applies to this recording.
        }
        begin();
      },
    });
  }, [begin]);

  useEffect(() => {
    onStartReady?.(requestStart);
    return () => onStartReady?.(undefined);
  }, [onStartReady, requestStart]);

  useEffect(() => {
    onBusyChange?.(
      recorder.status === "requesting" ||
        recorder.status === "recording" ||
        recorder.status === "transcribing",
    );
  }, [onBusyChange, recorder.status]);

  useEffect(() => {
    onAvailabilityChange?.(!!recorder.capabilities?.input.enabled);
  }, [onAvailabilityChange, recorder.capabilities?.input.enabled]);

  if (recorder.status === "recording") {
    const timeLabel = recordingTimeLabel(
      recorder.elapsedMs,
      recorder.capabilities?.input.max_duration_ms,
    );
    return (
      <>
        <Space.Compact>
          <Button
            aria-label={`Stop dictation recording, ${timeLabel}`}
            aria-pressed
            danger
            icon={<Icon name="stop" />}
            onClick={recorder.stop}
            size="small"
          >
            {timeLabel}
          </Button>
          <Tooltip placement="bottomRight" title="Cancel dictation">
            <Button
              aria-label="Cancel dictation"
              icon={<Icon name="times" />}
              onClick={recorder.cancel}
              size="small"
            />
          </Tooltip>
        </Space.Compact>
        <DictationLiveStatus label="Recording dictation" />
      </>
    );
  }

  if (recorder.status === "transcribing") {
    return (
      <>
        <Space.Compact>
          <Button
            aria-label="Transcribing dictation"
            aria-busy="true"
            loading
            size="small"
          >
            Transcribing
          </Button>
          <Tooltip placement="bottomRight" title="Cancel transcription">
            <Button
              aria-label="Cancel transcription"
              icon={<Icon name="times" />}
              onClick={recorder.cancel}
              size="small"
            />
          </Tooltip>
        </Space.Compact>
        <DictationLiveStatus label="Transcribing dictation" />
      </>
    );
  }

  const unavailable =
    recorder.status !== "loading" && !recorder.capabilities?.input.enabled;
  const title = onOpenVoiceOptions
    ? "Voice options"
    : unavailable
      ? (recorder.capabilities?.input.reason ??
        recorder.error ??
        "Dictation unavailable")
      : "Dictate message";
  return (
    <>
      <Tooltip placement="bottomRight" title={title}>
        <Button
          aria-label={onOpenVoiceOptions ? "Voice options" : "Dictate message"}
          aria-expanded={onOpenVoiceOptions ? voiceOptionsOpen : undefined}
          aria-controls={
            onOpenVoiceOptions ? "cocalc-live-voice-panel" : undefined
          }
          aria-busy={
            recorder.status === "loading" || recorder.status === "requesting"
          }
          disabled={onOpenVoiceOptions ? false : unavailable}
          icon={<Icon name="audio" />}
          loading={
            !onOpenVoiceOptions &&
            (recorder.status === "loading" || recorder.status === "requesting")
          }
          onClick={onOpenVoiceOptions ?? requestStart}
          size="small"
        />
      </Tooltip>
      <DictationLiveStatus
        label={
          recorder.status === "requesting" ? "Requesting microphone access" : ""
        }
      />
    </>
  );
}
