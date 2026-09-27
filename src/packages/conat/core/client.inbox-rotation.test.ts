/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import { Client, connect, type Message } from "./client";
import { ConatServer, init } from "./server";

describe("authenticated reply namespace rotation", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    "uses the authorized inbox after transport reconnection (rotation=%s, mutable provider=%s)",
    async (rotate, mutableProvider) => {
      const stablePrefix = `_INBOX.stable-${randomUUID()}`;
      let providerPrefix = stablePrefix;
      const broker = init({
        port: 0,
        autoscanInterval: 0,
        getUser: async (socket) => {
          const reply_prefix = rotate
            ? `_INBOX.rotation-${randomUUID()}`
            : stablePrefix;
          if (!socket.handshake.auth.hub_id) providerPrefix = reply_prefix;
          return { ...socket.handshake.auth, reply_prefix };
        },
        isAllowed: async ({ user, subject, type }) =>
          user.hub_id === "service" ||
          (type === "pub"
            ? subject === "rotation.echo"
            : subject.startsWith(user.reply_prefix + ".")),
      });
      const service = connect({
        address: broker.address(),
        noCache: true,
        auth: { hub_id: "service" },
      });
      const client = connect({
        address: broker.address(),
        noCache: true,
        reconnection: false,
        auth: { account_id: "test" },
      });
      client.inboxPrefixHook = mutableProvider
        ? () => providerPrefix
        : (info) => info?.user?.reply_prefix;
      await client.waitUntilSignedIn({ timeout: 3000 });
      const subscription = await service.subscribe("rotation.echo");
      let receivedAfter = false;
      let heldRequest: Message | undefined;
      let heldExecutions = 0;
      let admitted = () => {};
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      let releaseRefresh = () => {};
      const responder = (async () => {
        for await (const message of subscription) {
          if (message.data === "held") {
            heldExecutions++;
            heldRequest = message;
            admitted();
            continue;
          }
          if (message.data === "after") receivedAfter = true;
          message.respondSync(message.data);
        }
      })();
      try {
        expect(
          (await client.request("rotation.echo", "before", { timeout: 2000 }))
            .data,
        ).toBe("before");
        const previous = client.info!.user.reply_prefix;
        const previousInbox = (client as any).inboxSubject;
        // A stable authority must preserve pending listeners, not replay work.
        let acknowledged = () => {};
        const acknowledgment = new Promise<void>((resolve) => {
          acknowledged = resolve;
        });
        const publish = client.publish.bind(client);
        jest.spyOn(client, "publish").mockImplementation(async (...args) => {
          const result = await publish(...args);
          if (args[1] === "held") acknowledged();
          return result;
        });
        const pending = !rotate
          ? client.request("rotation.echo", "held", { timeout: 3000 })
          : undefined;
        void pending?.catch(() => {});
        if (pending) await Promise.all([admission, acknowledgment]);
        client.conn.disconnect();
        const refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        const emitWithAck = client.conn.emitWithAck.bind(client.conn);
        client.conn.emitWithAck = (async (event, ...args) => {
          if (event === "subscribe") await refreshGate;
          return await emitWithAck(event, ...args);
        }) as typeof client.conn.emitWithAck;
        const signedIn = new Promise<void>((resolve) =>
          client.once("info", () => resolve()),
        );
        client.conn.connect();
        await signedIn;
        expect(client.info!.user.reply_prefix === previous).toBe(!rotate);
        const after = client.request("rotation.echo", "after", {
          timeout: 2000,
        });
        void after.catch(() => {});
        await delay(30);
        expect(receivedAfter).toBe(false);
        releaseRefresh();
        expect((await after).data).toBe("after");
        expect((client as any).inboxSubject === previousInbox).toBe(!rotate);
        expect(client.numSubscriptions()).toBe(1);
        if (pending) {
          expect(heldRequest).toBeDefined();
          await heldRequest!.respond("completed-before-reconnect");
          expect((await pending).data).toBe("completed-before-reconnect");
          expect(heldExecutions).toBe(1);
        }
        if (rotate) {
          await expect(
            client.subscribe(previous + ".probe"),
          ).rejects.toMatchObject({ code: 403 });
        }
      } finally {
        releaseRefresh();
        subscription.close();
        await responder;
      }
    },
    10000,
  );
});
