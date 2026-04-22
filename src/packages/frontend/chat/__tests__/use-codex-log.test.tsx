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
const { useCodexLog } = require("../use-codex-log");

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
  ) {
    super();
  }

  close = jest.fn();
  getAll = jest.fn(() => [...this.messages]);
  getRecoveryState = jest.fn(() => this.recoveryState);

  push(message: any) {
    this.messages = [...this.messages, message];
    this.emit("change", message, message?.seq);
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
      await jest.advanceTimersByTimeAsync(150);
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
      await jest.advanceTimersByTimeAsync(150);
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
      await jest.advanceTimersByTimeAsync(150);
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
      await jest.advanceTimersByTimeAsync(150);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello!");
    });
    expect(get).not.toHaveBeenCalled();
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
      await jest.advanceTimersByTimeAsync(150);
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
      await jest.advanceTimersByTimeAsync(150);
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

  it("reconnect resource refetches persisted log and resubscribes", async () => {
    const first = new FakeDstream();
    const second = new FakeDstream();
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

    let reconnectPromise: Promise<void>;
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
  });
});
