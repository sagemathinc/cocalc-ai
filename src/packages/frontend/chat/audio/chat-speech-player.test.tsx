/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ChatSpeechPlayer,
  startChatSpeech,
  stopChatSpeech,
} from "./chat-speech-player";
import {
  cancelChatSpeech,
  getChatSpeechCapabilities,
  newSpeechRequestId,
  synthesizeChatSpeech,
} from "./api";

jest.mock("./api", () => ({
  cancelChatSpeech: jest.fn(async () => undefined),
  chatSpeechErrorMessage: (err: unknown) => `${(err as Error)?.message ?? err}`,
  getChatSpeechCapabilities: jest.fn(),
  newSpeechRequestId: jest.fn(() => "request-1"),
  synthesizeChatSpeech: jest.fn(),
}));

class FakeAudio {
  static rejectPlay = false;
  currentTime = 0;
  duration = 12;
  ended = false;
  paused = true;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;

  constructor(public src: string) {}

  async play() {
    if (FakeAudio.rejectPlay) throw new Error("gesture required");
    this.paused = false;
    this.onloadedmetadata?.();
  }

  pause() {
    this.paused = true;
  }

  load() {}

  removeAttribute() {}
}

const capabilities = {
  input: {
    enabled: true,
    max_bytes: 10_000,
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

describe("ChatSpeechPlayer", () => {
  beforeEach(() => {
    FakeAudio.rejectPlay = false;
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: FakeAudio,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:speech"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    });
    jest
      .mocked(getChatSpeechCapabilities)
      .mockResolvedValue(capabilities as any);
    jest.mocked(newSpeechRequestId).mockReturnValue("request-1");
    jest.mocked(synthesizeChatSpeech).mockResolvedValue({
      audio: new Uint8Array([1, 2, 3]),
      content_type: "audio/mpeg",
      model: "gpt-4o-mini-tts",
      request_id: "request-1",
    });
  });

  afterEach(() => {
    stopChatSpeech();
    jest.clearAllMocks();
  });

  it("exposes accessible persistent playback controls and disclosure", async () => {
    render(<ChatSpeechPlayer />);

    await act(async () => {
      await startChatSpeech({
        markdown: "A concise **answer**.",
        messageId: "message-1",
        title: "Final response",
      });
    });

    expect(
      screen.getByRole("region", { name: "Read aloud player" }),
    ).toBeTruthy();
    expect(screen.getByText("AI-generated voice")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pause read aloud" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Playback speed" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop read aloud" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Read aloud player" }),
      ).toBeNull(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:speech");
  });

  it("falls back to an explicit play control when iOS blocks delayed playback", async () => {
    FakeAudio.rejectPlay = true;
    render(<ChatSpeechPlayer />);

    await act(async () => {
      await startChatSpeech({
        markdown: "Ready after generation.",
        messageId: "message-2",
      });
    });

    expect(
      screen.getByRole("button", { name: "Play read aloud" }),
    ).toBeTruthy();
    expect(cancelChatSpeech).not.toHaveBeenCalled();
  });

  it("replaces the active player and releases its audio URL", async () => {
    render(<ChatSpeechPlayer />);
    await act(async () => {
      await startChatSpeech({ markdown: "First answer.", messageId: "first" });
      await startChatSpeech({
        markdown: "Second answer.",
        messageId: "second",
        title: "Second response",
      });
    });

    expect(screen.getByText("Second response")).toBeTruthy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:speech");
    expect(synthesizeChatSpeech).toHaveBeenCalledTimes(2);
  });
});
