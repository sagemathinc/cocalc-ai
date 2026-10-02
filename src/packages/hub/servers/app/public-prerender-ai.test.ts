import {
  getPublicAiCards,
  PUBLIC_AI_CLAUDE_HEADLINE,
  PUBLIC_AI_INTRO,
  PUBLIC_AI_MENTIONS_LINE,
} from "@cocalc/util/public-ai-page-content";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import type { PublicRouteMetadataConfig } from "@cocalc/util/public-site-metadata";
import { renderPublicRoutePrerender } from "./public-prerender";

// cocalc.ai's /customize reports the Launchpad product, so the cocalc.ai case
// does too.
const COCALC_AI = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  is_launchpad: true,
  site_name: "CoCalc",
};

const PAGE = getPublicFeaturePage("ai")!;

function renderAi(basePath: string, config?: PublicRouteMetadataConfig) {
  return renderPublicRoutePrerender(
    { section: "features", route: { view: "detail", slug: "ai" } },
    basePath,
    config,
  );
}

function header(html: string): string[] {
  const part = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  return [...part.matchAll(/<(p|h1|li)>([^<]+)<\/\1>/g)].map(
    ([, tag, text]) => `${tag}: ${text}`,
  );
}

// A card's title and paragraphs, as the fallback renders them before its links.
function cardStart({
  paragraphs,
  title,
}: {
  paragraphs?: string[];
  title: string;
}): string {
  return `<section><h2>${title}</h2>${(paragraphs ?? [])
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("")}`;
}

// The React page renders the same records
// (frontend/public/features/__tests__/ai-page.test.tsx), so crawlers read its
// hero and agent cards word for word.
describe("AI feature page initial HTML", () => {
  it.each(["/", "/prefix"])(
    "renders the hero and agent cards on cocalc.ai at %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      const html = renderAi(basePath, COCALC_AI);

      expect(header(html)).toEqual([
        "p: CoCalc feature",
        "h1: AI Agents",
        `p: ${PUBLIC_AI_CLAUDE_HEADLINE}`,
        `p: ${PUBLIC_AI_INTRO}`,
      ]);
      const cards = getPublicAiCards(COCALC_AI);
      expect(cards).toHaveLength(2);
      expect(cards[0].paragraphs).toContain(PUBLIC_AI_MENTIONS_LINE);
      const sections = cards.map(
        ({ links, paragraphs, title }) =>
          `<section><h2>${title}</h2>${paragraphs!
            .map((paragraph) => `<p>${paragraph}</p>`)
            .join("")}<ul>${links!
            .map(
              ({ href, label }) =>
                `<li><a href="${prefix}${href}">${label}</a></li>`,
            )
            .join("")}</ul></section>`,
      );
      expect(html).toContain(sections.join(""));
      expect(html).not.toContain("<details");
    },
  );

  // The same sites as the Home highlight that names Claude Code.
  it.each([
    [
      "a self-hosted Launchpad host",
      {
        cocalc_product: "launchpad",
        dns: "launchpad.example.edu",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      },
    ],
    ["a Rocket site", { cocalc_product: "rocket", dns: "compute.example.edu" }],
    [
      "a custom logo on cocalc.ai",
      { ...COCALC_AI, logo_square: "https://example.edu/logo.png" },
    ],
    ["a cocalc.ai subdomain", { ...COCALC_AI, dns: "dev.cocalc.ai" }],
    ["no site configuration", undefined],
  ])(
    "keeps the headline that does not name Claude Code on %s",
    (_site, config) => {
      const html = renderAi("/", config);
      expect(header(html)).toEqual([
        "p: CoCalc feature",
        "h1: AI Agents",
        `p: ${PAGE.tagline}`,
        `p: ${PUBLIC_AI_INTRO}`,
      ]);
      expect(html).not.toContain(PUBLIC_AI_CLAUDE_HEADLINE);
      for (const card of getPublicAiCards(config)) {
        expect(html).toContain(cardStart(card));
      }
      // Hosted sites add the line about @mentions once the product is known.
      expect(html.includes(PUBLIC_AI_MENTIONS_LINE)).toBe(config != null);
    },
  );

  it.each(["/", "/prefix"])(
    "keeps CoCalc Plus to the cards, without documentation links or the line about @mentions, at %s",
    (basePath) => {
      const prefix = basePath === "/" ? "" : basePath;
      for (const config of [
        { cocalc_product: "plus" },
        { ...COCALC_AI, cocalc_product: "plus" },
      ]) {
        const html = renderAi(basePath, config);
        expect(header(html)).toEqual([
          "p: CoCalc feature",
          "h1: AI Agents",
          `p: ${PAGE.tagline}`,
          `p: ${PUBLIC_AI_INTRO}`,
        ]);
        for (const { links, paragraphs, title } of PAGE.sections!) {
          expect(html).toContain(`<h2>${title}</h2><p>${paragraphs![0]}</p>`);
          for (const { href, label } of links!) {
            if (href.startsWith("/docs/")) {
              expect(html).not.toContain(`>${label}</a>`);
            } else {
              expect(html).toContain(
                `<li><a href="${prefix}${href}">${label}</a></li>`,
              );
            }
          }
        }
        expect(html).not.toContain(PUBLIC_AI_MENTIONS_LINE);
      }
    },
  );

  it("drops the lines and sections the page does not show", () => {
    const html = renderAi("/", COCALC_AI);
    expect(html).not.toContain(PAGE.summary);
    expect(html).not.toContain(PAGE.metadataSummary!);
    for (const line of [
      "Use AI agents where the work already lives.",
      "Codex in project threads",
      "Integrated chat or a terminal agent",
    ]) {
      expect(html).not.toContain(line);
    }
  });
});
