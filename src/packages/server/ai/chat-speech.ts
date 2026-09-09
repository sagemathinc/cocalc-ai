/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type {
  ChatSpeechCapabilities,
  ChatSpeechFundingSource,
  ChatSpeechSynthesisResult,
  ChatSpeechTranscriptionResult,
} from "@cocalc/conat/hub/api/system";
import { isAiLaunchDisabled } from "@cocalc/server/launch/kill-switches";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getExternalCredentialRouted } from "@cocalc/server/external-credentials/routing";
import { getAIUsageStatus } from "./usage-status";
import {
  releaseChatSpeechUsage,
  reserveChatSpeechUsage,
  settleChatSpeechUsage,
  type ChatSpeechUsageReservation,
} from "./chat-speech-reservations";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { isValidUUID } from "@cocalc/util/misc";
import {
  chatSpeechAccentInstruction,
  isChatSpeechAccent,
  type ChatSpeechAccent,
} from "@cocalc/util/ai/speech";

const log = getLogger("server:ai:chat-speech");

// Keep the ESM-only parser as a native lazy import in this CommonJS package.
const importMusicMetadata = new Function(
  "return import('music-metadata')",
) as () => Promise<typeof import("music-metadata")>;

async function parseAudioMetadata(audio: Uint8Array, contentType: string) {
  const { parseBuffer } = await importMusicMetadata();
  return await parseBuffer(
    audio,
    { mimeType: contentType, size: audio.length },
    { duration: true, skipCovers: true },
  );
}

export const CHAT_SPEECH_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const CHAT_SPEECH_MAX_DURATION_MS = 90_000;
export const CHAT_SPEECH_MAX_TEXT_CHARACTERS = 4_096;
export const CHAT_SPEECH_CONTENT_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
] as const;
export const CHAT_SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export const CHAT_SPEECH_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_API_KEY_KIND = "openai-api-key";
const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SYNTHESIZE_TIMEOUT_MS = 120_000;
const MAX_SYNTHESIZED_AUDIO_BYTES = 16 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const REQUEST_ID_TTL_MS = 10 * 60_000;
const MAX_REQUESTS_PER_ACCOUNT_PER_MINUTE = 30;
const TRANSCRIPTION_MICROUSD_PER_MINUTE = 4_500;
const SYNTHESIS_ESTIMATED_MICROUSD_PER_MINUTE = 15_000;
const ESTIMATED_TTS_CHARACTERS_PER_MINUTE = 1_000;

type SpeechOperation = "transcription" | "speech";

interface SpeechCredential {
  source: ChatSpeechFundingSource;
  apiKey: string;
}

interface ProviderResult<T> {
  value: T;
  providerRequestId?: string;
}

const activeRequests = new Map<string, AbortController>();
const recentRequests = new Map<string, number[]>();
const usedRequestIds = new Map<string, number>();

