jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { Client, connect } from "./client";
import { ConatServer, init } from "./server";

describe("core server inbound socket admission", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it("fast-fails high-rate per-socket protocol events before handler work", async () => {
    const server = init({
      port: 0,
      maxInboundEventsPerSocketWindow: 2,
      inboundEventWindowMs: 60_000,
      inboundEventBlockMs: 60_000,
    });
    const client = connect({
      address: server.address(),
      noCache: true,
    });
    await client.waitUntilSignedIn({ timeout: 5000 });

    let denied: any;
    for (let i = 0; i < 6; i++) {
      const response = await client.conn
        .timeout(2000)
        .emitWithAck("subscriptions", {});
      if (response?.code === 429) {
        denied = response;
        break;
      }
    }

    expect(denied).toMatchObject({ code: 429 });
    expect(denied.error).toContain("too many Conat socket messages");
    expect(server.getUsage()["inbound-deny:count"]).toBeGreaterThan(0);

    client.close();
    await server.close();
  });

  it("fast-fails high-rate protocol events shared across sockets for one identity", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) => socket.handshake.auth,
      maxInboundEventsPerSocketWindow: 100,
      maxInboundEventsPerIdentityWindow: 3,
      inboundEventWindowMs: 60_000,
      inboundEventBlockMs: 60_000,
    });
    const clientA = connect({
      address: server.address(),
      noCache: true,
      auth: { account_id: "same-account" },
    });
    const clientB = connect({
      address: server.address(),
      noCache: true,
      auth: { account_id: "same-account" },
    });
    await Promise.all([
      clientA.waitUntilSignedIn({ timeout: 5000 }),
      clientB.waitUntilSignedIn({ timeout: 5000 }),
    ]);

    let denied: any;
    for (let i = 0; i < 8; i++) {
      const client = i % 2 == 0 ? clientA : clientB;
      const response = await client.conn
        .timeout(2000)
        .emitWithAck("subscriptions", {});
      if (response?.code === 429) {
        denied = response;
        break;
      }
    }

    expect(denied).toMatchObject({ code: 429 });
    expect(denied.error).toContain("authenticated identity");
    expect(server.getUsage()["inbound-identity-deny:count"]).toBeGreaterThan(0);
    expect(server.getUsage()["inbound-deny:count"]).toBe(0);

    clientA.close();
    clientB.close();
    await server.close();
  });
});
