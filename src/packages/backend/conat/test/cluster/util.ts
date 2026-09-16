import { initConatServer } from "@cocalc/backend/conat/test/setup";
import type { Options, ConatServer } from "@cocalc/conat/core/server";
import type { Client } from "@cocalc/conat/core/client";

export async function createClusterNode(
  opts: {
    clusterName: string;
    id: string;
  } & Options,
): Promise<{ server: ConatServer; client: Client }> {
  const server = await initConatServer({
    // disable autoscan so we can precisely control connections when building clusters for unit testing.
    autoscanInterval: 0,
    systemAccountPassword: "foo",
    clusterLinkPassword: "cluster-link-secret",
    getUser: async (socket, systemAccounts = {}) => {
      const cookie = `${socket.handshake.headers.cookie ?? ""}`;
      for (const [name, account] of Object.entries(systemAccounts)) {
        if (cookie.includes(`${name}=${account.password}`)) {
          return account.user;
        }
      }
      return undefined;
    },
    ...opts,
  });
  const client = server.client({ systemAccountPassword: "foo" });
  await client.waitUntilSignedIn();
  return { server, client };
}