function codedError(message: string, code: number | string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function activeRequestKey(accountId: string, requestId: string): string {
  return `${accountId}:${requestId}`;
}

function validateRequestId(requestId: string): void {
  if (!isValidUUID(requestId)) {
    throw codedError("request_id must be a UUID", 400);
  }
}

function normalizeContentType(contentType: string): string {
  return `${contentType ?? ""}`.split(";", 1)[0].trim().toLowerCase();
}

function filenameForContentType(contentType: string): string {
  switch (contentType) {
    case "audio/webm":
      return "dictation.webm";
    case "audio/mp4":
      return "dictation.m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "dictation.mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "dictation.wav";
    case "audio/ogg":
      return "dictation.ogg";
    default:
      throw codedError("Unsupported audio recording format.", 400);
  }
}

function signatureMatches(contentType: string, audio: Uint8Array): boolean {
  if (audio.length < 12) return false;
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...audio.subarray(start, start + length));
  switch (contentType) {
    case "audio/webm":
      return (
        audio[0] === 0x1a &&
        audio[1] === 0x45 &&
        audio[2] === 0xdf &&
        audio[3] === 0xa3
      );
    case "audio/mp4":
      return ascii(4, 4) === "ftyp";
    case "audio/mpeg":
    case "audio/mp3":
      return (
        ascii(0, 3) === "ID3" ||
        (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
      );
    case "audio/wav":
    case "audio/x-wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
    case "audio/ogg":
      return ascii(0, 4) === "OggS";
    default:
      return false;
  }
}

export function validateChatSpeechAudio({
  contentType,
  audio,
}: {
  contentType: string;
  audio: Uint8Array;
}): string {
  const normalized = normalizeContentType(contentType);
  if (!(CHAT_SPEECH_CONTENT_TYPES as readonly string[]).includes(normalized)) {
    throw codedError("Unsupported audio recording format.", 400);
  }
  if (!(audio instanceof Uint8Array) || audio.length === 0) {
    throw codedError("The audio recording is empty.", 400);
  }
  if (audio.length > CHAT_SPEECH_MAX_AUDIO_BYTES) {
    throw codedError("The audio recording is too large.", 413);
  }
  if (!signatureMatches(normalized, audio)) {
    throw codedError("The audio data does not match its declared format.", 400);
  }
  return normalized;
}

export async function measureChatSpeechAudioDuration({
  contentType,
  audio,
}: {
  contentType: string;
  audio: Uint8Array;
}): Promise<number> {
  let duration: number | undefined;
  try {
    const metadata = await parseAudioMetadata(audio, contentType);
    duration = metadata.format.duration;
  } catch {
    throw codedError("The audio recording could not be read.", 400);
  }
  const durationMs = Math.round((duration ?? 0) * 1_000);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > CHAT_SPEECH_MAX_DURATION_MS
  ) {
    throw codedError("The recording duration is invalid or too long.", 400);
  }
  return durationMs;
}

export function validateChatSpeechText({
  text,
  messageId,
  voice,
  accent,
  speed,
}: {
  text: string;
  messageId: string;
  voice: string;
  accent?: ChatSpeechAccent;
  speed: number;
}): string {
  const speechText = `${text ?? ""}`.trim();
  if (!messageId?.trim()) {
    throw codedError("message_id must be specified.", 400);
  }
  if (!speechText) throw codedError("There is no text to read aloud.", 400);
  if (speechText.length > CHAT_SPEECH_MAX_TEXT_CHARACTERS) {
    throw codedError("This speech segment is too long.", 413);
  }
  if (!(CHAT_SPEECH_VOICES as readonly string[]).includes(voice)) {
    throw codedError("Unsupported speech voice.", 400);
  }
  if (accent != null && !isChatSpeechAccent(accent)) {
    throw codedError("Unsupported speech accent.", 400);
  }
  if (!(CHAT_SPEECH_SPEEDS as readonly number[]).includes(speed)) {
    throw codedError("Unsupported speech speed.", 400);
  }
  return speechText;
}

function checkRateLimit(accountId: string): void {
  const now = Date.now();
  const recent = (recentRequests.get(accountId) ?? []).filter(
    (time) => now - time < RATE_WINDOW_MS,
  );
  if (recent.length >= MAX_REQUESTS_PER_ACCOUNT_PER_MINUTE) {
    throw codedError("Too many speech requests. Try again in a minute.", 429);
  }
  recent.push(now);
  recentRequests.set(accountId, recent);
}

function claimRequestId(accountId: string, requestId: string): void {
  const now = Date.now();
  for (const [key, usedAt] of usedRequestIds) {
    if (now - usedAt >= REQUEST_ID_TTL_MS) usedRequestIds.delete(key);
  }
  const key = activeRequestKey(accountId, requestId);
  if (usedRequestIds.has(key)) {
    throw codedError("This speech request ID has already been used.", 409);
  }
  usedRequestIds.set(key, now);
}

