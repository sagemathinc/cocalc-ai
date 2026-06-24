/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";
import {
  expectGridTemplate,
  getCardTitles,
  getDirectCards,
  getGrid,
  getInjectedCss,
  HERO_H1_MAX,
  installMatchMediaStub,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  STALE_REPETITIVE_HOME_LINES,
  textLength,
} from "../../__tests__/test-helpers";

function renderHome() {
  return render(
    <PublicHomeApp
      config={{
        cocalc_product: "launchpad",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      }}
    />,
  );
}

function expectHomeCardsStayCompact(
  grid: HTMLElement,
  { maxCardText, maxTitleText }: { maxCardText: number; maxTitleText: number },
) {
  for (const card of getDirectCards(grid)) {
    expect(textLength(card)).toBeLessThanOrEqual(maxCardText);
    const heading = card.querySelector("h3");
    expect(heading).not.toBeNull();
    expect(textLength(heading as HTMLElement)).toBeLessThanOrEqual(
      maxTitleText,
    );
  }
}

beforeAll(() => {
  installMatchMediaStub();
});

describe("PublicHomeApp visual quality contract", () => {
  it("keeps the card systems balanced across the landing page", () => {
    const { container } = renderHome();

    const workflowGrid = within(
      screen.getByRole("region", { name: "Core workflows" }),
    ).getByRole("group", { name: "CoCalc workflow feature cards" });
    const audienceGrid = getGrid(
      container,
      ".cocalc-public-home-audience-grid",
    );
    const codexGrid = getGrid(container, ".cocalc-public-home-codex-grid");
    const productGrid = getGrid(container, ".cocalc-public-home-product-grid");
    const differenceGrid = getGrid(
      container,
      ".cocalc-public-home-difference-grid",
    );
    const finalActions = getGrid(
      container,
      ".cocalc-public-home-final-actions",
    );

    expect(getDirectCards(workflowGrid)).toHaveLength(6);
    expectGridTemplate(workflowGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(workflowGrid, "h3")).toEqual([
      "Jupyter Notebooks",
      "LaTeX Editor",
      "Linux Terminal",
      "Codex Agent Chat",
      "Teaching a Course",
      "Whiteboard & Slides",
    ]);
    expect(workflowGrid.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(workflowGrid.querySelectorAll(".anticon-arrow-right")).toHaveLength(
      0,
    );

    expect(getDirectCards(codexGrid)).toHaveLength(3);
    expectGridTemplate(codexGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(codexGrid, "h3")).toEqual([
      "Runs where your work lives",
      "You stay in review",
      "Powered by OpenAI",
    ]);

    expect(getDirectCards(audienceGrid)).toHaveLength(3);
    expectGridTemplate(audienceGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(audienceGrid, "h3")).toEqual([
      "Research and engineering teams",
      "IT and platform teams",
      "Technical courses and workshops",
    ]);
    for (const card of getDirectCards(audienceGrid)) {
      expect(card.tagName).toBe("A");
      expect(card.className).toContain("cocalc-public-home-audience-card");
      expect(card.getAttribute("style") ?? "").toContain("display: grid");
      expect(card.getAttribute("style") ?? "").toContain(
        "grid-template-rows: 44px minmax(96px, 1fr) auto",
      );
      expect(card.querySelector(".ant-btn")).toBeNull();
      expect(
        card.querySelector(".cocalc-public-home-audience-action"),
      ).not.toBeNull();
    }

    expect(getDirectCards(productGrid)).toHaveLength(5);
    expectGridTemplate(productGrid, "repeat(5, minmax(0, 1fr))");
    expect(productGrid.querySelectorAll(".anticon-arrow-right")).toHaveLength(
      0,
    );
    for (const card of getDirectCards(productGrid)) {
      expect(card.tagName).toBe("A");
      expect(card.className).toContain("cocalc-public-home-card-link");
    }
    expect(getCardTitles(productGrid, "h3")).toEqual([
      "CoCalc.ai",
      "CoCalc Plus",
      "CoCalc Star",
      "CoCalc Launchpad",
      "CoCalc Rocket",
    ]);

    expect(getDirectCards(differenceGrid)).toHaveLength(4);
    expectGridTemplate(differenceGrid, "repeat(2, minmax(0, 1fr))");
    for (const card of getDirectCards(differenceGrid)) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.className).toContain("cocalc-public-home-difference-card");
    }
    expect(getCardTitles(differenceGrid, "h3")).toEqual([
      "Project-centered workflow",
      "Inspection before handoff",
      "Practical recovery",
      "Operating model choice",
    ]);
    expect(differenceGrid.textContent ?? "").not.toMatch(
      /Inspect before handoff\s*Inspection before handoff/i,
    );

    expect(getDirectCards(finalActions)).toHaveLength(3);
    expectGridTemplate(finalActions, "repeat(3, max-content)");
    expect(container.querySelector(".cocalc-public-home-path-grid")).toBeNull();
  });

  it("keeps responsive grid fallbacks explicit for tablet and phone widths", () => {
    const { container } = renderHome();
    const css = getInjectedCss(container);

    expect(css).toContain("@media (max-width: 920px)");
    expect(css).toContain("@media (max-width: 1120px)");
    expect(css).toContain(".cocalc-public-home-workflow-layout");
    expect(css).toContain(".cocalc-public-home-final-layout");
    expect(css).toContain(".cocalc-public-home-audience-grid");
    expect(css).toContain(".cocalc-public-home-product-grid");
    expect(css).not.toContain(".cocalc-public-home-path-grid");
    expect(css).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr)) !important;",
    );

    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain(".cocalc-public-home-feature-grid");
    expect(css).toContain(".cocalc-public-home-codex-grid");
    expect(css).toContain(".cocalc-public-home-difference-grid");
    expect(css).toContain(".cocalc-public-home-modal-grid");
    expect(css).toContain(".cocalc-public-home-final-actions");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) !important;");
  });

  it("keeps repeated cards scannable instead of letting copy sprawl", () => {
    const { container } = renderHome();

    expectHomeCardsStayCompact(
      within(screen.getByRole("region", { name: "Core workflows" })).getByRole(
        "group",
        { name: "CoCalc workflow feature cards" },
      ),
      { maxCardText: 230, maxTitleText: 28 },
    );
    expectHomeCardsStayCompact(
      getGrid(container, ".cocalc-public-home-codex-grid"),
      { maxCardText: 250, maxTitleText: 28 },
    );
    expectHomeCardsStayCompact(
      getGrid(container, ".cocalc-public-home-audience-grid"),
      { maxCardText: 285, maxTitleText: 36 },
    );
    expectHomeCardsStayCompact(
      getGrid(container, ".cocalc-public-home-product-grid"),
      { maxCardText: 175, maxTitleText: 24 },
    );
    expectHomeCardsStayCompact(
      getGrid(container, ".cocalc-public-home-difference-grid"),
      { maxCardText: 245, maxTitleText: 36 },
    );
    for (const link of within(
      getGrid(container, ".cocalc-public-home-final-actions"),
    ).getAllByRole("link")) {
      expect(textLength(link)).toBeLessThanOrEqual(24);
    }
  });

  it("keeps the main story direct for researchers and decision makers", () => {
    const { container } = renderHome();

    const h1 = container.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent(
      "Shared Projects for Research Teams",
    );
    expect(textLength(h1[0])).toBeLessThanOrEqual(HERO_H1_MAX);

    // Section identity and order are canaried by the aria-label array in
    // app.test.tsx; here we only hold the count and an anti-sprawl length
    // bound, so headline wording can change without a test edit.
    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(sectionHeadings).toHaveLength(6);
    for (const heading of sectionHeadings) {
      expect(textLength(heading)).toBeLessThanOrEqual(SECTION_H2_MAX);
    }

    expect(container.textContent ?? "").not.toMatch(
      INTERNAL_IMPLEMENTATION_TERMS,
    );
    expect(container.textContent ?? "").not.toMatch(
      STALE_REPETITIVE_HOME_LINES,
    );
    const hero = screen.getByRole("region", { name: "CoCalc hero" });
    expect(hero.textContent ?? "").not.toMatch(
      /notebooks, code, documents|hosted, local, single-VM/i,
    );
  });

  it("keeps the landing page anchored by concrete visual assets", () => {
    renderHome();

    const heroImage = within(
      screen.getByRole("region", { name: "CoCalc hero" }),
    ).getByRole("img", {
      name: "CoCalc-AI collaborative project overview",
    });
    expect(heroImage.getAttribute("src")).toBe("/public/landing/home-hero.jpg");
    expect(heroImage.getAttribute("style") ?? "").toContain(
      "aspect-ratio: 1672 / 941;",
    );
    expect(heroImage.getAttribute("style") ?? "").toContain(
      "object-fit: contain;",
    );

    const workflowImage = within(
      screen.getByRole("region", { name: "Core workflows" }),
    ).getByRole("img", {
      name: "One CoCalc workspace containing many workflows",
    });
    expect(workflowImage.getAttribute("src")).toBe(
      "/public/landing/project-workflows.jpg",
    );
    expect(workflowImage.getAttribute("style") ?? "").toContain(
      "aspect-ratio: 16 / 9;",
    );
    expect(workflowImage.getAttribute("style") ?? "").toContain(
      "object-fit: contain;",
    );
  });
});
