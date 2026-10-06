/*
Socket.IO never reconnects after the server disconnects a client or rejects its
authentication. Clients created with reconnectAfterServerDisconnect (the
inter-bay fabric) must come back on their own; other clients must stay down.

pnpm test `pwd`/server-disconnect-reconnect.test.ts
*/

import getPort from "@cocalc/backend/get-port";
import { initConatServer } from "@cocalc/backend/conat/test/setup";
import { wait } from "@cocalc/backend/conat/test/util";
import { connect, type Client } from "@cocalc/conat/core/client";
import { delay } from "awaiting";

jest.setTimeout(30_000);

describe("reconnect after a server-initiated disconnect", () => {
  let server;
  let rejectAuth = false;
  const clients: Client[] = [];

  const newClient = (reconnectAfterServerDisconnect?: boolean) => {
    const client = connect({
      address: server.address(),
      noCache: true,
      reconnectAfterServerDisconnect,
    });
    clients.push(client);
    return client;
  };

  const socketIdsFor = (client: Client) =>
    Object.keys(server.getStatsSnapshot()).filter(
      (id) => id === client.conn.id,
    );

  it("starts a server whose authentication can be made to fail", async () => {
    server = await initConatServer({
      port: await getPort(),
      getUser: async () => {
        if (rejectAuth) throw Error("registry unavailable for test");
        return { hub_id: "hub" };
      },
    });
  });

  it("reconnects a client the server disconnected", async () => {
    const client = newClient(true);
    await client.waitUntilSignedIn({ timeout: 10_000 });
    const firstId = client.conn.id;
    server.disconnectSockets(socketIdsFor(client));
    await wait({ timeout: 5_000, until: () => client.conn.id !== firstId });
    await client.waitUntilSignedIn({ timeout: 10_000 });
    expect(client.state).toBe("connected");
    expect(client.info?.user?.hub_id).toBe("hub");
  });

  it("keeps retrying through rejected authentication until it succeeds", async () => {
    const client = newClient(true);
    await client.waitUntilSignedIn({ timeout: 10_000 });
    rejectAuth = true;
    server.disconnectSockets(socketIdsFor(client));
    // Let several reconnect attempts fail authentication.
    await delay(1_500);
    expect(client.info?.user?.error).toContain("registry unavailable");
    rejectAuth = false;
    await wait({
      timeout: 10_000,
      until: () =>
        client.state === "connected" && client.info?.user?.hub_id === "hub",
    });
  });

  it("waits through rejected handshakes when signing in for the first time", async () => {
    // e.g., a bay starting while the seed's registry is unavailable: its
    // services wait to sign in instead of failing startup.
    rejectAuth = true;
    const client = newClient(true);
    const signedIn = client.waitUntilSignedIn({ timeout: 15_000 });
    await delay(1_500);
    rejectAuth = false;
    await signedIn;
    expect(client.info?.user?.hub_id).toBe("hub");
  });

  it("still fails sign-in at once for other clients", async () => {
    rejectAuth = true;
    try {
      const client = newClient();
      await expect(
        client.waitUntilSignedIn({ timeout: 10_000 }),
      ).rejects.toThrow("failed to sign in");
    } finally {
      rejectAuth = false;
    }
  });

  it("leaves other clients disconnected, as before", async () => {
    const client = newClient();
    await client.waitUntilSignedIn({ timeout: 10_000 });
    server.disconnectSockets(socketIdsFor(client));
    await wait({
      timeout: 5_000,
      until: () => client.state === "disconnected",
    });
    await delay(1_500);
    expect(client.state).toBe("disconnected");
  });

  it("stops retrying once closed", async () => {
    const client = newClient(true);
    await client.waitUntilSignedIn({ timeout: 10_000 });
    server.disconnectSockets(socketIdsFor(client));
    client.close();
    await delay(1_000);
    expect(client.conn.connected).toBe(false);
  });

  it("clean up", async () => {
    for (const client of clients) client.close();
    await server?.close();
  });
});
