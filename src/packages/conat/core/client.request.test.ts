jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

describe("core client request setup failures", () => {
  it.each(["publish", "fastRpcRequest"])(
    "%s reports lost acknowledgments as structured errors without replay",
    async (method) => {
      jest.resetModules();
      let executions = 0;
      const emitWithAck = jest.fn(async () => {
        executions++;
        throw new Error("socket has been disconnected");
      });
      const socket = {
        on: jest.fn(),
        emit: jest.fn(),
        emitWithAck,
        timeout: () => ({ emitWithAck }),
        disconnect: jest.fn(),
        close: jest.fn(),
        io: { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
      };
      jest.doMock("socket.io-client", () => ({ connect: () => socket }));
      const { Client, ConatError } = require("./client");
      const client = new Client({
        address: "http://example.com",
        autoConnect: false,
        noCache: true,
      });
      client.state = "connected";
      client.info = { user: { account_id: "test-account" } };
      try {
        const pending = client[method]("test.write", ["write", "value"], {
          timeout: 1000,
        });
        await expect(pending).rejects.toBeInstanceOf(ConatError);
        await expect(pending).rejects.toMatchObject({
          code: "CONNECTION_LOST",
          subject: "test.write",
          message: "Error: socket has been disconnected",
        });
        expect(executions).toBe(1);
      } finally {
        client.close();
      }
    },
  );

  it("bounds sign-in waiting after an established connection disconnects", async () => {
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
    const { EventEmitter } = require("node:events");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    // Retain the inbox from an established session, as happens on token expiry.
    client.inbox = new EventEmitter();
    client.inboxSubject = "test.inbox";
    client.state = "disconnected";
    try {
      await expect(
        client.request("test.subject", ["payload"], { timeout: 25 }),
      ).rejects.toThrow(/timeout.*waiting for "info"/);
      expect(socket.emit).not.toHaveBeenCalled();
      expect(client.inbox.eventNames()).toEqual([]);
    } finally {
      client.close();
    }
  });

  it("turns closed-before-inbox errors into a conat timeout-style error", async () => {
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

    const pending = client.request("test.subject", ["payload"], {
      timeout: 1_000,
    });
    client.close();

    await expect(pending).rejects.toMatchObject({
      message: "closed",
      code: 408,
    });
  });
});
