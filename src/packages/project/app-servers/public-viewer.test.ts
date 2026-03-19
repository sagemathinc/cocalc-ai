/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_PROXY_EXPOSURE_HEADER } from "@cocalc/backend/auth/app-proxy";
import { PROJECT_PROXY_AUTH_HEADER } from "@cocalc/backend/auth/project-proxy-auth";

function appId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
  });
}

describe("static public viewer mode", () => {
  const originalHome = process.env.HOME;
  const originalSecretPath = process.env.COCALC_SECRET_TOKEN;
  const testHome = mkdtempSync(join(tmpdir(), "cocalc-public-viewer-"));
  const secretPath = join(testHome, "secret-token");
  const secretValue = "public-viewer-secret-token";

  beforeAll(() => {
    process.env.HOME = testHome;
    process.env.COCALC_SECRET_TOKEN = secretPath;
    writeFileSync(secretPath, secretValue, "utf8");
  });

  afterAll(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSecretPath == null) delete process.env.COCALC_SECRET_TOKEN;
    else process.env.COCALC_SECRET_TOKEN = originalSecretPath;
    rmSync(testHome, { recursive: true, force: true });
  });

  test("normalizes public viewer integration defaults and exposes them for routing", async () => {
    jest.resetModules();
    const { normalizeAppSpec } = await import("./specs");
    const { project_id } = await import("@cocalc/project/data");
    const { resolveAppProxyTarget, upsertAppSpec, deleteApp } =
      await import("./control");
    const root = mkdtempSync(join(testHome, "viewer-spec-"));
    const id = appId("viewer-spec");

    const normalized = normalizeAppSpec({
      version: 1,
      id,
      kind: "static",
      static: { root },
      integration: { mode: "cocalc-public-viewer" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    if (normalized.kind !== "static") {
      throw new Error("expected a static app spec");
    }
    expect(normalized.integration).toEqual({
      mode: "cocalc-public-viewer",
      file_types: [".md", ".ipynb", ".slides", ".board"],
      auto_refresh_s: 0,
      manifest: "index.json",
      directory_listing: "manifest-only",
      viewer_bundle: undefined,
    });

    await upsertAppSpec(normalized);
    try {
      const target = await resolveAppProxyTarget({
        base: `/${project_id}`,
        url: `http://project.local/${project_id}/apps/${id}/`,
      });
      expect(target?.kind).toBe("static");
      expect((target as any)?.integration?.mode).toBe("cocalc-public-viewer");
      expect((target as any)?.integration?.manifest).toBe("index.json");
    } finally {
      await deleteApp(id);
    }
  });

  test("serves manifest-generated index pages and raw file fallbacks through the project proxy", async () => {
    jest.resetModules();
    const { project_id, secretToken } = await import("@cocalc/project/data");
    const { startProxyServer } =
      await import("@cocalc/project/servers/proxy/proxy");
    const { upsertAppSpec, deleteApp, resolveAppProxyTarget } =
      await import("./control");

    const root = mkdtempSync(join(testHome, "viewer-proxy-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "readme.md"),
      "# Hello public viewer\n",
      "utf8",
    );
    writeFileSync(
      join(root, "docs", "index.json"),
      `${JSON.stringify(
        {
          version: 1,
          kind: "cocalc-public-viewer-index",
          title: "Course Notes",
          description: "Manifest-backed listing",
          entries: [
            {
              path: "docs/readme.md",
              title: "Read Me",
              description: "Markdown file",
              render: "viewer",
              tags: ["intro"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const id = appId("viewer-proxy");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "static",
      title: "Public Viewer Test",
      static: {
        root,
        index: "index.html",
        cache_control: "public, max-age=120",
      },
      integration: { mode: "cocalc-public-viewer" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    const server = await startProxyServer({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    const proxyPort =
      address && typeof address === "object" ? address.port : undefined;
    expect(proxyPort).toBeGreaterThan(0);

    try {
      const target = await resolveAppProxyTarget({
        base: `/${project_id}`,
        url: `http://project.local/${project_id}/apps/${id}/docs/`,
      });
      expect(target?.kind).toBe("static");
      expect((target as any)?.rewritePath).toBe("/docs/");
      expect((target as any)?.integration?.mode).toBe("cocalc-public-viewer");

      const page = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/docs/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
          [APP_PROXY_EXPOSURE_HEADER]: "public",
        },
      );
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.headers["cache-control"]).toBe("public, max-age=120");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      expect(page.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(page.body).toContain("Course Notes");
      expect(page.body).toContain("Read Me");
      expect(page.body).toContain("viewer planned");
      expect(page.body).toContain("Open manifest JSON");

      const manifest = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/docs/index.json`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toContain("application/json");
      expect(manifest.body).toContain("cocalc-public-viewer-index");

      const markdown = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/docs/readme.md`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(markdown.statusCode).toBe(200);
      expect(markdown.headers["content-type"]).toContain("text/markdown");
      expect(markdown.body).toContain("# Hello public viewer");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(id);
    }
  });

  test("prefers index.html over index.json and refuses implicit directory crawling", async () => {
    jest.resetModules();
    const { project_id, secretToken } = await import("@cocalc/project/data");
    const { startProxyServer } =
      await import("@cocalc/project/servers/proxy/proxy");
    const { upsertAppSpec, deleteApp } = await import("./control");

    const root = mkdtempSync(join(testHome, "viewer-precedence-"));
    mkdirSync(join(root, "site"), { recursive: true });
    mkdirSync(join(root, "empty"), { recursive: true });
    writeFileSync(
      join(root, "site", "index.html"),
      "<!doctype html><title>custom</title><h1>custom site</h1>\n",
      "utf8",
    );
    writeFileSync(
      join(root, "site", "index.json"),
      `${JSON.stringify({
        version: 1,
        kind: "cocalc-public-viewer-index",
        title: "Should not win",
        entries: [],
      })}\n`,
      "utf8",
    );

    const id = appId("viewer-precedence");
    await upsertAppSpec({
      version: 1,
      id,
      kind: "static",
      title: "Public Viewer Precedence Test",
      static: { root, index: "index.html" },
      integration: { mode: "cocalc-public-viewer" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 0, startup_timeout_s: 0 },
    });

    const server = await startProxyServer({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    const proxyPort =
      address && typeof address === "object" ? address.port : undefined;
    expect(proxyPort).toBeGreaterThan(0);

    try {
      const site = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/site/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(site.statusCode).toBe(200);
      expect(site.body).toContain("custom site");
      expect(site.body).not.toContain("Should not win");

      const empty = await httpGet(
        `http://127.0.0.1:${proxyPort}/${project_id}/apps/${id}/empty/`,
        {
          [PROJECT_PROXY_AUTH_HEADER]: secretToken,
        },
      );
      expect(empty.statusCode).toBe(404);
      expect(empty.body).toContain("Not found");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await deleteApp(id);
    }
  });
});
