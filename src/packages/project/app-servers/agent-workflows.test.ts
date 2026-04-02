import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appLogs,
  auditAppPublicReadiness,
  deleteApp,
  detectApps,
  ensureRunning,
  exposeApp,
  listAppSpecs,
  refreshApp,
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
    const publicCheck = auditPublic.checks.find(
      (c) => c.id === "exposure.public",
    );
    expect(publicCheck?.status).toBe("pass");
    expect(auditPublic.agent_prompt).toContain(`app '${id}'`);
    expect(auditPublic.suggested_actions.length).toBeGreaterThan(0);

    const privateStatus = await unexposeApp(id);
    expect(privateStatus.exposure).toBeUndefined();

    const auditPrivate = await auditAppPublicReadiness(id);
    const privateCheck = auditPrivate.checks.find(
      (c) => c.id === "exposure.public",
    );
    expect(privateCheck?.status).toBe("warn");
  });

  test("detect surfaces unmanaged listeners and distinguishes managed apps", async () => {
    const id = appId("detect");
    const unmanagedId = appId("unmanaged");
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

    const unmanagedServer = await new Promise<ReturnType<typeof createServer>>(
      (resolve) => {
        const srv = createServer((_req, res) => {
          res.statusCode = 200;
          res.end("unmanaged");
        });
        srv.listen(0, "127.0.0.1", () => resolve(srv));
      },
    );
    const unmanagedPort = (unmanagedServer.address() as any).port as number;
    expect(unmanagedPort).toBeGreaterThan(0);

    try {
      const withManaged = await detectApps({
        include_managed: true,
        limit: 1000,
      });
      const managedRow = withManaged.find((x) => x.port === managedPort);
      const unmanagedRow = withManaged.find((x) => x.port === unmanagedPort);
      expect(managedRow?.managed).toBe(true);
      expect(managedRow?.managed_app_ids).toContain(id);
      expect(unmanagedRow?.managed).toBe(false);

      const unmanagedOnly = await detectApps({
        include_managed: false,
        limit: 1000,
      });
      expect(unmanagedOnly.some((x) => x.port === unmanagedPort)).toBe(true);
      expect(unmanagedOnly.some((x) => x.port === managedPort)).toBe(false);

      await upsertAppSpec({
        version: 1,
        id: unmanagedId,
        kind: "service",
        title: "Detected Unmanaged Server",
        command: {
          exec: "bash",
          args: [
            "-lc",
            "echo 'This app is unmanaged. Start it outside CoCalc.' >&2; exit 1",
          ],
        },
        lifecycle: {
          mode: "unmanaged",
        },
        network: {
          listen_host: "127.0.0.1",
          port: unmanagedPort,
          protocol: "http",
        },
        proxy: {
          base_path: `/apps/${unmanagedId}`,
          strip_prefix: true,
          websocket: false,
        },
        wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
      });

      const unmanagedStatus = await statusApp(unmanagedId);
      expect(unmanagedStatus.lifecycle_mode).toBe("unmanaged");
      expect(unmanagedStatus.state).toBe("running");
      expect(unmanagedStatus.ready).toBe(true);
      expect(unmanagedStatus.port).toBe(unmanagedPort);
      expect(unmanagedStatus.url).toBe(`/apps/${unmanagedId}/`);

      const tracked = await detectApps({
        include_managed: true,
        limit: 1000,
      });
      const trackedRow = tracked.find((x) => x.port === unmanagedPort);
      expect(trackedRow?.managed).toBe(true);
      expect(trackedRow?.managed_app_ids).toContain(unmanagedId);

      const unmanagedOnlyAfterAdopt = await detectApps({
        include_managed: false,
        limit: 1000,
      });
      expect(
        unmanagedOnlyAfterAdopt.some((x) => x.port === unmanagedPort),
      ).toBe(false);

      await expect(stopApp(unmanagedId)).rejects.toThrow(/unmanaged/);
    } finally {
      await new Promise<void>((resolve) =>
        unmanagedServer.close(() => resolve()),
      );
      await stopApp(id);
    }
  });

  test("static app routing and public-readiness audit are agent-usable", async () => {
    const id = appId("static");
    const root = mkdtempSync(join(testHome, "static-app-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "index.html"), "static-root-ok\n", "utf8");
    writeFileSync(
      join(root, "sub", "index.html"),
      "static-nested-ok\n",
      "utf8",
    );

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
    const cacheCheck = audit.checks.find(
      (c) => c.id === "static.cache_control",
    );
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

  test("static refresh command runs on first hit and stale hits only", async () => {
    const id = appId("static-refresh");
    const root = mkdtempSync(join(testHome, "static-refresh-"));
    const counterPath = join(root, "counter.txt");
    const indexPath = join(root, "index.html");

    await upsertAppSpec({
      version: 1,
      id,
      kind: "static",
      title: "Static Refresh Test",
      static: {
        root,
        index: "index.html",
        cache_control: "public, max-age=60",
        refresh: {
          command: {
            exec: "bash",
            args: [
              "-lc",
              `n=0; [ -f '${counterPath}' ] && n=$(cat '${counterPath}'); n=$((n+1)); echo \"$n\" > '${counterPath}'; echo \"refresh-$n\" > '${indexPath}'`,
            ],
          },
          timeout_s: 10,
          stale_after_s: 1,
          trigger_on_hit: true,
        },
      },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/`,
    });
    expect(readFileSync(counterPath, "utf8").trim()).toBe("1");
    expect(readFileSync(indexPath, "utf8").trim()).toBe("refresh-1");

    await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/`,
    });
    expect(readFileSync(counterPath, "utf8").trim()).toBe("1");

    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/`,
    });
    expect(readFileSync(counterPath, "utf8").trim()).toBe("2");
    expect(readFileSync(indexPath, "utf8").trim()).toBe("refresh-2");
  });

  test("static refresh command can run manually before the stale window", async () => {
    const id = appId("static-refresh-manual");
    const root = mkdtempSync(join(testHome, "static-refresh-manual-"));
    const counterPath = join(root, "counter.txt");
    const indexPath = join(root, "index.html");

    await upsertAppSpec({
      version: 1,
      id,
      kind: "static",
      title: "Static Refresh Manual Test",
      static: {
        root,
        index: "index.html",
        cache_control: "public, max-age=60",
        refresh: {
          command: {
            exec: "bash",
            args: [
              "-lc",
              `n=0; [ -f '${counterPath}' ] && n=$(cat '${counterPath}'); n=$((n+1)); echo \"$n\" > '${counterPath}'; echo \"refresh-$n\" > '${indexPath}'`,
            ],
          },
          timeout_s: 10,
          stale_after_s: 3600,
          trigger_on_hit: true,
        },
      },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    await resolveAppProxyTarget({
      base: "/project-test",
      url: `http://project.local/project-test/apps/${id}/`,
    });
    expect(readFileSync(counterPath, "utf8").trim()).toBe("1");

    const status = await refreshApp(id);
    expect(status.state).toBe("running");
    expect(readFileSync(counterPath, "utf8").trim()).toBe("2");
    expect(readFileSync(indexPath, "utf8").trim()).toBe("refresh-2");
  });

  test("failed service startup keeps stderr visible in app logs", async () => {
    const id = appId("start-fail");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      title: "Startup Failure Logs Test",
      command: {
        exec: process.execPath,
        args: ["-e", "console.error('boot-fail'); process.exit(2);"],
      },
      network: { listen_host: "127.0.0.1", protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: true, keep_warm_s: 300, startup_timeout_s: 5 },
    });

    await expect(
      ensureRunning(id, { timeout: 1200, interval: 100 }),
    ).rejects.toThrow(/timed out waiting for app/);

    const logs = await appLogs(id);
    expect(logs.state).toBe("stopped");
    expect(logs.stderr).toContain("boot-fail");
  });
});
