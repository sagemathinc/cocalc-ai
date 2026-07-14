import type { AddressInfo } from "node:net";
import express from "express";
import initPublicContent from "./app/public-content";
import initPublicFeatures from "./app/public-features";
import initPublicLang from "./app/public-lang";
import initPublicSupport from "./app/public-support";
import initSitemap, {
  publicSitemapPaths,
  PUBLIC_SITEMAP_PATHS,
} from "./sitemap";
import { getPublicFeatureIndexPages } from "@cocalc/util/public-feature-pages";
import { docsPath, listDocsEntries } from "@cocalc/docs";

jest.mock("@cocalc/database/postgres/news", () => ({
  getFeedData: jest.fn(async () => [
    {
      channel: "feature",
      date: 1750000000,
      id: "42",
      title: "Test post",
      text: "Hello world",
    },
  ]),
  getNewsItem: jest.fn(async (id: number) =>
    id === 42
      ? {
          channel: "feature",
          date: 1750000000,
          id: "42",
          title: "Test post",
          text: "Hello world",
        }
      : null,
  ),
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    policy_pages: "sagemathinc",
    siteName: "CoCalc",
  })),
}));

import getCustomize from "@cocalc/database/settings/customize";

const mockedCustomize = jest.mocked(getCustomize);

function requestFor(host?: string) {
  return {
    get: (name: string) => (name === "host" ? host : undefined),
    protocol: "http",
  } as any;
}

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
    expect(PUBLIC_SITEMAP_PATHS).toContain("/products/cocalc-star");
    expect(PUBLIC_SITEMAP_PATHS).toContain("/about/team");
    expect(PUBLIC_SITEMAP_PATHS).toContain("/rootfs");
    expect(PUBLIC_SITEMAP_PATHS).not.toContain("/policies/imprint");
    expect(
      PUBLIC_SITEMAP_PATHS.filter((path) => path.startsWith("/features/")),
    ).toEqual(
      getPublicFeatureIndexPages().map((page) => `/features/${page.slug}`),
    );
  });

  it("adds public docs detail pages from the docs registry", async () => {
    const paths = await publicSitemapPaths(requestFor("example.test"));

    expect(paths).toContain("/docs");
    expect(paths).toContain("/docs/projects/project-secrets");
    expect(paths).toContain("/docs/collaboration/chat");
    expect(paths).not.toContain("/docs/admin/users");
    expect(paths).not.toContain("/docs/account/settings");
    expect(paths).not.toContain("/docs/projects/rstudio-project");
    expect(paths).not.toContain("/features");
    expect(paths).not.toContain("/pricing");
    expect(paths).not.toContain("/about");
    expect(paths).toContain("/");
    expect(paths).toContain("/news");
    expect(paths).toContain("/policies");
  });

  it("adds cocalc.ai profile docs only for the public cocalc.ai host", async () => {
    const paths = await publicSitemapPaths(requestFor("cocalc.ai"));

    expect(paths).toContain("/docs/projects/rstudio-project");
    expect(paths).toContain("/docs/jupyter/install-octave-kernel");
    expect(paths).not.toContain("/docs/admin/users");
    expect(paths).toContain("/features");
    expect(paths).toContain("/pricing");
    expect(paths).toContain("/about");
  });

  it("keeps sitemap docs paths in sync with visible docs entries", async () => {
    const paths = await publicSitemapPaths(requestFor("cocalc.ai"));
    const docsPaths = paths.filter((path) => path.startsWith("/docs/"));

    expect(docsPaths).toEqual(
      listDocsEntries({ siteProfile: "cocalc-ai" }).map((entry) =>
        docsPath(entry.slug),
      ),
    );
  });

  it("respects the policy_pages admin setting", async () => {
    mockedCustomize.mockResolvedValueOnce({ siteName: "CoCalc" } as any);
    const disabled = await publicSitemapPaths(requestFor("cocalc.ai"));
    expect(disabled.filter((path) => path.startsWith("/policies"))).toEqual([]);

    mockedCustomize.mockResolvedValueOnce({
      imprint: "# Imprint",
      policies: "site policies text",
      policy_pages: "custom",
      siteName: "CoCalc",
    } as any);
    const custom = await publicSitemapPaths(requestFor("cocalc.ai"));
    expect(custom.filter((path) => path.startsWith("/policies"))).toEqual([
      "/policies",
      "/policies/imprint",
      "/policies/policies",
    ]);

    // Custom mode without configured texts lists only the index.
    mockedCustomize.mockResolvedValueOnce({
      policy_pages: "custom",
      siteName: "CoCalc",
    } as any);
    const bare = await publicSitemapPaths(requestFor("cocalc.ai"));
    expect(bare.filter((path) => path.startsWith("/policies"))).toEqual([
      "/policies",
    ]);

    // An external policies URL replaces local policy pages entirely.
    mockedCustomize.mockResolvedValueOnce({
      policy_pages: "sagemathinc",
      siteName: "CoCalc",
      termsOfServiceURL: "https://example.com/legal",
    } as any);
    const external = await publicSitemapPaths(requestFor("cocalc.ai"));
    expect(external.filter((path) => path.startsWith("/policies"))).toEqual([]);

    const builtin = await publicSitemapPaths(requestFor("cocalc.ai"));
    expect(builtin).toContain("/policies");
    expect(builtin).toContain("/policies/privacy");
    expect(builtin).not.toContain("/policies/imprint");
  });

  it("serves every listed path through current public route handlers", async () => {
    const paths = await publicSitemapPaths(requestFor("example.test"));
    for (const path of paths) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("renders sitemap xml with absolute urls", async () => {
    const response = await fetch(`${origin}/sitemap.xml`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(response.headers.get("vary")).toContain("Host");
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    for (const path of await publicSitemapPaths(requestFor(undefined))) {
      expect(body).toContain(`<loc>${origin}${path}</loc>`);
    }
    // Published news posts (from the mocked feed) are listed too.
    expect(body).toContain(`<loc>${origin}/news/test-post-42</loc>`);
  });

  it("serves the listed news post URL without redirect", async () => {
    const response = await fetch(`${origin}/news/test-post-42`, {
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
