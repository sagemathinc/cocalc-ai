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
});
