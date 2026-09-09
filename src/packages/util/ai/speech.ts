/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CHAT_SPEECH_ACCENTS = [
  "default",
  "american",
  "british",
  "australian",
  "canadian",
  "indian",
  "irish",
  "scottish",
] as const;

export type ChatSpeechAccent = (typeof CHAT_SPEECH_ACCENTS)[number];

export function isChatSpeechAccent(value: unknown): value is ChatSpeechAccent {
  return (CHAT_SPEECH_ACCENTS as readonly unknown[]).includes(value);
}

export function chatSpeechAccentInstruction(
  accent: ChatSpeechAccent | undefined,
): string | undefined {
  switch (accent) {
    case undefined:
    case "default":
      return;
    case "american":
      return "Speak with a natural American English accent.";
    case "british":
      return "Speak with a natural British English accent.";
    case "australian":
      return "Speak with a natural Australian English accent.";
    case "canadian":
      return "Speak with a natural Canadian English accent.";
    case "indian":
      return "Speak with a natural Indian English accent.";
    case "irish":
      return "Speak with a natural Irish English accent.";
    case "scottish":
      return "Speak with a natural Scottish English accent.";
  }
}
