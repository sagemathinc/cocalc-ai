/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Progress, Select, Space, Typography } from "antd";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  cancelChatSpeech,
  chatSpeechErrorMessage,
  getChatSpeechCapabilities,
  newSpeechRequestId,
  synthesizeChatSpeech,
} from "./api";
import { markdownToSpeechText, splitSpeechText } from "./markdown-to-speech";
import {
  readChatSpeechPreferences,
  saveChatSpeechPreferences,
} from "./speech-preferences";
import type { ChatSpeechAccent } from "@cocalc/util/ai/speech";

type PlayerStatus =
  | "hidden"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error";

interface PlayerState {
  status: PlayerStatus;
  title: string;
  error?: string;
  currentChunk: number;
  chunkCount: number;
  currentTime: number;
  duration: number;
  speed: number;
  voices: string[];
  defaultVoice?: string;
}

interface StartOptions {
  markdown: string;
  title?: string;
  projectId?: string;
  path?: string;
  threadId?: string;
  messageId: string;
  voice?: string;
  accent?: ChatSpeechAccent;
}

const INITIAL_STATE: PlayerState = {
  status: "hidden",
  title: "",
  currentChunk: 0,
  chunkCount: 0,
  currentTime: 0,
  duration: 0,
  speed: 1,
  voices: [],
};

const ACCENT_OPTIONS: { value: ChatSpeechAccent; label: string }[] = [
  { value: "default", label: "Automatic" },
  { value: "american", label: "American English" },
  { value: "british", label: "British English" },
  { value: "australian", label: "Australian English" },
  { value: "canadian", label: "Canadian English" },
  { value: "indian", label: "Indian English" },
  { value: "irish", label: "Irish English" },
  { value: "scottish", label: "Scottish English" },
];

function voiceLabel(voice: string): string {
  return voice ? `${voice[0].toUpperCase()}${voice.slice(1)}` : voice;
}

let state = INITIAL_STATE;
let startOptions: StartOptions | undefined;
let chunks: string[] = [];
let audio: HTMLAudioElement | undefined;
let generation = 0;
let activeRequestId: string | undefined;
const urls = new Map<number, string>();
const pending = new Map<number, Promise<string>>();
const listeners = new Set<() => void>();

function emit(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function resetState(): void {
  state = { ...INITIAL_STATE };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PlayerState {
  return state;
}

function revokeUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  pending.clear();
}

function disposeAudio(): void {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio = undefined;
}

async function generateChunk(index: number, token: number): Promise<string> {
  const existing = urls.get(index);
  if (existing) return existing;
  const existingPromise = pending.get(index);
  if (existingPromise) return await existingPromise;
  if (!startOptions) throw new Error("No speech request is active.");
  const promise = (async () => {
    const capabilities = await getChatSpeechCapabilities(
      startOptions!.projectId,
    );
    if (!capabilities.output.enabled) {
      throw new Error(
        capabilities.output.reason ?? "Chat read aloud is unavailable.",
      );
    }
    const selectedVoice = capabilities.output.voices.includes(
      startOptions!.voice ?? "",
    )
      ? startOptions!.voice!
      : capabilities.output.default_voice;
    emit({
      voices: capabilities.output.voices,
      defaultVoice: capabilities.output.default_voice,
    });
    const requestId = newSpeechRequestId();
    activeRequestId = requestId;
    let result;
    try {
      result = await synthesizeChatSpeech({
        request_id: requestId,
        project_id: startOptions!.projectId,
        path: startOptions!.path,
        thread_id: startOptions!.threadId,
        message_id: startOptions!.messageId,
        text: chunks[index],
        voice: selectedVoice,
        accent: startOptions!.accent,
        speed: 1,
      });
    } finally {
      if (activeRequestId === requestId) activeRequestId = undefined;
    }
    if (token !== generation) throw new Error("Speech playback was stopped.");
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(result.audio)], { type: result.content_type }),
    );
    urls.set(index, url);
    return url;
  })().finally(() => {
    pending.delete(index);
  });
  pending.set(index, promise);
  return await promise;
}

