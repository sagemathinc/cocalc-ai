jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { __test__ } from "./server";

describe("core server trusted egress metering", () => {
  it("measures encoded engine.io packet bytes for string payloads", () => {
    const bytes = __test__.measureServerEgressPacketBytes(
      {
        conn: {
          transport: {
            supportsBinary: true,
            parser: require("engine.io-parser"),
          },
        },
      },
      { type: "message", data: "hello world", options: { compress: false } },
    );
    expect(bytes).toBeGreaterThan(Buffer.byteLength("hello world"));
  });

  it("measures encoded engine.io packet bytes for binary payloads", () => {
    const payload = Buffer.from("hello world");
    const bytes = __test__.measureServerEgressPacketBytes(
      {
        conn: {
          transport: {
            supportsBinary: true,
            parser: require("engine.io-parser"),
          },
        },
      },
      { type: "message", data: payload, options: { compress: false } },
    );
    expect(bytes).toBeGreaterThanOrEqual(payload.length);
  });
});
