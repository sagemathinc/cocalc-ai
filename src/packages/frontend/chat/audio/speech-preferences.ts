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

export interface ChatSpeechPreferences {
  voice?: string;
  accent: ChatSpeechAccent;
}

export function readChatSpeechPreferences(): ChatSpeechPreferences {
  const otherSettings = redux.getStore("account")?.get("other_settings") as any;
  const voiceValue = otherSettings?.get?.(CHAT_SPEECH_VOICE_SETTING);
  const voice =
    typeof voiceValue === "string" && voiceValue.trim()
      ? voiceValue.trim().toLowerCase()
      : undefined;
  const accentValue = otherSettings?.get?.(CHAT_SPEECH_ACCENT_SETTING);
  return {
    voice,
    accent: isChatSpeechAccent(accentValue) ? accentValue : "default",
  };
}

export function saveChatSpeechPreferences({
  voice,
  accent,
}: ChatSpeechPreferences): void {
  redux.getActions("account").set_other_settings_many({
    [CHAT_SPEECH_VOICE_SETTING]: voice ?? null,
    [CHAT_SPEECH_ACCENT_SETTING]: accent === "default" ? null : accent,
  });
}