async function playChunk(
  index: number,
  token: number,
  autoplay: boolean,
): Promise<void> {
  if (token !== generation || index >= chunks.length) return;
  emit({ status: "loading", currentChunk: index, currentTime: 0, duration: 0 });
  const url = await generateChunk(index, token);
  if (token !== generation) return;
  disposeAudio();
  const nextAudio = new Audio(url);
  audio = nextAudio;
  nextAudio.playbackRate = state.speed;
  nextAudio.ontimeupdate = () => {
    if (audio !== nextAudio) return;
    emit({
      currentTime: nextAudio.currentTime,
      duration: Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0,
    });
  };
  nextAudio.onloadedmetadata = () => {
    if (audio !== nextAudio) return;
    emit({
      duration: Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0,
      status: autoplay ? state.status : "ready",
    });
  };
  nextAudio.onended = () => {
    if (audio !== nextAudio || token !== generation) return;
    if (index + 1 < chunks.length) {
      void playChunk(index + 1, token, true).catch((err) =>
        emit({ status: "error", error: chatSpeechErrorMessage(err) }),
      );
    } else {
      emit({ status: "ready", currentTime: state.duration });
    }
  };
  emit({ status: "ready" });
  if (autoplay) {
    try {
      await nextAudio.play();
      emit({ status: "playing" });
    } catch {
      // iOS may require a second direct gesture after asynchronous generation.
      emit({ status: "ready" });
    }
  }
  if (index + 1 < chunks.length) {
    void generateChunk(index + 1, token).catch(() => undefined);
  }
}

export async function startChatSpeech(options: StartOptions): Promise<void> {
  stopChatSpeech();
  const speechText = markdownToSpeechText(options.markdown);
  chunks = splitSpeechText(speechText);
  if (chunks.length === 0) throw new Error("There is no text to read aloud.");
  startOptions = { ...options, ...readChatSpeechPreferences() };
  const token = ++generation;
  emit({
    ...INITIAL_STATE,
    error: undefined,
    status: "loading",
    title: options.title?.trim() || "Final response",
    chunkCount: chunks.length,
  });
  try {
    await playChunk(0, token, true);
  } catch (err) {
    if (token === generation) {
      emit({ status: "error", error: chatSpeechErrorMessage(err) });
    }
  }
}

export function stopChatSpeech(): void {
  generation += 1;
  const requestId = activeRequestId;
  activeRequestId = undefined;
  if (requestId) void cancelChatSpeech(requestId).catch(() => undefined);
  disposeAudio();
  revokeUrls();
  chunks = [];
  startOptions = undefined;
  resetState();
}

async function togglePlayback(): Promise<void> {
  if (!audio) return;
  if (audio.ended) {
    audio.currentTime = 0;
  }
  if (audio.paused) {
    try {
      await audio.play();
      emit({ status: "playing" });
    } catch (err) {
      emit({ status: "error", error: chatSpeechErrorMessage(err) });
    }
  } else {
    audio.pause();
    emit({ status: "paused" });
  }
}