function allowanceAvailable(
  status: Awaited<ReturnType<typeof getAIUsageStatus>>,
): boolean {
  return status.windows.every(
    ({ limit, used }) => typeof limit === "number" && limit > 0 && used < limit,
  );
}

async function resolveSpeechCredential({
  accountId,
  projectId,
  touchLastUsed,
}: {
  accountId: string;
  projectId?: string;
  touchLastUsed: boolean;
}): Promise<{ credential?: SpeechCredential; reason?: string }> {
  if (projectId) {
    await assertProjectCollaboratorAccessAllowRemote({
      account_id: accountId,
      project_id: projectId,
    });
    const projectCredential = await getExternalCredentialRouted({
      selector: {
        provider: "openai",
        kind: OPENAI_API_KEY_KIND,
        scope: "project",
        project_id: projectId,
      },
      touchLastUsed,
    });
    if (projectCredential?.payload.trim()) {
      return {
        credential: {
          source: "project",
          apiKey: projectCredential.payload.trim(),
        },
      };
    }
  }

  const accountCredential = await getExternalCredentialRouted({
    selector: {
      provider: "openai",
      kind: OPENAI_API_KEY_KIND,
      scope: "account",
      owner_account_id: accountId,
    },
    touchLastUsed,
  });
  if (accountCredential?.payload.trim()) {
    return {
      credential: {
        source: "account",
        apiKey: accountCredential.payload.trim(),
      },
    };
  }

  const settings = (await getServerSettings()) as Record<string, any>;
  const siteKey = `${settings.openai_api_key ?? ""}`.trim();
  if (
    !to_bool(settings.openai_enabled) ||
    (await isAiLaunchDisabled()) ||
    !siteKey
  ) {
    return {
      reason: "Connect an OpenAI API key in AI settings to use speech.",
    };
  }
  const usage = await getAIUsageStatus({ account_id: accountId });
  if (!allowanceAvailable(usage)) {
    return { reason: "Your site-funded AI allowance is exhausted." };
  }
  return { credential: { source: "site", apiKey: siteKey } };
}

async function speechSettings() {
  const settings = (await getServerSettings()) as Record<string, any>;
  const defaultVoice = `${settings.chat_speech_default_voice ?? "alloy"}`
    .trim()
    .toLowerCase();
  return {
    inputEnabled: to_bool(settings.chat_speech_input_enabled ?? true),
    outputEnabled: to_bool(settings.chat_speech_output_enabled ?? true),
    transcriptionModel:
      `${settings.chat_speech_transcription_model ?? "gpt-transcribe"}`.trim() ||
      "gpt-transcribe",
    synthesisModel:
      `${settings.chat_speech_synthesis_model ?? "gpt-4o-mini-tts"}`.trim() ||
      "gpt-4o-mini-tts",
    defaultVoice: (CHAT_SPEECH_VOICES as readonly string[]).includes(
      defaultVoice,
    )
      ? defaultVoice
      : "alloy",
  };
}

export async function getChatSpeechCapabilities({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id?: string;
}): Promise<ChatSpeechCapabilities> {
  if (!account_id) throw codedError("Must be signed in.", 401);
  const [settings, resolved] = await Promise.all([
    speechSettings(),
    resolveSpeechCredential({
      accountId: account_id,
      projectId: project_id,
      touchLastUsed: false,
    }),
  ]);
  const reason = resolved.reason;
  return {
    input: {
      enabled: settings.inputEnabled && resolved.credential != null,
      reason: !settings.inputEnabled ? "Chat dictation is disabled." : reason,
      max_bytes: CHAT_SPEECH_MAX_AUDIO_BYTES,
      max_duration_ms: CHAT_SPEECH_MAX_DURATION_MS,
      supported_content_types: [...CHAT_SPEECH_CONTENT_TYPES],
      model: settings.inputEnabled ? settings.transcriptionModel : undefined,
    },
    output: {
      enabled: settings.outputEnabled && resolved.credential != null,
      reason: !settings.outputEnabled ? "Chat read aloud is disabled." : reason,
      max_characters: CHAT_SPEECH_MAX_TEXT_CHARACTERS,
      voices: [...CHAT_SPEECH_VOICES],
      default_voice: settings.defaultVoice,
      speeds: [...CHAT_SPEECH_SPEEDS],
      model: settings.outputEnabled ? settings.synthesisModel : undefined,
    },
    funding_source: resolved.credential?.source,
  };
}

