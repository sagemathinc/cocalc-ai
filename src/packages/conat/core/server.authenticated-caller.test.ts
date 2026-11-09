/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const logged: unknown[][] = [];
jest.mock("@cocalc/conat/logger", () => {
  const log = (...args: unknown[]) => {
    logged.push(args);
  };
  return {
    getLogger: () => ({
      debug: log,
      info: log,
      warn: log,
      error: log,
      silly: log,
    }),
  };
});

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
  isFederatedBrokerLossPrincipal,
  type AllowFunction,
  type UserFunction,
} from "./server";
import { createServiceClient, createServiceHandler } from "../service/typed";
import { fileMutationAuthority } from "../files/mutation-authority";
import { DataEncoding } from "./codec";

describe("authenticated Conat caller metadata", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it.each([true, false])(
    "replaces forged mutation caller metadata (scoped key: %s)",
    async (key) => {
      const principal = {
        account_id: "account",
        auth_api_key: {
          account_id: "account",
          key_id: "key",
          scope_revision: 1,
          project_id: "project",
          placement_revision: 0,
          capabilities: ["file:write" as const],
          subjects: ["fs.project-project"],
          reply_prefix: "_INBOX.first",
        },
      };
      const server = init({
        port: 0,
        getUser: async (socket) =>
          socket.handshake.auth.key ? principal : { hub_id: "service" },
        isAllowed: async () => true,
      });
      const receiver = connect({ address: server.address(), noCache: true });
      const sender = connect({
        address: server.address(),
        noCache: true,
        auth: { key },
      });
      await receiver.waitUntilSignedIn({ timeout: 5_000 });
      await sender.waitUntilSignedIn({ timeout: 5_000 });
      const subscription = await receiver.subscribe("fs.project-project");
      const response = await sender.conn
        .timeout(5_000)
        .emitWithAck("publish", [
          "fs.project-project",
          "receipt-test",
          0,
          1,
          DataEncoding.JsonCodec,
          Buffer.from("null"),
          undefined,
          undefined,
          { file_mutation_authority: "forged", bay_id: "forged" },
        ]);
      expect(response?.error).toBeUndefined();
      expect((await subscription.next()).value?.caller ?? undefined).toEqual(
        key
          ? {
              file_mutation_authority: fileMutationAuthority(principal),
            }
          : undefined,
      );
    },
  );

  const BROKER_ID = "109876543210987654321";
  it.each([
    [
      "a verified broker",
      { hub_id: "federated-broker", federated_broker_signer_id: BROKER_ID },
      {
        federated_broker_signer_id: BROKER_ID,
        federated_broker_connection_id:
          expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      },
    ],
    [
      "a broker id mixed with a bay identity",
      {
        hub_id: "federated-broker",
        federated_broker_signer_id: BROKER_ID,
        cluster_id: "c",
        bay_id: "b",
        bay_credential_id: "k",
      },
      undefined,
    ],
    [
      "a broker id mixed with an account",
      { federated_broker_signer_id: BROKER_ID, account_id: "a" },
      undefined,
    ],
    [
      "a malformed broker id",
      { hub_id: "federated-broker", federated_broker_signer_id: "0123456" },
      undefined,
    ],
    [
      "a numeric broker id",
      { hub_id: "federated-broker", federated_broker_signer_id: 1234567 },
      undefined,
    ],
    [
      "a bay (unchanged)",
      { hub_id: "bay:b", cluster_id: "c", bay_id: "b", bay_credential_id: "k" },
      { cluster_id: "c", bay_id: "b", bay_credential_id: "k" },
    ],
    ["a plain hub (unchanged)", { hub_id: "service" }, undefined],
  ])(
    "stamps %s from its authentication, never from the message",
    async (_label, principal, expected) => {
      const server = init({
        port: 0,
        getUser: async (socket) =>
          socket.handshake.auth.key
            ? (principal as any)
            : { hub_id: "receiver" },
        isAllowed: async () => true,
      });
      const receiver = connect({ address: server.address(), noCache: true });
      const sender = connect({
        address: server.address(),
        noCache: true,
        auth: { key: true },
      });
      await receiver.waitUntilSignedIn({ timeout: 5_000 });
      await sender.waitUntilSignedIn({ timeout: 5_000 });
      const subscription = await receiver.subscribe("broker.test.subject");
      const response = await sender.conn.timeout(5_000).emitWithAck("publish", [
        "broker.test.subject",
        "broker-stamp-test",
        0,
        1,
        DataEncoding.JsonCodec,
        Buffer.from("null"),
        undefined,
        undefined,
        {
          federated_broker_signer_id: "999999999999999999999",
          federated_broker_connection_id: "AAAAAAAAAAAAAAAAAAAAAA",
          federated_broker_transport_lost: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      ]);
      expect(response?.error).toBeUndefined();
      expect((await subscription.next()).value?.caller ?? undefined).toEqual(
        expected,
      );
    },
  );

  it.each([
    ["the Hub API subject", true],
    ["any other subject", false],
  ])(
    "stamps the caller's own auth session only on %s",
    async (_label, hubApi) => {
      const account_id = "00000000-0000-4000-8000-000000000001";
      const subject = hubApi
        ? `hub.account.${account_id}.api`
        : `test.account.${account_id}.api`;
      const server = init({
        port: 0,
        getUser: async (socket) =>
          socket.handshake.auth.key
            ? { account_id, auth_session_hash: "own-session" }
            : { hub_id: "service" },
        isAllowed: async () => true,
      });
      const receiver = connect({ address: server.address(), noCache: true });
      const sender = connect({
        address: server.address(),
        noCache: true,
        auth: { key: true },
      });
      await receiver.waitUntilSignedIn({ timeout: 5_000 });
      await sender.waitUntilSignedIn({ timeout: 5_000 });
      const subscription = await receiver.subscribe(subject);
      const response = await sender.conn
        .timeout(5_000)
        .emitWithAck("publish", [
          subject,
          "session-test",
          0,
          1,
          DataEncoding.JsonCodec,
          Buffer.from("null"),
          undefined,
          undefined,
          { account_id, auth_session_hash: "forged-session" },
        ]);
      expect(response?.error).toBeUndefined();
      expect((await subscription.next()).value?.caller ?? undefined).toEqual(
        hubApi ? { account_id, auth_session_hash: "own-session" } : undefined,
      );
    },
  );

  it("stamps a null session for an account connection without one", async () => {
    const account_id = "00000000-0000-4000-8000-000000000001";
    const subject = `hub.account.${account_id}.api`;
    const server = init({
      port: 0,
      getUser: async (socket) =>
        socket.handshake.auth.key
          ? { account_id, auth_method: "api_key" }
          : { hub_id: "service" },
      isAllowed: async () => true,
    });
    const receiver = connect({ address: server.address(), noCache: true });
    const sender = connect({
      address: server.address(),
      noCache: true,
      auth: { key: true },
    });
    await receiver.waitUntilSignedIn({ timeout: 5_000 });
    await sender.waitUntilSignedIn({ timeout: 5_000 });
    const subscription = await receiver.subscribe(subject);
    await sender.publish(subject, { auth_session_hash: "forged-session" });
    expect((await subscription.next()).value?.caller).toEqual({
      account_id,
      auth_session_hash: null,
    });
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

  describe("the broker's connection id and transport loss (G3b design v3.4.2)", () => {
    const LOSS = "broker.cluster-1.transport-lost.v1";

    async function setup(isAllowed: AllowFunction = async () => true) {
      const brokers: any[] = [];
      const server = init({
        port: 0,
        getUser: async (socket) => {
          if (!socket.handshake.auth.key) return { hub_id: "receiver" };
          const user = {
            hub_id: "federated-broker",
            federated_broker_signer_id: BROKER_ID,
            auth_lease_exp_s: Math.floor(Date.now() / 1000) + 3600,
          };
          brokers.push(user);
          return user;
        },
        isAllowed,
        federatedBrokerLossSubject: LOSS,
      });
      const receiver = connect({ address: server.address(), noCache: true });
      await receiver.waitUntilSignedIn({ timeout: 5_000 });
      const broker = () =>
        connect({
          address: server.address(),
          noCache: true,
          auth: { key: true },
          reconnection: false,
        });
      return { server, receiver, broker, brokers };
    }

    async function stampOf(receiver: Client, sender: Client) {
      const sub = await receiver.subscribe("broker.test.stamp");
      await sender.publish("broker.test.stamp", null);
      const caller = (await sub.next()).value?.caller;
      sub.close();
      return caller;
    }

    it("mints a different id per socket, kept off the user object", async () => {
      const t = await setup();
      const a = t.broker();
      const b = t.broker();
      await a.waitUntilSignedIn({ timeout: 5_000 });
      await b.waitUntilSignedIn({ timeout: 5_000 });
      const ca = await stampOf(t.receiver, a);
      const cb = await stampOf(t.receiver, b);
      expect(ca.federated_broker_connection_id).not.toBe(
        cb.federated_broker_connection_id,
      );
      for (const user of t.brokers) {
        expect(Object.keys(user).sort()).toEqual([
          "auth_lease_exp_s",
          "federated_broker_signer_id",
          "hub_id",
        ]);
      }
      const ids = [
        ca.federated_broker_connection_id,
        cb.federated_broker_connection_id,
      ];
      const surfaces = JSON.stringify([
        t.brokers,
        (t.server as any).stats,
        t.server.getStatsSnapshot(),
        t.server.getUsage(),
        logged,
      ]);
      for (const id of ids) expect(surfaces).not.toContain(id);
    });

    it("keeps the id out of a permission-denied error", async () => {
      const t = await setup(async ({ subject }) => subject !== "broker.denied");
      const a = t.broker();
      await a.waitUntilSignedIn({ timeout: 5_000 });
      const { federated_broker_connection_id: id } = await stampOf(
        t.receiver,
        a,
      );
      const err = await a
        .publish("broker.denied", null)
        .then(() => undefined)
        .catch((e) => e);
      expect(`${err?.message ?? ""}`).toContain("permission denied");
      expect(`${err?.message ?? ""}`).not.toContain(id);
      expect(JSON.stringify(logged)).not.toContain(id);
    });

    it("publishes exactly one loss event, stamped with that connection's id only, when the broker socket closes", async () => {
      const seen: any[] = [];
      const t = await setup(async ({ user, subject, type }) => {
        if (isFederatedBrokerLossPrincipal(user)) {
          seen.push({ json: JSON.stringify(user), subject, type });
        }
        return true;
      });
      const a = t.broker();
      await a.waitUntilSignedIn({ timeout: 5_000 });
      const { federated_broker_connection_id: id } = await stampOf(
        t.receiver,
        a,
      );
      const loss = await t.receiver.subscribe(LOSS);
      a.close();
      const msg = (await loss.next()).value;
      expect(msg.caller).toEqual({ federated_broker_transport_lost: id });
      expect(msg.data).toBeNull();
      expect(seen).toEqual([{ json: "{}", subject: LOSS, type: "pub" }]);
      // Only one.
      const second = await Promise.race([
        loss.next().then(() => "more"),
        delay(300).then(() => "none"),
      ]);
      expect(second).toBe("none");
      expect(JSON.stringify(logged)).not.toContain(id);
    });

    it("publishes nothing for a non-broker socket", async () => {
      const t = await setup();
      const loss = await t.receiver.subscribe(LOSS);
      const other = connect({ address: t.server.address(), noCache: true });
      await other.waitUntilSignedIn({ timeout: 5_000 });
      other.close();
      const got = await Promise.race([
        loss.next().then(() => "loss"),
        delay(500).then(() => "none"),
      ]);
      expect(got).toBe("none");
    });
  });
});
