/** @jest-environment jsdom */
/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { act, render, screen, waitFor } from "@testing-library/react";
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
  threadRunning: false,
  messages: [],
  onDelegate: jest.fn(),
  onInterrupt: jest.fn(),
  onInterruptTarget: jest.fn(() => ({
    message_id: "turn-a",
    message_date: "2026-09-25T00:00:00.000Z",
    session_id: "session-a",
  })),
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
  expect(dialog).toHaveTextContent(/interrupt the turn/i);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("call-scoped cancellation", () => {
  let peers: any[];
  let streams: any[];
  let priorPeer: typeof RTCPeerConnection;
  let priorDevices: MediaDevices;
  let intervals: jest.SpyInstance;

  beforeEach(() => {
    peers = [];
    streams = [];
    priorPeer = global.RTCPeerConnection;
    priorDevices = navigator.mediaDevices;
    intervals = jest.spyOn(global, "setInterval");
    jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    jest
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    Object.defineProperty(global, "RTCPeerConnection", {
      configurable: true,
      value: jest.fn(() => {
        const channel = {
          readyState: "open",
          send: jest.fn(),
          close: jest.fn(),
          onmessage: undefined,
        };
        const peer = {
          channel,
          iceGatheringState: "complete",
          localDescription: { sdp: "offer" },
          createDataChannel: () => channel,
          createOffer: async () => ({ sdp: "offer" }),
          setLocalDescription: jest.fn(async () => {}),
          setRemoteDescription: jest.fn(async () => {}),
          addTrack: jest.fn(),
          close: jest.fn(),
        };
        peers.push(peer);
        return peer;
      }),
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: jest.fn(async () => {
          const track = { enabled: false, stop: jest.fn() };
          const stream = {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          };
          streams.push(stream);
          return stream;
        }),
      },
    });
    let session = 0;
    mockLiveVoice.mockImplementation(async ({ action }) =>
      action === "start"
        ? {
            enabled: true,
            session_id: `session-${++session}`,
            sdp: "answer",
            expires_at: Date.now() + 120_000,
          }
        : { enabled: true, max_seconds: 120, funding_source: "site" },
    );
  });

  afterEach(() => {
    Object.defineProperty(global, "RTCPeerConnection", {
      configurable: true,
      value: priorPeer,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: priorDevices,
    });
    jest.restoreAllMocks();
  });

  async function startCall(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Live voice" }));
    await user.click(screen.getByRole("button", { name: "Start live call" }));
    const peer = peers.at(-1);
    await waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalled());
    act(() =>
      peer.channel.onmessage({
        data: JSON.stringify({ type: "session.started" }),
      }),
    );
    await screen.findByText("Voice is live");
    return peer;
  }

  it("routes an explicit spoken stop to the bound interrupt action", async () => {
    const onDelegate = jest.fn();
    const onInterrupt = jest.fn(async () => true);
    const user = userEvent.setup();
    const view = render(
      <ChatLiveVoice
        {...props}
        onDelegate={onDelegate}
        onInterrupt={onInterrupt}
      />,
    );
    const peer = await startCall(user);
    act(() => {
      peer.channel.onmessage({
        data: JSON.stringify({
          type: "session.input_transcript.delta",
          delta: "Please interrupt the turn.",
          end_ms: 1,
        }),
      });
      peer.channel.onmessage({
        data: JSON.stringify({
          type: "session.delegation.created",
          offset_ms: 2,
          delegation: { id: "stop-1", target: "client" },
        }),
      });
    });
    await waitFor(() => expect(onInterrupt).toHaveBeenCalledTimes(1));
    expect(onInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: "turn-a" }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(onDelegate).not.toHaveBeenCalled();
    expect(peer.channel.send).toHaveBeenCalledWith(
      expect.stringContaining("Interrupt request accepted"),
    );
    view.unmount();
  });

  it("waits for delegation acceptance and replays a result received while waiting", async () => {
    const acceptance = deferred<{ message_id: string }>();
    const onDelegate = jest.fn(() => acceptance.promise);
    const user = userEvent.setup();
    const view = render(<ChatLiveVoice {...props} onDelegate={onDelegate} />);
    const peer = await startCall(user);
    const announce = screen.getByRole("button", {
      name: "Announce milestones",
    });
    announce.focus();
    expect(announce).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: "On-demand updates" }),
    ).toBeInTheDocument();
    act(() => {
      peer.channel.onmessage({
        data: JSON.stringify({
          type: "session.input_transcript.delta",
          delta: "Run a task",
          end_ms: 1,
        }),
      });
      peer.channel.onmessage({
        data: JSON.stringify({
          type: "session.delegation.created",
          offset_ms: 1,
          delegation: { id: "d1", target: "client" },
        }),
      });
    });
    await waitFor(() => expect(onDelegate).toHaveBeenCalledTimes(1));
    expect(
      peer.channel.send.mock.calls.some(
        ([payload]: [string]) => JSON.parse(payload).delegation_id === "d1",
      ),
    ).toBe(false);
    view.rerender(
      <ChatLiveVoice
        {...props}
        onDelegate={onDelegate}
        messages={[
          {
            message_id: "response-1",
            parent_message_id: "request-1",
            thread_id: props.threadId,
            sender_id: "agent-1",
            role: "agent",
            generating: false,
            state: "complete",
            content: "Finished result",
            date: "2026-09-25T00:00:00.000Z",
          },
        ]}
      />,
    );
    await act(async () => acceptance.resolve({ message_id: "request-1" }));
    await waitFor(() =>
      expect(peer.channel.send).toHaveBeenCalledWith(
        expect.stringContaining("Finished result"),
      ),
    );
    view.unmount();
  });

  it.each(["hang-up", "thread switch", "unmount"])(
    "invalidates pending dispatch on %s",
    async (reason) => {
      const prepare = deferred<void>();
      const dispatch = jest.fn();
      let signal!: AbortSignal;
      const onDelegate = jest.fn(async (_text, isCurrentCall, callSignal) => {
        signal = callSignal;
        await prepare.promise;
        if (!isCurrentCall()) throw Error("Call cancelled");
        dispatch();
        return { message_id: "request-1" };
      });
      const user = userEvent.setup();
      const view = render(<ChatLiveVoice {...props} onDelegate={onDelegate} />);
      const peer = await startCall(user);
      act(() => {
        peer.channel.onmessage({
          data: JSON.stringify({
            type: "session.input_transcript.delta",
            delta: "Run a task",
            end_ms: 1,
          }),
        });
        peer.channel.onmessage({
          data: JSON.stringify({
            type: "session.delegation.created",
            offset_ms: 1,
            delegation: { id: "d1", target: "client" },
          }),
        });
      });
      await waitFor(() => expect(onDelegate).toHaveBeenCalledTimes(1));
      if (reason === "hang-up")
        await user.click(screen.getByRole("button", { name: "End live call" }));
      else if (reason === "unmount") view.unmount();
      else {
        view.rerender(
          <ChatLiveVoice
            {...props}
            threadId="other-thread"
            onDelegate={onDelegate}
          />,
        );
        view.rerender(<ChatLiveVoice {...props} onDelegate={onDelegate} />);
      }
      expect(signal.aborted).toBe(true);
      await act(async () => prepare.resolve());
      expect(dispatch).not.toHaveBeenCalled();
      expect(streams[0].getTracks()[0].stop).toHaveBeenCalled();
      view.unmount();
    },
  );

  it.each(["reject", "resolve"])(
    "does not stop a replacement call when old startup settles: %s",
    async (settlement) => {
      const startup = deferred<any>();
      const defaultRpc = mockLiveVoice.getMockImplementation()!;
      let first = true;
      mockLiveVoice.mockImplementation((request) => {
        if (request.action === "start" && first) {
          first = false;
          return startup.promise;
        }
        return defaultRpc(request);
      });
      const user = userEvent.setup();
      const view = render(<ChatLiveVoice {...props} />);
      await user.click(
        await screen.findByRole("button", { name: "Live voice" }),
      );
      await user.click(screen.getByRole("button", { name: "Start live call" }));
      await waitFor(() => expect(first).toBe(false));
      await user.click(screen.getByRole("button", { name: "End live call" }));
      const replacement = await startCall(user);
      await act(async () => {
        if (settlement === "reject")
          startup.reject(Error("Old startup failed"));
        else
          startup.resolve({
            session_id: "old-session",
            sdp: "old-answer",
            expires_at: Date.now() + 120_000,
          });
      });
      expect(screen.getByText("Voice is live")).toBeInTheDocument();
      expect(replacement.close).not.toHaveBeenCalled();
      expect(streams[1].getTracks()[0].stop).not.toHaveBeenCalled();
      if (settlement === "resolve")
        expect(mockLiveVoice).toHaveBeenCalledWith(
          expect.objectContaining({ action: "end", session_id: "old-session" }),
        );
      view.unmount();
    },
  );

  it("ignores old heartbeat failures, audio events and playback rejections", async () => {
    const heartbeat = deferred<any>();
    const playback = deferred<void>();
    const defaultRpc = mockLiveVoice.getMockImplementation()!;
    mockLiveVoice.mockImplementation((request) =>
      request.action === "heartbeat" ? heartbeat.promise : defaultRpc(request),
    );
    const user = userEvent.setup();
    const view = render(<ChatLiveVoice {...props} />);
    const old = await startCall(user);
    const tick = intervals.mock.calls.find(([, delay]) => delay === 8_000)![0];
    act(() => tick());
    jest
      .mocked(HTMLMediaElement.prototype.play)
      .mockReturnValueOnce(playback.promise);
    act(() => old.ontrack({ streams: [streams[0]] }));
    await user.click(screen.getByRole("button", { name: "End live call" }));
    const replacement = await startCall(user);
    const plays = jest.mocked(HTMLMediaElement.prototype.play).mock.calls
      .length;
    await act(async () => {
      heartbeat.reject(Error("Old heartbeat failed"));
      playback.reject(Error("Old playback failed"));
      old.ontrack({ streams: [streams[0]] });
    });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays);
    expect(screen.getByText("Voice is live")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable call audio" }),
    ).toBeNull();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(streams[1].getTracks()[0].stop).not.toHaveBeenCalled();
    view.unmount();
  });
});
