jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    silly: jest.fn(),
  }),
}));

import { randomBytes } from "crypto";
import { delay } from "awaiting";
import { once } from "@cocalc/util/async-utils";
import { connect, Client } from "./client";
import { init, ConatServer } from "./server";
import type { ConnectionStats } from "./types";

function makeUserFromHandshake(socket): {
  account_id?: string;
  project_id?: string;
  hub_id?: string;
} {
  const auth = socket?.handshake?.auth ?? {};
  const account_id =
    typeof auth.account_id === "string" ? auth.account_id.trim() : undefined;
  const project_id =
    typeof auth.project_id === "string" ? auth.project_id.trim() : undefined;
  const hub_id =
    typeof auth.hub_id === "string" ? auth.hub_id.trim() : undefined;
  return {
    ...(account_id ? { account_id } : {}),
    ...(project_id ? { project_id } : {}),
    ...(hub_id ? { hub_id } : {}),
  };
}

async function waitFor<T>(
  label: string,
  fn: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value != null) {
      return value;
    }
    await delay(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function findSocketByBrowserId(
  snapshot: { [id: string]: ConnectionStats },
  browser_id: string,
): { socket_id: string; stats: ConnectionStats } | undefined {
  for (const [socket_id, stats] of Object.entries(snapshot)) {
    if (stats.browser_id === browser_id) {
      return { socket_id, stats };
    }
  }
}

function findSocketByAccountId(
  snapshot: { [id: string]: ConnectionStats },
  account_id: string,
): { socket_id: string; stats: ConnectionStats } | undefined {
  for (const [socket_id, stats] of Object.entries(snapshot)) {
    if (stats.user?.account_id === account_id) {
      return { socket_id, stats };
    }
  }
}

function findSocketByProjectId(
  snapshot: { [id: string]: ConnectionStats },
  project_id: string,
): { socket_id: string; stats: ConnectionStats } | undefined {
  for (const [socket_id, stats] of Object.entries(snapshot)) {
    if (stats.user?.project_id === project_id) {
      return { socket_id, stats };
    }
  }
}

function egressDeltaBytes(
  before: ConnectionStats | undefined,
  after: ConnectionStats | undefined,
): number {
  const beforeBytes = Math.max(0, before?.egress?.bytes ?? 0);
  const afterBytes = Math.max(0, after?.egress?.bytes ?? 0);
  return afterBytes >= beforeBytes ? afterBytes - beforeBytes : afterBytes;
}

describe("core server authenticated browser egress integration", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  it("attributes outbound bytes to the authenticated browser-facing socket, not the publisher", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) => makeUserFromHandshake(socket),
    });
    const browser = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "browser-account",
        browser_id: "browser-one",
      },
    });
    const publisher = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "malicious-publisher",
        browser_id: "spoofed-origin-browser",
        project_id: "project-origin",
      },
    });

    await Promise.all([
      browser.waitUntilSignedIn({ timeout: 5000 }),
      publisher.waitUntilSignedIn({ timeout: 5000 }),
    ]);

    const sub = await browser.subscribe("egress.integration.single");
    const before = server.getStatsSnapshot();
    const beforeBrowser = findSocketByBrowserId(before, "browser-one");
    const beforePublisher = findSocketByAccountId(
      before,
      "malicious-publisher",
    );
    expect(beforeBrowser?.stats.user?.account_id).toBe("browser-account");
    expect(beforeBrowser?.stats.browser_id).toBe("browser-one");
    expect(beforePublisher?.stats.user?.account_id).toBe("malicious-publisher");

    const payload = randomBytes(160_000).toString("base64url");
    const publishResult = await publisher.publish(
      "egress.integration.single",
      payload,
    );
    expect(publishResult.count).toBe(1);

    const received = (await sub.next()).value;
    expect(received?.data).toBe(payload);

    const afterBrowser = await waitFor("browser egress delta", () => {
      const snapshot = server.getStatsSnapshot();
      const current = findSocketByBrowserId(snapshot, "browser-one");
      if (!current) return;
      return egressDeltaBytes(beforeBrowser?.stats, current.stats) >
        Buffer.byteLength(payload)
        ? current
        : undefined;
    });

    const afterSnapshot = server.getStatsSnapshot();
    const afterPublisher = findSocketByAccountId(
      afterSnapshot,
      "malicious-publisher",
    );
    const browserDelta = egressDeltaBytes(
      beforeBrowser?.stats,
      afterBrowser.stats,
    );
    const publisherDelta = egressDeltaBytes(
      beforePublisher?.stats,
      afterPublisher?.stats,
    );

    expect(browserDelta).toBeGreaterThan(Buffer.byteLength(payload));
    expect(afterBrowser.stats.user?.account_id).toBe("browser-account");
    expect(afterBrowser.stats.browser_id).toBe("browser-one");
    expect(publisherDelta).toBeLessThan(10_000);

    sub.close();
    browser.close();
    publisher.close();
    await server.close();
  });

  it("counts fanout once per authenticated browser socket", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) => makeUserFromHandshake(socket),
    });
    const browserA = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "account-a",
        browser_id: "browser-a",
      },
    });
    const browserB = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "account-b",
        browser_id: "browser-b",
      },
    });
    const publisher = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "publisher-account",
      },
    });

    await Promise.all([
      browserA.waitUntilSignedIn({ timeout: 5000 }),
      browserB.waitUntilSignedIn({ timeout: 5000 }),
      publisher.waitUntilSignedIn({ timeout: 5000 }),
    ]);

    const subA = await browserA.subscribe("egress.integration.fanout");
    const subB = await browserB.subscribe("egress.integration.fanout");

    const before = server.getStatsSnapshot();
    const beforeA = findSocketByBrowserId(before, "browser-a");
    const beforeB = findSocketByBrowserId(before, "browser-b");

    const payload = randomBytes(96_000);
    const publishResult = await publisher.publish(
      "egress.integration.fanout",
      payload,
    );
    expect(publishResult.count).toBe(2);

    const [recvA, recvB] = await Promise.all([subA.next(), subB.next()]);
    expect(Buffer.compare(recvA.value.data, payload)).toBe(0);
    expect(Buffer.compare(recvB.value.data, payload)).toBe(0);

    const afterA = await waitFor("browser-a egress delta", () => {
      const snapshot = server.getStatsSnapshot();
      const current = findSocketByBrowserId(snapshot, "browser-a");
      if (!current) return;
      return egressDeltaBytes(beforeA?.stats, current.stats) > payload.length
        ? current
        : undefined;
    });
    const afterB = await waitFor("browser-b egress delta", () => {
      const snapshot = server.getStatsSnapshot();
      const current = findSocketByBrowserId(snapshot, "browser-b");
      if (!current) return;
      return egressDeltaBytes(beforeB?.stats, current.stats) > payload.length
        ? current
        : undefined;
    });

    const deltaA = egressDeltaBytes(beforeA?.stats, afterA.stats);
    const deltaB = egressDeltaBytes(beforeB?.stats, afterB.stats);

    expect(deltaA).toBeGreaterThan(payload.length);
    expect(deltaB).toBeGreaterThan(payload.length);
    expect(deltaA + deltaB).toBeGreaterThan(payload.length * 2);

    subA.close();
    subB.close();
    browserA.close();
    browserB.close();
    publisher.close();
    await server.close();
  });

  it("counts terminal-like socket traffic on the authenticated browser-facing connection", async () => {
    const server = init({
      port: 0,
      getUser: async (socket) => makeUserFromHandshake(socket),
    });
    const projectClient = connect({
      address: server.address(),
      noCache: true,
      auth: {
        project_id: "project-scope",
      },
    });
    const browser = connect({
      address: server.address(),
      noCache: true,
      auth: {
        account_id: "browser-account",
        browser_id: "browser-terminal",
      },
    });

    await Promise.all([
      projectClient.waitUntilSignedIn({ timeout: 5000 }),
      browser.waitUntilSignedIn({ timeout: 5000 }),
    ]);

    const socketServer = projectClient.socket.listen(
      "socket.egress.integration",
      {
        keepAlive: 0,
      },
    );
    const browserSocket = browser.socket.connect("socket.egress.integration", {
      reconnection: false,
      keepAlive: 0,
    });
    const serverSocketPromise = once(socketServer, "connection", 5000);
    await browserSocket.waitUntilReady(5000);
    const [serverSocket] = await serverSocketPromise;

    const before = server.getStatsSnapshot();
    const beforeBrowser = findSocketByBrowserId(before, "browser-terminal");
    const beforeProject = findSocketByAccountId(before, "browser-account");
    const beforeProjectScope = findSocketByProjectId(before, "project-scope");
    expect(beforeBrowser?.stats.user?.account_id).toBe("browser-account");
    expect(beforeProjectScope?.stats.user?.project_id).toBe("project-scope");

    const payload = randomBytes(140_000).toString("base64url");
    const receivedPromise = once(browserSocket, "data", 5000);
    serverSocket.write(payload);
    const [received] = await receivedPromise;
    expect(received).toBe(payload);

    const afterBrowser = await waitFor("browser socket egress delta", () => {
      const snapshot = server.getStatsSnapshot();
      const current = findSocketByBrowserId(snapshot, "browser-terminal");
      if (!current) return;
      return egressDeltaBytes(beforeBrowser?.stats, current.stats) >
        Buffer.byteLength(payload)
        ? current
        : undefined;
    });
    const afterSnapshot = server.getStatsSnapshot();
    const afterProjectScope = findSocketByProjectId(
      afterSnapshot,
      "project-scope",
    );
    const browserDelta = egressDeltaBytes(
      beforeBrowser?.stats,
      afterBrowser.stats,
    );
    const projectScopeDelta = egressDeltaBytes(
      beforeProjectScope?.stats,
      afterProjectScope?.stats,
    );

    expect(beforeProject?.socket_id).toBe(beforeBrowser?.socket_id);
    expect(browserDelta).toBeGreaterThan(Buffer.byteLength(payload));
    expect(projectScopeDelta).toBeLessThan(10_000);

    browserSocket.close();
    socketServer.close();
    browser.close();
    projectClient.close();
    await server.close();
  });
});
