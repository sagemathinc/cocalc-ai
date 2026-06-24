import type { AddressInfo } from "node:net";
import express from "express";
import initPublicContent from "./app/public-content";
import initPublicFeatures from "./app/public-features";
import initPublicLang from "./app/public-lang";
import initPublicSupport from "./app/public-support";
import initSitemap, { PUBLIC_SITEMAP_PATHS } from "./sitemap";

jest.mock("@cocalc/database/postgres/news", () => ({
  getFeedData: jest.fn(async () => []),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

describe("public sitemap", () => {
  let server: ReturnType<express.Express["listen"]>;
  let origin: string;

  beforeAll(async () => {
    const app = express();
    const router = express.Router();
    app.get("/", (_req, res) => res.type("html").send("public shell"));
    app.get("/static/public.html", (_req, res) =>
      res.type("html").send("public shell"),
    );
    app.use("/sitemap.xml", initSitemap());
    initPublicContent(router);
    initPublicFeatures(router);
    initPublicLang(router);
    initPublicSupport(router);
    app.use(router);
    app.use((_req, res) => res.status(404).end());

    server = await new Promise<ReturnType<express.Express["listen"]>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("uses stable, crawlable public paths", () => {
    expect(new Set(PUBLIC_SITEMAP_PATHS).size).toBe(
      PUBLIC_SITEMAP_PATHS.length,
    );
    for (const path of PUBLIC_SITEMAP_PATHS) {
      expect(path).toMatch(/^\//);
      if (path !== "/") {
        expect(path.endsWith("/")).toBe(false);
      }
    }
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/auth");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/support/new");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/products/cocalc-star");
  });

  it("serves every listed path through current public route handlers", async () => {
    for (const path of PUBLIC_SITEMAP_PATHS) {
      const response = await fetch(`${origin}${path}`, { redirect: "follow" });
      expect(response.status).toBe(200);
    }
  });

  it("renders sitemap xml with absolute urls", async () => {
    const response = await fetch(`${origin}/sitemap.xml`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    for (const path of PUBLIC_SITEMAP_PATHS) {
      expect(body).toContain(`<loc>${origin}${path}</loc>`);
    }
  });
});
