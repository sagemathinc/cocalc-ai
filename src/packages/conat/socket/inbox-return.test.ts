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

import { Client, ConatError, connect, messageData } from "../core/client";
import { ConatServer, init } from "../core/server";
import { SOCKET_RETURN_HEADER } from "../core/message-headers";
import { isProjectHostApiKeySubjectAllowed } from "../auth/project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "../auth/project-host-token";
import type { ServerSocket } from "./server-socket";
import { delay } from "awaiting";
import {
  initLoadBalancer,
  getPersistServerInfo,
  getPersistServerId,
} from "../persist/load-balancer";

const subject = "terminal.project-00000000-0000-4000-8000-000000000001.0";
const prefix = "_INBOX.api-key-test";
const binding = {
  reply_prefix: prefix,
  subjects: [subject + "."],
} as ProjectHostApiKeyBinding;

describe("socket inbox-return protocol", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  async function fixture(
    expires?: number,
    clustered = false,
    serviceSubject = subject,
    scopedBinding = binding,
  ) {
    const common = {
      port: 0,
      clusterName: "socket-inbox-test",
      systemAccountPassword: "test-system-password",
      clusterLinkPassword: "test-cluster-password",
      autoscanInterval: 0,
      getUser: async (socket, systemAccounts = {}) => {
        const cookie = `${socket.handshake.headers.cookie ?? ""}`;
        for (const [name, account] of Object.entries(systemAccounts) as [
          string,
          any,
        ][]) {
          if (cookie.includes(`${name}=${account.password}`))
            return account.user;
        }
        return {
          ...socket.handshake.auth,
          ...(socket.handshake.auth.hub_id
            ? {}
            : { auth_lease_exp_s: expires }),
        };
      },
      isAllowed: async ({ user, subject, type }) => {
        if (user?.hub_id === "cluster-link")
          return type === "pub" || subject.startsWith("_INBOX.");
        return (
          Boolean(user?.hub_id) ||
          isProjectHostApiKeySubjectAllowed({
            binding: scopedBinding,
            subject,
            type,
          })
        );
      },
    };
    const broker = init({ ...common, id: "caller" });
    const targetBroker = clustered
      ? init({ ...common, id: "service" })
      : broker;
    const service = connect({
      address: targetBroker.address(),
      noCache: true,
      auth: { hub_id: "service" },
    });
    const client = connect({
      address: broker.address(),
      noCache: true,
      reconnection: false,
      auth: { account_id: "test" },
      inboxPrefix: prefix,
    });
    await service.waitUntilSignedIn({ timeout: 5000 });
    await client.waitUntilSignedIn({ timeout: 5000 });
    const listener = service.socket.listen(serviceSubject, {
      keepAlive: 0,
      keepAliveTimeout: 1000,
    });
    await listener.waitUntilReady(5000);
    if (clustered) {
      await Promise.all([
        broker.join(targetBroker.address(), { timeout: 5000 }),
        targetBroker.join(broker.address(), { timeout: 5000 }),
      ]);
    }
    return { broker, targetBroker, service, client, listener };
  }

  it.each([false, true])(
    "negotiates confined persistence sockets through load balancing (clustered=%s)",
    async (clustered) => {
      const persist = "persist.project-00000000-0000-4000-8000-000000000001";
      const { client, service, listener } = await fixture(
        undefined,
        clustered,
        persist,
        {
          ...binding,
          subjects: [persist + "."],
        },
      );
      initLoadBalancer({ client: service, ids: [listener.id] });
      await client.waitForInterest(persist + ".id", { timeout: 5000 });
      // Existing clients still receive a bare ID; feature negotiation is opt-in.
      expect((await client.request(persist + ".id", null)).data).toBe(
        listener.id,
      );
      expect(await getPersistServerInfo({ client, subject: persist })).toEqual({
        id: listener.id,
        inboxReturn: 1,
      });
      expect(await getPersistServerId({ client, subject: persist })).toBe(
        listener.id,
      );
      const accepted = new Promise<ServerSocket>((resolve) =>
        listener.once("connection", resolve),
      );
      const socket = client.socket.connect(persist, {
        keepAlive: 0,
        reconnection: false,
        loadBalancer: (subject) => getPersistServerInfo({ client, subject }),
      });
      await socket.waitUntilReady(5000);
      const serverSocket = await accepted;
      expect(serverSocket.clientSubject.startsWith(prefix + ".")).toBe(true);
      serverSocket.on("request", (message) =>
        message.respondSync("persist-response"),
      );
      expect((await socket.request(null, { timeout: 2000 })).data).toBe(
        "persist-response",
      );
      await expect(
        client.subscribe(persist + ".client.foreign"),
      ).rejects.toThrow();
      await expect(
        client.subscribe("_INBOX.account-foreign.>"),
      ).rejects.toThrow();
      await socket.closeAndWait();
      listener.close();
    },
    15000,
  );

  it("preserves broker-attested routes across a cluster link and withdraws expired interest", async () => {
    const expires = (Date.now() + 4000) / 1000;
    const { client, service, listener } = await fixture(expires, true);
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    socket.on("request", (message) =>
      message.respondSync("reverse-over-cluster"),
    );
    const serverSocket = await accepted;
    serverSocket.on("request", (message) =>
      message.respondSync("forward-over-cluster"),
    );
    await socket.waitUntilReady(5000);
    expect((await socket.request(null, { timeout: 2000 })).data).toBe(
      "forward-over-cluster",
    );
    expect((await serverSocket.request(null, { timeout: 2000 })).data).toBe(
      "reverse-over-cluster",
    );
    const streamed = new Promise((resolve) => socket.once("data", resolve));
    serverSocket.write("cross-broker-data");
    expect(await streamed).toBe("cross-broker-data");
    await delay(Math.max(0, expires * 1000 - Date.now()) + 1600);
    expect(client.conn.connected).toBe(false);
    expect(await service.interest(serverSocket.clientSubject)).toBe(false);
    expect(serverSocket.state).toBe("closed");
    socket.close();
    listener.close();
  }, 15000);

  it.each(["timeout", "service-unavailable"])(
    "does not replay an admitted request after %s",
    async (failure) => {
      const { client, listener } = await fixture();
      const accepted = new Promise<ServerSocket>((resolve) =>
        listener.once("connection", resolve),
      );
      const socket = client.socket.connect(subject, {
        keepAlive: 0,
        reconnection: true,
      });
      const serverSocket = await accepted;
      let executions = 0;
      serverSocket.on("request", (message) => {
        executions++;
        if (failure === "service-unavailable") {
          message.respondSync(null, {
            headers: { error: "unavailable after admission", code: 503 },
          });
        }
      });
      try {
        await socket.waitUntilReady(5000);
        await expect(
          socket.request({ mutation: true }, { timeout: 100 }),
        ).rejects.toMatchObject({
          code: failure === "timeout" ? 408 : 503,
        });
        expect(executions).toBe(1);
      } finally {
        socket.close();
        listener.close();
      }
    },
  );

  it("does not replay stream setup after an uncertain publish acknowledgment", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: true,
    });
    const serverSocket = await accepted;
    let executions = 0;
    let admitted = () => {};
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    serverSocket.on("request", () => {
      executions++;
      admitted();
    });
    await socket.waitUntilReady(5000);
    const publish = client.publish.bind(client);
    const fault = jest
      .spyOn(client, "publish")
      .mockImplementation(async (...args) => {
        const result = await publish(...args);
        if (args[1]?.startStream) {
          await admission;
          throw new ConatError("acknowledgment lost", { code: 408 });
        }
        return result;
      });
    try {
      await expect(
        socket.requestMany({ startStream: true }, { timeout: 500 }),
      ).rejects.toMatchObject({ code: 408 });
      expect(executions).toBe(1);
    } finally {
      fault.mockRestore();
      socket.close();
      listener.close();
    }
  });

  it("reuses an authorized return route when the logical socket reconnects", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: true,
    });
    const serverSocket = await accepted;
    serverSocket.on("request", (message) => message.respondSync(message.data));
    await socket.waitUntilReady(5000);
    const route = serverSocket.clientSubject;
    expect((await socket.request("before", { timeout: 2000 })).data).toBe(
      "before",
    );
    socket.disconnect();
    await socket.waitUntilReady(5000);
    expect((await socket.request("after", { timeout: 2000 })).data).toBe(
      "after",
    );
    expect(serverSocket.clientSubject).toBe(route);
    expect(Object.keys(listener.sockets)).toHaveLength(1);
    socket.close();
    listener.close();
  });

  it("replaces forged wire caller metadata with broker-owned return authority", async () => {
    const { client, service, listener } = await fixture();
    const destination = subject + ".probe";
    const subscription = await service.subscribe(destination);
    const payload = messageData(null);
    const forged = { socket_return: "_INBOX.foreign.socket" };
    const send = async (headers, id) =>
      await client.conn
        .timeout(3000)
        .emitWithAck("publish", [
          destination,
          id,
          0,
          1,
          payload.encoding,
          payload.raw,
          headers,
          null,
          forged,
        ]);
    expect((await send({}, "without-route")).error).toBeUndefined();
    expect(
      (await subscription.next()).value?.caller ?? undefined,
    ).toBeUndefined();
    expect(
      (
        await send(
          { [SOCKET_RETURN_HEADER]: prefix + ".socket" },
          "authorized-route",
        )
      ).error,
    ).toBeUndefined();
    expect((await subscription.next()).value?.caller).toEqual({
      socket_return: prefix + ".socket",
    });
    expect(
      await send(
        { [SOCKET_RETURN_HEADER]: forged.socket_return },
        "foreign-route",
      ),
    ).toMatchObject({ code: 403 });
    subscription.close();
    listener.close();
  });

  it("carries requests and reverse requests without broad subscriptions or inbox publication", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    socket.on("request", (message) =>
      message.respondSync({ reverse: message.data }),
    );
    const serverSocket = await accepted;
    serverSocket.on("request", (message) =>
      message.respondSync({ forward: message.data }),
    );
    await socket.waitUntilReady(5000);
    expect(serverSocket.clientSubject.startsWith(prefix + ".")).toBe(true);
    expect((await socket.request("hello", { timeout: 3000 })).data).toEqual({
      forward: "hello",
    });
    expect(
      (await serverSocket.request("world", { timeout: 3000 })).data,
    ).toEqual({ reverse: "world" });
    const received = new Promise((resolve) => socket.once("data", resolve));
    serverSocket.write("stream-data");
    expect(await received).toBe("stream-data");
    await expect(
      client.subscribe(subject + ".client.other"),
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      client.publish(prefix + ".other", null, { waitForInterest: false }),
    ).rejects.toMatchObject({ code: 403 });
    socket.close();
    listener.close();
  });

  it("rejects a nominated foreign return inbox before delivery", async () => {
    const { client, listener } = await fixture();
    await expect(
      client.publish(subject + ".server.fake.socket", null, {
        waitForInterest: false,
        headers: { [SOCKET_RETURN_HEADER]: "_INBOX.someone-else.socket" },
      }),
    ).rejects.toMatchObject({ code: 403 });
    await expect(
      client.publish(subject + ".server.fake.socket-malformed", null, {
        waitForInterest: false,
        headers: { [SOCKET_RETURN_HEADER]: prefix + ".>" },
      }),
    ).rejects.toMatchObject({ code: 400 });
    listener.close();
  });

  it.each([false, true])(
    "acknowledges server cleanup before graceful close resolves (clustered=%s)",
    async (clustered) => {
      const { client, listener } = await fixture(undefined, clustered);
      const accepted = new Promise<ServerSocket>((resolve) =>
        listener.once("connection", resolve),
      );
      const socket = client.socket.connect(subject, {
        keepAlive: 0,
        reconnection: false,
      });
      const serverSocket = await accepted;
      await socket.waitUntilReady(5000);
      const closed = jest.fn();
      serverSocket.once("closed", closed);
      await socket.closeAndWait();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(socket.state).toBe("closed");
      listener.close();
    },
  );

  it("closes locally but reports an unconfirmed graceful close", async () => {
    const { client, listener } = await fixture();
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    await socket.waitUntilReady(5000);
    const request = jest
      .spyOn(client, "request")
      .mockRejectedValueOnce(new ConatError("timeout", { code: 408 }));
    try {
      await expect(socket.closeAndWait()).rejects.toMatchObject({ code: 408 });
      expect(socket.state).toBe("closed");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
      listener.close();
    }
  });

  it("rejects pending reverse requests on close", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const serverSocket = await accepted;
    await socket.waitUntilReady(5000);
    const seen = new Promise((resolve) => socket.once("request", resolve));
    const request = serverSocket.request("unanswered", { timeout: 3000 });
    const rejected = expect(request).rejects.toMatchObject({ code: "EPIPE" });
    await seen;
    serverSocket.close();
    await rejected;
    socket.close();
    listener.close();
  });

  it("does not redirect an established socket to another authorized return inbox", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const serverSocket = await accepted;
    const handler = jest.fn((message) => message.respondSync(message.data));
    serverSocket.on("request", handler);
    await socket.waitUntilReady(5000);
    const originalRoute = serverSocket.clientSubject;
    const alternateRoute = await client.socketInboxSubject();
    const alternate = await client.subscribe(alternateRoute);
    const delivered: unknown[] = [];
    const reader = (async () => {
      for await (const message of alternate) delivered.push(message.data);
    })();
    try {
      for (const extraHeaders of [{}, { "CN-SocketCmd": "connect" }]) {
        await expect(
          client.request(socket.serverSubject(), "redirect", {
            timeout: 150,
            headers: {
              ...extraHeaders,
              [SOCKET_RETURN_HEADER]: alternateRoute,
            },
          }),
        ).rejects.toMatchObject({ code: 408 });
      }
      expect(handler).not.toHaveBeenCalled();
      expect(serverSocket.clientSubject).toBe(originalRoute);
      expect(Object.keys(listener.sockets)).toHaveLength(1);
      expect(
        (await socket.request("still-bound", { timeout: 2000 })).data,
      ).toBe("still-bound");
      const streamed = new Promise((resolve) => socket.once("data", resolve));
      serverSocket.write("original-stream");
      expect(await streamed).toBe("original-stream");
      expect(delivered).toEqual([]);
    } finally {
      alternate.close();
      await reader;
      socket.close();
      listener.close();
    }
  });

  it("fails closed if an older broker does not attest the return route", async () => {
    const { listener } = await fixture();
    await (listener as any).handleMesg({
      subject: subject + ".server." + listener.id + ".old-broker",
      headers: {
        "CN-SocketCmd": "connect",
        [SOCKET_RETURN_HEADER]: prefix + ".socket",
      },
    });
    expect(Object.keys(listener.sockets)).toHaveLength(0);
    listener.close();
  });

  it("bounds outstanding reverse requests and releases them on close", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const serverSocket = await accepted;
    await socket.waitUntilReady(5000);
    const pending = Array.from({ length: 128 }, () =>
      serverSocket
        .request("unanswered", { timeout: 5000 })
        .catch((error) => error),
    );
    await expect(
      serverSocket.request("excess", { timeout: 5000 }),
    ).rejects.toMatchObject({ code: 429 });
    serverSocket.close();
    for (const result of await Promise.all(pending))
      expect(result).toMatchObject({ code: "EPIPE" });
    socket.close();
    listener.close();
  });

  it("ignores unrecognized reverse replies and expires the pending request", async () => {
    const { client, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const serverSocket = await accepted;
    await socket.waitUntilReady(5000);
    const seen = new Promise((resolve) => socket.once("request", resolve));
    const request = serverSocket.request("unanswered", { timeout: 100 });
    const rejected = expect(request).rejects.toMatchObject({ code: 408 });
    await seen;
    serverSocket.receiveResponse({
      headers: { "CN-SocketResponseId": "not-issued" },
    } as any);
    await rejected;
    expect((serverSocket as any).pendingReplies.size).toBe(0);
    socket.close();
    listener.close();
  });

  it("preserves legacy service-subject sockets for unrestricted clients", async () => {
    const { service, listener } = await fixture();
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = service.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const discover = (socket as any).getServerId.bind(socket);
    (socket as any).getServerId = async () => {
      await discover();
      (socket as any).inboxReturn = false;
    };
    const serverSocket = await accepted;
    serverSocket.on("request", (message) => message.respondSync("legacy"));
    await socket.waitUntilReady(5000);
    expect(serverSocket.clientSubject).toBe(subject + ".client." + socket.id);
    expect((await socket.request(null, { timeout: 3000 })).data).toBe("legacy");
    socket.close();
    listener.close();
  });

  it("withdraws the return subscription and closes the logical socket after lease expiry", async () => {
    const { client, service, listener } = await fixture(
      (Date.now() + 1800) / 1000,
    );
    const accepted = new Promise<ServerSocket>((resolve) =>
      listener.once("connection", resolve),
    );
    const socket = client.socket.connect(subject, {
      keepAlive: 0,
      reconnection: false,
    });
    const serverSocket = await accepted;
    await socket.waitUntilReady(5000);
    await delay(3000);
    expect(client.conn.connected).toBe(false);
    expect(await service.interest(serverSocket.clientSubject)).toBe(false);
    expect(serverSocket.state).toBe("closed");
    socket.close();
    listener.close();
  });
});
