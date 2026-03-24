import { act, render, screen, waitFor } from "@testing-library/react";
import { getLatestEventLineText } from "@cocalc/chat";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useCodexLog } from "../use-codex-log";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: jest.fn(),
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

class FakeChangefeed {
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
    const next = { value: data, done: false } as IteratorResult<any>;
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

class FakeAstream {
  constructor(
    private readonly initial: Array<{
      mesg: any;
      seq: number;
      time: number;
    }> = [],
    private readonly feed = new FakeChangefeed(),
  ) {}

  async *getAll() {
    for (const item of this.initial) {
      yield item;
    }
  }

  changefeed = jest.fn(async () => this.feed);
  close = jest.fn();
  push(update: any) {
    this.feed.push(update);
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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
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

  it("loads live events from an ephemeral astream while generating", async () => {
    jest.useFakeTimers();
    const stream = new FakeAstream([
      {
        mesg: {
          type: "event",
          seq: 1,
          event: { type: "message", text: "Hel" },
        },
        seq: 1,
        time: 10,
      },
    ]);
    const get = jest.fn().mockResolvedValue(null);
    conatMock.mockReturnValue({
      subscribe: jest.fn(),
      sync: {
        akv: () => ({ get }),
        astream: () => stream,
      },
    });

    render(<TestComponent generating={true} liveLogStream="live-stream-1" />);

    await waitFor(() => {
      expect(stream.changefeed).toHaveBeenCalled();
    });

    stream.push([
      {
        op: "set",
        mesg: {
          type: "event",
          seq: 2,
          event: { type: "message", text: "lo" },
        },
        seq: 2,
        time: 20,
      },
    ]);

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(150);
    });

    await waitFor(() => {
      expect(screen.getByTestId("latest-event").textContent).toBe("Hello");
    });
    expect(get).not.toHaveBeenCalled();
  });
});
