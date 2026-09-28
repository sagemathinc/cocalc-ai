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
  it("round trips fast RPC admission metadata without private fields or replay", async () => {
    jest.resetModules();
    let client: any;
    const emitWithAck = jest.fn(async (_event, request) => {
      let response;
      await client.handleFastRpcRequest(
        { pattern: request.subject, payload: request.payload },
        (value) => {
          response = JSON.parse(JSON.stringify(value));
        },
      );
      expect(response).not.toHaveProperty("credential");
      return response;
    });
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      timeout: () => ({ emitWithAck }),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
    };
    jest.doMock("socket.io-client", () => ({ connect: () => socket }));
    const { Client } = require("./client");
    client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    client.state = "connected";
    client.info = { user: { account_id: "test-account" } };
    client.fastRpcServiceHandlers["test.summary"] = jest.fn(async () => {
      throw Object.assign(new Error("search rate exceeded"), {
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
        credential: "must-not-cross-wire",
      });
    });
    try {
      await expect(
        client.fastRpcRequest("test.summary", {}),
      ).rejects.toMatchObject({
        message: "search rate exceeded",
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
        subject: "test.summary",
      });
      expect(emitWithAck).toHaveBeenCalledTimes(1);
      expect(
        client.fastRpcServiceHandlers["test.summary"],
      ).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
    }
  });

  it.each(
    [false, true].flatMap((many) =>
      ["close", "publish-error"].map((end) => [many, end] as const),
    ),
  )("releases tracked requests (many=%s, end=%s)", async (many, end) => {
    jest.resetModules();
    const socket = {
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      close: jest.fn(),
      io: { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
    };
    jest.doMock("socket.io-client", () => ({ connect: () => socket }));
    const { Client } = require("./client");
    const { EventEmitter } = require("node:events");
    const client = new Client({
      address: "http://example.com",
      autoConnect: false,
      noCache: true,
    });
    const inbox = new EventEmitter();
    client.inbox = inbox;
    client.inboxSubject = "test.inbox";
    client.state = "connected";
    client.publish = jest.fn(async () => {
      if (end === "publish-error") throw new Error("publication rejected");
      return { count: 1 };
    });
    try {
      const pending = many
        ? client
            .requestMany("test.subject", "payload")
            .then((sub) => sub.next())
        : client.request("test.subject", "payload", { timeout: 30_000 });
      void pending.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      if (end === "close") {
        expect(client.inboxRequests.size).toBe(1);
        client.close();
        await expect(pending).rejects.toMatchObject({
          code: "CONNECTION_LOST",
        });
      } else {
        await expect(pending).rejects.toThrow("publication rejected");
      }
      expect(client.inboxRequests.size).toBe(0);
      expect(inbox.eventNames()).toEqual([]);
      expect(client.publish).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
    }
  });

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
      ).rejects.toMatchObject({ code: 408 });
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
