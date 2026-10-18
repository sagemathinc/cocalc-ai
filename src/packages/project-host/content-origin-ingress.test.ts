/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The conat-router ingress, wired as startStandaloneProjectHostConatRouter
// wires it, must never route a content hostname to the conat router or answer
// it itself, whatever PROJECT_HOST_PUBLIC_URL and the content domain are set
// to.  Two local upstreams record what reaches them.

jest.mock(
  "@cocalc/conat/auth/project-content-capability",
  () => jest.requireActual("../conat/auth/project-content-capability"),
  { virtual: true },
);

import express from "express";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { attachProjectHostIngress } from "./conat-router";

const CONTENT_HOST =
  "0123456789abcdef0123456789abcdef.h-fedcba9876543210fedcba9876543210.usercontent.example.org";

function upstream() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end("upstream");
  });
  server.on("upgrade", (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  return { server, seen };
}

const port = (server: http.Server) => (server.address() as AddressInfo).port;

describe.each([
  ["no PROJECT_HOST_PUBLIC_URL, no content domain", {}],
  [
    "public URL and content domain set",
    {
      PROJECT_HOST_PUBLIC_URL: "https://host-1.example.org",
      COCALC_PROJECT_CONTENT_DOMAIN: "usercontent.example.org",
    },
  ],
])("router ingress with %s", (_label, env: Record<string, string>) => {
  const saved = { ...process.env };
  let conat: ReturnType<typeof upstream>;
  let main: ReturnType<typeof upstream>;
  let ingress: http.Server;

  beforeEach(async () => {
    delete process.env.PROJECT_HOST_PUBLIC_URL;
    delete process.env.COCALC_PROJECT_CONTENT_DOMAIN;
    Object.assign(process.env, env);
    conat = upstream();
    main = upstream();
    conat.server.listen(0, "127.0.0.1");
    main.server.listen(0, "127.0.0.1");
    await Promise.all([once(conat.server, "listening"), once(main.server, "listening")]);
    const app = express();
    ingress = http.createServer(app);
    attachProjectHostIngress({
      app,
      httpServers: [ingress],
      conatTarget: `http://127.0.0.1:${port(conat.server)}`,
      upstreamUrl: `http://127.0.0.1:${port(main.server)}`,
      hostId: "fedcba98-7654-4321-8edc-ba9876543210",
    });
    ingress.listen(0, "127.0.0.1");
    await once(ingress, "listening");
  });

  afterEach(async () => {
    process.env = saved;
    for (const s of [ingress, conat.server, main.server]) {
      s.closeAllConnections?.();
      await new Promise((r) => s.close(() => r(undefined)));
    }
  });

  const get = (path: string, host = CONTENT_HOST) =>
    new Promise<string>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: port(ingress), path, headers: { host } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        })
        .on("error", reject);
    });

  const upgrade = (path: string) =>
    new Promise<string>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: port(ingress),
        path,
        headers: { host: CONTENT_HOST, connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", (res) => resolve(`response ${res.statusCode}`));
      req.on("error", () => resolve("closed"));
      req.on("close", () => resolve("closed"));
      req.end();
    });

  it("sends content-hostname HTTP only to the main server, never the router", async () => {
    expect(await get("/_c/x/files/a.html")).toBe("upstream");
    expect(await get("/conat/?EIO=4&transport=polling")).toBe("upstream");
    expect(await get("/healthz")).toBe("upstream");
    expect(conat.seen).toEqual([]);
    expect(main.seen).toEqual([
      "GET /_c/x/files/a.html",
      "GET /conat/?EIO=4&transport=polling",
      "GET /healthz",
    ]);
  });

  it("refuses websocket upgrades on content hostnames at the ingress", async () => {
    expect(await upgrade("/conat/?EIO=4&transport=websocket")).toBe("closed");
    expect(await upgrade("/_c/x/files/a")).toBe("closed");
    expect(conat.seen).toEqual([]);
    expect(main.seen).toEqual([]);
  });

  it("still answers /healthz itself on other hostnames", async () => {
    expect(await get("/healthz", "localhost")).toContain("host_id");
    expect(main.seen).toEqual([]);
  });
});
