import { act, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "events";
import { getLatestEventLineText, getLiveResponseMarkdown } from "@cocalc/chat";

jest.mock("@cocalc/frontend/webapp-client", () => {
  const conatClientEvents = new EventEmitter();
  const reconnectResource = {
    requestReconnect: jest.fn(),
    close: jest.fn(),
  };
  return {
    webapp_client: {
      conat_client: {
        on: (...args: any[]) => (conatClientEvents.on as any)(...args),
        off: (...args: any[]) => (conatClientEvents.off as any)(...args),
        emit: (...args: any[]) => (conatClientEvents.emit as any)(...args),
        reconnectResource,
        registerReconnectResource: jest.fn(() => reconnectResource),
        conat: jest.fn(),
        projectConat: jest.fn(),
        dstream: jest.fn(),
      },
    },
  };
});

jest.mock("@cocalc/frontend/conat/project-dstream", () => ({
  acquireSharedProjectDStream: jest.fn(async (opts: any) => {
    const { webapp_client } = require("@cocalc/frontend/webapp-client");
    const stream = await webapp_client.conat_client.dstream(opts);
    return {
      stream,
      release: async () => {
        stream.close?.();
      },
    };
  }),
  resetSharedProjectDStreamCacheForTests: jest.fn(),
}));

const { webapp_client } = require("@cocalc/frontend/webapp-client");
const {
  resetSharedProjectDStreamCacheForTests,
} = require("@cocalc/frontend/conat/project-dstream");
const { useCodexLog, useCodexLiveActivityStatus } = require("../use-codex-log");

class FakeSubscription {
  private closed = false;
  private queue: IteratorResult<any>[] = [];
  private wake?: (value: IteratorResult<any>) => void;

  close = jest.fn(() => {
    this.closed = true;
    if (this.wake != null) {
      const wake = this.wake;
      this.wake = undefined;
      wake({ value: undefined, done: true });
    }
  });

  push(data: any) {
    const next = { value: { data }, done: false } as IteratorResult<any>;
    if (this.wake != null) {
      const wake = this.wake;
      this.wake = undefined;
      wake(next);
      return;
    }
    this.queue.push(next);
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next =
        this.queue.shift() ??
        (await new Promise<IteratorResult<any>>((resolve) => {
          this.wake = resolve;
        }));
      if (next.done) return;
      yield next.value;
    }
  }
}

class FakeDstream extends EventEmitter {
  constructor(
    private messages: any[] = [],
    private recoveryState: string = "ready",
    private transportSeqs: number[] = messages.map((message, index) =>
      typeof message?.seq === "number" ? message.seq : index + 1,
    ),
  ) {
    super();
  }

  close = jest.fn();
  getAll = jest.fn(() => [...this.messages]);
  get = jest.fn((index: number) => this.messages[index]);
  get length() {
    return this.messages.length;
  }
  seqs = jest.fn(() => [...this.transportSeqs]);
  getRecoveryState = jest.fn(() => this.recoveryState);
  recoverNow = jest.fn(async () => {
    this.setRecoveryState("ready");
  });

  push(message: any, transportSeq = message?.seq) {
    this.messages = [...this.messages, message];
    if (typeof transportSeq === "number") {
      this.transportSeqs = [...this.transportSeqs, transportSeq];
    }
    this.emit("change", message, transportSeq);
  }

  pushSilently(message: any, transportSeq = message?.seq) {
    this.messages = [...this.messages, message];
    if (typeof transportSeq === "number") {
      this.transportSeqs = [...this.transportSeqs, transportSeq];
    }
  }

  setRecoveryState(state: string) {
    this.recoveryState = state;
    this.emit(state === "ready" ? "recovered" : state);
  }
}

class RaceyFakeDstream extends FakeDstream {
  constructor(
    messages: any[] = [],
    private readonly messageOnAttach?: any,
  ) {
    super(messages);
  }

  override on(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    const result = super.on(event, listener);
    if (event === "change" && this.messageOnAttach != null) {
      const payload = this.messageOnAttach;
      (this as any).messageOnAttach = undefined;
      this.push(payload);
    }
    return result;
  }
}

