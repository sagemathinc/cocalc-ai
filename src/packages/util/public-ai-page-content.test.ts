import { getDocsEntry } from "@cocalc/docs";

import {
  getPublicAiCards,
  getPublicAiHeadline,
  PUBLIC_AI_CLAUDE_HEADLINE,
  PUBLIC_AI_MENTIONS_LINE,
} from "./public-ai-page-content";
import { getPublicFeaturePage } from "./public-feature-pages";
import {
  getPublicHomeHighlights,
  PUBLIC_HOME_AGENTS_HIGHLIGHT,
} from "./public-home-content";

const COCALC_AI = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  site_name: "CoCalc",
};

describe("AI feature page words", () => {
  it.each([
    [COCALC_AI, true],
    [{ ...COCALC_AI, dns: "cocalc.ai:443" }, true],
    [{ ...COCALC_AI, cocalc_product: "plus" }, false],
    [{ ...COCALC_AI, dns: "launchpad.example.edu" }, false],
    [{ cocalc_product: "rocket", dns: "compute.example.edu" }, false],
    [{ ...COCALC_AI, logo_square: "https://example.edu/logo.png" }, false],
    [{ ...COCALC_AI, site_name: "University CoCalc" }, false],
    // Before /customize answers, as on Home.
    [{}, false],
    [undefined, false],
  ])(
    "names Claude Code in the headline where Home's highlights do: %j",
    (config, namesClaude) => {
      expect(getPublicAiHeadline(config)).toBe(
        namesClaude
          ? PUBLIC_AI_CLAUDE_HEADLINE
          : getPublicFeaturePage("ai")!.tagline,
      );
      expect(
        getPublicHomeHighlights(config).includes(PUBLIC_HOME_AGENTS_HIGHLIGHT),
      ).toBe(namesClaude);
    },
  );

  it.each([
    [COCALC_AI, true],
    [{ cocalc_product: "launchpad", dns: "launchpad.example.edu" }, true],
    [{ cocalc_product: "rocket" }, true],
    [{ cocalc_product: "plus" }, false],
    [{ ...COCALC_AI, cocalc_product: "plus" }, false],
    [{}, false],
    [undefined, false],
  ])(
    "adds the line about @mentions to the first card on hosted sites only: %j",
    (config, hosted) => {
      const sections = getPublicFeaturePage("ai")!.sections!;
      const cards = getPublicAiCards(config);
      expect(cards).toHaveLength(sections.length);
      expect(cards[0]).toEqual({
        ...sections[0],
        paragraphs: hosted
          ? [...sections[0].paragraphs!, PUBLIC_AI_MENTIONS_LINE]
          : sections[0].paragraphs,
      });
      expect(cards.slice(1)).toEqual(sections.slice(1));
      // The record itself never carries the line.
      expect(
        sections.flatMap(({ paragraphs }) => paragraphs ?? []),
      ).not.toContain(PUBLIC_AI_MENTIONS_LINE);
    },
  );

  it("links each card's documentation to a published docs page", () => {
    const sections = getPublicFeaturePage("ai")!.sections!;
    const docsLinks = sections.flatMap(({ links }) =>
      (links ?? []).filter(({ href }) => href.startsWith("/docs/")),
    );
    expect(docsLinks.map(({ href }) => href)).toEqual([
      "/docs/ai/codex-chat",
      "/docs/ai/claude-code",
    ]);
    for (const { href } of docsLinks) {
      expect(getDocsEntry(href.slice("/docs/".length))).toBeDefined();
      // None of them is in CoCalc Plus, which is why Plus hides these links.
      expect(
        getDocsEntry(href.slice("/docs/".length), { product: "plus" }),
      ).toBeUndefined();
    }
    expect(getDocsEntry("ai/claude-code")?.title).toBe(
      "Claude Code in CoCalc (Experimental Preview)",
    );
  });
});
