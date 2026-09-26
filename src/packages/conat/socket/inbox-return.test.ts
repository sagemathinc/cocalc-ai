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

import { Client, connect } from "../core/client";
import { ConatServer, init } from "../core/server";
import { SOCKET_RETURN_HEADER } from "../core/message-headers";
import { isProjectHostApiKeySubjectAllowed } from "../auth/project-host-api-key-policy";
import type { ProjectHostApiKeyBinding } from "../auth/project-host-token";
import type { ServerSocket } from "./server-socket";
import { delay } from "awaiting";

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

  async function fixture(expires?: number) {
    const broker = init({
      port: 0,
      getUser: async (socket) => ({
        ...socket.handshake.auth,
        ...(socket.handshake.auth.hub_id ? {} : { auth_lease_exp_s: expires }),
      }),
      isAllowed: async ({ user, subject, type }) =>
        user?.hub_id === "service" ||
        isProjectHostApiKeySubjectAllowed({ binding, subject, type }),
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
      inboxPrefix: prefix,
    });
    await service.waitUntilSignedIn({ timeout: 5000 });
    await client.waitUntilSignedIn({ timeout: 5000 });
    const listener = service.socket.listen(subject, {
      keepAlive: 0,
      keepAliveTimeout: 1000,
    });
    await listener.waitUntilReady(5000);
    return { broker, service, client, listener };
  }

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
