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
