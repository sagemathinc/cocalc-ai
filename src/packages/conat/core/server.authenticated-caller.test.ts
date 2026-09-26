/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
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
import {
  CLUSTER_INTEREST_OPEN,
  CLUSTER_INTEREST_PROTOCOL,
  CLUSTER_LINK_COOKIE_NAME,
} from "./cluster";
import {
  ConatServer,
  init,
  type AllowFunction,
  type UserFunction,
} from "./server";
import { createServiceClient, createServiceHandler } from "../service/typed";

describe("authenticated Conat caller metadata", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it("closes a credential-backed socket when its authorization lease expires", async () => {
    const server = init({
      port: 0,
      getUser: async () => ({
        account_id: "00000000-0000-4000-8000-000000000001",
        auth_lease_exp_s: (Date.now() + 1_000) / 1_000,
      }),
      isAllowed: async () => true,
    });
    const client = connect({ address: server.address(), noCache: true });
    await client.waitUntilSignedIn({ timeout: 5_000 });
    expect(client.conn.connected).toBe(true);
    await delay(1_300);
    expect(client.conn.connected).toBe(false);
    client.close();
    await server.close();
  });

  it("keeps a valid API-key socket open, then closes its interests after revocation", async () => {
    let valid = true;
    const getUser = jest.fn(async () => {
      if (!valid) throw new Error("API key revoked");
      return {
        account_id: "00000000-0000-4000-8000-000000000001",
        auth_method: "api_key",
        key_id: "key-1",
        scope_revision: 1,
      };
    });
    const server = init({ port: 0, getUser, isAllowed: async () => true });
    const client = connect({ address: server.address(), noCache: true });
    await client.waitUntilSignedIn({ timeout: 5_000 });
    await client.subscribe("test.api-key.subscription", () => undefined);
    await delay(16_000);
    expect(client.conn.connected).toBe(true);
    expect(getUser).toHaveBeenCalledTimes(2);
    valid = false;
    await delay(16_000);
    expect(client.conn.connected).toBe(false);
    client.close();
    await server.close();
  }, 40_000);

  it.each(["subscription", "rpc", "publication"])(
    "closes an API-key %s after project authority changes while the key remains valid",
    async (kind) => {
      let allowed = true;
      let logins = 0;
      let originalPrefix: string;
      const server = init({
        port: 0,
        getUser: async () => {
          const prefix = `_INBOX.test-${++logins}`;
          originalPrefix ??= prefix;
          return {
            account_id: "00000000-0000-4000-8000-000000000001",
            auth_method: "api_key",
            key_id: "key-1",
            scope_revision: 1,
            auth_api_key_reply_prefix: prefix,
          };
        },
        isAllowed: async ({ user, subject }) =>
          subject.startsWith("_INBOX.")
            ? user.auth_api_key_reply_prefix === originalPrefix
            : subject !== "test.denied.probe" && allowed,
      });
      const client = connect({ address: server.address(), noCache: true });
      let service: ReturnType<typeof createServiceHandler> | undefined;
      try {
        await client.waitUntilSignedIn({ timeout: 5_000 });
        await client.subscribe(`${originalPrefix!}.reply`, () => undefined);
        if (kind === "subscription")
          await client.subscribe("test.project.interest", () => undefined);
        else if (kind === "publication") {
          await expect(
            client.publish("test.denied.probe", "probe"),
          ).rejects.toThrow();
          await client.publish("test.project.interest", "request");
        } else
          service = createServiceHandler({
            client,
            subject: "test.project.interest",
            service: "revocation-test",
            transport: "fast-rpc",
            impl: { read: async () => "ok" },
          });
        await delay(250);
        await delay(16_000);
        expect(client.conn.connected).toBe(true);
        allowed = false;
        await delay(16_000);
        expect(logins).toBeGreaterThanOrEqual(2);
        expect(client.conn.connected).toBe(false);
        expect(
          Object.values((server as any).subscriptions).some(
            (subjects: Set<string>) => subjects.has("test.project.interest"),
          ),
        ).toBe(false);
        expect(
          Object.values((server as any).rpcServiceSubjects).some(
            (subjects: Set<string>) => subjects.has("test.project.interest"),
          ),
        ).toBe(false);
      } finally {
        service?.close();
        client.close();
        await server.close();
      }
    },
    40_000,
  );

  it("bounds retained publication interests and permits repeat publications", async () => {
    const server = init({
      port: 0,
      maxSubscriptionsPerClient: 2,
      getUser: async () => ({
        account_id: "test-account",
        auth_method: "api_key",
      }),
      isAllowed: async () => true,
    });
    const client = connect({ address: server.address(), noCache: true });
    await client.waitUntilSignedIn({ timeout: 5_000 });
    await client.publish("test.first", "one");
    await client.publish("test.first", "two");
    await client.publish("test.second", "three");
    expect(client.conn.connected).toBe(true);
    const disconnected = new Promise<void>((resolve) =>
      client.conn.once("disconnect", () => resolve()),
    );
    client
      .publish("test.third", "four", { timeout: 500 })
      .catch(() => undefined);
    await disconnected;
    expect(client.conn.connected).toBe(false);
    client.close();
    await server.close();
  });

  it("does not wait for interest after publication authorization is denied", async () => {
    const server = init({
      port: 0,
      getUser: async () => ({
        account_id: "test-account",
        auth_method: "api_key",
      }),
      isAllowed: async () => false,
    });
    const wait = jest.spyOn(server as any, "waitForInterest");
    const client = connect({ address: server.address(), noCache: true });
    await client.waitUntilSignedIn({ timeout: 5_000 });
    const response = await client.conn
      .timeout(2_000)
      .emitWithAck("wait-for-interest", {
        subject: "test.denied",
        timeout: 100,
      });
    expect(response.code).toBe(403);
    expect(wait).not.toHaveBeenCalled();
    client.close();
    await server.close();
  });

  it("does not deliver an API-key publication when authorization finishes after disconnect", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = init({
      port: 0,
      getUser: async (socket) => socket.handshake.auth,
      isAllowed: async ({ user, type }) => {
        if (user.auth_method === "api_key" && type === "pub") {
          entered();
          await gate;
        }
        return true;
      },
    });
    const client = connect({
      address: server.address(),
      noCache: true,
      auth: { account_id: "caller", auth_method: "api_key" },
    });
    const receiver = connect({
      address: server.address(),
      noCache: true,
      auth: { account_id: "receiver" },
    });
    await client.waitUntilSignedIn({ timeout: 5_000 });
    await receiver.waitUntilSignedIn({ timeout: 5_000 });
    const delivered = jest.fn();
    await receiver.subscribe("test.delayed", delivered);
    const pending = client
      .publish("test.delayed", "payload", { timeout: 500 })
      .catch(() => undefined);
    await started;
    client.close();
    await delay(100);
    release();
    await pending;
    await delay(100);
    expect(delivered).not.toHaveBeenCalled();
    receiver.close();
    await server.close();
  });

  it("requires a distinct link credential for authenticated clusters", () => {
    expect(() =>
      init({
        id: "authenticated",
        port: 0,
        clusterName: "credential-boundary",
        getUser: async () => ({ hub_id: "test" }),
      }),
    ).toThrow("authenticated cluster must have clusterLinkPassword set");
  });

  it.each(["fast-rpc", "request"] as const)(
    "binds source bay claims over %s",
    async (transport) => {
      const server = init({
        port: 0,
        getUser: async (socket) => socket.handshake.auth,
        isAllowed: async () => true,
      });
      const serviceClient = connect({
        address: server.address(),
        noCache: true,
        auth: { hub_id: "service" },
      });
      const callerClient = connect({
        address: server.address(),
        noCache: true,
        auth: {
          hub_id: "bay:bay-authenticated",
          cluster_id: "cluster",
          bay_id: "bay-authenticated",
          bay_credential_id: "credential",
        },
      });
      await Promise.all([
        serviceClient.waitUntilSignedIn({ timeout: 5_000 }),
        callerClient.waitUntilSignedIn({ timeout: 5_000 }),
      ]);
      const impl = jest.fn(async () => "ok");
      const service = createServiceHandler<any>({
        service: "caller-test",
        subject: `caller.test.${transport}`,
        transport,
        client: serviceClient,
        impl: { write: impl },
      });
      await delay(50);
      const api = createServiceClient<any>({
        service: "caller-test",
        subject: `caller.test.${transport}`,
        transport,
        client: callerClient,
      });

      await expect(api.write({ source_bay_id: "bay-spoofed" })).rejects.toThrow(
        "must match authenticated bay 'bay-authenticated'",
      );
      await expect(
        api.write({ source_bay_id: "bay-authenticated" }),
      ).resolves.toBe("ok");
      expect(impl).toHaveBeenCalledTimes(1);

      service.close();
      callerClient.close();
      serviceClient.close();
      await server.close();
    },
  );

  it("preserves authenticated bay identity across a distinct cluster link", async () => {
    const clusterLinkPassword = "cluster-link-secret";
    const getUser: UserFunction = async (socket: any, systemAccounts = {}) => {
      const cookie = `${socket.handshake.headers.cookie ?? ""}`;
      for (const [name, account] of Object.entries(systemAccounts)) {
        if (cookie.includes(`${name}=${account.password}`)) {
          return account.user;
        }
      }
      return socket.handshake.auth;
    };
    const forwarded: any[] = [];
    const isAllowed: AllowFunction = async (opts) => {
      if (opts.user?.hub_id === "cluster-link") {
        if (opts.type === "sub") {
          return opts.subject.startsWith("_INBOX.");
        }
        forwarded.push(opts);
        if (!opts.subject.startsWith("global.directory.rpc.")) {
          return true;
        }
        return (
          opts.type === "pub" &&
          opts.forwardedCaller?.bay_id === "bay-authenticated"
        );
      }
      return true;
    };
    const common = {
      clusterName: "caller-cluster",
      systemAccountPassword: "generic-system-secret",
      clusterLinkPassword,
      autoscanInterval: 0,
      getUser,
      isAllowed,
    };
    const sourceServer = init({ ...common, id: "source", port: 0 });
    const targetServer = init({ ...common, id: "target", port: 0 });
    const serviceClient = connect({
      address: targetServer.address(),
      noCache: true,
      auth: { hub_id: "service" },
    });
    const callerClient = connect({
      address: sourceServer.address(),
      noCache: true,
      auth: {
        hub_id: "bay:bay-authenticated",
        cluster_id: "cluster",
        bay_id: "bay-authenticated",
        bay_credential_id: "credential",
      },
    });
    await Promise.all([
      serviceClient.waitUntilSignedIn({ timeout: 5_000 }),
      callerClient.waitUntilSignedIn({ timeout: 5_000 }),
    ]);
    const genericSystemClient = connect({
      address: targetServer.address(),
      noCache: true,
      systemAccountPassword: "generic-system-secret",
    });
    await genericSystemClient.waitUntilSignedIn({ timeout: 5_000 });
    const systemOpen = await new Promise<any>((resolve) => {
      genericSystemClient.conn.emit(
        CLUSTER_INTEREST_OPEN,
        {
          protocol: CLUSTER_INTEREST_PROTOCOL,
          clusterName: "caller-cluster",
          nodeId: "forged-system-link",
        },
        resolve,
      );
    });
    expect(systemOpen).toEqual(
      expect.objectContaining({ ok: false, code: 403 }),
    );
    genericSystemClient.close();

    const directClusterLink = connect({
      address: targetServer.address(),
      noCache: true,
      extraHeaders: {
        Cookie: `${CLUSTER_LINK_COOKIE_NAME}=${clusterLinkPassword}`,
      },
    });
    await directClusterLink.waitUntilSignedIn({ timeout: 5_000 });
    const directPublish = await new Promise<any>((resolve) => {
      directClusterLink.conn.emit(
        "publish",
        ["global.directory.rpc.cluster-test"],
        resolve,
      );
    });
    expect(directPublish).toEqual(expect.objectContaining({ code: 403 }));
    directClusterLink.close();

    const impl = jest.fn(async () => "ok");
    const service = createServiceHandler<any>({
      service: "caller-test",
      subject: "global.directory.rpc.cluster-test",
      transport: "request",
      client: serviceClient,
      impl: { write: impl },
    });
    await delay(50);
    await Promise.all([
      sourceServer.join(targetServer.address(), { timeout: 5_000 }),
      targetServer.join(sourceServer.address(), { timeout: 5_000 }),
    ]);
    await delay(50);
    const api = createServiceClient<any>({
      service: "caller-test",
      subject: "global.directory.rpc.cluster-test",
      transport: "request",
      client: callerClient,
    });

    await expect(
      api.write({ source_bay_id: "bay-authenticated" }),
    ).resolves.toBe("ok");
    expect(impl).toHaveBeenCalledTimes(1);
    expect(forwarded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "global.directory.rpc.cluster-test",
          forwardedCaller: {
            cluster_id: "cluster",
            bay_id: "bay-authenticated",
            bay_credential_id: "credential",
          },
        }),
      ]),
    );

    service.close();
    callerClient.close();
    serviceClient.close();
    await sourceServer.close();
    await targetServer.close();
  }, 15_000);
});
