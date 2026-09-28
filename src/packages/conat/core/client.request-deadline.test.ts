import { EventEmitter } from "events";

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

describe("request end-to-end deadline", () => {
  let client: any;
  let inbox: EventEmitter;
  let socket: any;
  const subject = "hub.account.test.api";
  const payload = {
    name: "hosts.resolveHostConnection",
    args: [{ host_id: "host-1" }],
  };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    socket = {
      sendBuffer: [],
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
      timeout: jest.fn(),
      emitWithAck: jest.fn(async () => ({ count: 1 })),
    };
    socket.volatile = socket;
    socket.timeout.mockReturnValue(socket);
    jest.doMock("socket.io-client", () => ({ connect: jest.fn(() => socket) }));
    const { Client } = require("./client");
    client = new Client({
      address: "http://example.invalid",
      autoConnect: false,
      noCache: true,
    });
    inbox = new EventEmitter();
    inbox.setMaxListeners(0);
    client.inboxSubject = "INBOX.deadline-test";
  });

  afterEach(() => {
    client.close();
    jest.useRealTimers();
  });

  function connect() {
    socket.connected = true;
    socket.io.engine = {
      readyState: "open",
      transport: { writable: true },
      _hasPingExpired: () => false,
      on: jest.fn(),
      off: jest.fn(),
    };
    client.state = "connected";
    client.info = { user: { account_id: "test" } };
    client.inbox = inbox;
    client.emit("inbox");
    client.emit("info");
  }

  function reply() {
    for (const event of inbox.eventNames()) {
      inbox.emit(event, { data: "ok" });
    }
  }

  it.each([false, true])(
    "expires 300 offline attempts without reconnect sends (inbox=%s)",
    async (ready) => {
      if (ready) client.inbox = inbox;
      for (let i = 0; i < 300; i++) {
        const result = client
          .request(subject, payload, { timeout: 5000 })
          .catch((err) => err);
        await jest.advanceTimersByTimeAsync(10_000);
        expect(await result).toMatchObject({ code: 408 });
        expect(inbox.eventNames()).toHaveLength(0);
      }
      connect();
      await jest.advanceTimersByTimeAsync(1);
      expect(socket.emitWithAck).not.toHaveBeenCalled();
      const fresh = client.request(subject, payload, { timeout: 5000 });
      await jest.advanceTimersByTimeAsync(1);
      reply();
      await expect(fresh).resolves.toMatchObject({ data: "ok" });
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
      expect(inbox.eventNames()).toHaveLength(0);
    },
  );

  it.each(["inbox", "connection", "response"])(
    "cancels a caller waiting for %s without poisoning shared readiness",
    async (phase) => {
      if (phase !== "inbox") client.inbox = inbox;
      if (phase === "response") connect();
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const result = client
        .request(subject, payload, { timeout: 5000, signal: controller.signal })
        .catch((err) => err);
      await jest.advanceTimersByTimeAsync(1);
      controller.abort(reason);
      expect(await result).toBe(reason);
      expect(inbox.eventNames()).toHaveLength(0);
      connect();
      await jest.advanceTimersByTimeAsync(1);
      expect(socket.emitWithAck).toHaveBeenCalledTimes(
        phase === "response" ? 1 : 0,
      );
      const fresh = client.request(subject, payload, { timeout: 5000 });
      await jest.advanceTimersByTimeAsync(1);
      reply();
      await expect(fresh).resolves.toMatchObject({ data: "ok" });
    },
  );

  it("spends one timeout budget across connection, publish acknowledgement and response", async () => {
    client.inbox = inbox;
    const result = client
      .request(subject, payload, { timeout: 5000 })
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(3000);
    connect();
    await jest.advanceTimersByTimeAsync(1);
    expect(socket.timeout).toHaveBeenCalledWith(2000);
    await jest.advanceTimersByTimeAsync(1999);
    expect(await result).toMatchObject({ code: 408 });
    expect(inbox.eventNames()).toHaveLength(0);
  });

  it("expires even if the publish acknowledgement never arrives", async () => {
    connect();
    socket.emitWithAck.mockImplementation(() => new Promise(() => undefined));
    const result = client
      .request(subject, payload, { timeout: 5000 })
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ code: 408 });
    expect(inbox.eventNames()).toHaveLength(0);
  });

  it("cleans the response listener after a publish failure", async () => {
    connect();
    socket.emitWithAck.mockRejectedValue(new Error("publish failed"));
    await expect(
      client.request(subject, payload, { timeout: 5000 }),
    ).rejects.toThrow("publish failed");
    expect(inbox.eventNames()).toHaveLength(0);
  });

  it("does not resend after the deadline while waiting for interest", async () => {
    connect();
    socket.emitWithAck.mockResolvedValue({ count: 0 });
    let interested!: () => void;
    client.waitForInterest = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          interested = resolve;
        }),
    );
    const result = client
      .request(subject, payload, { timeout: 5000, waitForInterest: true })
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ code: 408 });
    interested();
    await jest.advanceTimersByTimeAsync(1);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
    expect(inbox.eventNames()).toHaveLength(0);
  });

  it("rejects an already aborted signal without publishing", async () => {
    connect();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      client.request(subject, payload, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    expect(inbox.eventNames()).toHaveLength(0);
  });
});
