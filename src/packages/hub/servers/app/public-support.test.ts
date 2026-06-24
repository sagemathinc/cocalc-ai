import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import initPublicSupport from "./public-support";

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: jest.fn(() => false),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public support routes", () => {
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
    initPublicSupport(router);
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

  it("serves contact routes with public support metadata", async () => {
    const response = await request(
      "/support/new?subject=CoCalc%20Rocket&context=product-cocalc-rocket",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("<title>Contact CoCalc Support | CoCalc</title>");
    expect(html).toContain(
      "Contact CoCalc about pricing, deployment, product paths",
    );
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("/support/new");
    expect(html).toContain('src="/static/public-test.js"');
  });
});
