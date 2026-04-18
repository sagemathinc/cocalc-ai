import { CoreStream } from "./core-stream";

function createStream() {
  return new CoreStream({
    name: "history-gap-test",
    client: {
      state: "ready",
      recoveryScheduler: {
        registerResource: jest.fn(() => ({
          requestRecovery: jest.fn(),
          close: jest.fn(),
        })),
      },
    } as any,
  });
}

describe("CoreStream history gap propagation", () => {
  it("emits history-gap when replay starts after the requested seq", async () => {
    const stream = createStream();
    const events: any[] = [];
    stream.on("history-gap", (info) => {
      events.push(info);
    });
    const persistClient = {
      changefeed: jest.fn().mockResolvedValue({}),
      getAllWithInfo: jest.fn().mockResolvedValue({
        messages: [],
        effective_start_seq: 14,
        oldest_retained_seq: 14,
        newest_retained_seq: 19,
      }),
    };
    (stream as any).persistClient = persistClient;

    await (stream as any).getAllFromPersist({
      start_seq: 10,
      noEmit: false,
      includeConfig: false,
    });

    expect(events).toEqual([
      {
        requested_start_seq: 10,
        effective_start_seq: 14,
        oldest_retained_seq: 14,
        newest_retained_seq: 19,
      },
    ]);
  });

  it("does not emit history-gap when the requested seq is still retained", async () => {
    const stream = createStream();
    const events: any[] = [];
    stream.on("history-gap", (info) => {
      events.push(info);
    });
    const persistClient = {
      changefeed: jest.fn().mockResolvedValue({}),
      getAllWithInfo: jest.fn().mockResolvedValue({
        messages: [],
        effective_start_seq: 10,
        oldest_retained_seq: 10,
        newest_retained_seq: 19,
      }),
    };
    (stream as any).persistClient = persistClient;

    await (stream as any).getAllFromPersist({
      start_seq: 10,
      noEmit: false,
      includeConfig: false,
    });

    expect(events).toEqual([]);
  });
});