async function providerError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const text = (await response.text()).slice(0, 4_096);
    const parsed = JSON.parse(text);
    detail = `${parsed?.error?.message ?? parsed?.message ?? ""}`.trim();
  } catch {
    // Keep provider bodies out of logs and user-visible errors.
  }
  const message =
    response.status === 429
      ? "The speech service is busy or rate limited. Try again shortly."
      : response.status === 401 || response.status === 403
        ? "The configured OpenAI credential cannot use the speech service."
        : detail || "The speech service request failed.";
  return codedError(message, response.status || 502);
}

export async function runProviderRequest<T>({
  accountId,
  requestId,
  timeoutMs,
  run,
}: {
  accountId: string;
  requestId: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  validateRequestId(requestId);
  checkRateLimit(accountId);
  claimRequestId(accountId, requestId);
  const key = activeRequestKey(accountId, requestId);
  if (activeRequests.has(key)) {
    throw codedError("This speech request is already active.", 409);
  }
  const controller = new AbortController();
  activeRequests.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw codedError("The speech request was canceled or timed out.", 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (activeRequests.get(key) === controller) activeRequests.delete(key);
  }
}

export async function transcribeWithOpenAI({
  apiKey,
  model,
  contentType,
  filename,
  audio,
  language,
  signal,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  contentType: string;
  filename: string;
  audio: Uint8Array;
  language?: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProviderResult<{ text: string; language?: string }>> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: contentType }),
    filename || filenameForContentType(contentType),
  );
  form.set("model", model);
  form.set("response_format", "json");
  if (language) form.set("language", language);
  const response = await fetchImpl(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  if (!response.ok) throw await providerError(response);
  const result = (await response.json()) as {
    text?: string;
    language?: string;
  };
  const text = `${result?.text ?? ""}`.trim();
  if (!text) throw codedError("No speech was detected.", 422);
  return {
    value: { text, language: result?.language },
    providerRequestId: response.headers.get("x-request-id") ?? undefined,
  };
}

