/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import http from "node:http";
import express from "express";
import {
  attachProjectHostHttpFallbackProxy,
  isProjectHostExternalConatRouterEnabled,
  isProjectHostManagedLocalConatRouter,
  resolveProjectHostConatRouterClusterName,
  resolveProjectHostConatRouterUrl,
  rewriteProjectHostConatProxyUrl,
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
