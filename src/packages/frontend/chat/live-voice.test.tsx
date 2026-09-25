/** @jest-environment jsdom */
/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatLiveVoice, requestMicrophoneWithTimeout } from "./live-voice";

const mockLiveVoice = jest.fn();
const mockOpenAccountSettings = jest.fn();
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => mockOpenAccountSettings(...args),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: { liveVoice: (...args: any[]) => mockLiveVoice(...args) },
      },
    },
  },
}));
jest.mock("@cocalc/chat-client", () => ({
  LiveDelegation: class {
    close() {}
    observe() {}
    async event() {}
  },
  LIVE_VOICE_POLICY: jest.requireActual(
    "../../chat-client/src/live-voice-policy",
  ).LIVE_VOICE_POLICY,
}));

const props = {
  projectId: "project-1",
  threadId: "agent-thread-1",
  messages: [],
  onDelegate: jest.fn(),
  visible: true,
};

beforeEach(() => {
  mockLiveVoice.mockReset();
  mockOpenAccountSettings.mockReset();
});

it("explains live voice and dictation in an accessible dialog", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: true,
    max_seconds: 120,
    funding_source: "site",
  });
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  await screen.findByText(
    "Choose a live conversation or dictate a message to text.",
  );
  const trigger = screen.getByRole("button", { name: "How this works" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "How voice works" });
  expect(dialog).toHaveTextContent(/up to eight recent completed messages/i);
  expect(dialog).toHaveTextContent(/fresh authentication/i);
  expect(dialog).toHaveTextContent(/review and send yourself/i);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "How voice works" }),
    ).toBeNull(),
  );
  expect(trigger).toHaveFocus();
});

it("times out a stalled microphone prompt and stops a late stream", async () => {
  jest.useFakeTimers();
  try {
    let resolveStream!: (stream: MediaStream) => void;
    const request = jest.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const pending = requestMicrophoneWithTimeout(request, 25);
    const timedOut = expect(pending).rejects.toThrow(
      /Microphone access timed out/,
    );
    jest.advanceTimersByTime(25);
    await timedOut;
    const stop = jest.fn();
    resolveStream({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("shows site allowance without a dollar amount and starts from the keyboard", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: true,
    max_seconds: 120,
    funding_source: "site",
    own_key_available: true,
    allowance: [
      { window: "5h", remaining_percent: 67 },
      { window: "7d", remaining_percent: 42 },
    ],
  });
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  const button = await screen.findByRole("button", { name: "Live voice" });
  expect(
    screen.getByLabelText("5-hour limit: 67% remaining"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("7-day limit: 42% remaining"),
  ).toBeInTheDocument();
  expect(screen.getByText("Talk with your agent")).toBeInTheDocument();
  expect(screen.queryByText(/\$|per minute/i)).not.toBeInTheDocument();
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Start live call" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
});

it("opens and closes voice options and offers one-shot dictation", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: true,
    max_seconds: 120,
    funding_source: "site",
  });
  const onDictate = jest.fn();
  const onClose = jest.fn();
  const user = userEvent.setup();
  const view = render(
    <ChatLiveVoice
      {...props}
      panelOpen={false}
      onDictate={onDictate}
      onClose={onClose}
    />,
  );
  expect(screen.queryByText("Talk with your agent")).not.toBeInTheDocument();
  view.rerender(
    <ChatLiveVoice
      {...props}
      panelOpen
      onDictate={onDictate}
      onClose={onClose}
    />,
  );
  expect(await screen.findByText("Talk with your agent")).toBeInTheDocument();
  await user.click(
    await screen.findByRole("button", { name: "Dictate message" }),
  );
  expect(onDictate).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  view.rerender(
    <ChatLiveVoice
      {...props}
      panelOpen
      dictationBusy
      onDictate={onDictate}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("button", { name: "Live voice" })).toBeDisabled();
  view.rerender(
    <ChatLiveVoice
      {...props}
      panelOpen={false}
      onDictate={onDictate}
      onClose={onClose}
    />,
  );
  expect(screen.queryByText("Talk with your agent")).not.toBeInTheDocument();
});

