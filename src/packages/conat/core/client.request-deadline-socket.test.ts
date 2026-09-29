import { EventEmitter } from "events";
import { createRequire } from "module";
import { Client } from "./client";
import * as codec from "./codec";

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

// Real Socket.IO Socket/Manager and Engine.IO buffering/encoding, with only
// transport I/O controlled. No external server or timing-dependent network.
const engineRequire = createRequire(require.resolve("socket.io-client"));
const { SocketWithoutUpgrade } = engineRequire("engine.io-client");
class ControlledEngine extends SocketWithoutUpgrade {
  _open() {}
}

describe("request admission with real Socket.IO", () => {
  let client: any;
  let socket: any;
  let engine: any;
  let transport: any;
  let inbox: EventEmitter;
  let packets: jest.SpyInstance;
  let wire: any[];
  const subject = "test.deadline";

  beforeEach(() => {
    jest.useFakeTimers();
    client = new Client({
      address: "http://localhost",
      autoConnect: false,
      noCache: true,
      retries: 2,
    });
    socket = client.conn;
    engine = new ControlledEngine({ transports: [] });
    engine.readyState = "open";
    engine._pingTimeoutTime = Infinity;
    wire = [];
    transport = Object.assign(new EventEmitter(), {
      name: "websocket",
      writable: true,
      send: jest.fn((batch) => {
        wire.push(...batch);
        transport.writable = false;
      }),
      close: jest.fn(),
    });
    engine.setTransport(transport);
    socket.io.engine = engine;
    socket.connected = true;
    client.state = "connected";
    client.info = { user: { account_id: "test" } };
    inbox = new EventEmitter();
    client.inbox = inbox;
    client.inboxSubject = "INBOX.real-socket";
    packets = jest.spyOn(socket, "packet");
  });

  afterEach(() => {
    client.close();
    engine._onClose("forced close");
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function request(options = {}) {
    return client.request(
      subject,
      { value: "test" },
      { timeout: 1000, ...options },
    );
  }

  function drain() {
    transport.writable = true;
    transport.emit("drain");
  }

  function ack(packet, response = { count: 1 }) {
    socket.onack({ id: packet.id, data: [response] });
  }

  function reply(packet) {
    inbox.emit(packet.data[1][6]["CN-Reply"], { data: "ok" });
  }

  function expectNoQueuedSend() {
    expect(socket.sendBuffer).toHaveLength(0);
    expect(socket._queue).toHaveLength(0);
    expect(Object.keys(socket.acks)).toHaveLength(0);
    expect(packets).not.toHaveBeenCalled();
    expect(engine.writeBuffer).toHaveLength(0);
    expect(inbox.eventNames()).toHaveLength(0);
  }

  it.each(["disconnected", "unwritable", "expired heartbeat"])(
    "expires before handoff with %s transport, without reconnect sends",
    async (state) => {
      if (state === "disconnected") socket.connected = false;
      if (state === "unwritable") transport.writable = false;
      if (state === "expired heartbeat")
        engine._pingTimeoutTime = Date.now() - 1;
      const result = request().catch((err) => err);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ code: 408 });
      expectNoQueuedSend();
      engine.readyState = "open";
      engine._pingTimeoutTime = Infinity;
      socket.connected = true;
      drain();
      socket.emitBuffered();
      await jest.advanceTimersByTimeAsync(1000);
      expectNoQueuedSend();
    },
  );

  it("cancels an admission waiter and removes its listeners and timer", async () => {
    transport.writable = false;
    const initialTimers = jest.getTimerCount();
    const controller = new AbortController();
    const result = request({ signal: controller.signal }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(engine.listeners("drain")).toHaveLength(1);
    const reason = new Error("cancelled before handoff");
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(engine.listeners("drain")).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(initialTimers);
    drain();
    await jest.advanceTimersByTimeAsync(1000);
    expectNoQueuedSend();
  });

  it.each(["sign-in", "transport"])(
    "inbox invalidation aborts a request waiting for %s before handoff",
    async (phase) => {
      if (phase === "sign-in") client.state = "disconnected";
      transport.writable = false;
      const result = request().catch((err) => err);
      await jest.advanceTimersByTimeAsync(0);
      expect(client.inboxRequests.size).toBe(1);

      client.invalidateInboxRequests(inbox);
      await jest.advanceTimersByTimeAsync(0);
      // Assert prompt rejection without waiting for the request's deadline.
      expect(
        await Promise.race([result, Promise.resolve("still pending")]),
      ).toMatchObject({ code: "CONNECTION_LOST", subject });
      expect(client.inboxRequests.size).toBe(0);
      expect(engine.listeners("drain")).toHaveLength(0);
      expectNoQueuedSend();

      client.state = "connected";
      client.emit("info");
      drain();
      socket.emitBuffered();
      await jest.advanceTimersByTimeAsync(1000);
      expectNoQueuedSend();

      // Cancelling an old request must not poison the new reply namespace.
      inbox = new EventEmitter();
      client.inbox = inbox;
      client.inboxSubject = "INBOX.replaced";
      const fresh = request();
      await jest.advanceTimersByTimeAsync(0);
      expect(packets).toHaveBeenCalledTimes(1);
      const packet = packets.mock.calls[0][0];
      ack(packet);
      reply(packet);
      await expect(fresh).resolves.toEqual({ data: "ok" });
      expect(client.inboxRequests.size).toBe(0);
    },
  );

  it("inbox invalidation aborts pending chunks and ACK waits without retracting handed-off frames", async () => {
    client.info.max_payload = 1000;
    const result = client
      .request(subject, Buffer.alloc(2500), { timeout: 1000 })
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(packets).toHaveBeenCalledTimes(1);
    expect(wire).toHaveLength(1);
    expect(engine.writeBuffer).toHaveLength(2);

    client.invalidateInboxRequests(inbox);
    await jest.advanceTimersByTimeAsync(0);
    expect(
      await Promise.race([result, Promise.resolve("still pending")]),
    ).toMatchObject({ code: "CONNECTION_LOST", subject });
    expect(client.inboxRequests.size).toBe(0);
    expect(inbox.eventNames()).toHaveLength(0);
    expect(engine.listeners("drain")).toHaveLength(0);
    expect(engine.writeBuffer).toHaveLength(2);

    for (let i = 0; i < 6; i++) {
      drain();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(wire).toHaveLength(2);
    expect(packets).toHaveBeenCalledTimes(1);
    ack(packets.mock.calls[0][0]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(packets).toHaveBeenCalledTimes(1);
    expect(Object.keys(socket.acks)).toHaveLength(0);
    expect(socket.sendBuffer).toHaveLength(0);
    expect(socket._queue).toHaveLength(0);
  });

  it.each(["before", "after"])(
    "does not abort successful responses arriving %s the publish ACK",
    async (order) => {
      const pending = request();
      await jest.advanceTimersByTimeAsync(0);
      const packet = packets.mock.calls[0][0];
      if (order === "before") {
        reply(packet);
        await jest.advanceTimersByTimeAsync(0);
        expect(client.inboxRequests.size).toBe(1);
        ack(packet);
      } else {
        ack(packet);
        await jest.advanceTimersByTimeAsync(0);
        reply(packet);
      }
      await expect(pending).resolves.toEqual({ data: "ok" });
      expect(client.inboxRequests.size).toBe(0);
      client.invalidateInboxRequests(inbox);
      await jest.advanceTimersByTimeAsync(1000);
      expect(inbox.eventNames()).toHaveLength(0);
      expect(packets).toHaveBeenCalledTimes(1);
    },
  );

  it("retracts only its unsent Socket.IO packet if heartbeat expires inside emit", async () => {
    const oldPacket = { data: ["unrelated", "buffered earlier"] };
    socket.sendBuffer.push(oldPacket);
    jest
      .spyOn(engine, "_hasPingExpired")
      .mockReturnValueOnce(false) // Admission check.
      .mockReturnValue(true); // Socket.IO's own check and subsequent admission.
    const result = request().catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(socket.sendBuffer).toEqual([oldPacket]);
    expect(Object.keys(socket.acks)).toHaveLength(0);
    expect(engine.writeBuffer).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: 408 });
    expect(socket.sendBuffer).toEqual([oldPacket]);
    expect(packets).not.toHaveBeenCalled();
    expect(engine.listeners("drain")).toHaveLength(0);
  });

  it("rechecks the clock after slow encoding without waiting for the abort timer", async () => {
    const encode = codec.encode;
    jest.spyOn(codec, "encode").mockImplementation((options) => {
      const raw = encode(options);
      jest.setSystemTime(Date.now() + 2000);
      return raw;
    });
    await expect(request()).rejects.toMatchObject({ code: 408 });
    expectNoQueuedSend();
  });

  it("admits concurrent requests on drain without dropping them or serializing ACKs", async () => {
    transport.writable = false;
    const pending = [request(), request(), request()];
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      drain();
      await jest.advanceTimersByTimeAsync(0);
    }
    const emitted = packets.mock.calls.map(([packet]) => packet);
    expect(emitted).toHaveLength(3);
    expect(socket.sendBuffer).toHaveLength(0);
    expect(socket._queue).toHaveLength(0);
    for (const packet of emitted) {
      ack(packet);
      reply(packet);
    }
    await expect(Promise.all(pending)).resolves.toEqual([
      { data: "ok" },
      { data: "ok" },
      { data: "ok" },
    ]);
    expect(inbox.eventNames()).toHaveLength(0);
    expect(engine.listeners("drain")).toHaveLength(0);
  });

  it("leaves already handed-off binary frames intact on timeout, with unknown outcome", async () => {
    const result = request().catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(packets).toHaveBeenCalledTimes(1);
    expect(wire).toHaveLength(1); // Socket.IO binary header has been sent.
    expect(engine.writeBuffer).toHaveLength(2); // Header plus binary attachment.
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: 408 });
    expect(Object.keys(socket.acks)).toHaveLength(0);
    expect(socket._queue).toHaveLength(0);
    expect(inbox.eventNames()).toHaveLength(0);
    expect(engine.writeBuffer).toHaveLength(2);
    drain();
    expect(wire).toHaveLength(2); // The remaining attachment is not deleted.
    expect(packets).toHaveBeenCalledTimes(1); // No automatic mutation retry.
  });

  it("preserves chunk order without waiting for individual ACKs", async () => {
    client.info.max_payload = 1000;
    const result = client.request(subject, Buffer.alloc(2500), {
      timeout: 1000,
    });
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      drain();
      await jest.advanceTimersByTimeAsync(0);
    }
    const emitted = packets.mock.calls.map(([packet]) => packet);
    expect(emitted.map((packet) => packet.data[1][2])).toEqual([0, 1, 2]);
    expect(emitted.map((packet) => packet.data[1][3])).toEqual([0, 0, 1]);
    for (const packet of emitted) ack(packet);
    reply(emitted[2]);
    await expect(result).resolves.toEqual({ data: "ok" });
  });

  it("does not change buffering for ordinary non-deadline publishes", () => {
    socket._opts.retries = undefined;
    socket.connected = false;
    client.publishSync(subject, { ordinary: true });
    expect(socket.sendBuffer).toHaveLength(1);
    expect(packets).not.toHaveBeenCalled();
  });

  it("admits requests after no-auth servers send info without a user", async () => {
    client.info = { max_payload: 100000 };
    const result = request();
    await jest.advanceTimersByTimeAsync(0);
    expect(packets).toHaveBeenCalledTimes(1);
    const packet = packets.mock.calls[0][0];
    ack(packet);
    reply(packet);
    await expect(result).resolves.toEqual({ data: "ok" });
  });

  it("bounds interest ACK and server wait by readiness plus writable wait", async () => {
    client.state = "disconnected";
    const result = request({ waitForInterest: true }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(600);
    client.state = "connected";
    client.emit("info");
    await jest.advanceTimersByTimeAsync(0);
    ack(packets.mock.calls[0][0], { count: 0 });
    await jest.advanceTimersByTimeAsync(200);
    const timeout = jest.spyOn(socket, "timeout");
    drain();
    drain();
    await jest.advanceTimersByTimeAsync(0);
    expect(packets).toHaveBeenCalledTimes(2);
    expect(packets.mock.calls[1][0].data).toEqual([
      "wait-for-interest",
      { subject, timeout: 200 },
    ]);
    expect(timeout).toHaveBeenCalledWith(200);
    await jest.advanceTimersByTimeAsync(200);
    expect(await result).toMatchObject({ code: 408 });
    expect(Object.keys(socket.acks)).toHaveLength(0);
    drain();
    await jest.advanceTimersByTimeAsync(1000);
    expect(packets).toHaveBeenCalledTimes(2);
  });

  it("does not hand off interest after expiry while waiting for writable transport", async () => {
    const result = request({ waitForInterest: true }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    ack(packets.mock.calls[0][0], { count: 0 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: 408 });
    drain();
    drain();
    await jest.advanceTimersByTimeAsync(1000);
    expect(packets).toHaveBeenCalledTimes(1);
    expect(socket.sendBuffer).toHaveLength(0);
    expect(Object.keys(socket.acks)).toHaveLength(0);
    expect(engine.listeners("drain")).toHaveLength(0);
  });

  it("rechecks the deadline after encoding an interest-triggered publish retry", async () => {
    const result = request({ waitForInterest: true }).catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    ack(packets.mock.calls[0][0], { count: 0 });
    await jest.advanceTimersByTimeAsync(0);
    drain();
    drain();
    await jest.advanceTimersByTimeAsync(0);
    expect(packets.mock.calls[1][0].data[0]).toBe("wait-for-interest");
    const encode = codec.encode;
    jest.spyOn(codec, "encode").mockImplementation((options) => {
      const raw = encode(options);
      jest.setSystemTime(Date.now() + 2000);
      return raw;
    });
    socket.onack({ id: packets.mock.calls[1][0].id, data: [true] });
    await expect(result).resolves.toMatchObject({ code: 408 });
    drain();
    await jest.advanceTimersByTimeAsync(1000);
    expect(packets).toHaveBeenCalledTimes(2);
    expect(socket.sendBuffer).toHaveLength(0);
    expect(inbox.eventNames()).toHaveLength(0);
  });

  it("cancels unsent chunks after an early publish ACK failure", async () => {
    client.info.max_payload = 1000;
    const result = client
      .request(subject, Buffer.alloc(3000), { timeout: 1000 })
      .catch((err) => err);
    await jest.advanceTimersByTimeAsync(0);
    expect(packets).toHaveBeenCalledTimes(1);
    socket.onack({
      id: packets.mock.calls[0][0].id,
      data: [{ error: "rejected", code: 429 }],
    });
    expect(await result).toMatchObject({ code: 429 });
    drain();
    drain();
    await jest.advanceTimersByTimeAsync(1000);
    expect(packets).toHaveBeenCalledTimes(1);
    expect(engine.listeners("drain")).toHaveLength(0);
  });
});
