import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express from "express";
import { getDocsEntry } from "@cocalc/docs";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import initPublicLlmsTxt, {
  LLMS_TXT_PAGE_ID,
  renderLlmsTxt,
} from "./public-llms-txt";

// cocalc.ai runs the Launchpad product.
jest.mock("@cocalc/server/launchpad/mode", () => ({
  getCocalcProduct: () => "launchpad",
  isLaunchpadProduct: () => true,
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ siteName: "CoCalc" })),
}));

import getCustomize from "@cocalc/database/settings/customize";

const mockedCustomize = jest.mocked(getCustomize);
const page = getDocsEntry(LLMS_TXT_PAGE_ID, { siteProfile: "cocalc-ai" })!;

async function get(host: string) {
  const app = express();
  const router = express.Router();
  initPublicLlmsTxt(router);
  app.use(router);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<{ body: string; headers: any; status: number }>(
      (resolve, reject) => {
        const options = { headers: { Host: host }, path: "/llms.txt", port };
        httpRequest({ ...options, hostname: "127.0.0.1" }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
              status: response.statusCode ?? 0,
            }),
          );
        })
          .on("error", reject)
          .end();
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("/llms.txt", () => {
  it("is served on the canonical cocalc.ai host", async () => {
    const { body, headers, status } = await get("cocalc.ai");
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(headers.vary).toMatch(/host/i);
    expect(body).toMatch(/^# CoCalc\n\n> CoCalc is made by SageMath, Inc\. /);
    expect(body).toContain(
      `## Start here\n\n- [${page.title}](https://cocalc.ai/docs/${page.slug}): ${page.summary}\n`,
    );
  });

  it("titles the site as the public pages do", async () => {
    // The default Launchpad site name maps to the marketing name...
    mockedCustomize.mockResolvedValueOnce({
      siteName: "CoCalc Launchpad",
    } as any);
    expect((await get("cocalc.ai")).body).toMatch(/^# CoCalc\n/);
    // ...unless the site has its own logo, which keeps the configured name.
    mockedCustomize.mockResolvedValueOnce({
      logoSquareURL: "https://example.com/logo.png",
      siteName: "CoCalc Launchpad",
    } as any);
    expect((await get("cocalc.ai")).body).toMatch(/^# CoCalc Launchpad\n/);
  });

  it.each(["example.com", "lite1b.cocalc.ai", "localhost:9100"])(
    "returns 404 on %s",
    async (host) => {
      const { headers, status } = await get(host);
      expect(status).toBe(404);
      expect(headers.vary).toMatch(/host/i);
    },
  );

  it("is derived from the at-a-glance page and the registries", () => {
    const text = renderLlmsTxt({ product: "launchpad", siteName: "Example" })!;
    expect(text.startsWith("# Example\n\n> ")).toBe(true);
    // The quote is the page's first paragraph.
    const definition = page.body.split(/\n\s*\n/)[1].replace(/\s+/g, " ");
    expect(text).toContain(`\n\n> ${definition}\n\n`);
    // Sections follow the page's headings, and links use the linked page's
    // own title and summary rather than typed labels.
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings[0]).toBe("Start here");
    for (const heading of headings.slice(1)) {
      expect(page.body).toContain(`## ${heading}\n`);
    }
    const links = [...page.body.matchAll(/\]\((\/(docs|features)\/[^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(10);
    for (const [, path, kind] of links) {
      const slug = path.slice(kind.length + 2);
      const target =
        kind === "docs"
          ? getDocsEntry(slug, { siteProfile: "cocalc-ai" })
          : getPublicFeaturePage(slug);
      expect(text).toContain(
        `- [${target!.title}](https://cocalc.ai${path}): ${target!.summary}`,
      );
    }
    expect(text).toContain("- [Pricing](https://cocalc.ai/pricing)\n");
  });

  it("tags a link with the status its page declares", () => {
    const text = renderLlmsTxt({ product: "launchpad", siteName: "CoCalc" })!;
    const tagged = text.split("\n").filter((line) => /Status: /.test(line));
    expect(tagged).toEqual([
      expect.stringMatching(
        /^- \[Claude Code in CoCalc \(Experimental Preview\)\]\(https:\/\/cocalc\.ai\/docs\/ai\/claude-code\): .+ Status: experimental preview\.$/,
      ),
    ]);
  });
});
