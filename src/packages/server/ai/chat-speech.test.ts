/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  cancelChatSpeech,
  measureChatSpeechAudioDuration,
  resetChatSpeechStateForTests,
  runProviderRequest,
  synthesizeWithOpenAI,
  transcribeWithOpenAI,
  validateChatSpeechAudio,
  validateChatSpeechText,
} from "./chat-speech";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(() => resetChatSpeechStateForTests());

describe("OpenAI chat speech provider", () => {
  it("sends binary transcription input without putting the API key in the payload", async () => {
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer secret-key",
      );
      expect(form.get("model")).toBe("gpt-transcribe");
      expect(form.get("language")).toBe("en");
      expect(`${form.get("file")}`).not.toContain("secret-key");
      return new Response(
        JSON.stringify({ text: "hello world", language: "en" }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-1",
          },
        },
      );
    });

    const result = await transcribeWithOpenAI({
      apiKey: "secret-key",
      model: "gpt-transcribe",
      contentType: "audio/webm",
      filename: "dictation.webm",
      audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      language: "en",
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      value: { text: "hello world", language: "en" },
      providerRequestId: "req-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requests bounded MP3 speech with the selected voice and speed", async () => {
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(`${init.body}`)).toEqual({
        model: "gpt-4o-mini-tts",
        input: "Read this",
        voice: "alloy",
        instructions: "Speak with a natural British English accent.",
        speed: 1.25,
        response_format: "mp3",
      });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "x-request-id": "req-2" },
      });
    });

    const result = await synthesizeWithOpenAI({
      apiKey: "secret-key",
      model: "gpt-4o-mini-tts",
      text: "Read this",
      voice: "alloy",
      instructions: "Speak with a natural British English accent.",
      speed: 1.25,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(Array.from(result.value)).toEqual([1, 2, 3]);
    expect(result.providerRequestId).toBe("req-2");
  });

  it("normalizes provider authentication failures", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "sensitive detail" } }),
          {
            status: 401,
          },
        ),
    );

    await expect(
      synthesizeWithOpenAI({
        apiKey: "bad-key",
        model: "gpt-4o-mini-tts",
        text: "Read this",
        voice: "alloy",
        speed: 1,
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: 401,
      message:
        "The configured OpenAI credential cannot use the speech service.",
    });
  });
});

describe("chat speech request validation", () => {
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);

  function makeWav(durationSeconds: number): Uint8Array {
    const sampleRate = 8_000;
    const dataLength = sampleRate * durationSeconds;
    const wav = new Uint8Array(44 + dataLength);
    const view = new DataView(wav.buffer);
    const writeAscii = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) {
        wav[offset + i] = value.charCodeAt(i);
      }
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeAscii(36, "data");
    view.setUint32(40, dataLength, true);
    return wav;
  }

  it("normalizes a supported recorder MIME type", () => {
    expect(
      validateChatSpeechAudio({
        contentType: "audio/webm;codecs=opus",
        audio: webm,
      }),
    ).toBe("audio/webm");
  });

  it.each([
    ["unsupported MIME", "audio/aac", webm, 400],
    ["invalid container", "audio/webm", new Uint8Array(12), 400],
  ])("rejects %s", (_label, contentType, audio, code) => {
    expect(() => validateChatSpeechAudio({ contentType, audio })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("rejects invalid speech options and bounds", () => {
    expect(() =>
      validateChatSpeechText({
        text: "read this",
        messageId: "message-1",
        voice: "unknown",
        speed: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 400 }));
    expect(() =>
      validateChatSpeechText({
        text: "x".repeat(4_097),
        messageId: "message-1",
        voice: "alloy",
        speed: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 413 }));
    expect(() =>
      validateChatSpeechText({
        text: "read this",
        messageId: "message-1",
        voice: "alloy",
        accent: "unsupported" as any,
        speed: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 400 }));
  });

  it("derives duration from the audio container instead of caller metadata", async () => {
    await expect(
      measureChatSpeechAudioDuration({
        contentType: "audio/wav",
        audio: makeWav(1),
      }),
    ).resolves.toBe(1_000);
  });

  it("accepts a real Chromium streaming WebM without duration metadata", async () => {
    const audio = readFileSync(
      join(__dirname, "fixtures/chromium-streaming-opus.webm"),
    );
    const duration = await measureChatSpeechAudioDuration({
      contentType: "audio/webm;codecs=opus",
      audio,
    });
    expect(duration).toBeGreaterThanOrEqual(900);
    expect(duration).toBeLessThanOrEqual(1200);
  });

  it("rejects malformed WebM rather than accepting a missing duration", async () => {
    await expect(
      measureChatSpeechAudioDuration({
        contentType: "audio/webm",
        audio: webm,
      }),
    ).rejects.toMatchObject({ code: 400 });
  });

  it("enforces the duration limit using the uploaded audio", async () => {
    await expect(
      measureChatSpeechAudioDuration({
        contentType: "audio/wav",
        audio: makeWav(91),
      }),
    ).rejects.toMatchObject({ code: 400 });
  });
});

describe("chat speech cancellation and idempotency", () => {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const requestId = "22222222-2222-4222-8222-222222222222";

  it("aborts active provider work through the explicit cancel method", async () => {
    const request = runProviderRequest({
      accountId,
      requestId,
      timeoutMs: 10_000,
      run: async (signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const rejected = expect(request).rejects.toMatchObject({ code: 408 });

    await expect(
      cancelChatSpeech({ account_id: accountId, request_id: requestId }),
    ).resolves.toEqual({ canceled: true });
    await rejected;
  });

  it("rejects reuse of a paid provider request ID", async () => {
    await runProviderRequest({
      accountId,
      requestId,
      timeoutMs: 10_000,
      run: async () => "first",
    });
    await expect(
      runProviderRequest({
        accountId,
        requestId,
        timeoutMs: 10_000,
        run: async () => "duplicate",
      }),
    ).rejects.toMatchObject({ code: 409 });
  });
});
