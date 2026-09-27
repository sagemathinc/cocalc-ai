/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { Client, connect } from "./client";
import { ConatServer, init } from "./server";

describe("authenticated reply namespace rotation", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each([true, false])(
    "uses the authorized inbox after transport reconnection (rotation=%s)",
    async (rotate) => {
      const stablePrefix = `_INBOX.stable-${randomUUID()}`;
      const broker = init({
        port: 0,
        autoscanInterval: 0,
        getUser: async (socket) => ({
          ...socket.handshake.auth,
          reply_prefix: rotate
            ? `_INBOX.rotation-${randomUUID()}`
            : stablePrefix,
        }),
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
      client.inboxPrefixHook = (info) => info?.user?.reply_prefix;
      await client.waitUntilSignedIn({ timeout: 3000 });
      const subscription = await service.subscribe("rotation.echo");
      const responder = (async () => {
        for await (const message of subscription)
          message.respondSync(message.data);
      })();
      try {
        expect(
          (await client.request("rotation.echo", "before", { timeout: 2000 }))
            .data,
        ).toBe("before");
        const previous = client.info!.user.reply_prefix;
        const previousInbox = (client as any).inboxSubject;
        client.conn.disconnect();
        const signedIn = new Promise<void>((resolve) =>
          client.once("info", () => resolve()),
        );
        client.conn.connect();
        await signedIn;
        expect(client.info!.user.reply_prefix === previous).toBe(!rotate);
        expect(
          (await client.request("rotation.echo", "after", { timeout: 2000 }))
            .data,
        ).toBe("after");
        expect((client as any).inboxSubject === previousInbox).toBe(!rotate);
        expect(client.numSubscriptions()).toBe(1);
        if (rotate) {
          await expect(
            client.subscribe(previous + ".probe"),
          ).rejects.toMatchObject({ code: 403 });
        }
      } finally {
        subscription.close();
        await responder;
      }
    },
    10000,
  );
});
