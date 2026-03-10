import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_PROXY_AUTH_HEADER } from "@cocalc/backend/auth/project-proxy-auth";
import { APP_PROXY_EXPOSURE_HEADER } from "@cocalc/backend/auth/app-proxy";

const SERVICE_SCRIPT = `
const http = require("http");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 0);
const server = http.createServer((_req, res) => {
  const body = "metrics-ok\\n";
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
});
server.listen(port, host);
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

function appId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{
  statusCode?: number;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
  });
}

describe("managed app metrics", () => {
  const originalHome = process.env.HOME;
  const originalSecretPath = process.env.COCALC_SECRET_TOKEN;
  const originalTestMode = process.env.COCALC_TEST_MODE;
  const testHome = mkdtempSync(join(tmpdir(), "cocalc-app-metrics-"));
  const secretPath = join(testHome, "secret-token");
  const secretValue = "metrics-secret-token";

  beforeAll(() => {
    process.env.HOME = testHome;
    process.env.COCALC_SECRET_TOKEN = secretPath;
    delete process.env.COCALC_TEST_MODE;
    writeFileSync(secretPath, secretValue, "utf8");
  });

  afterAll(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSecretPath == null) delete process.env.COCALC_SECRET_TOKEN;
    else process.env.COCALC_SECRET_TOKEN = originalSecretPath;
    if (originalTestMode == null) delete process.env.COCALC_TEST_MODE;
    else process.env.COCALC_TEST_MODE = originalTestMode;
    rmSync(testHome, { recursive: true, force: true });
  });

  test("records per-app private/public HTTP metrics through the project proxy", async () => {
    jest.resetModules();
    const { project_id, secretToken } = await import("@cocalc/project/data");
    const { startProxyServer } =
      await import("@cocalc/project/servers/proxy/proxy");
    const { deleteApp, ensureRunning, upsertAppSpec } =
      await import("./control");

    expect(secretToken).toBeTruthy();

    const id = appId("metrics");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });

    const server = await startProxyServer({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    const proxyPort =
      address && typeof address === "object" ? address.port : undefined;
    expect(proxyPort).toBeGreaterThan(0);

    try {
      await ensureRunning(id, { timeout: 10_000, interval: 100 });

      const privateRes = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(privateRes.statusCode).toBe(200);
      expect(privateRes.body).toContain("metrics-ok");

      const publicRes = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
          [APP_PROXY_EXPOSURE_HEADER]: "public",
        },
      );
      expect(publicRes.statusCode).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 2200));
      jest.resetModules();
      const { appMetrics } = await import("./control");
      const summary = await appMetrics(id, { minutes: 60 });
      expect(summary.totals.requests).toBe(2);
      expect(summary.totals.private_requests).toBe(1);
      expect(summary.totals.public_requests).toBe(1);
      expect(summary.totals.bytes_sent).toBeGreaterThan(0);
      expect(summary.history.length).toBeGreaterThan(0);
      expect(summary.last_hit_ms).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(id);
    }
  });

  test("records managed app metrics for direct /port routes", async () => {
    jest.resetModules();
    const { project_id, secretToken } = await import("@cocalc/project/data");
    const { startProxyServer } =
      await import("@cocalc/project/servers/proxy/proxy");
    const {
      appMetrics,
      deleteApp,
      ensureRunning,
      managedServiceAppForPort,
      upsertAppSpec,
    } = await import("./control");

    expect(secretToken).toBeTruthy();

    const id = appId("metrics-port");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: {
        base_path: `/apps/${id}`,
        strip_prefix: true,
        websocket: false,
        open_mode: "port",
      },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });

    const server = await startProxyServer({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    const proxyPort =
      address && typeof address === "object" ? address.port : undefined;
    expect(proxyPort).toBeGreaterThan(0);

    try {
      const status = await ensureRunning(id, {
        timeout: 10_000,
        interval: 100,
      });
      expect(status.port).toBeGreaterThan(0);
      await expect(managedServiceAppForPort(status.port!)).resolves.toEqual({
        app_id: id,
        kind: "service",
      });

      const viaPort = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/port/${status.port}/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(viaPort.statusCode).toBe(200);
      expect(viaPort.body).toContain("metrics-ok");

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const summary = await appMetrics(id, { minutes: 60 });
      expect(summary.totals.requests).toBe(1);
      expect(summary.totals.private_requests).toBe(1);
      expect(summary.totals.bytes_sent).toBeGreaterThan(0);
      expect(summary.last_hit_ms).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(id);
    }
  });

  test("records managed app metrics for direct /proxy routes", async () => {
    jest.resetModules();
    const { project_id, secretToken } = await import("@cocalc/project/data");
    const { startProxyServer } =
      await import("@cocalc/project/servers/proxy/proxy");
    const { appMetrics, deleteApp, ensureRunning, upsertAppSpec } =
      await import("./control");

    expect(secretToken).toBeTruthy();

    const id = appId("metrics-proxy");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: {
        base_path: `/apps/${id}`,
        strip_prefix: true,
        websocket: false,
        open_mode: "proxy",
      },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });

    const server = await startProxyServer({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    const proxyPort =
      address && typeof address === "object" ? address.port : undefined;
    expect(proxyPort).toBeGreaterThan(0);

    try {
      const status = await ensureRunning(id, {
        timeout: 10_000,
        interval: 100,
      });
      expect(status.port).toBeGreaterThan(0);

      const viaProxy = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/proxy/${status.port}/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(viaProxy.statusCode).toBe(200);
      expect(viaProxy.body).toContain("metrics-ok");

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const summary = await appMetrics(id, { minutes: 60 });
      expect(summary.totals.requests).toBe(1);
      expect(summary.totals.private_requests).toBe(1);
      expect(summary.totals.bytes_sent).toBeGreaterThan(0);
      expect(summary.last_hit_ms).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(id);
    }
  });
});
