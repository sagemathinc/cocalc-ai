import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import express from "express";
import { PUBLIC_POLICY_MARKDOWN } from "@cocalc/util/public-policies-markdown.generated";
import initPublicPolicies, {
  builtinPolicies,
  renderPublicPoliciesPrerender,
  resolvePolicyLinks,
} from "./public-policies";
import { renderLlmsTxt } from "./public-llms-txt";

jest.mock("@cocalc/server/launchpad/mode", () => ({
  getCocalcProduct: () => "launchpad",
  isLaunchpadProduct: () => true,
}));

jest.mock("@cocalc/database/settings/customize", () => ({
  __esModule: true,
  default: jest.fn(async () => ({ policy_pages: "sagemathinc" })),
}));

import getCustomize from "@cocalc/database/settings/customize";

const mockedCustomize = jest.mocked(getCustomize);
const SAGEMATHINC = { policy_pages: "sagemathinc" };

async function get(path: string) {
  const app = express();
  const router = express.Router();
  initPublicPolicies(router);
  // Stands in for the public content routes registered after it.
  router.get("/policies/:slug", (_req, res) => {
    res.send("public shell");
  });
  app.use(router);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const next = app.listen(0, "127.0.0.1", () => resolve(next));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<{ body: string; headers: any; status: number }>(
      (resolve, reject) => {
        const options = { headers: { Host: "cocalc.ai" }, path, port };
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

describe("built-in policy Markdown", () => {
  it("covers every built-in policy, each with a title, date and sections", () => {
    expect(PUBLIC_POLICY_MARKDOWN.map(({ slug }) => slug).sort()).toEqual([
      "accessibility",
      "copyright",
      "dpa",
      "ferpa",
      "privacy",
      "terms",
      "trust",
    ]);
    for (const policy of PUBLIC_POLICY_MARKDOWN) {
      expect(policy.markdown.startsWith(`# ${policy.title}\n`)).toBe(true);
      expect(policy.markdown).toContain(`Last Updated: ${policy.updated}`);
      expect(policy.description).toBeTruthy();
    }
  });

  it("exists only where the built-in policy pages do", () => {
    expect(builtinPolicies(SAGEMATHINC)).toHaveLength(
      PUBLIC_POLICY_MARKDOWN.length,
    );
    expect(builtinPolicies({})).toEqual([]);
    expect(builtinPolicies({ policy_pages: "custom" })).toEqual([]);
    expect(
      builtinPolicies({
        ...SAGEMATHINC,
        terms_of_service_url: "https://example.com/terms",
      }),
    ).toEqual([]);
  });

  it("resolves site-relative links only", () => {
    expect(
      resolvePolicyLinks(
        "[a](/policies/privacy) [b](https://x.org/) [c](mailto:o@x.org)",
        "https://cocalc.ai/",
      ),
    ).toBe(
      "[a](https://cocalc.ai/policies/privacy) [b](https://x.org/) [c](mailto:o@x.org)",
    );
  });
});

describe("/policies/<slug>.md", () => {
  beforeEach(() => mockedCustomize.mockResolvedValue(SAGEMATHINC as any));

  it("serves the policy as Markdown ahead of the page route", async () => {
    const response = await get("/policies/terms.md");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.vary).toContain("Host");
    expect(response.body.startsWith("# Terms of Service\n")).toBe(true);
    expect(response.body).toContain("](http://cocalc.ai/policies/terms)");
    expect(response.body).not.toMatch(/\]\(\/[^/]/);
  });

  it("leaves the page route alone and 404s unknown policies", async () => {
    expect((await get("/policies/terms")).body).toBe("public shell");
    expect((await get("/policies/nope.md")).status).toBe(404);
  });

  it("404s where the built-in policies are not served", async () => {
    mockedCustomize.mockResolvedValue({ policy_pages: "custom" } as any);
    expect((await get("/policies/terms.md")).status).toBe(404);
  });
});

describe("prerendered policy pages", () => {
  const detail = (slug: string) =>
    ({
      route: { policySlug: slug, view: "policies-detail" },
      section: "policies",
    }) as any;

  it("includes a policy's headings and text", () => {
    const html = renderPublicPoliciesPrerender(detail("privacy"), SAGEMATHINC);
    expect(html).toContain("<h1>Privacy Policy</h1>");
    expect(html).toContain("<h2>");
    expect(html).toContain("<table>");
    expect(html).toContain('href="/policies/privacy.md"');
    expect(html).not.toContain("<script");
  });

  it("lists the policies on the index and renders nothing when disabled", () => {
    const index = renderPublicPoliciesPrerender(
      { route: { view: "policies" }, section: "policies" } as any,
      SAGEMATHINC,
    );
    for (const policy of PUBLIC_POLICY_MARKDOWN) {
      expect(index).toContain(`href="/policies/${policy.slug}.md"`);
    }
    expect(renderPublicPoliciesPrerender(detail("terms"), {})).toBe("");
    expect(renderPublicPoliciesPrerender(detail("nope"), SAGEMATHINC)).toBe("");
  });
});

describe("llms.txt policies section", () => {
  it("links each policy's Markdown with its description", () => {
    const text = renderLlmsTxt({
      policies: builtinPolicies(SAGEMATHINC),
      product: "launchpad",
      siteName: "CoCalc",
    })!;
    const section = text.slice(text.indexOf("## Policies\n"));
    expect(section.startsWith("## Policies\n")).toBe(true);
    for (const policy of PUBLIC_POLICY_MARKDOWN) {
      expect(section).toContain(
        `- [${policy.title}](https://cocalc.ai/policies/${policy.slug}.md): ${policy.description}`,
      );
    }
  });

  it("has no policies section without policies", () => {
    expect(
      renderLlmsTxt({ product: "launchpad", siteName: "CoCalc" }),
    ).not.toContain("## Policies");
  });
});
