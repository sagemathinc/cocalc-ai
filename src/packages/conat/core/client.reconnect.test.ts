jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

describe("core client socket.io reconnect policy", () => {
  it("restores steady reconnect settings after the initial connection", async () => {
    jest.resetModules();

    const handlers: Record<string, () => void> = {};
    const manager = {
      on: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      timeout: jest.fn(),
      reconnectionDelay: jest.fn(),
      reconnectionDelayMax: jest.fn(),
      randomizationFactor: jest.fn(),
    };
    const socket = {
      connected: true,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: manager,
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { Client } = require("./client");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      timeout: 12_000,
      reconnectionDelay: 700,
      reconnectionDelayMax: 9_000,
      randomizationFactor: 0.25,
      initialConnectionPolicy: {
        timeout: 250,
        reconnectionDelay: 50,
        reconnectionDelayMax: 250,
        randomizationFactor: 0,
        restoreAfterMs: 5_000,
      },
    });

    const socketOptions = connectToSocketIO.mock.calls[0][1];
    expect(socketOptions).toEqual(
      expect.objectContaining({
        timeout: 250,
        reconnectionDelay: 50,
        reconnectionDelayMax: 250,
        randomizationFactor: 0,
      }),
    );
    expect(socketOptions).not.toHaveProperty("initialConnectionPolicy");
    expect(socketOptions).not.toHaveProperty("restoreAfterMs");

    client.connect();
    handlers.connect();

    expect(manager.timeout).toHaveBeenCalledWith(12_000);
    expect(manager.reconnectionDelay).toHaveBeenCalledWith(700);
    expect(manager.reconnectionDelayMax).toHaveBeenCalledWith(9_000);
    expect(manager.randomizationFactor).toHaveBeenCalledWith(0.25);

    client.close();
  });

  it("restores steady reconnect settings when the startup window expires", async () => {
    jest.resetModules();
    jest.useFakeTimers();

    const manager = {
      on: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      timeout: jest.fn(),
      reconnectionDelay: jest.fn(),
      reconnectionDelayMax: jest.fn(),
      randomizationFactor: jest.fn(),
    };
    const socket = {
      connected: false,
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: manager,
    };

    jest.doMock("socket.io-client", () => ({
      connect: jest.fn(() => socket),
    }));

    let client: { close: () => void } | undefined;
    try {
      const { Client } = require("./client");
      client = new Client({
        address: "http://example.com",
        initialConnectionPolicy: {
          timeout: 250,
          reconnectionDelay: 50,
          reconnectionDelayMax: 250,
          randomizationFactor: 0,
          restoreAfterMs: 5_000,
        },
      });

      jest.advanceTimersByTime(4_999);
      expect(manager.timeout).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);

      expect(manager.timeout).toHaveBeenCalledWith(20_000);
      expect(manager.reconnectionDelay).toHaveBeenCalledWith(500);
      expect(manager.reconnectionDelayMax).toHaveBeenCalledWith(15_000);
      expect(manager.randomizationFactor).toHaveBeenCalledWith(0.5);
    } finally {
      client?.close();
      jest.useRealTimers();
    }
  });

  it("respects reconnection false passed by callers", async () => {
    jest.resetModules();

    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { connect } = require("./client");
    const client = connect({
      address: "http://example.com",
      reconnection: false,
    });

    expect(connectToSocketIO).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reconnection: false,
      }),
    );

    client.close();
  });

  it("does not auto-connect when callers pass autoConnect false", async () => {
    jest.resetModules();

    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { connect } = require("./client");
    const client = connect({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });

    expect(connectToSocketIO).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        autoConnect: false,
      }),
    );
    expect(socket.io.connect).not.toHaveBeenCalled();

    client.connect();
    expect(socket.io.connect).toHaveBeenCalledTimes(1);

    client.close();
  });

  it("does not unsubscribe subjects the client still wants during resync", async () => {
    jest.resetModules();

    const emitWithAck = jest
      .fn()
      .mockResolvedValueOnce(["wanted.subject"])
      .mockResolvedValueOnce([]);
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      timeout: jest.fn(() => ({ emitWithAck })),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { Client } = require("./client");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    const anyClient = client as any;
    anyClient.info = { user: { hub_id: "hub" } };
    anyClient.state = "connected";
    anyClient.queueGroups = { "wanted.subject": "0" };

    const stable = await anyClient.syncSubscriptions0(1000);

    expect(stable).toBe(true);
    expect(emitWithAck).toHaveBeenCalledTimes(1);
    expect(emitWithAck).toHaveBeenCalledWith("subscriptions", null);

    client.close();
  });

  it("unsubscribes only server-side extras during resync", async () => {
    jest.resetModules();

    const emitWithAck = jest
      .fn()
      .mockResolvedValueOnce(["wanted.subject", "stale.subject"])
      .mockResolvedValueOnce([]);
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      timeout: jest.fn(() => ({ emitWithAck })),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { Client } = require("./client");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    const anyClient = client as any;
    anyClient.info = { user: { hub_id: "hub" } };
    anyClient.state = "connected";
    anyClient.queueGroups = { "wanted.subject": "0" };

    const stable = await anyClient.syncSubscriptions0(1000);

    expect(stable).toBe(false);
    expect(emitWithAck).toHaveBeenNthCalledWith(1, "subscriptions", null);
    expect(emitWithAck).toHaveBeenNthCalledWith(2, "unsubscribe", [
      { subject: "stale.subject" },
    ]);

    client.close();
  });

  it("rejects an already received sign-in failure but permits a later handshake", async () => {
    jest.resetModules();
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    jest.doMock("socket.io-client", () => ({ connect: () => socket }));
    const { Client } = require("./client");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    try {
      client.state = "connected";
      client.info = { user: { error: "test authority revoked" } };
      await expect(client.waitUntilSignedIn({ timeout: 100 })).rejects.toThrow(
        "test authority revoked",
      );

      client.state = "disconnected";
      const signedIn = client.waitUntilSignedIn({ timeout: 1000 });
      await Promise.resolve();
      client.state = "connected";
      client.info = { user: { account_id: "account-1" } };
      client.emit("info", client.info);
      await expect(signedIn).resolves.toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("keeps waiting when sign-in info races a disconnect", async () => {
    jest.resetModules();

    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: {
        on: jest.fn(),
        connect: jest.fn(),
        disconnect: jest.fn(),
      },
    };
    const connectToSocketIO = jest.fn(() => socket);

    jest.doMock("socket.io-client", () => ({
      connect: connectToSocketIO,
    }));

    const { Client } = require("./client");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    const anyClient = client as any;
    const signedIn = client.waitUntilSignedIn({ timeout: 1_000 });

    anyClient.info = { user: { account_id: "account-1" } };
    client.emit("info", anyClient.info);
    await Promise.resolve();

    anyClient.state = "connected";
    client.emit("info", anyClient.info);

    await expect(signedIn).resolves.toBeUndefined();
    client.close();
  });
});
