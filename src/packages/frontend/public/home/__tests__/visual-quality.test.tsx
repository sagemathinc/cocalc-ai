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

    const codexGrid = getGrid(container, ".cocalc-public-home-codex-grid");
    const differenceGrid = getGrid(
      container,
      ".cocalc-public-home-difference-grid",
    );
    const finalActions = getGrid(
      container,
      ".cocalc-public-home-final-actions",
    );

    expect(getDirectCards(codexGrid)).toHaveLength(3);
    expectGridTemplate(codexGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(codexGrid, "h3")).toEqual([
      "Work with files and services",
      "Review agent changes",
      "Integrated chat or terminal",
    ]);

    // The tool catalogue, the audience cards and the product list are not on
    // Home any more.
    for (const removedGrid of [
      ".cocalc-public-home-feature-grid",
      ".cocalc-public-home-audience-grid",
      ".cocalc-public-home-product-grid",
    ]) {
      expect(container.querySelector(removedGrid)).toBeNull();
    }

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
    expect(css).toContain(".cocalc-public-home-final-layout");
    expect(css).not.toContain(".cocalc-public-home-path-grid");
    // No rules are left for the sections Home no longer renders.
    for (const removedClass of [
      ".cocalc-public-home-workflow-",
      ".cocalc-public-home-feature-grid",
      ".cocalc-public-home-audience-grid",
      ".cocalc-public-home-product-grid",
      ".cocalc-public-home-products",
    ]) {
      expect(css).not.toContain(removedClass);
    }

    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain(".cocalc-public-home-final-actions .ant-btn");

    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain(".cocalc-public-home-codex-grid");
    expect(css).toContain(".cocalc-public-home-difference-grid");
    expect(css).toContain(".cocalc-public-home-modal-grid");
    expect(css).toContain(".cocalc-public-home-final-actions");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) !important;");
  });

  it("keeps repeated cards scannable instead of letting copy sprawl", () => {
    const { container } = renderHome();

    expectHomeCardsStayCompact(
      getGrid(container, ".cocalc-public-home-codex-grid"),
      { maxCardText: 250, maxTitleText: 28 },
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
    expect(h1[0]).toHaveTextContent("Build and use software with AI.");
    expect(textLength(h1[0])).toBeLessThanOrEqual(HERO_H1_MAX);

    // Section identity and order are canaried by the aria-label array in
    // app.test.tsx; here we only hold the count and an anti-sprawl length
    // bound, so headline wording can change without a test edit.
    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(sectionHeadings).toHaveLength(3);
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
    const { container } = renderHome();

    const heroImage = within(
      screen.getByRole("region", { name: "CoCalc hero" }),
    ).getByRole("img", {
      name: "A saved CoCalc Jupyter notebook with synthetic runtime results and TimeTravel and Agent controls",
    });
    expect(heroImage.getAttribute("src")).toBe(
      "/public/landing/project-notebook-20260916.jpg",
    );
    expect(heroImage.getAttribute("style") ?? "").toContain(
      "aspect-ratio: 1050 / 650;",
    );
    expect(heroImage.getAttribute("style") ?? "").toContain(
      "object-fit: contain;",
    );

    // The terminal capture went with the tool catalogue, so the hero image is
    // the only image in the page body.
    expect(
      within(
        container.querySelector(".cocalc-public-home") as HTMLElement,
      ).getAllByRole("img"),
    ).toEqual([heroImage]);
  });
});