it("ends an active call when the selected agent thread changes", async () => {
  const track = { enabled: false, stop: jest.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = {
    readyState: "open",
    close: jest.fn(),
    send: jest.fn(),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  const peer = {
    iceGatheringState: "complete",
    localDescription: { sdp: "v=0\r\n" },
    createDataChannel: () => channel,
    createOffer: async () => ({ sdp: "v=0\r\n" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addTrack: jest.fn(),
    close: jest.fn(),
  };
  const priorPeer = global.RTCPeerConnection;
  const priorDevices = navigator.mediaDevices;
  const priorPlay = HTMLMediaElement.prototype.play;
  const priorPause = HTMLMediaElement.prototype.pause;
  Object.defineProperty(global, "RTCPeerConnection", {
    configurable: true,
    value: jest.fn(() => peer),
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => stream) },
  });
  HTMLMediaElement.prototype.play = jest.fn(async () => {});
  HTMLMediaElement.prototype.pause = jest.fn();
  mockLiveVoice.mockImplementation(async ({ action }) =>
    action === "capabilities"
      ? { enabled: true, max_seconds: 120, funding_source: "site" }
      : action === "start"
        ? {
            enabled: true,
            session_id: "session-1",
            sdp: "answer",
            expires_at: Date.now() + 120_000,
          }
        : { enabled: false },
  );
  try {
    const user = userEvent.setup();
    const view = render(<ChatLiveVoice {...props} />);
    await screen.findByText(
      "Choose a live conversation or dictate a message to text.",
    );
    await user.click(screen.getByRole("button", { name: "Live voice" }));
    await user.click(screen.getByRole("button", { name: "Start live call" }));
    await waitFor(() =>
      expect(mockLiveVoice).toHaveBeenCalledWith(
        expect.objectContaining({ action: "start" }),
      ),
    );
    channel.onmessage?.({ data: JSON.stringify({ type: "session.started" }) });
    await screen.findByText("Voice is live");
    view.rerender(<ChatLiveVoice {...props} threadId="agent-thread-2" />);
    await waitFor(() =>
      expect(mockLiveVoice).toHaveBeenCalledWith(
        expect.objectContaining({ action: "end", session_id: "session-1" }),
      ),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
  } finally {
    Object.defineProperty(global, "RTCPeerConnection", {
      configurable: true,
      value: priorPeer,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: priorDevices,
    });
    HTMLMediaElement.prototype.play = priorPlay;
    HTMLMediaElement.prototype.pause = priorPause;
  }
});

it("offers free users membership or their own key from a dialog", async () => {
  mockLiveVoice.mockImplementation(async ({ funding_preference }) =>
    funding_preference === "own"
      ? { enabled: true, max_seconds: 120, funding_source: "account" }
      : {
          enabled: false,
          max_seconds: 120,
          own_key_available: true,
          reason: "Included live voice requires a paid membership.",
        },
  );
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  expect(
    await screen.findByText(/requires a paid membership/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Live voice" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "View membership plans" }),
  );
  expect(mockOpenAccountSettings).toHaveBeenCalledWith({ page: "membership" });
  await user.click(screen.getByRole("button", { name: "Live voice" }));
  await user.click(screen.getByRole("button", { name: "Use my OpenAI key" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Live voice" }),
    ).toBeInTheDocument(),
  );
  expect(mockLiveVoice).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "capabilities",
      funding_preference: "own",
      project_id: "project-1",
    }),
  );
});

it("sends free users without a key to AI settings", async () => {
  mockLiveVoice.mockResolvedValue({
    enabled: false,
    max_seconds: 120,
    own_key_available: false,
    reason: "Live voice requires a paid membership or your own OpenAI API key.",
  });
  const user = userEvent.setup();
  render(<ChatLiveVoice {...props} />);
  await user.click(await screen.findByRole("button", { name: "Live voice" }));
  await user.click(screen.getByRole("button", { name: "Add an OpenAI key" }));
  expect(mockOpenAccountSettings).toHaveBeenCalledWith({ page: "ai" });
});