function TestComponent({
  generating,
  logKey = "log-key",
  logSubject = "subject-1",
  liveLogStream,
}: {
  generating: boolean;
  logKey?: string;
  logSubject?: string;
  liveLogStream?: string;
}) {
  const { events } = useCodexLog({
    enabled: true,
    generating,
    projectId: "project-1",
    logStore: "acp-log",
    logKey,
    logSubject,
    liveLogStream,
  });
  return (
    <div data-testid="latest-event">
      {getLatestEventLineText((events ?? []) as any) ?? ""}
    </div>
  );
}

function LiveResponseComponent({
  generating,
  logKey = "log-key",
  logSubject = "subject-1",
  liveLogStream,
  liveStreamIsProjection = false,
}: {
  generating: boolean;
  logKey?: string;
  logSubject?: string;
  liveLogStream?: string;
  liveStreamIsProjection?: boolean;
}) {
  const { events } = useCodexLog({
    enabled: true,
    generating,
    projectId: "project-1",
    logStore: "acp-log",
    logKey,
    logSubject,
    liveLogStream,
    liveStreamIsProjection,
  });
  return (
    <div data-testid="live-response">
      {getLiveResponseMarkdown((events ?? []) as any) ?? ""}
    </div>
  );
}

function StatusComponent({
  generating,
  logKey = "log-key",
  logSubject = "subject-1",
  liveLogStream,
}: {
  generating: boolean;
  logKey?: string;
  logSubject?: string;
  liveLogStream?: string;
}) {
  const { liveStatus } = useCodexLog({
    enabled: true,
    generating,
    projectId: "project-1",
    logStore: "acp-log",
    logKey,
    logSubject,
    liveLogStream,
  });
  return <div data-testid="live-status">{liveStatus}</div>;
}

function ActivityStatusComponent({
  logSubject = "subject-1",
  liveLogStream,
}: {
  logSubject?: string;
  liveLogStream?: string;
}) {
  const { activeDescendantThreadIds, lastActivityAtMs, liveStatus } =
    useCodexLiveActivityStatus({
      enabled: true,
      projectId: "project-1",
      logSubject,
      liveLogStream,
    });
  return (
    <>
      <div data-testid="activity-last-time">{`${lastActivityAtMs ?? ""}`}</div>
      <div data-testid="activity-live-status">{liveStatus}</div>
      <div data-testid="activity-subagents">
        {activeDescendantThreadIds.join(",")}
      </div>
    </>
  );
}

