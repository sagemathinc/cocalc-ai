import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditAppPublicReadiness,
  deleteApp,
  detectApps,
  ensureRunning,
  exposeApp,
  listAppSpecs,
  resolveAppProxyTarget,
  statusApp,
  stopApp,
  unexposeApp,
  upsertAppSpec,
  waitForAppState,
} from "./control";

const SERVICE_SCRIPT = `
const http = require("http");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("ok");
});
server.listen(port, host);
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

function appId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function cleanupApps(): Promise<void> {
  const rows = await listAppSpecs();
  for (const row of rows) {
    if (!row.spec?.id) continue;
    try {
      await deleteApp(row.spec.id);
    } catch {
      // keep cleanup best-effort for test isolation
    }
  }
}

describe("app server agent workflows", () => {
  const originalHome = process.env.HOME;
  const originalProduct = process.env.COCALC_PRODUCT;
  const testHome = mkdtempSync(join(tmpdir(), "cocalc-app-agent-workflows-"));

  beforeAll(async () => {
    process.env.HOME = testHome;
    process.env.COCALC_PRODUCT = "lite";
    await cleanupApps();
  });

  afterEach(async () => {
    await cleanupApps();
  });

  afterAll(async () => {
    await cleanupApps();
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalProduct == null) {
      delete process.env.COCALC_PRODUCT;
    } else {
      process.env.COCALC_PRODUCT = originalProduct;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  test("wake-on-demand startup and recovery via proxy resolution", async () => {
    const id = appId("wake");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });

    const before = await statusApp(id);
    expect(before.state).toBe("stopped");

    const first = await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/healthz`,
    });
    expect(first?.kind).toBe("service");
    expect((first as any)?.port).toBeGreaterThan(0);

    const running = await statusApp(id);
    expect(running.state).toBe("running");
    expect(running.ready).toBe(true);
    expect(running.pid).toBeGreaterThan(0);

    // Simulate a crash and verify proxy resolution auto-recovers the app.
    process.kill(running.pid!, "SIGKILL");
    const stopped = await waitForAppState(id, "stopped", {
      timeout: 10_000,
      interval: 100,
    });
    expect(stopped).toBe(true);

    const second = await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/healthz`,
    });
    expect(second?.kind).toBe("service");
    expect((second as any)?.port).toBeGreaterThan(0);
    const recovered = await statusApp(id);
    expect(recovered.state).toBe("running");
    expect(recovered.ready).toBe(true);
  });

  test("expose/unexpose lifecycle is auditable for agent workflows", async () => {
    const id = appId("expose");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      title: "Agent Expose Test",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });

    await ensureRunning(id, { timeout: 10_000, interval: 100 });

    const exposed = await exposeApp({
      id,
      ttl_s: 600,
      auth_front: "token",
      random_subdomain: true,
    });
    expect(exposed.exposure?.mode).toBe("public");
    expect(exposed.exposure?.auth_front).toBe("token");
    expect(exposed.exposure?.token).toBeTruthy();

    const auditPublic = await auditAppPublicReadiness(id);
    const publicCheck = auditPublic.checks.find((c) => c.id === "exposure.public");
    expect(publicCheck?.status).toBe("pass");
    expect(auditPublic.agent_prompt).toContain(`app '${id}'`);
    expect(auditPublic.suggested_actions.length).toBeGreaterThan(0);

    const privateStatus = await unexposeApp(id);
    expect(privateStatus.exposure).toBeUndefined();

    const auditPrivate = await auditAppPublicReadiness(id);
    const privateCheck = auditPrivate.checks.find((c) => c.id === "exposure.public");
    expect(privateCheck?.status).toBe("warn");
  });

  test("detect surfaces unmanaged listeners and distinguishes managed apps", async () => {
    const id = appId("detect");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      command: { exec: process.execPath, args: ["-e", SERVICE_SCRIPT] },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 15 },
    });
    const managed = await ensureRunning(id, { timeout: 10_000, interval: 100 });
    expect(managed.port).toBeGreaterThan(0);
    const managedPort = managed.port as number;

    const unmanagedServer = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const srv = createServer((_req, res) => {
        res.statusCode = 200;
        res.end("unmanaged");
      });
      srv.listen(0, "127.0.0.1", () => resolve(srv));
    });
    const unmanagedPort = (unmanagedServer.address() as any).port as number;
    expect(unmanagedPort).toBeGreaterThan(0);

    try {
      const withManaged = await detectApps({ include_managed: true, limit: 1000 });
      const managedRow = withManaged.find((x) => x.port === managedPort);
      const unmanagedRow = withManaged.find((x) => x.port === unmanagedPort);
      expect(managedRow?.managed).toBe(true);
      expect(managedRow?.managed_app_ids).toContain(id);
      expect(unmanagedRow?.managed).toBe(false);

      const unmanagedOnly = await detectApps({ include_managed: false, limit: 1000 });
      expect(unmanagedOnly.some((x) => x.port === unmanagedPort)).toBe(true);
      expect(unmanagedOnly.some((x) => x.port === managedPort)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => unmanagedServer.close(() => resolve()));
      await stopApp(id);
    }
  });

  test("static app routing and public-readiness audit are agent-usable", async () => {
    const id = appId("static");
    const root = mkdtempSync(join(testHome, "static-app-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "index.html"), "static-root-ok\n", "utf8");
    writeFileSync(join(root, "sub", "index.html"), "static-nested-ok\n", "utf8");

    await upsertAppSpec({
      version: 1,
      id,
      kind: "static",
      title: "Agent Static Test",
      static: {
        root,
        index: "index.html",
        cache_control: "public, max-age=600",
      },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    const status = await ensureRunning(id, { timeout: 10_000, interval: 100 });
    expect(status.kind).toBe("static");
    expect(status.state).toBe("running");
    expect(status.ready).toBe(true);

    const rootTarget = await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/`,
    });
    expect(rootTarget?.kind).toBe("static");
    expect((rootTarget as any)?.root).toBe(root);
    expect((rootTarget as any)?.rewritePath).toBe("/");

    const nestedTarget = await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/sub/`,
    });
    expect(nestedTarget?.kind).toBe("static");
    expect((nestedTarget as any)?.rewritePath).toBe("/sub/");

    const audit = await auditAppPublicReadiness(id);
    const cacheCheck = audit.checks.find((c) => c.id === "static.cache_control");
    expect(cacheCheck?.status).toBe("pass");

    const exposed = await exposeApp({
      id,
      ttl_s: 600,
      auth_front: "token",
      random_subdomain: true,
    });
    expect(exposed.exposure?.mode).toBe("public");

    const hidden = await unexposeApp(id);
    expect(hidden.exposure).toBeUndefined();

    await stopApp(id);
    const afterStop = await statusApp(id);
    expect(afterStop.state).toBe("running");
    expect(afterStop.kind).toBe("static");
  });
});
