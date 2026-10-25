/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Delivery targets (publish payload slot 6) are server-owned cluster routing
// metadata: an ordinary client must never choose where its message goes.

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { delay } from "awaiting";
import { Client, connect } from "./client";
import { ConatServer, init, validClusterDeliveryTargets } from "./server";
import { DataEncoding } from "./codec";

describe("publish delivery targets", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it("an ordinary client can't deliver into another socket's subscription room", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) =>
        socket.handshake.auth.who === "victim"
          ? { account_id: "00000000-0000-4000-8000-000000000001" }
          : { account_id: "00000000-0000-4000-8000-000000000002" },
      // The attacker may publish only to its own subject; the victim may
      // subscribe to its own.
      isAllowed: async ({ user, subject }) =>
        subject.startsWith("_INBOX.") ||
        (user?.account_id?.endsWith("1")
          ? subject.startsWith("victim.")
          : subject.startsWith("attacker.")),
    });
    const victim = connect({
      address: server.address(),
      noCache: true,
      auth: { who: "victim" },
    });
    const attacker = connect({
      address: server.address(),
      noCache: true,
      auth: { who: "attacker" },
    });
    await victim.waitUntilSignedIn({ timeout: 5_000 });
    await attacker.waitUntilSignedIn({ timeout: 5_000 });
    const received: unknown[] = [];
    const sub = await victim.subscribe("victim.inbox");
    void (async () => {
      for await (const m of sub) received.push(m.data);
    })();
    // Suppose the attacker learned the victim's socket id.
    const room = JSON.stringify({
      id: victim.conn.id,
      subject: "victim.inbox",
    });
    const response = await attacker.conn
      .timeout(5_000)
      .emitWithAck("publish", [
        "attacker.anything",
        "forged",
        0,
        1,
        DataEncoding.JsonCodec,
        Buffer.from(JSON.stringify("forged reply")),
        undefined,
        [{ pattern: "victim.inbox", target: room }],
      ]);
    await delay(300);
    expect(received).toEqual([]);
    expect(response?.code).toBe(403);
  });

  it("cluster delivery targets must be well-formed rooms for patterns the subject matches", () => {
    const room = (subject: string) => JSON.stringify({ id: "abc", subject });
    expect(
      validClusterDeliveryTargets("a.b", [
        { pattern: "a.*", target: room("a.*") },
      ]),
    ).toBe(true);
    for (const targets of [
      null,
      "x",
      {},
      [{ pattern: "a.*", target: room("x.*") }],
      [{ pattern: "x.y", target: room("x.y") }],
      [{ pattern: "a.*", target: "not json" }],
      [{ pattern: "a.*", target: JSON.stringify({ id: 1, subject: "a.*" }) }],
      [
        {
          pattern: "a.*",
          target: JSON.stringify({ id: "abc", subject: "a.*", extra: 1 }),
        },
      ],
      [{ pattern: 5, target: room("a.*") }],
    ]) {
      expect(validClusterDeliveryTargets("a.b", targets)).toBe(false);
    }
  });

  // A hub socket may hold MAX_SUBSCRIPTIONS_PER_HUB (15,000) subscriptions,
  // all matching one subject, so a legitimate cluster frame can carry more
  // than 10,000 targets; the receiver must deliver all of them.
  it("delivers a clustered publish with more than 10,000 legitimate targets", async () => {
    const tokens = 14;
    const subject = Array.from({ length: tokens }, (_, i) => `t${i}`).join(".");
    // distinct patterns matching subject: literal or * at each token
    const patterns: string[] = [];
    for (let mask = 0; patterns.length < 10_001; mask++) {
      patterns.push(
        subject
          .split(".")
          .map((t, i) => (mask & (1 << i) ? "*" : t))
          .join("."),
      );
    }
    const common = {
      clusterName: "many-targets",
      clusterLinkPassword: "synthetic-link-password",
      systemAccountPassword: "synthetic-system-password",
      autoscanInterval: 0,
      getUser: async (socket, systemAccounts = {}) => {
        const cookie = `${socket.handshake.headers.cookie ?? ""}`;
        for (const [name, account] of Object.entries(systemAccounts)) {
          if (cookie.includes(`${name}=${(account as any).password}`)) {
            return (account as any).user;
          }
        }
        return socket.handshake.auth;
      },
      isAllowed: async () => true,
    };
    const source = init({ ...common, id: "source", port: 0 });
    const remote = init({ ...common, id: "remote", port: 0 });
    const subscriber = connect({
      address: remote.address(),
      noCache: true,
      reconnection: false,
      auth: { hub_id: "subscriber" },
    });
    const publisher = connect({
      address: source.address(),
      noCache: true,
      reconnection: false,
      auth: { hub_id: "publisher" },
    });
    try {
      await subscriber.waitUntilSignedIn({ timeout: 5000 });
      await publisher.waitUntilSignedIn({ timeout: 5000 });
      for (let i = 0; i < patterns.length; i += 500) {
        await Promise.all(
          patterns
            .slice(i, i + 500)
            .map((pattern) => subscriber.subscribe(pattern)),
        );
      }
      await source.join(remote.address(), { timeout: 5000 });
      await remote.join(source.address(), { timeout: 5000 });
      const deadline = Date.now() + 20000;
      const link = () => (source as any).clusterLinks["many-targets"]?.remote;
      while (link()?.interest?.matches(subject).length !== patterns.length) {
        if (Date.now() > deadline) throw Error("interest did not propagate");
        await delay(50);
      }
      // Count what the receiving server emits into subscription rooms (the
      // test client's own per-message dispatch is too slow at this scale).
      const emitted = new Set<string>();
      const io = (remote as any).io;
      const to = io.to;
      io.to = (room: string) => ({
        emit: (pattern: string, mesg: { subject: string }) => {
          if (mesg?.subject === subject) emitted.add(`${room}|${pattern}`);
        },
      });
      try {
        const { count } = await publisher.publish(subject, "hello");
        expect(count).toBe(patterns.length);
        while (emitted.size < patterns.length && Date.now() < deadline) {
          await delay(50);
        }
      } finally {
        io.to = to;
      }
      expect(emitted.size).toBe(patterns.length);
    } finally {
      subscriber.close();
      publisher.close();
      await source.close();
      await remote.close();
    }
  }, 60000);
});
