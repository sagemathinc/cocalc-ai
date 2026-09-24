/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import http from "node:http";
import express from "express";
import {
  attachProjectHostHttpFallbackProxy,
  attachProjectHostConatRouterProxy,
  deriveProjectHostConatClusterLinkPassword,
  examHostnameFromProjectHostPublicUrl,
  isProjectHostExternalConatRouterEnabled,
  isProjectHostManagedLocalConatRouter,
  projectHostConatRouterHealthState,
  resolveProjectHostConatRouterClusterName,
  resolveProjectHostConatRouterUrl,
  resolveProjectHostDirectHttpsConfig,
  rewriteProjectHostConatProxyUrl,
  shouldRouteProjectHostIngressToApp,
} from "./conat-router";

async function requestJson({
  url,
  headers,
}: {
  url: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode ?? 0,
          body: JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("project-host conat router helpers", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST;
    delete process.env.COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME;
    delete process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOST;
    delete process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT;
    delete process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOSTNAME;
    delete process.env.PROJECT_HOST_INTERNAL_URL;
    delete process.env.PROJECT_HOST_PUBLIC_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("always uses the managed local router daemon", () => {
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER;
    expect(isProjectHostExternalConatRouterEnabled()).toBe(true);

    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "0";
    expect(isProjectHostExternalConatRouterEnabled()).toBe(true);
  });

  it("resolves the managed local router url from the local port", () => {
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT = "9922";
    expect(resolveProjectHostConatRouterUrl()).toBe("http://127.0.0.1:9922");
  });

  it("allows only the derived local router url", () => {
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST = "127.0.0.1";
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT = "9922";
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL = "http://127.0.0.1:9922";
    expect(isProjectHostManagedLocalConatRouter()).toBe(true);

    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL =
      "https://router.example:9922";
    expect(() => resolveProjectHostConatRouterUrl()).toThrow(
      /does not support an external conat router/i,
    );
  });

  it("requires managed local router port bootstrap config", () => {
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    expect(() => resolveProjectHostConatRouterUrl()).toThrow(
      /requires COCALC_PROJECT_HOST_CONAT_ROUTER_PORT/i,
    );
  });

  it("defaults router cluster naming only when local clustering is enabled", () => {
    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 1,
      }),
    ).toBeUndefined();

    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 3,
      }),
    ).toBe("project-host-router-host-123");

    process.env.COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME = "explicit-cluster";
    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 2,
      }),
    ).toBe("explicit-cluster");
  });

  it("derives a stable, domain-separated local cluster credential", () => {
    const systemPassword = "host-system-secret";
    const clusterPassword =
      deriveProjectHostConatClusterLinkPassword(systemPassword);

    expect(clusterPassword).toBe(
      deriveProjectHostConatClusterLinkPassword(systemPassword),
    );
    expect(clusterPassword).not.toBe(systemPassword);
    expect(clusterPassword).not.toBe(
      deriveProjectHostConatClusterLinkPassword("another-system-secret"),
    );
    expect(() => deriveProjectHostConatClusterLinkPassword("")).toThrow(
      /system account password is required/i,
    );
  });

  it("identifies the project host on router and ingress health responses", () => {
    expect(projectHostConatRouterHealthState("host-123", true)).toEqual({
      ok: true,
      ready: true,
      host_id: "host-123",
    });
    expect(projectHostConatRouterHealthState("host-123", false)).toEqual({
      ok: false,
      ready: false,
      host_id: "host-123",
    });
  });

  it("binds configured direct HTTPS ingress publicly by default", () => {
    process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT = "443";
    process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOSTNAME =
      "host-123.example.com";
    expect(resolveProjectHostDirectHttpsConfig()).toEqual({
      host: "0.0.0.0",
      port: 443,
      hostname: "host-123.example.com",
    });

    process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_HOST = "127.0.0.1";
    expect(resolveProjectHostDirectHttpsConfig()?.host).toBe("127.0.0.1");
  });

  it("derives the direct HTTPS certificate hostname from the public URL", () => {
    process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT = "443";
    process.env.PROJECT_HOST_PUBLIC_URL = "https://host-123.example.com/base";
    expect(resolveProjectHostDirectHttpsConfig()?.hostname).toBe(
      "host-123.example.com",
    );
  });

  it("rejects invalid direct HTTPS ports", () => {
    process.env.COCALC_PROJECT_HOST_DIRECT_HTTPS_PORT = "65536";
    expect(() => resolveProjectHostDirectHttpsConfig()).toThrow(
      /1 through 65535/,
    );
  });

  it("rewrites proxied conat urls down to the router path", () => {
    expect(rewriteProjectHostConatProxyUrl("/conat/?EIO=4")).toBe(
      "/conat/?EIO=4",
    );
    expect(rewriteProjectHostConatProxyUrl("/host/base/conat/?EIO=4")).toBe(
      "/conat/?EIO=4",
    );
    expect(rewriteProjectHostConatProxyUrl("/api/not-conat")).toBeUndefined();
    expect(
      rewriteProjectHostConatProxyUrl("/host/base/conat/socket"),
    ).toBeUndefined();
    expect(
      rewriteProjectHostConatProxyUrl(
        "/11111111-1111-4111-8111-111111111111/apps/dev-site/conat/",
      ),
    ).toBeUndefined();
  });

  it("routes only custom DNS hostnames through the app ingress", () => {
    process.env.PROJECT_HOST_PUBLIC_URL =
      "https://host-123.example.com/ignored";
    process.env.PROJECT_HOST_INTERNAL_URL =
      "http://host-123.projecthosts.internal:9002";
    const request = (host: string) => ({ headers: { host } });

    expect(
      shouldRouteProjectHostIngressToApp(request("host-123.example.com")),
    ).toBe(false);
    expect(
      shouldRouteProjectHostIngressToApp(request("HOST-123.EXAMPLE.COM.:443")),
    ).toBe(false);
    expect(
      shouldRouteProjectHostIngressToApp(request("exam-123.example.com")),
    ).toBe(false);
    expect(
      shouldRouteProjectHostIngressToApp(request("dev-123.example.com")),
    ).toBe(true);
    expect(
      shouldRouteProjectHostIngressToApp(request("exam-other.example.com")),
    ).toBe(true);
    expect(
      shouldRouteProjectHostIngressToApp(
        request("host-123.projecthosts.internal:9002"),
      ),
    ).toBe(false);
    expect(shouldRouteProjectHostIngressToApp(request("localhost:9002"))).toBe(
      false,
    );
    expect(shouldRouteProjectHostIngressToApp(request("127.0.0.1"))).toBe(
      false,
    );
    expect(shouldRouteProjectHostIngressToApp(request("[::1]:9002"))).toBe(
      false,
    );

    delete process.env.PROJECT_HOST_PUBLIC_URL;
    expect(
      shouldRouteProjectHostIngressToApp(request("dev-123.example.com")),
    ).toBe(false);
  });

  it("derives the paired exam hostname from the public host URL", () => {
    expect(
      examHostnameFromProjectHostPublicUrl(
        "https://host-123.example.com/some/path",
      ),
    ).toBe("exam-123.example.com");
    expect(
      examHostnameFromProjectHostPublicUrl("https://custom.example.com"),
    ).toBeUndefined();
  });

  it("gives a custom hostname its root Conat HTTP namespace", async () => {
    process.env.PROJECT_HOST_PUBLIC_URL = "https://host-123.example.com";
    const conatApp = express();
    conatApp.get("/conat/", (_req, res) => {
      res.json({ source: "outer-conat" });
    });
    const conatServer = http.createServer(conatApp);
    conatServer.listen(0, "127.0.0.1");
    await once(conatServer, "listening");
    const conatPort = (conatServer.address() as AddressInfo).port;

    const upstreamApp = express();
    upstreamApp.use((req, res) => {
      res.json({ source: "project-host-upstream", url: req.url });
    });
    const upstreamServer = http.createServer(upstreamApp);
    upstreamServer.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const ingressApp = express();
    const ingressServer = http.createServer(ingressApp);
    attachProjectHostConatRouterProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${conatPort}`,
    });
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${upstreamPort}`,
    });
    ingressServer.listen(0, "127.0.0.1");
    await once(ingressServer, "listening");
    const ingressPort = (ingressServer.address() as AddressInfo).port;

    try {
      expect(
        await requestJson({
          url: `http://127.0.0.1:${ingressPort}/conat/`,
          headers: { host: "host-123.example.com" },
        }),
      ).toEqual({
        statusCode: 200,
        body: { source: "outer-conat" },
      });
      expect(
        await requestJson({
          url: `http://127.0.0.1:${ingressPort}/conat/`,
          headers: { host: "dev-123.example.com" },
        }),
      ).toEqual({
        statusCode: 200,
        body: { source: "project-host-upstream", url: "/conat/" },
      });
      expect(
        await requestJson({
          url: `http://127.0.0.1:${ingressPort}/conat/`,
          headers: { host: "exam-123.example.com" },
        }),
      ).toEqual({
        statusCode: 200,
        body: { source: "outer-conat" },
      });
    } finally {
      await new Promise<void>((resolve) =>
        ingressServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) => conatServer.close(() => resolve()));
    }
  });

  it("gives a custom hostname its root Conat WebSocket namespace", async () => {
    process.env.PROJECT_HOST_PUBLIC_URL = "https://host-123.example.com";
    const createUpgradeServer = (source: string) => {
      const server = http.createServer();
      server.on("upgrade", (req, socket) => {
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `X-Proxy-Source: ${source}\r\n` +
            `X-Proxy-Browser-Session: ${req.headers.cookie?.includes("cocalc_project_host_session=browser-session") ? "yes" : "no"}\r\n\r\n`,
        );
      });
      return server;
    };
    const conatServer = createUpgradeServer("outer-conat");
    conatServer.listen(0, "127.0.0.1");
    await once(conatServer, "listening");
    const conatPort = (conatServer.address() as AddressInfo).port;
    const upstreamServer = createUpgradeServer("project-host-upstream");
    upstreamServer.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const ingressApp = express();
    const ingressServer = http.createServer(ingressApp);
    attachProjectHostConatRouterProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${conatPort}`,
    });
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${upstreamPort}`,
    });
    ingressServer.listen(0, "127.0.0.1");
    await once(ingressServer, "listening");
    const ingressPort = (ingressServer.address() as AddressInfo).port;

    const requestUpgrade = async (host: string): Promise<string> => {
      const client = connect({ host: "127.0.0.1", port: ingressPort });
      await once(client, "connect");
      client.write(
        "GET /conat/?EIO=4&transport=websocket HTTP/1.1\r\n" +
          `Host: ${host}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Cookie: cocalc_project_host_session=browser-session\r\n" +
          "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
      const [chunk] = (await once(client, "data")) as [Buffer];
      client.destroy();
      return chunk.toString("utf8");
    };

    try {
      const hostResponse = (
        await requestUpgrade("host-123.example.com")
      ).toLowerCase();
      expect(hostResponse).toContain("x-proxy-source: outer-conat");
      expect(hostResponse).toContain("x-proxy-browser-session: yes");
      expect(
        (await requestUpgrade("dev-123.example.com")).toLowerCase(),
      ).toContain("x-proxy-source: project-host-upstream");
      expect(
        (await requestUpgrade("exam-123.example.com")).toLowerCase(),
      ).toContain("x-proxy-source: outer-conat");
    } finally {
      await new Promise<void>((resolve) =>
        ingressServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) => conatServer.close(() => resolve()));
    }
  });

  it("lets a host-routed app own its native Conat path", async () => {
    const conatApp = express();
    conatApp.get("/conat/", (_req, res) => {
      res.json({ source: "outer-conat" });
    });
    const conatServer = http.createServer(conatApp);
    conatServer.listen(0, "127.0.0.1");
    await once(conatServer, "listening");
    const conatPort = (conatServer.address() as AddressInfo).port;

    const ingressApp = express();
    const ingressServer = http.createServer(ingressApp);
    attachProjectHostConatRouterProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${conatPort}`,
      rewriteIngressRequest: async (req) => {
        if (req.headers.host === "dev.example.com") {
          req.url = `/11111111-1111-4111-8111-111111111111/apps/dev-site${req.url}`;
        }
      },
    });
    ingressApp.use((req, res) => {
      res.json({ source: "private-app", url: req.url });
    });
    ingressServer.listen(0, "127.0.0.1");
    await once(ingressServer, "listening");
    const ingressPort = (ingressServer.address() as AddressInfo).port;

    try {
      expect(
        await requestJson({
          url: `http://127.0.0.1:${ingressPort}/conat/`,
          headers: { host: "dev.example.com" },
        }),
      ).toEqual({
        statusCode: 200,
        body: {
          source: "private-app",
          url: "/11111111-1111-4111-8111-111111111111/apps/dev-site/conat/",
        },
      });
    } finally {
      await new Promise<void>((resolve) =>
        ingressServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) => conatServer.close(() => resolve()));
    }
  });

  it("attaches conat upgrades to every ingress listener", () => {
    const app = express();
    const servers = [http.createServer(app), http.createServer(app)];
    attachProjectHostConatRouterProxy({
      app,
      httpServers: servers,
      target: "http://127.0.0.1:9999",
    });
    expect(servers[0].listenerCount("upgrade")).toBe(1);
    expect(servers[1].listenerCount("upgrade")).toBe(1);
  });

  it("attaches fallback upgrades to every ingress listener", () => {
    const app = express();
    const servers = [http.createServer(app), http.createServer(app)];
    attachProjectHostHttpFallbackProxy({
      app,
      httpServers: servers,
      target: "http://127.0.0.1:9999",
    });
    expect(servers[0].listenerCount("upgrade")).toBe(1);
    expect(servers[1].listenerCount("upgrade")).toBe(1);
  });

  it("proxies non-conat ingress traffic to the project-host app upstream", async () => {
    const upstreamApp = express();
    upstreamApp.get("/app", (_req, res) => {
      res.json({ ok: true, source: "project-host-upstream" });
    });
    const upstreamServer = http.createServer(upstreamApp);
    upstreamServer.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const ingressApp = express();
    const ingressServer = http.createServer(ingressApp);
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${upstreamPort}`,
    });
    ingressServer.listen(0, "127.0.0.1");
    await once(ingressServer, "listening");
    const ingressPort = (ingressServer.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${ingressPort}/app`);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({
        ok: true,
        source: "project-host-upstream",
      });
    } finally {
      await new Promise<void>((resolve) =>
        ingressServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
    }
  });

  it("preserves project-host auth cookies on the fallback ingress proxy", async () => {
    const upstreamApp = express();
    upstreamApp.get("/app", (req, res) => {
      res.json({ cookie: req.headers.cookie ?? null });
    });
    const upstreamServer = http.createServer(upstreamApp);
    upstreamServer.listen(0, "127.0.0.1");
    await once(upstreamServer, "listening");
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    const ingressApp = express();
    const ingressServer = http.createServer(ingressApp);
    attachProjectHostHttpFallbackProxy({
      app: ingressApp,
      httpServer: ingressServer,
      target: `http://127.0.0.1:${upstreamPort}`,
    });
    ingressServer.listen(0, "127.0.0.1");
    await once(ingressServer, "listening");
    const ingressPort = (ingressServer.address() as AddressInfo).port;

    try {
      const res = await requestJson({
        url: `http://127.0.0.1:${ingressPort}/app`,
        headers: {
          Cookie: [
            "cocalc_project_host_http_bearer=bearer-cookie",
            "cocalc_project_host_http_session=http-session-cookie",
            "cocalc_project_host_session=browser-session-cookie",
            "other_cookie=kept",
          ].join("; "),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        cookie: [
          "cocalc_project_host_http_bearer=bearer-cookie",
          "cocalc_project_host_http_session=http-session-cookie",
          "cocalc_project_host_session=browser-session-cookie",
          "other_cookie=kept",
        ].join("; "),
      });
    } finally {
      await new Promise<void>((resolve) =>
        ingressServer.close(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
    }
  });
});
