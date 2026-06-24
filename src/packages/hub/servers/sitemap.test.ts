import type { AddressInfo } from "node:net";
import express from "express";
import { get_server_settings } from "@cocalc/database/postgres/settings/server-settings";
import initSitemap from "./sitemap";

jest.mock("@cocalc/database/postgres/settings/server-settings", () => ({
  get_server_settings: jest.fn(),
}));

const mockGetServerSettings = get_server_settings as jest.MockedFunction<
  typeof get_server_settings
>;

async function requestSitemap() {
  const app = express();
  app.use("/sitemap.xml", initSitemap());
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/sitemap.xml`, {
      headers: {
        "x-forwarded-host": "example.test",
        "x-forwarded-proto": "https",
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("sitemap.xml", () => {
  beforeEach(() => {
    mockGetServerSettings.mockReset();
  });

  it("serves canonical public URLs when landing pages are enabled", async () => {
    mockGetServerSettings.mockResolvedValue({ landing_pages: true } as any);

    const response = await requestSitemap();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    const body = await response.text();
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(body).toContain("<loc>https://example.test/</loc>");
    expect(body).toContain("<loc>https://example.test/features/ai</loc>");
    expect(body).toContain(
      "<loc>https://example.test/products/cocalc-star</loc>",
    );
    expect(body).toContain("<loc>https://example.test/policies/privacy</loc>");
    expect(body).toContain("<loc>https://example.test/de</loc>");
    expect(body).not.toContain("/auth/sign-up");
    expect(body).not.toContain("/features/icons");
  });

  it("keeps the sitemap behind the landing-pages gate", async () => {
    mockGetServerSettings.mockResolvedValue({ landing_pages: false } as any);

    const response = await requestSitemap();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
  });
});
