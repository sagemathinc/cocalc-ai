/*
054 C (H1): the bay's Conat client to a project host is socket.io over
engine.io, and BOTH engine.io transports (HTTP long-polling and websocket) open
their connection through the agent route-client passes. So a host address whose
name resolves to a refused address is refused at connect time on either.
*/

import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createProjectHostAgent } from "@cocalc/backend/project-host-target";

// The same socket.io-client the Conat client uses (from the conat package).
const { io } = require(
  require.resolve("socket.io-client", {
    paths: [join(__dirname, "..", "..", "conat")],
  }),
);

function fakeLookup(table: Record<string, string>, calls: string[]) {
  return ((hostname: string, options: any, callback: any) => {
    calls.push(hostname);
    const address = table[hostname];
    if (!address) {
      process.nextTick(
        callback,
        Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
      );
    } else if (options?.all) {
      process.nextTick(callback, null, [{ address, family: 4 }]);
    } else {
      process.nextTick(callback, null, address, 4);
    }
  }) as any;
}

describe("engine.io transports use the project host agent", () => {
  let server: http.Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("connection", () => (connections += 1));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    connections = 0;
  });

  function attempt(url: string, transport: string, agent: any): Promise<any> {
    return new Promise((resolve) => {
      const socket = io(url, {
        transports: [transport],
        agent,
        forceNew: true,
        reconnection: false,
        timeout: 3000,
      });
      socket.on("connect_error", (err: any) => {
        socket.close();
        resolve(err);
      });
      socket.on("connect", () => {
        socket.close();
        resolve(undefined);
      });
    });
  }

  for (const transport of ["polling", "websocket"]) {
    it(`${transport}: a refused name never reaches the server; an allowed one does`, async () => {
      const calls: string[] = [];
      const agent = createProjectHostAgent({
        secure: false,
        allowLoopback: true,
        lookup: fakeLookup(
          { "evil.example": "127.0.0.1", localhost: "127.0.0.1" },
          calls,
        ),
      });
      const refused = await attempt(
        `http://evil.example:${port}`,
        transport,
        agent,
      );
      expect(refused).toBeDefined();
      expect(connections).toBe(0);
      expect(calls).toContain("evil.example");
      // positive control: the same agent, an allowed name, reaches the server
      await attempt(`http://localhost:${port}`, transport, agent);
      expect(calls).toContain("localhost");
      expect(connections).toBeGreaterThan(0);
    });
  }
});
