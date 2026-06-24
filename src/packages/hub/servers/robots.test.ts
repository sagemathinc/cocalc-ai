import type { AddressInfo } from "node:net";
import express from "express";
import { get_server_settings } from "@cocalc/database/postgres/settings/server-settings";
import initRobots from "./robots";

jest.mock("@cocalc/database/postgres/settings/server-settings", () => ({
  get_server_settings: jest.fn(),
}));

const mockGetServerSettings = get_server_settings as jest.Mock;

describe("robots.txt", () => {
  async function request() {
    const app = express();
    app.use("/robots.txt", initRobots());
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    try {
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const response = await fetch(`${origin}/robots.txt`);
      return { body: await response.text(), origin, response };
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("adds the sitemap reference when landing pages are enabled", async () => {
    mockGetServerSettings.mockResolvedValueOnce({ landing_pages: true });

    const { body, origin, response } = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("Disallow: /static/");
    expect(body).toContain(`Sitemap: ${origin}/sitemap.xml`);
  });

  it("keeps the locked-down default when landing pages are disabled", async () => {
    mockGetServerSettings.mockResolvedValueOnce({ landing_pages: false });

    const { body, response } = await request();

    expect(response.status).toBe(200);
    expect(body).toContain("Allow: /share");
    expect(body).toContain("Disallow: /");
    expect(body).not.toContain("Sitemap:");
  });
});
