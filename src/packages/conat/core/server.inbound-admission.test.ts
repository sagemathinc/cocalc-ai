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
import { delay } from "awaiting";
import { setServiceAdmissionLimitOverrides } from "@cocalc/conat/admission/limits";
import { ConatServer, init } from "./server";

describe("core server inbound socket admission", () => {
  afterEach(async () => {
    setServiceAdmissionLimitOverrides({});
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

  it("uses a tighter per-socket guard for subscription sync requests", async () => {
    setServiceAdmissionLimitOverrides({
      conat_subscriptions_requests_per_socket_window: 2,
    });
    const server = init({
      port: 0,
      maxInboundEventsPerSocketWindow: 100,
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

  it("uses the identity guard instead of the per-socket guard for hub service clients", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) => socket.handshake.auth,
      maxInboundEventsPerSocketWindow: 2,
      maxInboundEventsPerIdentityWindow: 3,
      inboundEventWindowMs: 60_000,
      inboundEventBlockMs: 60_000,
    });
    const client = connect({
      address: server.address(),
      noCache: true,
      auth: { hub_id: "hub-1" },
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
    expect(denied.error).toContain("authenticated identity");
    expect(server.getUsage()["inbound-deny:count"]).toBe(0);
    expect(server.getUsage()["inbound-identity-deny:count"]).toBeGreaterThan(0);

    client.close();
    await server.close();
  });

  it("runs queued publishes after disconnect without deleted stats", async () => {
    const server = init({ port: 0 });
    const client = connect({
      address: server.address(),
      noCache: true,
    });
    await client.waitUntilSignedIn({ timeout: 5000 });

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalPublish = server.publish.bind(server);
    const publish = jest
      .spyOn(server, "publish")
      .mockImplementation(async (opts) => {
        markFirstStarted();
        await firstBlocked;
        return await originalPublish(opts);
      });
    const payload = [
      "queued.publish.disconnect",
      "chunk-id",
      0,
      1,
      "json",
      Buffer.from("null"),
    ];

    client.conn.emit("publish", payload);
    await firstStarted;
    client.conn.emit("publish", payload);
    await delay(20);
    client.close();
    for (let i = 0; i < 100; i++) {
      if (Object.keys(server.getStatsSnapshot()).length === 0) break;
      await delay(10);
    }
    expect(Object.keys(server.getStatsSnapshot())).toHaveLength(0);

    releaseFirst();
    for (let i = 0; i < 100; i++) {
      if (publish.mock.calls.length === 2) break;
      await delay(10);
    }
    expect(publish).toHaveBeenCalledTimes(2);

    await server.close();
  });
});
