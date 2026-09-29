import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect, type Client } from "@cocalc/conat/core/client";
import { init } from "@cocalc/conat/core/server";
import { reconnectApiKeyProjectHostAfterLease } from "./api-key-hub";

test("lease reconnect ignores ordinary disconnects and stops on explicit close", () => {
  let connections = 0;
  let invalidations = 0;
  const conn = Object.assign(new EventEmitter(), {
    connect: () => connections++,
  });
  const client = Object.assign(new EventEmitter(), {
    conn,
    state: "connected",
  });
  reconnectApiKeyProjectHostAfterLease(client as unknown as Client, () => {
    invalidations++;
  });
  conn.emit("disconnect", "transport close");
  conn.emit("disconnect", "io client disconnect");
  assert.equal(connections, 0);
  assert.equal(invalidations, 0);
  conn.emit("disconnect", "io server disconnect");
  assert.equal(connections, 1);
  assert.equal(invalidations, 1);
  client.state = "closed";
  conn.emit("disconnect", "io server disconnect");
  assert.equal(connections, 1);
  client.emit("closed");
  assert.equal(conn.listenerCount("disconnect"), 0);
});

test("scoped host lease expiry renews authentication and rejects revoked authority", async () => {
  let allowed = true;
  let issued = 0;
  let invalidated = 0;
  const broker = init({
    port: 0,
    autoscanInterval: 0,
    getUser: async (socket) => {
      if (!allowed) throw Error("test key revoked");
      return {
        account_id: "test-account",
        auth_api_key_reply_prefix: socket.handshake.auth.prefix,
        auth_lease_exp_s: Math.ceil(Date.now() / 1000) + 1,
      };
    },
    isAllowed: async ({ user }) => !user?.error,
  });
  const client = connect({
    address: broker.address(),
    noCache: true,
    reconnection: true,
    auth: (cb) => {
      issued++;
      cb({ prefix: `_INBOX.api-key-${randomUUID()}` });
    },
  });
  reconnectApiKeyProjectHostAfterLease(client, () => invalidated++);
  try {
    await client.waitUntilSignedIn({ timeout: 3000 });
    const firstPrefix = client.info?.user?.auth_api_key_reply_prefix;
    const disconnected = once(client, "disconnected", {
      signal: AbortSignal.timeout(4000),
    });
    await disconnected;
    await client.waitUntilSignedIn({ timeout: 3000 });
    assert.equal(issued, 2);
    assert.equal(invalidated, 1);
    assert.notEqual(client.info?.user?.auth_api_key_reply_prefix, firstPrefix);
    assert.equal(client.info?.user?.account_id, "test-account");

    allowed = false;
    await once(client, "disconnected", { signal: AbortSignal.timeout(4000) });
    await assert.rejects(
      client.waitUntilSignedIn({ timeout: 3000 }),
      /test key revoked/,
    );
    assert.equal(issued, 3);
    assert.equal(invalidated, 2);
    assert.ok(client.info?.user?.error);
  } finally {
    client.close();
    await broker.close();
  }
});
