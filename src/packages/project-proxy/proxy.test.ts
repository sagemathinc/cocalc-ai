/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import http from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import type { AddressInfo, Server } from "node:net";
import express from "express";
import { attachProjectProxy, createProxyHandlers } from "./proxy";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

async function closeServer(server: Server | http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("project proxy upstream boundary metering", () => {
  it.each(["ingress", "project"])(
    "propagates an upstream stream abort through the %s proxy",
    async (mode) => {
      const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("before-expiry");
        const timer = setTimeout(() => res.destroy(), 50);
        res.once("close", () => clearTimeout(timer));
      });
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const resolveTarget = () => ({
        handled: true,
        target: {
          host: "127.0.0.1",
          port: (upstream.address() as AddressInfo).port,
        },
      });
      const app = express();
      const server = http.createServer(app);
      if (mode === "ingress") {
        const { handleRequest } = createProxyHandlers({ resolveTarget });
        app.use((req, res) => void handleRequest(req, res));
      } else {
        attachProjectProxy({ httpServer: server, app, resolveTarget });
      }
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const result = await new Promise<{ state: string; body: string }>(
          (resolve) => {
            let body = "";
            const req = http.get({
              host: "127.0.0.1",
              port: (server.address() as AddressInfo).port,
              path: `/${PROJECT_ID}/proxy/8080/stream`,
            });
            const timer = setTimeout(() => {
              resolve({ state: "timeout", body });
              req.destroy();
            }, 1000);
            const finish = (state: string) => {
              clearTimeout(timer);
              resolve({ state, body });
            };
            req.on("error", () => finish("request-error"));
            req.on("response", (res) => {
              res.on("data", (chunk) => (body += chunk));
              res.on("aborted", () => finish("aborted"));
              res.on("error", () => finish("response-error"));
              res.on("end", () => finish("ended"));
            });
          },
        );
        expect(result).toEqual({ state: "aborted", body: "before-expiry" });
      } finally {
        server.closeAllConnections();
        upstream.closeAllConnections();
        await closeServer(server);
        await closeServer(upstream);
      }
    },
  );

  it.each(["expired", "closed", "serialization"])(
    "does not forward parsed JSON after delayed resolution (%s)",
    async (mode) => {
      let connections = 0;
      let requests = 0;
      const upstream = http.createServer((_req, res) => {
        requests++;
        res.end("unexpected");
      });
      upstream.on("connection", () => connections++);
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const app = express();
      app.use(express.json());
      const server = http.createServer(app);
      let deadline = Infinity;
      let resolved!: () => void;
      const resolution = new Promise<void>((resolve) => (resolved = resolve));
      attachProjectProxy({
        httpServer: server,
        app,
        assertForwardAllowed: () => {
          if (Date.now() >= deadline) {
            throw Object.assign(new Error("authorization expired"), {
              statusCode: 403,
            });
          }
        },
        resolveTarget: async (req, res) => {
          expect((req as any).body).toEqual({ mutation: true });
          deadline = Date.now() + 20;
          if (mode === "closed") res!.destroy();
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (mode === "closed") deadline = Infinity;
          if (mode === "serialization") {
            deadline = Infinity;
            (req as any).body.toJSON = () => {
              deadline = Date.now() - 1;
              return { mutation: true };
            };
          }
          resolved();
          return {
            handled: true,
            target: {
              host: "127.0.0.1",
              port: (upstream.address() as AddressInfo).port,
            },
          };
        },
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const result = await new Promise<number | string>((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: (server.address() as AddressInfo).port,
              path: `/${PROJECT_ID}/proxy/8080/`,
              method: "POST",
              headers: { "content-type": "application/json" },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode!));
            },
          );
          req.on("error", (err: NodeJS.ErrnoException) => {
            if (mode !== "expired") resolve(err.code!);
            else reject(err);
          });
          req.end(JSON.stringify({ mutation: true }));
        });
        await resolution;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(result).toBe(mode === "expired" ? 403 : "ECONNRESET");
        expect(requests).toBe(0);
        if (mode !== "serialization") expect(connections).toBe(0);
      } finally {
        await closeServer(server);
        await closeServer(upstream);
      }
    },
  );

  it("supports an early host-first dispatcher for reserved outer paths", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ source: "private-app", url: req.url }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    let earlyHandler:
      | ((
          req: http.IncomingMessage,
          res: http.ServerResponse,
          next: express.NextFunction,
        ) => Promise<void>)
      | undefined;
    app.use((req, res, next) => {
      if (req.headers.host !== "dev.example.com" || !earlyHandler) {
        return next();
      }
      req.url = `/${PROJECT_ID}/apps/dev-site${req.url}`;
      void earlyHandler(req, res, next);
    });
    app.get("/healthz", (_req, res) => {
      res.json({ source: "outer-project-host" });
    });
    const server = http.createServer(app);
    const handlers = attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
    });
    earlyHandler = handlers.handleRequest;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port: proxyPort,
              path: "/healthz",
              headers: { host: "dev.example.com" },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              res.on("end", () =>
                resolve(Buffer.concat(chunks).toString("utf8")),
              );
            },
          )
          .on("error", reject);
      });
      expect(JSON.parse(body)).toEqual({
        source: "private-app",
        url: `/${PROJECT_ID}/apps/dev-site/healthz`,
      });
    } finally {
      await closeServer(server);
      await closeServer(upstream);
    }
  });

  it("attaches websocket upgrades to every ingress listener", async () => {
    const upstreamCookies: Array<string | undefined> = [];
    const upstream = http.createServer();
    upstream.on("upgrade", (req, socket) => {
      upstreamCookies.push(req.headers.cookie);
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n\r\n",
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const servers = [http.createServer(app), http.createServer(app)];
    attachProjectProxy({
      httpServers: servers,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
    });
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }

    try {
      for (const server of servers) {
        const port = (server.address() as AddressInfo).port;
        const client = connect({ host: "127.0.0.1", port });
        await once(client, "connect");
        client.write(
          `GET /${PROJECT_ID}/port/9999/ HTTP/1.1\r\n` +
            "Host: 127.0.0.1\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Cookie: cocalc_project_host_session=edge-secret; app_session=keep-me\r\n\r\n",
        );
        const [chunk] = (await once(client, "data")) as [Buffer];
        expect(chunk.toString("utf8")).toContain("101 Switching Protocols");
        client.destroy();
      }
      expect(upstreamCookies).toEqual([
        "app_session=keep-me",
        "app_session=keep-me",
      ]);
    } finally {
      for (const server of servers) await closeServer(server);
      await closeServer(upstream);
    }
  });

  it("forwards JSON bodies already parsed by Express middleware", async () => {
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString("utf8"),
            contentLength: req.headers["content-length"],
          }),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    app.use(express.json());
    const server = http.createServer(app);
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const payload = JSON.stringify({ method: "client_init" });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `/${PROJECT_ID}/proxy/6006/rpc/client_init`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

    expect(JSON.parse(body)).toEqual({
      method: "POST",
      body: payload,
      contentLength: `${Buffer.byteLength(payload)}`,
    });

    await closeServer(server);
    await closeServer(upstream);
  });

  it("reports upstream HTTP response bytes", async () => {
    const payload = Buffer.from("hello over http");
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(payload);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const server = http.createServer(app);
    const noteUpstreamHttpBytes = jest.fn();
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
      noteUpstreamHttpBytes,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const body = await new Promise<Buffer>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: `/${PROJECT_ID}/port/9999/`,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        )
        .on("error", reject);
    });

    expect(body).toEqual(payload);
    expect(noteUpstreamHttpBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: payload.length,
      }),
    );

    await closeServer(server);
    await closeServer(upstream);
  });

  it("reports upstream websocket bytes", async () => {
    const payload = Buffer.from("hello over websocket");
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "\r\n",
      );
      socket.write(payload);
      socket.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const server = http.createServer(app);
    const noteUpstreamWsBytes = jest.fn();
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
      noteUpstreamWsBytes,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const client = connect({ host: "127.0.0.1", port: proxyPort });
    await once(client, "connect");
    const received: Buffer[] = [];
    client.on("data", (chunk) => received.push(Buffer.from(chunk)));
    const callbackDone = new Promise<void>((resolve) => {
      noteUpstreamWsBytes.mockImplementation(() => resolve());
    });
    client.write(
      `GET /${PROJECT_ID}/port/9999/ HTTP/1.1\r\n` +
        "Host: 127.0.0.1\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n",
    );
    await callbackDone;
    await once(client, "close");

    expect(Buffer.concat(received).includes(payload)).toBe(true);
    expect(noteUpstreamWsBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: payload.length,
      }),
    );

    await closeServer(server);
    await closeServer(upstream);
  });
});

