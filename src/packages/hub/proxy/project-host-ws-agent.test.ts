/*
054 C (H1): the real http-proxy-3 web and websocket paths open their upstream
connection through the agent the hub passes, so a target name that resolves to
a refused address never reaches the upstream server.
*/

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import httpProxy from "http-proxy-3";
import { createProjectHostAgent } from "@cocalc/backend/project-host-target";
import { endProxyError } from "./project-host";

function fakeLookup(table: Record<string, string>) {
  return ((hostname: string, options: any, callback: any) => {
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

describe("http-proxy-3 with the project host agent", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamConnections = 0;
  let upgrades = 0;
  let front: http.Server;
  let frontPort: number;
  let targetName = "evil.example";
  const proxy = httpProxy.createProxyServer({ ws: true });
  // the hub's own handler
  proxy.on("error", endProxyError as any);
  const agent = createProjectHostAgent({
    secure: false,
    allowLoopback: true,
    lookup: fakeLookup({ "evil.example": "127.0.0.1", localhost: "127.0.0.1" }),
  });

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => res.end("upstream"));
    upstream.on("connection", () => (upstreamConnections += 1));
    upstream.on("upgrade", (_req, socket) => {
      upgrades += 1;
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = (upstream.address() as AddressInfo).port;

    front = http.createServer((req, res) => {
      proxy.web(req, res, {
        target: `http://${targetName}:${upstreamPort}`,
        prependPath: false,
        agent,
      });
    });
    front.on("upgrade", (req, socket, head) => {
      proxy.ws(req, socket, head, {
        target: `http://${targetName}:${upstreamPort}`,
        prependPath: false,
        agent,
      });
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    frontPort = (front.address() as AddressInfo).port;
  });

  afterAll(async () => {
    front.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise((r) => front.close(r));
    await new Promise((r) => upstream.close(r));
  });

  beforeEach(() => {
    upstreamConnections = 0;
    upgrades = 0;
  });

  function upgrade(): Promise<string> {
    return new Promise((resolve) => {
      const s = net.connect(frontPort, "127.0.0.1", () => {
        s.write(
          "GET /conat/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      let data = "";
      s.on("data", (c) => (data += c));
      s.on("close", () => resolve(data));
      s.on("error", () => resolve(data));
      setTimeout(() => s.destroy(), 3000);
    });
  }

  function get(): Promise<number | string> {
    return new Promise((resolve) => {
      const req = http
        .get(`http://127.0.0.1:${frontPort}/x`, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        })
        .on("error", (err: any) => resolve(err.code));
      // a request the proxy leaves open must fail the test, not hang it
      req.setTimeout(2000, () => {
        resolve("left open");
        req.destroy();
      });
    });
  }

  it("a refused target: neither the web nor the websocket path reaches upstream", async () => {
    targetName = "evil.example";
    expect(await get()).toBe(502);
    const data = await upgrade();
    expect(data).not.toMatch(/101 Switching Protocols/);
    expect(upstreamConnections).toBe(0);
    expect(upgrades).toBe(0);
  });

  it("an allowed target (positive control): both paths reach upstream", async () => {
    targetName = "localhost";
    expect(await get()).toBe(200);
    const data = await upgrade();
    expect(data).toMatch(/101 Switching Protocols/);
    expect(upgrades).toBe(1);
  });
});
