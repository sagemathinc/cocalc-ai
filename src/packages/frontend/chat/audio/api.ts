/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ChatSpeechCapabilities,
  ChatSpeechSynthesisResult,
  ChatSpeechTranscriptionResult,
} from "@cocalc/conat/hub/api/system";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ChatSpeechAccent } from "@cocalc/util/ai/speech";

const capabilityCache = new Map<
  string,
  { expires: number; promise: Promise<ChatSpeechCapabilities> }
>();

export function newSpeechRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export async function getChatSpeechCapabilities(
  projectId?: string,
): Promise<ChatSpeechCapabilities> {
  const key = projectId ?? "account";
  const cached = capabilityCache.get(key);
  if (cached && cached.expires > Date.now()) return await cached.promise;
  const promise =
    webapp_client.conat_client.hub.system.getChatSpeechCapabilities({
      project_id: projectId,
    });
  capabilityCache.set(key, { expires: Date.now() + 30_000, promise });
  try {
    return await promise;
  } catch (err) {
    capabilityCache.delete(key);
    throw err;
  }
}

export async function transcribeChatAudio(opts: {
  request_id: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
  content_type: string;
  filename: string;
  audio: Uint8Array;
  duration_ms: number;
  language_hints?: string[];
}): Promise<ChatSpeechTranscriptionResult> {
  return await webapp_client.conat_client.hub.system.transcribeChatAudio({
    ...opts,
    timeout: 130_000,
  });
}

export async function synthesizeChatSpeech(opts: {
  request_id: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
  message_id: string;
  text: string;
  voice?: string;
  accent?: ChatSpeechAccent;
  speed?: number;
}): Promise<ChatSpeechSynthesisResult> {
  return await webapp_client.conat_client.hub.system.synthesizeChatSpeech({
    ...opts,
    timeout: 130_000,
  });
}

export async function cancelChatSpeech(requestId: string): Promise<void> {
  await webapp_client.conat_client.hub.system.cancelChatSpeech({
    request_id: requestId,
  });
}

export function clearChatSpeechCapabilityCache(): void {
  capabilityCache.clear();
}

export function chatSpeechErrorMessage(err: unknown): string {
  const message = `${(err as any)?.message ?? err ?? ""}`
    .replace(/^Error:\s*/i, "")
    .replace(/\s*\(code=.*$/i, "")
    .trim();
  return message || "The speech service request failed.";
}
