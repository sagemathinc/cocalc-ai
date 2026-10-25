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
      Array(10_001).fill({ pattern: "a.*", target: room("a.*") }),
    ]) {
      expect(validClusterDeliveryTargets("a.b", targets)).toBe(false);
    }
  });
});
