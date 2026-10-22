import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import getCustomize from "@cocalc/database/settings/customize";
import { POLICY_MARKDOWN_ASSET } from "@cocalc/util/public-policy-markdown";
import { initPublicPolicyMarkdown } from "./public-policy-markdown";

let mockStaticPath: string;
jest.mock("./public-static-path", () => ({
  resolveStaticPath: () => mockStaticPath,
}));
jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(),
}));

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let origin: string;
const documents = [
  "terms",
  "privacy",
  "dpa",
  "ferpa",
  "trust",
  "copyright",
  "accessibility",
].map((slug) => ({
  slug,
  title: slug,
  description: `${slug} description`,
  updated: "October 1, 2026",
  markdown: `# ${slug}\n\nLast Updated: October 1, 2026\n\nPolicy text.\n`,
}));

beforeAll(async () => {
  mockStaticPath = await mkdtemp(join(tmpdir(), "policy-markdown-"));
  await writeFile(
    join(mockStaticPath, POLICY_MARKDOWN_ASSET),
    JSON.stringify(documents),
  );
  const app = express();
  const router = express.Router();
  initPublicPolicyMarkdown(router);
  // Mirror a deployment with a non-root base path and the HTML fallback.
  router.get("/policies/:slug", (_req, res) => res.send("HTML shell"));
  app.use("/site", router);
  server = await new Promise((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/site`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(mockStaticPath, { recursive: true, force: true });
});
beforeEach(() =>
  jest
    .mocked(getCustomize)
    .mockResolvedValue({ policy_pages: "sagemathinc" } as any),
);

test.each(documents)(
  "serves $slug Markdown from the generated manifest",
  async (document) => {
    const response = await fetch(`${origin}/policies/${document.slug}.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("vary")).toMatch(/host/i);
    expect(await response.text()).toBe(document.markdown);
  },
);

test.each([
  {},
  { policy_pages: "none" },
  { policy_pages: "custom" },
  {
    policy_pages: "sagemathinc",
    termsOfServiceURL: "https://example.com/legal",
  },
])("does not expose built-in Markdown for %j", async (config) => {
  jest.mocked(getCustomize).mockResolvedValue(config as any);
  expect((await fetch(`${origin}/policies/terms.md`)).status).toBe(404);
});

test("unknown slugs do not fall through to the HTML shell", async () => {
  expect((await fetch(`${origin}/policies/missing.md`)).status).toBe(404);
});

test("a missing build artifact returns an unavailable response", async () => {
  await rm(join(mockStaticPath, POLICY_MARKDOWN_ASSET));
  const response = await fetch(`${origin}/policies/terms.md`);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("HTML shell");
});
