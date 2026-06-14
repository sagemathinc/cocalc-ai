import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import initPublicAuth from "./public-auth";

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: jest.fn(() => false),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public auth routes", () => {
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
    initPublicAuth(router);
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

  it("serves CLI login approval routes through the public auth shell", async () => {
    const response = await request("/auth/cli-login/challenge-123?x=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("<title>CoCalc</title>");
    expect(html).toContain(
      "Use your CoCalc account to access projects, collaborators, billing, support, and deployment tools.",
    );
    expect(html).toContain("/auth/sign-in");
  });

  it("serves CLI elevation approval routes through the public auth shell", async () => {
    const response = await request("/auth/cli-elevate/challenge-456");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('src="/static/load-test.js"');
  });

  it("serves project invite routes through the public auth shell", async () => {
    const response = await request(
      "/invites/project/937f48ab-c8ce-4877-bb02-5ff43da8e787/f5888c36-fb55-47e7-9cb7-99d3c5d1b231?token=secret",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'property="og:description" content="Use your CoCalc account',
    );
  });

  it("serves sign-up routes with public account metadata", async () => {
    const response = await request("/auth/sign-up");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      "<title>Create your CoCalc account | CoCalc</title>",
    );
    expect(html).toContain("Create a CoCalc account to start hosted projects");
    expect(html).toContain("/auth/sign-up");
  });
});
