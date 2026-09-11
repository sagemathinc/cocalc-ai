/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import {
  isChatSpeechAccent,
  type ChatSpeechAccent,
} from "@cocalc/util/ai/speech";

export const CHAT_SPEECH_VOICE_SETTING = "chat_speech_voice";
export const CHAT_SPEECH_ACCENT_SETTING = "chat_speech_accent";
export const CHAT_SPEECH_SPEED_SETTING = "chat_speech_speed";

export const CHAT_SPEECH_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
export type ChatSpeechSpeed = (typeof CHAT_SPEECH_SPEEDS)[number];

export interface ChatSpeechPreferences {
  voice?: string;
  accent: ChatSpeechAccent;
  speed: ChatSpeechSpeed;
}

export function isChatSpeechSpeed(value: unknown): value is ChatSpeechSpeed {
  return CHAT_SPEECH_SPEEDS.some((speed) => speed === value);
}

export function readChatSpeechPreferences(): ChatSpeechPreferences {
  const otherSettings = redux.getStore("account")?.get("other_settings") as any;
  const voiceValue = otherSettings?.get?.(CHAT_SPEECH_VOICE_SETTING);
  const voice =
    typeof voiceValue === "string" && voiceValue.trim()
      ? voiceValue.trim().toLowerCase()
      : undefined;
  const accentValue = otherSettings?.get?.(CHAT_SPEECH_ACCENT_SETTING);
  const speedValue = otherSettings?.get?.(CHAT_SPEECH_SPEED_SETTING);
  return {
    voice,
    accent: isChatSpeechAccent(accentValue) ? accentValue : "default",
    speed: isChatSpeechSpeed(speedValue) ? speedValue : 1,
  };
}

export function saveChatSpeechPreferences({
  voice,
  accent,
}: Pick<ChatSpeechPreferences, "voice" | "accent">): void {
  redux.getActions("account").set_other_settings_many({
    [CHAT_SPEECH_VOICE_SETTING]: voice ?? null,
    [CHAT_SPEECH_ACCENT_SETTING]: accent === "default" ? null : accent,
  });
}

export function saveChatSpeechSpeed(speed: ChatSpeechSpeed): void {
  redux.getActions("account").set_other_settings_many({
    [CHAT_SPEECH_SPEED_SETTING]: speed === 1 ? null : speed,
  });
}
