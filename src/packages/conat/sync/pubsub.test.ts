import { PubSub } from "./pubsub";

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({ warn: jest.fn() }),
}));

describe("PubSub explicit client routing", () => {
  it("requires an explicit client", () => {
    expect(
      () => new PubSub({ project_id: "project-1", name: "cursor" } as any),
    ).toThrow("pubsub must provide an explicit Conat client");
  });
});

describe("PubSub subscription lifecycle", () => {
  const project_id = "00000000-0000-4000-8000-000000000001";
  function channel(subscribe: jest.Mock) {
    return new PubSub({
      project_id,
      name: "document-presence",
      client: { subscribe } as any,
    });
  }

  it("exposes subscription failures and closes instead of becoming ready", async () => {
    const error = new Error("permission denied subscribing");
    const pubsub = channel(jest.fn().mockRejectedValue(error));
    const closed = jest.fn();
    const connected = jest.fn();
    pubsub.on("closed", closed);
    pubsub.on("connected", connected);
    await expect(pubsub.ready).rejects.toBe(error);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it("contains rejection for legacy callers that do not await ready", async () => {
    const pubsub = channel(jest.fn().mockRejectedValue(new Error("denied")));
    const closed = jest.fn();
    pubsub.on("closed", closed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("closes a subscription that arrives after the channel was closed", async () => {
    let resolve!: (sub: any) => void;
    const pubsub = channel(
      jest.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const connected = jest.fn();
    pubsub.on("connected", connected);
    pubsub.close();
    const sub = { close: jest.fn() };
    resolve(sub);
    await expect(pubsub.ready).rejects.toThrow("closed during subscription");
    expect(sub.close).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it("delivers messages and closes on stream failure without an unhandled rejection", async () => {
    const sub = {
      close: jest.fn(),
      async *[Symbol.asyncIterator]() {
        yield { data: { mode: "edit" } };
        throw new Error("stream failed");
      },
    };
    const pubsub = channel(jest.fn().mockResolvedValue(sub));
    const change = jest.fn();
    const closed = jest.fn();
    pubsub.on("change", change);
    pubsub.on("closed", closed);
    await pubsub.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(change).toHaveBeenCalledWith({ mode: "edit" });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sub.close).toHaveBeenCalledTimes(1);
  });
});
