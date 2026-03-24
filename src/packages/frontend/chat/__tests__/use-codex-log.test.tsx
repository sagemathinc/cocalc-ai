import { act, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "events";
import { getLatestEventLineText } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useCodexLog } from "../use-codex-log";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: jest.fn(),
      dstream: jest.fn(),
    },
  },
}));

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
  constructor(private messages: any[] = []) {
    super();
  }

  close = jest.fn();
  getAll = jest.fn(() => [...this.messages]);

  push(message: any) {
    this.messages = [...this.messages, message];
    this.emit("change", message, message?.seq);
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

describe("useCodexLog", () => {
  const conatMock = webapp_client.conat_client.conat as jest.Mock;
  const dstreamMock = webapp_client.conat_client.dstream as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    dstreamMock.mockReset();
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
      expect(dstreamMock).toHaveBeenCalledWith({
        project_id: "project-1",
        name: "live-stream-1",
        ephemeral: true,
      });
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
});
