import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  PUBLIC_BODY_PLACEHOLDER,
  PUBLIC_STATIC_BASE_PLACEHOLDER,
} from "@cocalc/util/public-site-metadata";
import { renderPublicShell } from "./public-shell";

// Public site fixtures model Launchpad explicitly; an unset product defaults
// to Plus, whose smaller docs catalog intentionally excludes these pages.
jest.mock("@cocalc/server/launchpad/mode", () => {
  const getCocalcProduct = jest.fn(() => "launchpad");
  return {
    getCocalcProduct,
    isLaunchpadProduct: () => getCocalcProduct() === "launchpad",
  };
});

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    policy_pages: "sagemathinc",
    siteName: "CoCalc",
  })),
}));

import getCustomize from "@cocalc/database/settings/customize";

const mockedCustomize = jest.mocked(getCustomize);

jest.mock("@cocalc/database/postgres/news", () => ({
  getNewsItem: jest.fn(async (id: number) =>
    id === 42
      ? {
          id: "42",
          channel: "feature",
          date: 1750000000,
          title: "Test post",
          text: "Hello **world** body",
        }
      : null,
  ),
}));

jest.mock("@cocalc/server/rootfs/catalog", () => ({
  listVisibleRootfsImages: jest.fn(async () => ({
    version: 1,
    images: [
      {
        id: "abc123",
        slug: "ubuntu-24.04",
        label: "Ubuntu 24.04",
        image: "docker.io/library/ubuntu:24.04",
        content: { version: 1, description: "A **classic** LTS base image." },
      },
      {
        id: "no-slug-image",
        label: "No Slug",
        image: "registry.example.com/cocalc/no-slug-image",
      },
    ],
  })),
}));

import { listVisibleRootfsImages } from "@cocalc/server/rootfs/catalog";

const mockedListVisibleRootfsImages = jest.mocked(listVisibleRootfsImages);

// Serve a synthetic shell instead of whatever packages/static/dist currently
// holds, so these tests do not depend on the state of the last static build.
// resolveStaticPath() honors COCALC_STATIC_PATH and resolves lazily on the
// first render, so setting it here is early enough.
function shellHtml({ tokenized }: { tokenized: boolean }): string {
  const src = (file: string) =>
    tokenized ? `${PUBLIC_STATIC_BASE_PLACEHOLDER}/${file}` : file;
  return `<!doctype html><html><head><title>CoCalc</title></head><body><script defer src="${src(
    "load-abc.js",
  )}"></script><script defer src="${src(
    "public-def.js",
  )}"></script><div id="cocalc-webapp-container">${PUBLIC_BODY_PLACEHOLDER}</div></body></html>`;
}

const staticDir = mkdtempSync(join(tmpdir(), "public-shell-test-"));
writeFileSync(join(staticDir, "app.html"), "<!doctype html><html></html>");
writeFileSync(join(staticDir, "public.html"), shellHtml({ tokenized: true }));
process.env.COCALC_STATIC_PATH = staticDir;

function request(
  path: string,
  query: Record<string, string> = {},
  host = "cocalc.ai",
) {
  const search = new URLSearchParams(query).toString();
  return {
    get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
    path,
    protocol: "https",
    query,
    url: search ? `${path}?${search}` : path,
  } as any;
}