export async function synthesizeWithOpenAI({
  apiKey,
  model,
  text,
  voice,
  instructions,
  speed,
  signal,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  text: string;
  voice: string;
  instructions?: string;
  speed: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ProviderResult<Uint8Array>> {
  const response = await fetchImpl(`${OPENAI_BASE_URL}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      ...(instructions ? { instructions } : {}),
      speed,
      response_format: "mp3",
    }),
    signal,
  });
  if (!response.ok) throw await providerError(response);
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0 || audio.length > MAX_SYNTHESIZED_AUDIO_BYTES) {
    throw codedError("The generated audio response has an invalid size.", 502);
  }
  return {
    value: audio,
    providerRequestId: response.headers.get("x-request-id") ?? undefined,
  };
}

function speechCostMicrousd({
  operation,
  durationMs,
}: {
  operation: SpeechOperation;
  durationMs: number;
}): number {
  const rate =
    operation === "transcription"
      ? TRANSCRIPTION_MICROUSD_PER_MINUTE
      : SYNTHESIS_ESTIMATED_MICROUSD_PER_MINUTE;
  return Math.max(1, Math.ceil((durationMs * rate) / 60_000));
}

async function settleSiteFundedSpeechUsage({
  reservation,
  accountId,
  projectId,
  path,
  requestId,
  operation,
  model,
  durationMs,
  inputCharacters,
  providerRequestId,
  elapsedMs,
}: {
  reservation: ChatSpeechUsageReservation;
  accountId: string;
  projectId?: string;
  path?: string;
  requestId: string;
  operation: SpeechOperation;
  model: string;
  durationMs: number;
  inputCharacters?: number;
  providerRequestId?: string;
  elapsedMs: number;
}): Promise<void> {
  const costMicrousd = speechCostMicrousd({ operation, durationMs });
  try {
    await settleChatSpeechUsage({
      reservation,
      projectId,
      path,
      operation,
      model,
      costMicrousd,
      durationMs,
      inputCharacters,
      providerRequestId,
      elapsedMs,
    });
  } catch (err) {
    log.error("failed to record site-funded chat speech usage", {
      account_id: accountId,
      project_id: projectId,
      request_id: requestId,
      operation,
      model,
      cost_microusd: costMicrousd,
      error: `${err}`,
    });
  }
}

async function releaseSiteFundedSpeechUsage(
  reservation: ChatSpeechUsageReservation,
): Promise<void> {
  try {
    await releaseChatSpeechUsage(reservation);
  } catch (err) {
    // A failed release leaves a conservative hold that expires automatically.
    log.error("failed to release site-funded chat speech reservation", {
      account_id: reservation.accountId,
      request_id: reservation.requestId,
      error: `${err}`,
    });
  }
}

export async function transcribeChatAudio({
  account_id,
  request_id,
  project_id,
  path,
  content_type,
  audio,
  language_hints,
}: {
  account_id?: string;
  request_id: string;
  project_id?: string;
  path?: string;
  thread_id?: string;
  content_type: string;
  filename: string;
  audio: Uint8Array;
  duration_ms?: number;
  language_hints?: string[];
}): Promise<ChatSpeechTranscriptionResult> {
  if (!account_id) throw codedError("Must be signed in.", 401);
  validateRequestId(request_id);
  const contentType = validateChatSpeechAudio({
    contentType: content_type,
    audio,
  });
  const durationMs = await measureChatSpeechAudioDuration({
    contentType,
    audio,
  });
  const settings = await speechSettings();
  if (!settings.inputEnabled)
    throw codedError("Chat dictation is disabled.", 403);
  const resolved = await resolveSpeechCredential({
    accountId: account_id,
    projectId: project_id,
    touchLastUsed: true,
  });
  if (!resolved.credential)
    throw codedError(resolved.reason ?? "Speech unavailable.", 403);
  const reservation =
    resolved.credential.source === "site"
      ? await reserveChatSpeechUsage({
          accountId: account_id,
          requestId: request_id,
          operation: "transcription",
          model: settings.transcriptionModel,
          reservedMicrousd: speechCostMicrousd({
            operation: "transcription",
            durationMs,
          }),
        })
      : undefined;
  const language =
    `${language_hints?.[0] ?? ""}`.trim().slice(0, 16) || undefined;
  const started = Date.now();
  let provider: ProviderResult<{ text: string; language?: string }>;
  try {
    provider = await runProviderRequest({
      accountId: account_id,
      requestId: request_id,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      run: async (signal) =>
        await transcribeWithOpenAI({
          apiKey: resolved.credential!.apiKey,
          model: settings.transcriptionModel,
          contentType,
          filename: filenameForContentType(contentType),
          audio,
          language,
          signal,
        }),
    });
  } catch (err) {
    if (reservation) await releaseSiteFundedSpeechUsage(reservation);
    throw err;
  }
  if (reservation) {
    await settleSiteFundedSpeechUsage({
      reservation,
      accountId: account_id,
      projectId: project_id,
      path,
      requestId: request_id,
      operation: "transcription",
      model: settings.transcriptionModel,
      durationMs,
      providerRequestId: provider.providerRequestId,
      elapsedMs: Date.now() - started,
    });
  }
  log.debug("chat audio transcribed", {
    account_id,
    project_id,
    request_id,
    funding_source: resolved.credential.source,
    duration_ms: durationMs,
    bytes: audio.length,
  });
  return {
    text: provider.value.text,
    model: settings.transcriptionModel,
    request_id,
    detected_language: provider.value.language,
  };
}

export async function synthesizeChatSpeech({
  account_id,
  request_id,
  project_id,
  path,
  message_id,
  text,
  voice,
  accent,
  speed = 1,
}: {
  account_id?: string;
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
  if (!account_id) throw codedError("Must be signed in.", 401);
  validateRequestId(request_id);
  const settings = await speechSettings();
  if (!settings.outputEnabled)
    throw codedError("Chat read aloud is disabled.", 403);
  const selectedVoice = `${voice ?? settings.defaultVoice}`
    .trim()
    .toLowerCase();
  const speechText = validateChatSpeechText({
    text,
    messageId: message_id,
    voice: selectedVoice,
    accent,
    speed,
  });
  const resolved = await resolveSpeechCredential({
    accountId: account_id,
    projectId: project_id,
    touchLastUsed: true,
  });
  if (!resolved.credential)
    throw codedError(resolved.reason ?? "Speech unavailable.", 403);
  const estimatedDurationMs = Math.max(
    1_000,
    (speechText.length / ESTIMATED_TTS_CHARACTERS_PER_MINUTE) *
      (60_000 / speed),
  );
  const reservation =
    resolved.credential.source === "site"
      ? await reserveChatSpeechUsage({
          accountId: account_id,
          requestId: request_id,
          operation: "speech",
          model: settings.synthesisModel,
          reservedMicrousd: speechCostMicrousd({
            operation: "speech",
            durationMs: estimatedDurationMs,
          }),
        })
      : undefined;
  const started = Date.now();
  let provider: ProviderResult<Uint8Array>;
  try {
    provider = await runProviderRequest({
      accountId: account_id,
      requestId: request_id,
      timeoutMs: SYNTHESIZE_TIMEOUT_MS,
      run: async (signal) =>
        await synthesizeWithOpenAI({
          apiKey: resolved.credential!.apiKey,
          model: settings.synthesisModel,
          text: speechText,
          voice: selectedVoice,
          instructions: chatSpeechAccentInstruction(accent),
          speed,
          signal,
        }),
    });
  } catch (err) {
    if (reservation) await releaseSiteFundedSpeechUsage(reservation);
    throw err;
  }
  if (reservation) {
    await settleSiteFundedSpeechUsage({
      reservation,
      accountId: account_id,
      projectId: project_id,
      path,
      requestId: request_id,
      operation: "speech",
      model: settings.synthesisModel,
      durationMs: estimatedDurationMs,
      inputCharacters: speechText.length,
      providerRequestId: provider.providerRequestId,
      elapsedMs: Date.now() - started,
    });
  }
  log.debug("chat speech synthesized", {
    account_id,
    project_id,
    request_id,
    funding_source: resolved.credential.source,
    input_characters: speechText.length,
    output_bytes: provider.value.length,
  });
  return {
    audio: provider.value,
    content_type: "audio/mpeg",
    model: settings.synthesisModel,
    request_id,
  };
}

export async function cancelChatSpeech({
  account_id,
  request_id,
}: {
  account_id?: string;
  request_id: string;
}): Promise<{ canceled: boolean }> {
  if (!account_id) throw codedError("Must be signed in.", 401);
  validateRequestId(request_id);
  const key = activeRequestKey(account_id, request_id);
  const controller = activeRequests.get(key);
  if (!controller) return { canceled: false };
  controller.abort();
  activeRequests.delete(key);
  return { canceled: true };
}

export function resetChatSpeechStateForTests(): void {
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
  recentRequests.clear();
  usedRequestIds.clear();
}
