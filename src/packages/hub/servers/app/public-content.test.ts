import type { AddressInfo } from "node:net";
import express from "express";
import { PUBLIC_PRODUCT_AVAILABILITY } from "@cocalc/util/public-product-availability";
import initPublicContent from "./public-content";

afterEach(() => jest.restoreAllMocks());

jest.mock("@cocalc/database/postgres/news", () => ({
  getFeedData: jest.fn(async () => []),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public content routes", () => {
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

  it.each([
    "/products/cocalc-launchpad",
    "/products/cocalc-launchpad/",
    "/products/cocalc-rocket",
    "/products/cocalc-rocket/",
  ])(
    "temporarily redirects the hidden product page %s to the products page",
    async (path) => {
      const response = await request(`${path}?ref=old-link`);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/products?ref=old-link");
      // Temporary: cached for no longer than a page.
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=10, must-revalidate",
      );
      expect(response.headers.get("vary")).toContain("Host");
    },
  );

  it("serves the shown product pages and the products page", async () => {
    for (const path of [
      "/products",
      "/products/cocalc-plus",
      "/products/cocalc-star",
    ]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(await (await request("/products/cocalc-plus")).text()).toContain(
      "<h1>CoCalc Plus</h1>",
    );
  });

  it("serves a hidden product's page again once its switch is on", async () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "launchpad", true);
    const response = await request("/products/cocalc-launchpad");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("<h1>CoCalc Launchpad</h1>");
  });

  it("redirects a shown product's page again once its switch is off", async () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "plus", false);
    const response = await request("/products/cocalc-plus");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/products");
  });

  it("serves the guides bridge page from the clean URL", async () => {
    const response = await request("/guides?topic=jupyter");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain("<title>CoCalc Guides | CoCalc</title>");
    expect(body).toContain('rel="canonical"');
    expect(body).toContain('href="https://cocalc.ai/guides" rel="canonical"');
  });
});
