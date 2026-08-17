import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express from "express";
import { APP_ROUTES } from "@cocalc/util/routing/app";
import initRobots from "./robots";

jest.mock("@cocalc/database/postgres/news", () => ({
  getFeedData: jest.fn(async () => []),
}));

describe("robots.txt", () => {
  async function request({ host }: { host?: string } = {}) {
    const app = express();
    app.use("/robots.txt", initRobots());
    const server = await new Promise<ReturnType<typeof app.listen>>(
      (resolve) => {
        const next = app.listen(0, "127.0.0.1", () => resolve(next));
      },
    );
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise<{
        body: string;
        contentType?: string;
        status: number;
        vary?: string;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            headers: host == null ? undefined : { Host: host },
            hostname: "127.0.0.1",
            path: "/robots.txt",
            port,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: response.headers["content-type"],
                status: response.statusCode ?? 0,
                vary: response.headers.vary,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  it("allows all public content on the canonical public host", async () => {
    const host = "cocalc.ai";
    const { body, contentType, status, vary } = await request({ host });

    expect(status).toBe(200);
    expect(contentType).toContain("text/plain");
    expect(vary).toContain("Host");
    expect(body.split("\n")).toContain("Allow: /");
    expect(body.split("\n")).toContain("Allow: /share");
    expect(body.split("\n")).toContain("Allow: /static/");
    expect(body).toContain("Disallow: /static/public.html");
    expect(body).toContain("Disallow: /static/app.html");
    expect(body).toContain("Disallow: /static/embed.html");
    expect(body).toContain("Disallow: /static/ultralite.html");
    expect(body.split("\n")).toContain("Disallow: /essential");
    // The viewer shells are blocked, but the public-viewer*-<hash>.js entry
    // chunks must stay fetchable so crawlers can render /share pages.
    expect(body.split("\n")).toContain("Disallow: /static/public-viewer*.html");
    expect(body).not.toContain("Disallow: /static/\n");
    expect(body).toContain("Disallow: /webapp/");
    expect(body).toContain("Disallow: /cdn/");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain(`Sitemap: http://${host}/sitemap.xml`);
    expect(body).not.toContain("Disallow: /features");
    expect(body).not.toMatch(/^ +/m);
  });

  it("blocks app shell routes except public shares", async () => {
    const { body } = await request({ host: "cocalc.ai" });
    const lines = body.split("\n");

    for (const route of APP_ROUTES) {
      if (route === "share") {
        expect(lines).not.toContain(`Disallow: /${route}`);
      } else {
        expect(lines).toContain(`Disallow: /${route}`);
      }
    }
  });

  it("lets branded crawlers read canonicals and advertises the local sitemap", async () => {
    const host = "university.example.edu";
    const { body, status } = await request({ host });
    const lines = body.split("\n");

    expect(status).toBe(200);
    expect(lines).toContain("Allow: /");
    expect(lines).toContain("Allow: /share");
    expect(lines).not.toContain("Disallow: /features");
    expect(lines).not.toContain("Disallow: /pricing");
    expect(lines).not.toContain("Disallow: /about");
    expect(lines).not.toContain("Disallow: /products");
    expect(lines).not.toContain("Disallow: /news");
    expect(lines).not.toContain("Disallow: /docs");
    expect(lines).not.toContain("Disallow: /auth");
    expect(body).toContain(`Sitemap: http://${host}/sitemap.xml`);
  });

  it("keeps dev subdomains and local instances locked down", async () => {
    for (const host of ["localhost:9100", "[::1]:9100", "dev123.cocalc.ai"]) {
      const { body, status } = await request({ host });
      expect({ body, host, status }).toEqual({
        body: "User-agent: *\nAllow: /share\nDisallow: /\n",
        host,
        status: 200,
      });
      expect(body).not.toContain("Sitemap:");
      expect(body).not.toMatch(/^ +/m);
    }
  });
});