describe("public shell rendering", () => {
  it("renders crawler-visible feature content into the initial HTML", async () => {
    const { html: body, status } = await renderPublicShell(
      request("/features/jupyter-notebook"),
    );

    expect(status).toBe(200);
    expect(body).toContain('data-cocalc-public-prerender="feature"');
    expect(body).toContain("<h1>Online Jupyter Notebooks</h1>");
    expect(body).toContain("Real-time collaborative editing");
    expect(body).toContain('href="/features/terminal"');
    expect(body).not.toContain(PUBLIC_BODY_PLACEHOLDER);
  });

  it("removes the body placeholder from routes without a prerender", async () => {
    const { html: body } = await renderPublicShell(request("/pricing"));

    expect(body).not.toContain(PUBLIC_BODY_PLACEHOLDER);
    expect(body).not.toContain("data-cocalc-public-prerender");
  });

  it("renders docs inside the container replaced by the public React app", async () => {
    const { html, status } = await renderPublicShell(
      request("/docs/projects/project-secrets", { tracking: "example" }),
    );
    expect(status).toBe(200);
    expect(html).toContain("<h1>Project secrets</h1>");
    expect(html).toContain(
      '<div id="cocalc-webapp-container"><article data-cocalc-public-prerender="docs-detail"',
    );
    expect(
      html.match(/data-cocalc-public-prerender="docs-detail"/g),
    ).toHaveLength(1);
    expect(html).not.toContain(PUBLIC_BODY_PLACEHOLDER);
    expect(html).toContain(
      'href="https://cocalc.ai/docs/projects/project-secrets" rel="canonical"',
    );
  });

  it("keeps initial docs content independent of request authentication", async () => {
    const anonymous = await renderPublicShell(request("/docs/admin/users"));
    const authenticated = await renderPublicShell({
      ...request("/docs/admin/users"),
      headers: { cookie: "session=example" },
      account_id: "example",
      is_admin: true,
    } as any);
    expect(authenticated).toEqual(anonymous);
    expect(anonymous.status).toBe(200);
    expect(anonymous.html).toContain('content="noindex"');
    expect(anonymous.html).not.toContain(
      'data-cocalc-public-prerender="docs-detail"',
    );
    expect(anonymous.html).not.toContain("<h1>Users</h1>");
  });

  it("does not expose feature-gated or other-site docs in initial HTML", async () => {
    for (const req of [
      request("/docs/projects/virtual-machines"),
      request("/docs/account/settings"),
      request("/docs/projects/rstudio-project", {}, "university.example.edu"),
    ]) {
      const { html, status } = await renderPublicShell(req);
      expect(status).toBe(200);
      expect(html).toContain('content="noindex"');
      expect(html).not.toContain('data-cocalc-public-prerender="docs-detail"');
    }
  });

  it("supports the legacy empty app container without duplicating the article", async () => {
    writeFileSync(
      join(staticDir, "public.html"),
      shellHtml({ tokenized: true }).replace(PUBLIC_BODY_PLACEHOLDER, ""),
    );
    try {
      const { html } = await renderPublicShell(
        request("/docs/collaboration/chat"),
      );
      expect(
        html.match(/data-cocalc-public-prerender="docs-detail"/g),
      ).toHaveLength(1);
      expect(html).toContain('<div id="cocalc-webapp-container"><article');
    } finally {
      writeFileSync(
        join(staticDir, "public.html"),
        shellHtml({ tokenized: true }),
      );
    }
  });

  it("canonicalizes static shell target URLs to the clean public URL", async () => {
    const { html: body, status } = await renderPublicShell(
      request("/static/public.html", {
        target: "/features/jupyter-notebook?x=1",
      }),
    );

    expect(status).toBe(200);
    expect(body).toContain(
      'href="https://cocalc.ai/features/jupyter-notebook" rel="canonical"',
    );
    expect(body).toContain(
      'data-cocalc-public-route-meta="description" name="description"',
    );
    expect(body).not.toContain(
      'href="https://cocalc.ai/static/public.html" rel="canonical"',
    );
  });

  it("emits exactly one title", async () => {
    const { html: body, status } = await renderPublicShell(request("/pricing"));

    expect(status).toBe(200);
    expect(body.match(/<title>/g)).toHaveLength(1);
  });

  it("resolves the static-base token to absolute asset URLs without a base tag", async () => {
    const { html: body } = await renderPublicShell(
      request("/docs/collaboration/chat"),
    );

    expect(body).toContain('src="/static/load-abc.js"');
    expect(body).toContain('src="/static/public-def.js"');
    expect(body).not.toContain(PUBLIC_STATIC_BASE_PLACEHOLDER);
    // A page-wide <base> tag would hijack same-page fragment links
    // (href="#..." resolving to /static/#...), so tokenized shells must
    // not get one.
    expect(body).not.toContain("<base ");
    expect(body).toContain('<meta name="cocalc-base-path" content="/">');
  });

  it("injects a base tag ahead of the scripts for legacy shells without the token", async () => {
    writeFileSync(
      join(staticDir, "public.html"),
      shellHtml({ tokenized: false }),
    );
    try {
      const { html: body } = await renderPublicShell(
        request("/docs/collaboration/chat"),
      );

      const baseIndex = body.indexOf('<base href="/static/">');
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      const scriptIndex = body.indexOf("<script");
      expect(scriptIndex).toBeGreaterThan(baseIndex);
    } finally {
      writeFileSync(
        join(staticDir, "public.html"),
        shellHtml({ tokenized: true }),
      );
    }
  });

  it("does not interpret replacement patterns from request-derived values", async () => {
    const { html: body } = await renderPublicShell({
      get: (name: string) =>
        name.toLowerCase() === "host" ? "cocalc.ai$'" : undefined,
      path: "/pricing",
      protocol: "https",
      query: {},
      url: "/pricing",
    } as any);

    // With String.replace $-substitution, $' would splice the document tail
    // into the head, duplicating the webapp container div.
    expect(body.match(/cocalc-webapp-container/g)).toHaveLength(1);
    expect(body.match(/<title>/g)).toHaveLength(1);
  });

  it("resolves news posts from the database for canonical, title, summary", async () => {
    const { html: body, status } = await renderPublicShell(
      request("/news/test-post-42"),
    );

    expect(status).toBe(200);
    expect(body).toContain(
      'href="https://cocalc.ai/news/test-post-42" rel="canonical"',
    );
    expect(body).toContain("<title>Test post | CoCalc</title>");
    expect(body).toContain('content="Hello world body"');
  });

  it("permanently redirects non-canonical news detail URLs to the slug URL", async () => {
    // Mistyped or outdated slug: resolves by id, redirects to the real slug.
    const mistyped = await renderPublicShell(
      request("/news/totally-wrong-slug-42"),
    );
    expect(mistyped.redirectTo).toBe("/news/test-post-42");
    expect(mistyped.html).toContain(
      'href="https://cocalc.ai/news/test-post-42" rel="canonical"',
    );

    // Bare id URL, preserving the query string.
    const bareId = await renderPublicShell(request("/news/42", { x: "1" }));
    expect(bareId.redirectTo).toBe("/news/test-post-42?x=1");

    // The canonical URL itself serves the page.
    const canonical = await renderPublicShell(request("/news/test-post-42"));
    expect(canonical.redirectTo).toBeUndefined();
    expect(canonical.status).toBe(200);
  });

  it("canonicalizes news history views to the current post without redirecting", async () => {
    const { html: body, redirectTo } = await renderPublicShell(
      request("/news/test-post-42/1751000000"),
    );

    expect(redirectTo).toBeUndefined();
    expect(body).toContain(
      'href="https://cocalc.ai/news/test-post-42" rel="canonical"',
    );
  });

  it("responds 404 for news ids that do not exist", async () => {
    for (const path of [
      "/news/no-such-post-99",
      // Beyond int4: must 404 without reaching the DB (would throw there)
      // and without falling back to 200 index metadata.
      "/news/foo-9999999999",
    ]) {
      const { status } = await renderPublicShell(request(path));
      expect({ path, status }).toEqual({ path, status: 404 });
    }
  });

  it("resolves rootfs detail pages from the catalog for canonical, title, summary", async () => {
    const bySlug = await renderPublicShell(request("/rootfs/ubuntu-24.04"));
    expect(bySlug.status).toBe(200);
    expect(bySlug.html).toContain(
      'href="https://cocalc.ai/rootfs/ubuntu-24.04" rel="canonical"',
    );
    expect(bySlug.html).toContain("<title>Ubuntu 24.04 | CoCalc</title>");
    expect(bySlug.html).toContain('content="A classic LTS base image."');

    // A by-id URL for an image with a slug canonicalizes to the slug URL.
    const byId = await renderPublicShell(request("/rootfs/id/abc123"));
    expect(byId.status).toBe(200);
    expect(byId.html).toContain(
      'href="https://cocalc.ai/rootfs/ubuntu-24.04" rel="canonical"',
    );

    // The bare image name is a valid by-id target as well.
    const byImageName = await renderPublicShell(
      request("/rootfs/id/no-slug-image"),
    );
    expect(byImageName.status).toBe(200);
    expect(byImageName.html).toContain(
      'href="https://cocalc.ai/rootfs/id/no-slug-image" rel="canonical"',
    );
    expect(byImageName.html).toContain("<title>No Slug | CoCalc</title>");

    // Percent-encoded targets match decoded, like the client does:
    // ubuntu%3A24.04 → ubuntu:24.04, the bare image name of the entry.
    const encoded = await renderPublicShell(
      request("/rootfs/id/ubuntu%3A24.04"),
    );
    expect(encoded.status).toBe(200);
    expect(encoded.html).toContain(
      'href="https://cocalc.ai/rootfs/ubuntu-24.04" rel="canonical"',
    );
  });

  it("responds 404 for rootfs slugs and ids that are not in the catalog", async () => {
    for (const path of [
      "/rootfs/this-does-not-exist",
      "/rootfs/id/no-such-image",
    ]) {
      const { status } = await renderPublicShell(request(path));
      expect({ path, status }).toEqual({ path, status: 404 });
    }
  });

  it("responds 503 when the rootfs catalog cannot be read", async () => {
    // Jump past the 60s anonymous-catalog TTL so this request refills the
    // cache and deterministically hits the rejected lookup.
    const future = Date.now() + 61_000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => future);
    try {
      mockedListVisibleRootfsImages.mockRejectedValueOnce(
        new Error("catalog down"),
      );
      const { status } = await renderPublicShell(
        request("/rootfs/ubuntu-24.04"),
      );
      // Neither a fabricated 200 (indexable soft-404) nor a 404 (drops real
      // pages from the index) is safe during an outage.
      expect(status).toBe(503);

      // Failures are not cached: the next request resolves normally.
      const recovered = await renderPublicShell(
        request("/rootfs/ubuntu-24.04"),
      );
      expect(recovered.status).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("canonicalizes duplicated marketing pages to cocalc.ai on branded hosts", async () => {
    const marketing = await renderPublicShell(
      request("/features/jupyter-notebook", {}, "university.example.edu"),
    );
    expect(marketing.html).toContain(
      'href="https://cocalc.ai/features/jupyter-notebook" rel="canonical"',
    );

    const localNews = await renderPublicShell(
      request("/news/test-post-42", {}, "university.example.edu"),
    );
    expect(localNews.html).toContain(
      'href="https://university.example.edu/news/test-post-42" rel="canonical"',
    );
  });

  it("serves restricted docs entries with 200 and a robots noindex tag", async () => {
    // Admin-visibility docs entry: not visible to anonymous crawlers, but it
    // must not 404 for entitled signed-in users (the client enforces access).
    const { html: body, status } = await renderPublicShell(
      request("/docs/admin/users"),
    );

    expect(status).toBe(200);
    expect(body).toContain(
      'content="noindex" data-cocalc-public-route-meta="robots" name="robots"',
    );

    // Publicly visible entries must not carry noindex.
    const publicPage = await renderPublicShell(
      request("/docs/collaboration/chat"),
    );
    expect(publicPage.html).not.toContain('name="robots"');
  });

  it("mirrors the policy_pages admin setting for policy routes", async () => {
    // Disabled policies: the whole section is a 404.
    mockedCustomize.mockResolvedValueOnce({ siteName: "CoCalc" } as any);
    expect((await renderPublicShell(request("/policies"))).status).toBe(404);
    mockedCustomize.mockResolvedValueOnce({ siteName: "CoCalc" } as any);
    expect((await renderPublicShell(request("/policies/privacy"))).status).toBe(
      404,
    );

    // Custom mode: configured pages exist, built-in documents do not.
    const customModeSettings = {
      imprint: "# Imprint",
      policies: "site policy text",
      policy_pages: "custom",
      siteName: "CoCalc",
    } as any;
    mockedCustomize.mockResolvedValueOnce(customModeSettings);
    const customPage = await renderPublicShell(request("/policies/policies"));
    expect(customPage.status).toBe(200);
    expect(customPage.html).toContain(
      'href="https://cocalc.ai/policies/policies" rel="canonical"',
    );
    mockedCustomize.mockResolvedValueOnce(customModeSettings);
    expect((await renderPublicShell(request("/policies/imprint"))).status).toBe(
      200,
    );
    mockedCustomize.mockResolvedValueOnce(customModeSettings);
    expect((await renderPublicShell(request("/policies/privacy"))).status).toBe(
      404,
    );

    // Custom mode without configured texts: those pages do not exist.
    mockedCustomize.mockResolvedValueOnce({
      policy_pages: "custom",
      siteName: "CoCalc",
    } as any);
    expect(
      (await renderPublicShell(request("/policies/policies"))).status,
    ).toBe(404);

    // External policies URL: index stays as a noindexed link-out stub,
    // local documents are gone.
    const externalSettings = {
      policy_pages: "sagemathinc",
      siteName: "CoCalc",
      termsOfServiceURL: "https://example.com/legal",
    } as any;
    mockedCustomize.mockResolvedValueOnce(externalSettings);
    const stub = await renderPublicShell(request("/policies"));
    expect(stub.status).toBe(200);
    expect(stub.html).toContain(
      'content="noindex" data-cocalc-public-route-meta="robots" name="robots"',
    );
    mockedCustomize.mockResolvedValueOnce(externalSettings);
    expect((await renderPublicShell(request("/policies/privacy"))).status).toBe(
      404,
    );

    // Built-in mode (the default mock): imprint/custom pages do not exist.
    expect((await renderPublicShell(request("/policies/imprint"))).status).toBe(
      404,
    );
    expect(
      (await renderPublicShell(request("/policies/policies"))).status,
    ).toBe(404);
  });

  it("responds 404 for detail slugs that are not in a registry", async () => {
    for (const path of [
      "/docs/does-not-exist",
      "/about/team/not-a-person",
      "/policies/bogus",
      "/features/no-such-feature",
    ]) {
      const { status } = await renderPublicShell(request(path));
      expect({ path, status }).toEqual({ path, status: 404 });
    }
  });

  it("responds 200 for known detail slugs", async () => {
    for (const path of [
      "/docs/collaboration/chat",
      "/about/team/harald-schilly",
      "/policies/privacy",
      "/features/jupyter-notebook",
      "/features/compare",
    ]) {
      const { status } = await renderPublicShell(request(path));
      expect({ path, status }).toEqual({ path, status: 200 });
    }
  });
});

import { getCocalcProduct } from "@cocalc/server/launchpad/mode";
const mockedProduct = jest.mocked(getCocalcProduct);
beforeEach(() => mockedProduct.mockReturnValue("launchpad"));

jest.mock("@cocalc/backend/base-path", () => ({
  __esModule: true,
  default: "/",
}));

describe("research compute shell availability", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(["/", "/prefix", "/docs"])(
    "keeps Plus status, metadata and body consistent under %s",
    async (basePath) => {
      mockedProduct.mockReturnValue("plus");
      jest.replaceProperty(
        jest.requireMock("@cocalc/backend/base-path"),
        "default",
        basePath,
      );
      const prefix = basePath === "/" ? "" : basePath;
      for (const req of [
        request("/features/research-compute"),
        request("/static/public.html", {
          target: `${prefix}/features/research-compute`,
        }),
      ]) {
        const { html, status } = await renderPublicShell(req);
        expect(status).toBe(404);
        expect(html).not.toContain('data-cocalc-public-prerender="feature"');
        expect(html).not.toContain("Research Compute");
        expect(html).toContain(
          `href="https://cocalc.ai${prefix}/features" rel="canonical"`,
        );
      }
      for (const path of ["/features", "/features/terminal"]) {
        const { html, status } = await renderPublicShell(request(path));
        expect(status).toBe(200);
        expect(html).toContain("data-cocalc-public-prerender");
        expect(html).not.toContain("research-compute");
      }
    },
  );

  it.each(["launchpad", "rocket"] as const)(
    "retains the full research page for %s",
    async (product) => {
      mockedProduct.mockReturnValue(product);
      const { html, status } = await renderPublicShell(
        request("/features/research-compute"),
      );
      expect(status).toBe(200);
      expect(html).toContain('data-cocalc-public-prerender="feature"');
      expect(html).toContain(
        'href="https://cocalc.ai/features/research-compute" rel="canonical"',
      );
      expect(html).toContain('href="/docs/hosts/project-hosts"');
    },
  );
});
