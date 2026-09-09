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
  within,
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
import {
  readChatSpeechPreferences,
  saveChatSpeechPreferences,
  saveChatSpeechSpeed,
} from "./speech-preferences";
import { SpeechPaneContext } from "./speech-pane-context";
import { ChatReadAloudButton } from "../codex-final-response-copy";

jest.mock("./api", () => ({
  cancelChatSpeech: jest.fn(async () => undefined),
  chatSpeechErrorMessage: (err: unknown) => `${(err as Error)?.message ?? err}`,
  getChatSpeechCapabilities: jest.fn(),
  newSpeechRequestId: jest.fn(() => "request-1"),
  synthesizeChatSpeech: jest.fn(),
}));

jest.mock("./speech-preferences", () => ({
  CHAT_SPEECH_SPEEDS: [0.75, 1, 1.25, 1.5, 2],
  readChatSpeechPreferences: jest.fn(() => ({
    voice: undefined,
    accent: "default",
    speed: 1,
  })),
  saveChatSpeechPreferences: jest.fn(),
  saveChatSpeechSpeed: jest.fn(),
}));

class FakeAudio {
  static rejectPlay = false;
  static latest: FakeAudio | undefined;
  currentTime = 0;
  duration = 12;
  ended = false;
  paused = true;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;

  constructor(public src: string) {
    FakeAudio.latest = this;
  }

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
    voices: ["alloy", "coral"],
    default_voice: "alloy",
    speeds: [1],
  },
} as const;

describe("ChatSpeechPlayer", () => {
  beforeEach(() => {
    FakeAudio.rejectPlay = false;
    FakeAudio.latest = undefined;
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

  it.each([false, true])(
    "does not synthesize a replacement twice when an old lookup resolves (replacement ready: %s)",
    async (replacementReady) => {
      let resolveFirst!: (value: any) => void;
      let resolveSecond!: (value: any) => void;
      jest
        .mocked(getChatSpeechCapabilities)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        );
      render(<ChatSpeechPlayer />);
      await act(async () => {
        const first = startChatSpeech({ markdown: "Answer A", messageId: "a" });
        const second = startChatSpeech({
          markdown: "Answer B",
          messageId: "b",
        });
        if (replacementReady) {
          resolveSecond(capabilities);
          await second;
        }
        resolveFirst(capabilities);
        await first;
        expect(synthesizeChatSpeech).toHaveBeenCalledTimes(
          replacementReady ? 1 : 0,
        );
        if (!replacementReady) {
          resolveSecond(capabilities);
          await second;
        }
      });
      expect(synthesizeChatSpeech).toHaveBeenCalledTimes(1);
      expect(synthesizeChatSpeech).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: "b", text: "Answer B" }),
      );
      expect(
        screen.getByRole("button", { name: "Pause read aloud" }),
      ).toBeTruthy();
    },
  );

  it("does not synthesize after stopping during the capability lookup", async () => {
    let resolveLookup!: (value: any) => void;
    jest.mocked(getChatSpeechCapabilities).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    render(<ChatSpeechPlayer />);
    await act(async () => {
      const started = startChatSpeech({ markdown: "Answer A", messageId: "a" });
      stopChatSpeech();
      resolveLookup(capabilities);
      await started;
    });
    expect(synthesizeChatSpeech).not.toHaveBeenCalled();
    expect(newSpeechRequestId).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Read aloud player" }),
    ).toBeNull();
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

  it("opens account-wide voice and accent settings from the disclosure", async () => {
    render(<ChatSpeechPlayer />);
    await act(async () => {
      await startChatSpeech({
        markdown: "Choose a voice.",
        messageId: "message-settings",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "AI-generated voice" }));
    expect(await screen.findByText("Read aloud voice")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Read aloud voice" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Read aloud accent" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveChatSpeechPreferences).toHaveBeenCalledWith({
      voice: undefined,
      accent: "default",
    });
    expect(readChatSpeechPreferences).toHaveBeenCalled();
  });

  it("restores the account-wide playback speed", async () => {
    jest.mocked(readChatSpeechPreferences).mockReturnValueOnce({
      voice: undefined,
      accent: "default",
      speed: 1.5,
    });
    render(<ChatSpeechPlayer />);

    await act(async () => {
      await startChatSpeech({
        markdown: "Listen faster.",
        messageId: "message-speed",
      });
    });

    expect(
      screen.getByRole("combobox", { name: "Playback speed" }),
    ).toBeTruthy();
    expect(FakeAudio.latest?.playbackRate).toBe(1.5);
    expect(saveChatSpeechSpeed).not.toHaveBeenCalled();
  });

  it("allows seeking through the current speech segment", async () => {
    render(<ChatSpeechPlayer />);
    await act(async () => {
      await startChatSpeech({
        markdown: "Seek through this answer.",
        messageId: "message-seek",
      });
    });

    const slider = screen.getByRole("slider", { name: "Seek read aloud" });
    slider.focus();
    fireEvent.keyDown(slider, {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
      which: 39,
    });
    expect(FakeAudio.latest?.currentTime).toBeGreaterThan(0);
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

  it("keeps shared playback alive when an unrelated chatroom unmounts", async () => {
    const owner = render(
      <ChatSpeechPlayer
        projectId="project-1"
        path="owner.chat"
        threadId="thread-1"
      />,
    );
    const unrelated = render(
      <ChatSpeechPlayer
        projectId="project-2"
        path="other.chat"
        threadId="thread-2"
      />,
    );
    await act(async () => {
      await startChatSpeech({
        markdown: "Keep playing.",
        messageId: "message-owner",
        projectId: "project-1",
        path: "owner.chat",
        threadId: "thread-1",
      });
    });

    expect(
      screen.getAllByRole("region", { name: "Read aloud player" }),
    ).toHaveLength(1);
    unrelated.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Read aloud player" }),
    ).toBeTruthy();

    owner.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:speech");
  });

  it.each([0, 1])(
    "owns playback in duplicate pane %s",
    async (initiatingPane) => {
      localStorage.setItem("cocalc-chat-speech-output-disclosed", "yes");
      const context = {
        projectId: "same-project",
        path: "same.chat",
        threadId: "same-thread",
      };
      const panes = [0, 1].map(() =>
        render(
          <SpeechPaneContext.Provider value={Symbol("pane")}>
            <ChatReadAloudButton {...context} value="Read the same message." />
            <ChatSpeechPlayer {...context} />
          </SpeechPaneContext.Provider>,
        ),
      );
      await act(async () => {
        fireEvent.click(
          within(panes[initiatingPane].container).getByRole("button", {
            name: "Read this response aloud",
          }),
        );
      });
      expect(
        screen.getAllByRole("region", { name: "Read aloud player" }),
      ).toHaveLength(1);
      expect(
        within(panes[initiatingPane].container).getByRole("region", {
          name: "Read aloud player",
        }),
      ).toBeTruthy();
      panes[1 - initiatingPane].unmount();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(FakeAudio.latest?.paused).toBe(false);
      panes[initiatingPane].unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:speech");
      expect(FakeAudio.latest?.paused).toBe(true);
      localStorage.removeItem("cocalc-chat-speech-output-disclosed");
    },
  );
});
