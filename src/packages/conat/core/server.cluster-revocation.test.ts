/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

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
import { ConatServer, init, type UserFunction } from "./server";
import { createServiceClient, createServiceHandler } from "../service/typed";

async function eventually(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("condition did not become true");
    await delay(20);
  }
}

describe("cluster interest withdrawal on API-key revalidation failure", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each(["revoked", "unavailable"])(
    "withdraws subscription and RPC interest when authority is %s",
    async (failure) => {
      let deny = false;
      let refreshes = 0;
      const getUser: UserFunction = async (
        socket,
        systemAccounts = {},
        options,
      ) => {
        const cookie = `${socket.handshake.headers.cookie ?? ""}`;
        for (const [name, account] of Object.entries(systemAccounts)) {
          if (cookie.includes(`${name}=${account.password}`))
            return account.user;
        }
        if (
          socket.handshake.auth.auth_method === "api_key" &&
          options?.revalidation
        ) {
          refreshes++;
          if (deny) {
            if (failure === "unavailable")
              return await new Promise(() => undefined);
            throw Error("key revoked");
          }
        }
        return socket.handshake.auth;
      };
      const clusterName = `revocation-${failure}`;
      const common = {
        clusterName,
        clusterLinkPassword: "synthetic-link-password",
        systemAccountPassword: "synthetic-system-password",
        autoscanInterval: 0,
        getUser,
        isAllowed: async () => true,
      };
      const source = init({ ...common, id: "source", port: 0 });
      const remote = init({ ...common, id: "remote", port: 0 });
      const keyClient = connect({
        address: source.address(),
        noCache: true,
        reconnection: false,
        auth: {
          account_id: "test-account",
          auth_method: "api_key",
          key_id: "test-key",
          scope_revision: 1,
        },
      });
      const caller = connect({
        address: remote.address(),
        noCache: true,
        auth: { hub_id: "test-caller" },
      });
      let service: ReturnType<typeof createServiceHandler> | undefined;
      let subscription: Awaited<ReturnType<Client["subscribe"]>> | undefined;
      let reader: Promise<void> | undefined;
      const received: unknown[] = [];
      try {
        await keyClient.waitUntilSignedIn({ timeout: 5000 });
        await caller.waitUntilSignedIn({ timeout: 5000 });
        subscription = await keyClient.subscribe("test.revocation.events");
        reader = (async () => {
          for await (const message of subscription!)
            received.push(message.data);
        })();
        service = createServiceHandler({
          client: keyClient,
          subject: "test.revocation.rpc",
          service: "revocation-test",
          transport: "fast-rpc",
          impl: { read: async () => "ok" },
        });
        await source.join(remote.address(), { timeout: 5000 });
        await remote.join(source.address(), { timeout: 5000 });
        const interest = (subject: string) =>
          !!(remote as any).clusterLinks[clusterName]?.source?.hasInterest(
            subject,
          );
        await eventually(
          () =>
            interest("test.revocation.events") &&
            interest("test.revocation.rpc"),
        );
        await caller.publish("test.revocation.events", "before");
        await eventually(() => received.length === 1);
        const api = createServiceClient<any>({
          client: caller,
          subject: "test.revocation.rpc",
          service: "revocation-test",
          transport: "fast-rpc",
          timeout: 1000,
        });
        expect(await api.read()).toBe("ok");
        deny = true;
        await eventually(() => !keyClient.conn.connected, 27000);
        expect(refreshes).toBeGreaterThan(0);
        await eventually(
          () =>
            !interest("test.revocation.events") &&
            !interest("test.revocation.rpc"),
        );
        expect(source.interest.hasMatch("test.revocation.events")).toBe(false);
        expect(source.interest.hasMatch("test.revocation.rpc")).toBe(false);
        expect(received).toEqual(["before"]);
        await expect(api.read()).rejects.toThrow();
      } finally {
        service?.close();
        subscription?.close();
        keyClient.close();
        caller.close();
        await reader;
        await source.close();
        await remote.close();
      }
    },
    40000,
  );
});
