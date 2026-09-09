/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatAudioRecorder } from "./use-chat-audio-recorder";
import {
  cancelChatSpeech,
  getChatSpeechCapabilities,
  transcribeChatAudio,
} from "./api";

jest.mock("./api", () => ({
  cancelChatSpeech: jest.fn(async () => undefined),
  chatSpeechErrorMessage: (err: unknown) => `${(err as Error)?.message ?? err}`,
  getChatSpeechCapabilities: jest.fn(),
  newSpeechRequestId: jest.fn(() => "request-1"),
  transcribeChatAudio: jest.fn(),
}));

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = jest.fn((type: string) =>
    type.startsWith("audio/webm"),
  );
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

function makeMedia() {
  const track = {
    addEventListener: jest.fn(),
    stop: jest.fn(),
  };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const getUserMedia = jest.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  return { getUserMedia, stream, track };
}

const capabilities = {
  input: {
    enabled: true,
    max_bytes: 10 * 1024 * 1024,
    max_duration_ms: 90_000,
    supported_content_types: ["audio/webm"],
  },
  output: {
    enabled: true,
    max_characters: 4_096,
    voices: ["alloy"],
    default_voice: "alloy",
    speeds: [1],
  },
} as const;

describe("useChatAudioRecorder", () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    jest
      .mocked(getChatSpeechCapabilities)
      .mockResolvedValue(capabilities as any);
    jest.mocked(transcribeChatAudio).mockResolvedValue({
      text: "dictated text",
      model: "gpt-transcribe",
      request_id: "request-1",
    });
  });

  afterEach(() => jest.clearAllMocks());

  it("requests microphone permission only after activation and cleans up on cancel", async () => {
    const media = makeMedia();
    const onTranscript = jest.fn();
    const hook = renderHook(() =>
      useChatAudioRecorder({ projectId: "project-1", onTranscript }),
    );
    await waitFor(() => expect(hook.result.current.status).toBe("idle"));
    expect(media.getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.current.start({ session: 1 });
    });
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(hook.result.current.status).toBe("recording");

    act(() => hook.result.current.cancel());
    expect(media.track.stop).toHaveBeenCalled();
    expect(transcribeChatAudio).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
  });

  it("transcribes a stopped clip and returns its original context", async () => {
    const media = makeMedia();
    const onTranscript = jest.fn();
    const hook = renderHook(() =>
      useChatAudioRecorder({
        projectId: "project-1",
        path: "chat.chat",
        threadId: "thread-1",
        onTranscript,
      }),
    );
    await waitFor(() => expect(hook.result.current.status).toBe("idle"));

    await act(async () => {
      await hook.result.current.start({ session: 7 });
    });
    const recorder = FakeMediaRecorder.instances[0];
    const data = new Blob([new Uint8Array([1, 2, 3])], {
      type: "audio/webm",
    });
    recorder.ondataavailable?.({
      data,
    } as BlobEvent);
    act(() => hook.result.current.stop());

    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("dictated text", {
        session: 7,
      }),
    );
    expect(transcribeChatAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        path: "chat.chat",
        thread_id: "thread-1",
        content_type: "audio/webm",
      }),
    );
    expect(media.track.stop).toHaveBeenCalled();
  });

  it("cancels an in-flight transcription before another recorder starts", async () => {
    makeMedia();
    let resolveTranscription:
      | ((value: Awaited<ReturnType<typeof transcribeChatAudio>>) => void)
      | undefined;
    jest.mocked(transcribeChatAudio).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    const first = renderHook(() =>
      useChatAudioRecorder({ onTranscript: jest.fn() }),
    );
    const second = renderHook(() =>
      useChatAudioRecorder({ onTranscript: jest.fn() }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("idle"));
    await waitFor(() => expect(second.result.current.status).toBe("idle"));

    await act(async () => {
      await first.result.current.start({ session: 1 });
    });
    const firstRecorder = FakeMediaRecorder.instances[0];
    firstRecorder.ondataavailable?.({
      data: new Blob([new Uint8Array([1])], { type: "audio/webm" }),
    } as BlobEvent);
    act(() => first.result.current.stop());
    await waitFor(() =>
      expect(first.result.current.status).toBe("transcribing"),
    );

    await act(async () => {
      await second.result.current.start({ session: 2 });
    });
    expect(cancelChatSpeech).toHaveBeenCalledWith("request-1");
    expect(first.result.current.status).toBe("idle");
    expect(second.result.current.status).toBe("recording");

    await act(async () => {
      resolveTranscription?.({
        text: "late transcript",
        model: "gpt-transcribe",
        request_id: "request-1",
      });
      await Promise.resolve();
    });
    expect(second.result.current.status).toBe("recording");
    act(() => second.result.current.cancel());
  });
});