describe("project proxy forwarded app redirects", () => {
  it("normalizes forwarded HTTPS host and port headers for upstream apps", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          proto: req.headers["x-forwarded-proto"],
          host: req.headers["x-forwarded-host"],
          port: req.headers["x-forwarded-port"],
        }),
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const server = http.createServer(app);
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: `/${PROJECT_ID}/proxy/6006/`,
            headers: {
              Host: "host-example.cocalc.ai:80",
              "X-Forwarded-Proto": "https",
              "X-Forwarded-Port": "80",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () =>
              resolve(Buffer.concat(chunks).toString("utf8")),
            );
          },
        )
        .on("error", reject);
    });

    expect(JSON.parse(body)).toEqual({
      proto: "https",
      host: "host-example.cocalc.ai",
      port: "443",
    });

    await closeServer(server);
    await closeServer(upstream);
  });

  it("removes invalid https port 80 from upstream Location headers", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location:
          "https://host-example.cocalc.ai:80/11111111-1111-4111-8111-111111111111/proxy/6006/unsupported_browser.htm",
      });
      res.end("");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const server = http.createServer(app);
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const location = await new Promise<string | undefined>(
      (resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port: proxyPort,
              path: `/${PROJECT_ID}/proxy/6006/`,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.headers.location));
            },
          )
          .on("error", reject);
      },
    );

    expect(location).toBe(
      "https://host-example.cocalc.ai/11111111-1111-4111-8111-111111111111/proxy/6006/unsupported_browser.htm",
    );

    await closeServer(server);
    await closeServer(upstream);
  });

  it("applies caller-specific response rewriting after normalization", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, {
        Location:
          "https://host-example.cocalc.ai:80/11111111-1111-4111-8111-111111111111/apps/dev-site/",
      });
      res.end("");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const app = express();
    const server = http.createServer(app);
    const normalizedLocations: Array<string | undefined> = [];
    const rewriteResponse = jest.fn((proxyRes: http.IncomingMessage) => {
      normalizedLocations.push(proxyRes.headers.location);
      proxyRes.headers.location = "/rewritten";
    });
    attachProjectProxy({
      httpServer: server,
      app,
      resolveTarget: async () => ({
        handled: true,
        target: { host: "127.0.0.1", port: upstreamPort },
      }),
      rewriteResponse,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxyPort = (server.address() as AddressInfo).port;

    const location = await new Promise<string | undefined>(
      (resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port: proxyPort,
              path: `/${PROJECT_ID}/apps/dev-site/`,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.headers.location));
            },
          )
          .on("error", reject);
      },
    );

    expect(rewriteResponse).toHaveBeenCalledTimes(1);
    expect(normalizedLocations).toEqual([
      "https://host-example.cocalc.ai/11111111-1111-4111-8111-111111111111/apps/dev-site/",
    ]);
    expect(location).toBe("/rewritten");

    await closeServer(server);
    await closeServer(upstream);
  });
});
