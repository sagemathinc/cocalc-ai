import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import initPublicFeatures from "./public-features";

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: jest.fn(() => false),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public feature and docs routes", () => {
  let previousStaticPath: string | undefined;
  let staticPath: string;

  beforeAll(() => {
    previousStaticPath = process.env.COCALC_STATIC_PATH;
    staticPath = mkdtempSync(join(tmpdir(), "cocalc-public-shell-"));
    writeFileSync(
      join(staticPath, "public.html"),
      `<!doctype html><html><head><title>CoCalc</title><script defer src="load-test.js"></script><script defer src="public-test.js"></script></head><body><div id="cocalc-webapp-container"></div></body></html>`,
    );
    process.env.COCALC_STATIC_PATH = staticPath;
  });

  afterAll(() => {
    if (previousStaticPath == null) {
      delete process.env.COCALC_STATIC_PATH;
    } else {
      process.env.COCALC_STATIC_PATH = previousStaticPath;
    }
    rmSync(staticPath, { force: true, recursive: true });
  });

  async function request(path: string) {
    const app = express();
    const router = express.Router();
    initPublicFeatures(router);
    app.use(router);
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    try {
      const { port } = server.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("serves feature pages with crawler-visible metadata", async () => {
    const response = await request("/features/python?x=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("<title>Python | CoCalc</title>");
    expect(html).toContain("Use Python for technical computing");
    expect(html).toContain("/features/python");
    expect(html).toContain('src="/static/public-test.js"');
    expect(html).toContain('property="og:site_name" content="CoCalc"');
    expect(html).toContain('property="og:image:width" content="1599"');
    expect(html).toContain('property="og:image:height" content="779"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"name":"Python"');
  });

  it("serves docs pages with public documentation metadata", async () => {
    const response = await request("/docs/projects/project-secrets?x=1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>CoCalc Documentation | CoCalc</title>");
    expect(html).toContain("Browse CoCalc documentation");
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("/docs");
  });

  it("redirects rootfs image pages into the public shell", async () => {
    const response = await request("/rootfs/id/rootfs-image-1?x=1");
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("/static/public.html?target=");
    const redirected = new URL(`http://host${location}`);
    expect(redirected.searchParams.get("target")).toBe(
      "/rootfs/id/rootfs-image-1?x=1",
    );
  });
});