describe("useCodexLog", () => {
  const reconnectRegisterMock = (webapp_client.conat_client as any)
    .registerReconnectResource as jest.Mock;
  const reconnectResource = (webapp_client.conat_client as any)
    .reconnectResource as {
    requestReconnect: jest.Mock;
    close: jest.Mock;
  };
  const conatMock = webapp_client.conat_client.conat as jest.Mock;
  const projectConatMock = webapp_client.conat_client.projectConat as jest.Mock;
  const dstreamMock = webapp_client.conat_client.dstream as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    resetSharedProjectDStreamCacheForTests();
    conatMock.mockReset();
    projectConatMock.mockReset();
    projectConatMock.mockImplementation(async () => conatMock());
    dstreamMock.mockReset();
    reconnectResource.requestReconnect.mockReset();
    reconnectResource.close.mockReset();
    reconnectRegisterMock.mockReset();
    reconnectRegisterMock.mockReturnValue(reconnectResource);
  });

  it("does not subscribe to live events when the turn is idle", async () => {
    const subscribe = jest.fn();
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });
    dstreamMock.mockResolvedValue(new FakeDstream());

    render(<TestComponent generating={false} />);

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith("log-key");
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("closes the live subscription when generating turns off", async () => {
    const subscription = new FakeSubscription();
    const subscribe = jest.fn().mockResolvedValue(subscription);
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });
    dstreamMock.mockResolvedValue(new FakeDstream());

    const { rerender } = render(<TestComponent generating={true} />);

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith("subject-1");
    });

    rerender(<TestComponent generating={false} />);

    await waitFor(() => {
      expect(subscription.close).toHaveBeenCalled();
    });
  });

  it("batches live stream updates before re-rendering", async () => {
    jest.useFakeTimers();
    const subscription = new FakeSubscription();
    const subscribe = jest.fn().mockResolvedValue(subscription);
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });
    dstreamMock.mockResolvedValue(new FakeDstream());

    render(
      <TestComponent
        generating={true}
        logKey="log-key-batch"
        logSubject="subject-batch"
      />,
    );

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith("subject-batch");
    });

    subscription.push({
      type: "event",
      seq: 1,
      event: { type: "message", text: "Hel" },
    });
    subscription.push({
      type: "event",
      seq: 2,
      event: { type: "message", text: "lo" },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("latest-event").textContent).toBe("");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });
  });

  it("accepts backend-published batches of log events", async () => {
    jest.useFakeTimers();
    const subscription = new FakeSubscription();
    const subscribe = jest.fn().mockResolvedValue(subscription);
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });

    render(<TestComponent generating={true} />);

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith("subject-1");
    });

    subscription.push([
      {
        type: "event",
        seq: 1,
        event: { type: "message", text: "Hel" },
      },
      {
        type: "event",
        seq: 2,
        event: { type: "message", text: "lo" },
      },
    ]);

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });
  });

  it("loads live events from an ephemeral dstream while generating", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 1,
        time: 10,
        event: { type: "message", text: "Hel" },
      },
      {
        type: "event",
        seq: 2,
        time: 20,
        event: { type: "message", text: "lo" },
      },
    ]);
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <TestComponent
        generating={true}
        logKey="log-key-live-astream"
        liveLogStream="live-stream-1"
      />,
    );

    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
          name: "live-stream-1",
          ephemeral: true,
          maxListeners: 50,
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });

    stream.push({
      type: "event",
      seq: 3,
      time: 30,
      event: { type: "message", text: "!" },
    });

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello!");
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts batched live events from the shared dstream", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream([
      [
        {
          type: "event",
          seq: 1,
          time: 10,
          event: { type: "message", text: "Hel" },
        },
        {
          type: "event",
          seq: 2,
          time: 20,
          event: { type: "message", text: "lo" },
        },
      ],
    ]);
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <TestComponent
        generating={true}
        logKey="log-key-live-batch"
        liveLogStream="live-stream-batch"
      />,
    );

    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });

    stream.push([
      {
        type: "event",
        seq: 3,
        time: 30,
        event: { type: "message", text: "!" },
      },
    ]);

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello!");
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("flushes a cumulative preview snapshot immediately", async () => {
    const stream = new FakeDstream();
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn() }),
      },
    });

    render(
      <LiveResponseComponent
        generating={true}
        logKey="log-key-projected-immediate"
        liveLogStream="preview-stream-immediate"
        liveStreamIsProjection
      />,
    );

    await waitFor(() => expect(dstreamMock).toHaveBeenCalled());
    act(() => {
      stream.push({
        type: "event",
        seq: 1,
        time: 10,
        event: {
          type: "message",
          text: "Visible without another token.",
          delta: false,
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("live-response").textContent).toBe(
      "Visible without another token.",
    );
  });

  it("preserves a buffered final preview delta when generation ends", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream();
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn(() => new Promise(() => {})) }),
      },
    });

    const props = {
      logKey: "log-key-projected-final-delta",
      liveLogStream: "preview-stream-final-delta",
      liveStreamIsProjection: true,
    } as const;
    const mounted = render(
      <LiveResponseComponent {...props} generating={true} />,
    );

    await waitFor(() => expect(stream.listenerCount("change")).toBe(1));
    act(() => {
      stream.push({
        type: "event",
        seq: 1,
        time: 10,
        event: {
          type: "message",
          text: "There is significant engineering around AI",
          delta: false,
        },
      });
    });
    expect(screen.getByTestId("live-response").textContent).toBe(
      "There is significant engineering around AI",
    );

    act(() => {
      stream.push({
        type: "event",
        seq: 2,
        time: 20,
        event: {
          type: "message",
          text: " agents.",
          delta: true,
        },
      });
    });
    expect(screen.getByTestId("live-response").textContent).toBe(
      "There is significant engineering around AI",
    );

    mounted.rerender(<LiveResponseComponent {...props} generating={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "There is significant engineering around AI agents.",
      );
    });
  });

  it("restores a running preview without inferring a consumed prefix from its highest sequence", async () => {
    const first = new FakeDstream(
      [
        {
          type: "event",
          seq: 10,
          time: 10,
          event: {
            type: "message",
            text: "Already visible output.",
            delta: false,
          },
        },
      ],
      "ready",
      [41],
    );
    const second = new FakeDstream(
      [
        {
          type: "event",
          seq: 11,
          time: 20,
          event: {
            type: "message",
            text: "Already visible output. Newly missed output.",
            delta: false,
          },
        },
      ],
      "ready",
      [42],
    );
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn() }),
      },
    });
    const props = {
      generating: true,
      logKey: "log-key-projected-resume",
      liveLogStream: "preview-stream-resume",
      liveStreamIsProjection: true,
    } as const;

    const mounted = render(<LiveResponseComponent {...props} />);
    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Already visible output.",
      );
    });
    mounted.unmount();

    render(<LiveResponseComponent {...props} />);
    expect(screen.getByTestId("live-response").textContent).toBe(
      "Already visible output.",
    );
    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalledTimes(2);
    });
    expect(dstreamMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        name: "preview-stream-resume",
      }),
    );
    expect(dstreamMock.mock.calls[1][0]).not.toHaveProperty("start_seq");
    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Already visible output. Newly missed output.",
      );
    });
  });

  it("does not cache a buffered receipt as applied before its text is flushed", async () => {
    const initial = { type: "status", seq: 1, time: 10, status: "running" };
    const pending = {
      type: "event",
      seq: 2,
      time: 20,
      event: { type: "message", text: "Buffered text", delta: true },
    };
    const first = new FakeDstream([initial], "ready", [1]);
    const second = new FakeDstream([pending], "ready", [2]);
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    let latest: any[] = [];
    function Probe() {
      const { events } = useCodexLog({
        enabled: true,
        generating: true,
        projectId: "project-1",
        logStore: "acp-log",
        logKey: "log-buffered-resume",
        liveLogStream: "stream-buffered-resume",
        liveStreamIsProjection: true,
      });
      latest = events ?? [];
      return null;
    }
    const view = render(<Probe />);
    await waitFor(() => expect(latest.map((event) => event.seq)).toEqual([1]));
    act(() => first.push(pending, 2));
    expect(latest.map((event) => event.seq)).toEqual([1]);
    view.unmount();
    render(<Probe />);
    await waitFor(() =>
      expect(latest.map((event) => event.seq)).toEqual([1, 2]),
    );
    expect(dstreamMock.mock.calls[1][0]).toHaveProperty("start_seq", 2);
  });

  it("restores a preview when its stream reference changes while offline", async () => {
    const first = new FakeDstream(
      [
        {
          type: "event",
          seq: 10,
          time: 10,
          event: {
            type: "message",
            text: "Cached before switching threads.",
            delta: false,
          },
        },
      ],
      "ready",
      [71],
    );
    dstreamMock
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise(() => {}));
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn() }),
      },
    });

    const mounted = render(
      <LiveResponseComponent
        generating
        logKey="log-key-stream-hydration"
        liveLogStream="derived-preview-stream"
        liveStreamIsProjection
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Cached before switching threads.",
      );
    });
    mounted.unmount();

    render(
      <LiveResponseComponent
        generating
        logKey="log-key-stream-hydration"
        liveLogStream="explicit-preview-stream"
        liveStreamIsProjection
      />,
    );

    // The reconnect is intentionally unresolved, as it would be while the
    // browser is offline. The stable per-turn cache must still render now.
    expect(screen.getByTestId("live-response").textContent).toBe(
      "Cached before switching threads.",
    );
    await waitFor(() => expect(dstreamMock).toHaveBeenCalledTimes(2));
    expect(dstreamMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        name: "explicit-preview-stream",
      }),
    );
    expect(dstreamMock.mock.calls[1][0]).not.toHaveProperty("start_seq");
  });

  it("does not let full activity logs evict a lightweight preview", async () => {
    const preview = new FakeDstream(
      [
        {
          type: "event",
          seq: 10,
          time: 10,
          event: {
            type: "message",
            text: "Cached projection.",
            delta: false,
          },
        },
      ],
      "ready",
      [50],
    );
    dstreamMock.mockResolvedValueOnce(preview);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn() }),
      },
    });
    const previewProps = {
      generating: true,
      logKey: "log-key-projection-cache-priority",
      liveLogStream: "preview-stream-cache-priority",
      liveStreamIsProjection: true,
    } as const;

    const mountedPreview = render(<LiveResponseComponent {...previewProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Cached projection.",
      );
    });
    mountedPreview.unmount();

    for (let index = 0; index < 5; index += 1) {
      dstreamMock.mockResolvedValueOnce(
        new FakeDstream([
          {
            type: "event",
            seq: index + 1,
            time: index + 1,
            event: { type: "message", text: `activity-${index}` },
          },
        ]),
      );
      const mountedActivity = render(
        <TestComponent
          generating={true}
          logKey={`log-key-activity-cache-${index}`}
          liveLogStream={`activity-stream-cache-${index}`}
        />,
      );
      await waitFor(() => {
        expect(screen.getByTestId("latest-event").textContent).toBe(
          `activity-${index}`,
        );
      });
      mountedActivity.unmount();
    }

    dstreamMock.mockResolvedValueOnce(new FakeDstream([], "disconnected"));
    render(<LiveResponseComponent {...previewProps} />);
    expect(screen.getByTestId("live-response").textContent).toBe(
      "Cached projection.",
    );
  });

  it("does not miss messages pushed after the shared dstream listener attaches", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 1,
        time: 10,
        event: { type: "message", text: "Hel" },
      },
    ]);
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <TestComponent
        generating={true}
        logKey="log-key-live-gap"
        liveLogStream="live-stream-gap"
      />,
    );

    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalled();
    });

    stream.push({
      type: "event",
      seq: 2,
      time: 20,
      event: { type: "message", text: "lo" },
    });

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("deduplicates a dstream event that races with getAll on first attach", async () => {
    jest.useFakeTimers();
    const payload = {
      type: "event",
      seq: 1,
      time: 10,
      event: {
        type: "message",
        text: "You want the real implementation",
      },
    };
    const stream = new RaceyFakeDstream([], payload);
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <LiveResponseComponent
        generating={true}
        logKey="log-key-live-race"
        liveLogStream="live-stream-race"
      />,
    );

    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalled();
    });

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "You want the real implementation",
      );
    });
  });

  it("closes the shared dstream on cleanup", async () => {
    const stream = new FakeDstream();
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    const { unmount } = render(
      <TestComponent
        generating={true}
        logKey="log-key-live-close"
        liveLogStream="live-stream-close"
      />,
    );

    await waitFor(() => {
      expect(dstreamMock).toHaveBeenCalled();
    });

    unmount();

    await waitFor(() => {
      expect(stream.close).toHaveBeenCalled();
    });
  });

  it("requests coordinated reconnect when the transport disconnects", async () => {
    const stream = new FakeDstream();
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <TestComponent
        generating={true}
        logKey="log-key-live-disconnect"
        liveLogStream="live-stream-disconnect"
      />,
    );

    await waitFor(() => {
      expect(reconnectRegisterMock).toHaveBeenCalledTimes(1);
      expect(dstreamMock).toHaveBeenCalled();
    });

    act(() => {
      (webapp_client.conat_client as any).emit("disconnected");
    });

    expect(reconnectResource.requestReconnect).toHaveBeenCalledWith({
      reason: "codex_log_disconnected",
    });
  });

  it("surfaces shared dstream live status and requests reconnect on disconnect", async () => {
    const stream = new FakeDstream();
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <StatusComponent
        generating={true}
        logKey="log-key-live-status"
        liveLogStream="live-stream-status"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("live-status").textContent).toBe("connected");
    });

    act(() => {
      stream.setRecoveryState("disconnected");
    });

    await waitFor(() => {
      expect(screen.getByTestId("live-status").textContent).toBe(
        "reconnecting",
      );
    });
    expect(reconnectResource.requestReconnect).toHaveBeenCalledWith({
      reason: "codex_log_stream_disconnected",
    });

    act(() => {
      stream.setRecoveryState("ready");
    });

    await waitFor(() => {
      expect(screen.getByTestId("live-status").textContent).toBe("connected");
    });
  });

  it("surfaces a shared dstream that is already recovering on attach", async () => {
    const stream = new FakeDstream([], "recovering");
    const get = jest.fn().mockResolvedValue(null);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <StatusComponent
        generating={true}
        logKey="log-key-live-status-recovering"
        liveLogStream="live-stream-status-recovering"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("live-status").textContent).toBe(
        "reconnecting",
      );
    });
    expect(reconnectResource.requestReconnect).toHaveBeenCalledWith({
      reason: "codex_log_stream_not_ready",
    });
  });

  it("forces recovery when a running dstream silently stops receiving events", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream();
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn().mockResolvedValue(null) }),
      },
    });

    render(
      <StatusComponent
        generating={true}
        logKey="log-key-stale-watchdog"
        liveLogStream="live-stream-stale-watchdog"
      />,
    );

    await waitFor(() => {
      expect(reconnectRegisterMock).toHaveBeenCalledTimes(1);
      expect(dstreamMock).toHaveBeenCalledTimes(1);
    });
    const options = reconnectRegisterMock.mock.calls[0][0];
    expect(options.probeOnForeground()).toBe(true);
    reconnectResource.requestReconnect.mockClear();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(reconnectResource.requestReconnect).toHaveBeenCalledWith({
      force: true,
      reason: "codex_log_stale_watchdog",
      resetBackoff: true,
    });
  });

  it("does not replay coalesced text or rebuild old payloads on repeated recovery", async () => {
    const stream = new FakeDstream(
      [
        {
          type: "event",
          seq: 10,
          time: 10,
          event: { type: "message", text: "Hel", delta: true },
        },
        {
          type: "event",
          seq: 11,
          time: 20,
          event: { type: "message", text: "lo", delta: true },
        },
      ],
      "ready",
      [41, 42],
    );
    dstreamMock.mockResolvedValue(stream);
    render(
      <LiveResponseComponent
        generating
        liveStreamIsProjection
        logKey="log-recovery-coalesced"
        liveLogStream="stream-recovery-coalesced"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("live-response").textContent).toBe("Hello"),
    );
    const reconnect = reconnectRegisterMock.mock.calls[0][0].reconnect;
    stream.get.mockClear();
    stream.getAll.mockClear();
    await act(async () => {
      await reconnect();
      await reconnect();
    });
    expect(screen.getByTestId("live-response").textContent).toBe("Hello");
    expect(stream.get).not.toHaveBeenCalled();
    expect(stream.getAll).not.toHaveBeenCalled();
  });

  it("recovers a missed batch before a newer live receipt without replaying that receipt", async () => {
    const batch = (seq: number) => ({
      type: "status",
      seq,
      time: seq,
      status: "running",
    });
    const stream = new FakeDstream([batch(1)], "ready", [101]);
    dstreamMock.mockResolvedValue(stream);
    let latest: any[] = [];
    function Probe() {
      const { events } = useCodexLog({
        enabled: true,
        generating: true,
        projectId: "project-1",
        logStore: "acp-log",
        logKey: "log-recovery-gap",
        liveLogStream: "stream-recovery-gap",
        liveStreamIsProjection: true,
      });
      latest = events ?? [];
      return null;
    }
    render(<Probe />);
    await waitFor(() => expect(latest.map((event) => event.seq)).toEqual([1]));
    stream.pushSilently(batch(2), 102);
    act(() => stream.push(batch(3), 103));
    await waitFor(() =>
      expect(latest.map((event) => event.seq)).toEqual([1, 3]),
    );
    stream.get.mockClear();
    await act(async () => reconnectRegisterMock.mock.calls[0][0].reconnect());
    expect(latest.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(stream.get.mock.calls).toEqual([[1]]);
  });

  it.each(["change", "snapshot", "cached resume"])(
    "preserves a snapshot gap through %s",
    async (delivery) => {
      const batch = (seq: number) => ({
        type: "status",
        seq,
        time: seq,
        status: "running",
      });
      const stream = new FakeDstream(
        [batch(40), batch(42)],
        "recovering",
        [40, 42],
      );
      dstreamMock.mockResolvedValue(stream);
      let latest: any[] = [];
      function Probe() {
        const { events } = useCodexLog({
          enabled: true,
          generating: true,
          projectId: "project-1",
          logStore: "acp-log",
          logKey: `log-partial-${delivery}`,
          liveLogStream: `stream-partial-${delivery}`,
          liveStreamIsProjection: true,
        });
        latest = events ?? [];
        return null;
      }
      const view = render(<Probe />);
      await waitFor(() =>
        expect(latest.map((event) => event.seq)).toEqual([40, 42]),
      );
      if (delivery === "change") {
        act(() => stream.push(batch(41), 41));
      } else if (delivery === "snapshot") {
        stream.pushSilently(batch(41), 41);
        await act(async () =>
          reconnectRegisterMock.mock.calls[0][0].reconnect(),
        );
      } else {
        view.unmount();
        const restored = new FakeDstream(
          [batch(40), batch(41), batch(42)],
          "ready",
          [40, 41, 42],
        );
        dstreamMock.mockResolvedValue(restored);
        render(<Probe />);
        await waitFor(() => expect(dstreamMock).toHaveBeenCalledTimes(2));
        expect(dstreamMock.mock.calls[1][0]).not.toHaveProperty("start_seq");
      }
      await waitFor(() =>
        expect(latest.map((event) => event.seq)).toEqual([40, 41, 42]),
      );
    },
  );

  it("reconciles hook state after forcing a ready-looking dstream recovery", async () => {
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 1,
        time: 10,
        event: { type: "message", text: "Hello", delta: false },
      },
    ]);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn().mockResolvedValue(null) }),
      },
    });

    render(
      <LiveResponseComponent
        generating={true}
        logKey="log-key-ready-looking"
        liveLogStream="live-stream-ready-looking"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe("Hello");
    });
    stream.pushSilently({
      type: "event",
      seq: 2,
      time: 20,
      event: { type: "message", text: "Hello again", delta: false },
    });
    const options = reconnectRegisterMock.mock.calls[0][0];

    await act(async () => {
      await options.reconnect();
    });

    expect(stream.recoverNow).toHaveBeenCalledWith({
      force: true,
      priority: "foreground",
      reason: "codex_log_reconnect",
    });
    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Hello again",
      );
    });
  });

  it("tracks live activity time without materializing the full log", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 1,
        time: 10,
        event: { type: "message", text: "Hello" },
      },
    ]);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn().mockResolvedValue(null) }),
      },
    });

    render(
      <ActivityStatusComponent liveLogStream="live-stream-activity-status" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-live-status").textContent).toBe(
        "connected",
      );
      expect(screen.getByTestId("activity-last-time").textContent).toBe("10");
    });

    act(() => {
      stream.push({
        type: "event",
        seq: 2,
        time: 20,
        event: { type: "message", text: " world" },
      });
    });

    expect(screen.getByTestId("activity-last-time").textContent).toBe("10");

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1050);
    });

    await waitFor(() => {
      expect(screen.getByTestId("activity-last-time").textContent).toBe("20");
    });
  });

  it("tracks active subagents from the lightweight preview stream", async () => {
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 1,
        event: {
          type: "subagent",
          operationId: "spawn-1",
          threadId: "child-1",
          state: "running",
        },
      },
    ]);
    dstreamMock.mockResolvedValue(stream);

    render(<ActivityStatusComponent liveLogStream="live-stream-subagents" />);

    await waitFor(() => {
      expect(screen.getByTestId("activity-subagents").textContent).toBe(
        "child-1",
      );
    });

    act(() => {
      stream.push({
        type: "event",
        seq: 2,
        event: {
          type: "subagent",
          operationId: "wait-1",
          threadId: "child-1",
          state: "completed",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("activity-subagents").textContent).toBe("");
    });
  });

  it("forces recovery when the full activity stream goes quiet", async () => {
    jest.useFakeTimers();
    const stream = new FakeDstream();
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get: jest.fn().mockResolvedValue(null) }),
      },
    });

    render(
      <ActivityStatusComponent liveLogStream="live-stream-activity-stale" />,
    );

    await waitFor(() => {
      expect(reconnectRegisterMock).toHaveBeenCalledTimes(1);
      expect(dstreamMock).toHaveBeenCalledTimes(1);
    });
    const options = reconnectRegisterMock.mock.calls[0][0];
    expect(options.probeOnForeground()).toBe(true);
    reconnectResource.requestReconnect.mockClear();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(reconnectResource.requestReconnect).toHaveBeenCalledWith({
      force: true,
      reason: "codex_activity_stale_watchdog",
      resetBackoff: true,
    });
  });

  it("reconnect resource refetches persisted log and resubscribes", async () => {
    const first = new FakeDstream();
    const second = new FakeDstream();
    first.recoverNow.mockRejectedValueOnce(new Error("stale stream"));
    const get = jest.fn().mockResolvedValue([
      {
        type: "event",
        seq: 1,
        time: 10,
        event: { type: "message", text: "Hello" },
      },
    ]);
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <TestComponent
        generating={true}
        logKey="log-key-live-reconnect"
        liveLogStream="live-stream-reconnect"
      />,
    );

    await waitFor(() => {
      expect(reconnectRegisterMock).toHaveBeenCalledTimes(1);
      expect(dstreamMock).toHaveBeenCalledTimes(1);
    });

    const options = reconnectRegisterMock.mock.calls[0][0];

    let reconnectPromise!: Promise<void>;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => {
        reconnectPromise = options.reconnect();
      });

      expect(get).toHaveBeenCalledWith("log-key-live-reconnect");
      await waitFor(() => {
        expect(dstreamMock).toHaveBeenCalledTimes(2);
      });
      await act(async () => {
        await reconnectPromise;
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not merge the full persisted log into a live preview projection", async () => {
    const stream = new FakeDstream([
      {
        type: "event",
        seq: 10,
        time: 10,
        event: {
          type: "message",
          text: "Projected manager activity.",
          delta: false,
        },
      },
    ]);
    const get = jest.fn().mockResolvedValue([
      {
        type: "event",
        seq: 1,
        time: 1,
        event: { type: "message", text: "Raw manager delta.", delta: true },
      },
      {
        type: "event",
        seq: 2,
        time: 2,
        event: { type: "terminal", phase: "start", terminalId: "term-1" },
      },
      { type: "status", state: "running", seq: 3, time: 3 },
    ]);
    dstreamMock.mockResolvedValue(stream);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
      },
    });

    render(
      <LiveResponseComponent
        generating={true}
        logKey="log-key-projected-reconnect"
        liveLogStream="preview-stream-reconnect"
        liveStreamIsProjection
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("live-response").textContent).toBe(
        "Projected manager activity.",
      );
    });
    const options = reconnectRegisterMock.mock.calls[0][0];
    await act(async () => {
      await options.reconnect();
    });

    expect(get).not.toHaveBeenCalled();
    expect(screen.getByTestId("live-response").textContent).toBe(
      "Projected manager activity.",
    );
  });
});
