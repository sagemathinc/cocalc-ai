/** @jest-environment jsdom */

import type { ComponentProps } from "react";

import { render, screen, within } from "@testing-library/react";

import {
  getPublicAiCards,
  PUBLIC_AI_CLAUDE_HEADLINE,
  PUBLIC_AI_INTRO,
  PUBLIC_AI_MENTIONS_LINE,
} from "@cocalc/util/public-ai-page-content";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import PublicFeaturesApp from "../app";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

// cocalc.ai's /customize reports the Launchpad product and the request host.
const COCALC_AI = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  site_name: "CoCalc",
};
const PLUS = { cocalc_product: "plus", site_name: "CoCalc Plus" };

const PAGE = getPublicFeaturePage("ai")!;
const INTERFACE_TITLE = "Use the agent interface that fits the task.";

function renderAiPage(
  config?: ComponentProps<typeof PublicFeaturesApp>["config"],
) {
  return render(
    <PublicFeaturesApp
      config={config}
      initialRoute={{ slug: "ai", view: "detail" }}
    />,
  );
}

function card(title: string): HTMLElement {
  return screen
    .getByRole("heading", { level: 3, name: title })
    .closest("article")!;
}

describe("AI feature page", () => {
  // The crawler fallback renders the same records
  // (hub/servers/app/public-prerender-ai.test.ts).
  it("renders its hero and agent cards from the shared records", () => {
    renderAiPage(COCALC_AI);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: PUBLIC_AI_CLAUDE_HEADLINE,
      }),
    ).not.toBeNull();
    expect(screen.getByText(PUBLIC_AI_INTRO)).not.toBeNull();

    const region = screen.getByRole("region", { name: INTERFACE_TITLE });
    const cards = getPublicAiCards(COCALC_AI);
    expect(cards).toHaveLength(2);
    expect(cards[0].paragraphs).toContain(PUBLIC_AI_MENTIONS_LINE);
    for (const { bullets, links, paragraphs, title } of cards) {
      // The page renders paragraphs and links; bullets would reach only the
      // crawler fallback.
      expect(bullets).toBeUndefined();
      const article = card(title);
      expect(region.contains(article)).toBe(true);
      for (const paragraph of paragraphs!) {
        expect(within(article).getByText(paragraph)).not.toBeNull();
      }
      for (const { href, label } of links!) {
        expect(
          within(article)
            .getByRole("link", { name: label })
            .getAttribute("href"),
        ).toBe(href);
      }
    }
  });

  // The same sites as the Home highlight that names Claude Code.
  it.each([
    ["the default CoCalc brand on cocalc.ai", COCALC_AI, true],
    [
      "CoCalc Plus on the canonical host",
      { ...COCALC_AI, cocalc_product: "plus" },
      false,
    ],
    [
      "a self-hosted Launchpad host",
      {
        cocalc_product: "launchpad",
        dns: "launchpad.example.edu",
        site_name: "CoCalc Launchpad",
      },
      false,
    ],
    [
      "a Rocket site",
      { cocalc_product: "rocket", dns: "compute.example.edu" },
      false,
    ],
    [
      "a custom logo on cocalc.ai",
      { ...COCALC_AI, logo_square: "https://example.edu/logo.png" },
      false,
    ],
    [
      "a custom site name on cocalc.ai",
      { ...COCALC_AI, site_name: "University CoCalc" },
      false,
    ],
    ["a cocalc.ai subdomain", { ...COCALC_AI, dns: "dev.cocalc.ai" }, false],
    // As on Home, the headline waits for /customize, even when the sign-in
    // state arrives first.
    [
      "only the sign-in state, before /customize answers",
      { is_authenticated: false },
      false,
    ],
    ["no site configuration yet", undefined, false],
  ])(
    "names Claude Code in the headline only where it is enabled: %s",
    (_site, config, namesClaude) => {
      const { container } = renderAiPage(config);
      const headline = namesClaude ? PUBLIC_AI_CLAUDE_HEADLINE : PAGE.tagline;
      expect(
        screen.getByRole("heading", { level: 2, name: headline }),
      ).not.toBeNull();
      expect(container.textContent).toContain(PUBLIC_AI_INTRO);
      if (!namesClaude) {
        expect(container.textContent).not.toContain(PUBLIC_AI_CLAUDE_HEADLINE);
      }
    },
  );

  it.each([
    [
      "another Launchpad host",
      { cocalc_product: "launchpad", dns: "launchpad.example.edu" },
      true,
    ],
    [
      "a Rocket site",
      { cocalc_product: "rocket", dns: "compute.example.edu" },
      true,
    ],
    ["no site configuration yet", undefined, false],
  ])(
    "shows the line about @mentions in the first card on hosted sites: %s",
    (_site, config, shown) => {
      renderAiPage(config);
      const first = card(PAGE.sections![0].title);
      if (shown) {
        expect(within(first).getByText(PUBLIC_AI_MENTIONS_LINE)).not.toBeNull();
      } else {
        expect(within(first).queryByText(PUBLIC_AI_MENTIONS_LINE)).toBeNull();
      }
    },
  );

  it("keeps CoCalc Plus to its existing cards, without documentation links or the line about @mentions", () => {
    const { container } = renderAiPage(PLUS);

    expect(
      screen.getByRole("heading", { level: 2, name: PAGE.tagline }),
    ).not.toBeNull();
    for (const { links, paragraphs, title } of PAGE.sections!) {
      const article = card(title);
      for (const paragraph of paragraphs!) {
        expect(within(article).getByText(paragraph)).not.toBeNull();
      }
      for (const { href, label } of links!) {
        if (href.startsWith("/docs/")) {
          expect(screen.queryByRole("link", { name: label })).toBeNull();
        } else {
          expect(
            within(article).getByRole("link", { name: label }),
          ).toHaveAttribute("href", href);
        }
      }
    }
    expect(container.textContent).not.toContain(PUBLIC_AI_MENTIONS_LINE);
  });
});
