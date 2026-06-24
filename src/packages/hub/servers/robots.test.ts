import type { AddressInfo } from "node:net";
import express from "express";
import { get_server_settings } from "@cocalc/database/postgres/settings/server-settings";
import initRobots from "./robots";

jest.mock("@cocalc/database/postgres/settings/server-settings", () => ({
  get_server_settings: jest.fn(),
}));

const mockGetServerSettings = get_server_settings as jest.MockedFunction<
  typeof get_server_settings
>;

async function requestRobots() {
  const app = express();
  app.use("/robots.txt", initRobots());
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/robots.txt`, {
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

describe("robots.txt", () => {
  beforeEach(() => {
    mockGetServerSettings.mockReset();
  });

  it("advertises the sitemap when landing pages are enabled", async () => {
    mockGetServerSettings.mockResolvedValue({ landing_pages: true } as any);

    const response = await requestRobots();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /static/");
    expect(body).toContain("Sitemap: https://example.test/sitemap.xml");
  });

  it("keeps the default non-landing robots gate without a sitemap", async () => {
    mockGetServerSettings.mockResolvedValue({ landing_pages: false } as any);

    const response = await requestRobots();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Allow: /share");
    expect(body).toContain("Disallow: /");
    expect(body).not.toContain("Sitemap:");
  });
});