function setSpeed(speed: number): void {
  if (![0.75, 1, 1.25, 1.5, 2].includes(speed)) return;
  if (audio) audio.playbackRate = speed;
  emit({ speed });
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${`${rounded % 60}`.padStart(2, "0")}`;
}

export function ChatSpeechPlayer() {
  const player = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftVoice, setDraftVoice] = useState<string>();
  const [draftAccent, setDraftAccent] = useState<ChatSpeechAccent>("default");
  useEffect(() => stopChatSpeech, []);
  if (player.status === "hidden") return null;
  const progress =
    player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0;
  const openSettings = () => {
    const preferences = readChatSpeechPreferences();
    setDraftVoice(
      player.voices.includes(preferences.voice ?? "")
        ? preferences.voice
        : undefined,
    );
    setDraftAccent(preferences.accent);
    setSettingsOpen(true);
  };
  return (
    <div
      aria-label="Read aloud player"
      role="region"
      style={{
        alignItems: "center",
        background: UI_COLORS.surface,
        border: `1px solid ${UI_COLORS.border}`,
        color: UI_COLORS.text,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 8,
        padding: "6px 8px",
        width: "100%",
      }}
    >
      <Tooltip title={player.status === "playing" ? "Pause" : "Play"}>
        <Button
          aria-label={
            player.status === "playing" ? "Pause read aloud" : "Play read aloud"
          }
          disabled={player.status === "loading" || player.status === "error"}
          icon={<Icon name={player.status === "playing" ? "pause" : "play"} />}
          loading={player.status === "loading"}
          onClick={() => void togglePlayback()}
          size="small"
        />
      </Tooltip>
      <div style={{ flex: "1 1 140px", minWidth: 100 }}>
        <Typography.Text
          aria-live="polite"
          ellipsis
          style={{ color: UI_COLORS.text, display: "block", fontSize: 12 }}
        >
          {player.error ?? player.title}
        </Typography.Text>
        <Progress
          percent={progress}
          showInfo={false}
          size="small"
          status={player.status === "error" ? "exception" : "normal"}
        />
      </div>
      <Typography.Text
        style={{
          color: UI_COLORS.secondary,
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        {formatTime(player.currentTime)} / {formatTime(player.duration)}
        {player.chunkCount > 1
          ? ` · ${player.currentChunk + 1}/${player.chunkCount}`
          : ""}
      </Typography.Text>
      <Select
        aria-label="Playback speed"
        onChange={setSpeed}
        options={[0.75, 1, 1.25, 1.5, 2].map((value) => ({
          value,
          label: `${value}x`,
        }))}
        size="small"
        style={{ width: 72 }}
        value={player.speed}
      />
      <Tooltip title="Stop read aloud">
        <Button
          aria-label="Stop read aloud"
          icon={<Icon name="times" />}
          onClick={stopChatSpeech}
          size="small"
        />
      </Tooltip>
      <div style={{ flexBasis: "100%" }}>
        <Button
          aria-haspopup="dialog"
          onClick={openSettings}
          size="small"
          style={{ fontSize: 10, height: "auto", padding: 0 }}
          type="link"
        >
          AI-generated voice
        </Button>
      </div>
      <Modal
        cancelText="Cancel"
        okText="Save"
        onCancel={() => setSettingsOpen(false)}
        onOk={() => {
          saveChatSpeechPreferences({
            voice: draftVoice,
            accent: draftAccent,
          });
          setSettingsOpen(false);
        }}
        open={settingsOpen}
        title="Read aloud voice"
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            These account-wide settings apply the next time you choose Read
            aloud.
          </Typography.Text>
          <label>
            <Typography.Text strong>Voice</Typography.Text>
            <Select
              aria-label="Read aloud voice"
              onChange={(voice) =>
                setDraftVoice(voice === "site-default" ? undefined : voice)
              }
              options={[
                {
                  value: "site-default",
                  label: `Site default (${voiceLabel(player.defaultVoice ?? "")})`,
                },
                ...player.voices.map((voice) => ({
                  value: voice,
                  label: voiceLabel(voice),
                })),
              ]}
              style={{ display: "block", marginTop: 6, width: "100%" }}
              value={draftVoice ?? "site-default"}
            />
          </label>
          <label>
            <Typography.Text strong>Accent</Typography.Text>
            <Select
              aria-label="Read aloud accent"
              onChange={setDraftAccent}
              options={ACCENT_OPTIONS}
              style={{ display: "block", marginTop: 6, width: "100%" }}
              value={draftAccent}
            />
          </label>
        </Space>
      </Modal>
    </div>
  );
}
