import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import initPublicLang from "./public-lang";

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: jest.fn(() => false),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public language routes", () => {
  let previousStaticPath: string | undefined;
  let staticPath: string;

  beforeAll(() => {
    previousStaticPath = process.env.COCALC_STATIC_PATH;
    staticPath = mkdtempSync(join(tmpdir(), "cocalc-public-shell-"));
    writeFileSync(
      join(staticPath, "public.html"),
      `<!doctype html><html><head><title>CoCalc</title><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"></head><body><div id="cocalc-webapp-container"></div></body></html>`,
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
    initPublicLang(router);
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

  it("serves locale aliases with a matching html lang before JavaScript", async () => {
    const response = await request("/de");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    );
    expect(html).toContain('property="og:locale" content="de"');
    expect(html).toContain('"@type":"Organization"');
    expect(html).not.toContain("user-scalable");
  });

  it("serves the language index with the default html lang", async () => {
    const response = await request("/lang");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
  });
});
