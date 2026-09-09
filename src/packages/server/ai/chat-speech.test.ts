/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  cancelChatSpeech,
  resetChatSpeechStateForTests,
  runProviderRequest,
  synthesizeWithOpenAI,
  transcribeWithOpenAI,
  validateChatSpeechAudio,
  validateChatSpeechText,
} from "./chat-speech";

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

  it("normalizes a supported recorder MIME type", () => {
    expect(
      validateChatSpeechAudio({
        contentType: "audio/webm;codecs=opus",
        audio: webm,
        durationMs: 1_000,
      }),
    ).toBe("audio/webm");
  });

  it.each([
    ["unsupported MIME", "audio/aac", webm, 1_000, 400],
    ["invalid container", "audio/webm", new Uint8Array(12), 1_000, 400],
    ["excessive duration", "audio/webm", webm, 90_001, 400],
  ])("rejects %s", (_label, contentType, audio, durationMs, code) => {
    expect(() =>
      validateChatSpeechAudio({ contentType, audio, durationMs }),
    ).toThrow(expect.objectContaining({ code }));
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
