import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import initPublicContent from "./public-content";

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: jest.fn(() => false),
}));

jest.mock("@cocalc/database/postgres/news", () => ({
  getFeedData: jest.fn(async () => []),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

function jsonLdGraph(html: string): any[] {
  return Array.from(
    html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ).flatMap((match) => JSON.parse(match[1])?.["@graph"] ?? []);
}

describe("public content routes", () => {
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
    initPublicContent(router);
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

  it("serves the guides bridge page with public shell metadata", async () => {
    const response = await request("/guides?topic=jupyter");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("<title>CoCalc Guides | CoCalc</title>");
    expect(html).toContain('name="description"');
    expect(html).toContain("Read CoCalc guides for project workflows");
    expect(html).toContain('src="/static/load-test.js"');
  });

  it("serves Star product detail pages with crawler-visible metadata", async () => {
    const response = await request("/products/cocalc-star?source=home");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("<title>CoCalc Star | CoCalc</title>");
    expect(html).toContain("single-VM appliance path");
    expect(html).toContain(
      'property="og:title" content="CoCalc Star | CoCalc"',
    );
    expect(html).toContain('property="og:site_name" content="CoCalc"');
    expect(html).toContain('property="og:locale" content="en_US"');
    expect(html).toContain('property="og:image" content="http://127.0.0.1:');
    expect(html).toContain('property="og:image:width" content="1691"');
    expect(html).toContain('property="og:image:height" content="930"');
    expect(html).toContain("/public/landing/product-options.jpg");
    expect(html).toContain("/products/cocalc-star");

    const graph = jsonLdGraph(html);
    expect(graph).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "Organization",
          name: "SageMath, Inc.",
        }),
        expect.objectContaining({
          "@type": "SoftwareApplication",
          name: "CoCalc",
        }),
        expect.objectContaining({
          "@type": "Product",
          name: "CoCalc Star",
        }),
        expect.objectContaining({
          "@type": "BreadcrumbList",
        }),
      ]),
    );
  });
});
