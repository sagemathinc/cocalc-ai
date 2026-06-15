/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";

const INTERNAL_IMPLEMENTATION_TERMS =
  /serious\s+technical\s+work|project hosts|backend state|logs stay scoped|RootFS|multi-bay|control plane|postgres|kubernetes|systemd|conat/i;

const STALE_REPETITIVE_HOME_LINES =
  /One workspace for code, notebooks, documents, compute, and AI|Bring technical work back into one context|One workspace for research, courses, and platform teams|Use the tools you already understand, together|Collaborative computing for research, teaching, and teams|shared project space for notebooks, code, documents, terminals|Make computational work easier to share, review, and continue|CoCalc is a shared project workspace for computational work/i;

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

function getGrid(container: HTMLElement, selector: string): HTMLElement {
  const grid = container.querySelector(selector);
  expect(grid).not.toBeNull();
  return grid as HTMLElement;
}

function expectGridTemplate(element: HTMLElement, template: string) {
  expect(element.getAttribute("style") ?? "").toContain(
    `grid-template-columns: ${template};`,
  );
}

function getDirectCards(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.children) as HTMLElement[];
}

function getCardTitles(grid: HTMLElement): string[] {
  return getDirectCards(grid).map((card) => {
    const heading = card.querySelector("h4");
    expect(heading).not.toBeNull();
    return heading?.textContent?.trim() ?? "";
  });
}

function textLength(element: Element): number {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function getHomeCss(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
}

function expectCardsStayCompact(
  grid: HTMLElement,
  {
    maxCardText,
    maxTitleText,
  }: {
    maxCardText: number;
    maxTitleText: number;
  },
) {
  for (const card of getDirectCards(grid)) {
    expect(textLength(card)).toBeLessThanOrEqual(maxCardText);

    const heading = card.querySelector("h4");
    expect(heading).not.toBeNull();
    expect(textLength(heading as HTMLElement)).toBeLessThanOrEqual(
      maxTitleText,
    );
  }
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
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
    const productGrid = getGrid(container, ".cocalc-public-home-product-grid");
    const differenceGrid = getGrid(
      container,
      ".cocalc-public-home-difference-grid",
    );
    const pathGrid = getGrid(container, ".cocalc-public-home-path-grid");

    expect(getDirectCards(workflowGrid)).toHaveLength(6);
    expectGridTemplate(workflowGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(workflowGrid)).toEqual([
      "Jupyter Notebooks",
      "LaTeX Editor",
      "Linux Terminal",
      "Codex Agent Chat",
      "Teaching a Course",
      "Whiteboard",
    ]);

    expect(getDirectCards(audienceGrid)).toHaveLength(3);
    expectGridTemplate(audienceGrid, "repeat(3, minmax(0, 1fr))");
    expect(getCardTitles(audienceGrid)).toEqual([
      "Research and engineering teams",
      "Technical courses and workshops",
      "IT and platform teams",
    ]);

    expect(getDirectCards(productGrid)).toHaveLength(5);
    expectGridTemplate(productGrid, "repeat(5, minmax(0, 1fr))");
    expect(getCardTitles(productGrid)).toEqual([
      "CoCalc.ai",
      "CoCalc Plus",
      "CoCalc Star",
      "CoCalc Launchpad",
      "CoCalc Rocket",
    ]);

    expect(getDirectCards(differenceGrid)).toHaveLength(4);
    expectGridTemplate(differenceGrid, "repeat(2, minmax(0, 1fr))");
    expect(getCardTitles(differenceGrid)).toEqual([
      "Project-centered workflow",
      "Inspection before handoff",
      "Practical recovery",
      "Deployment path choice",
    ]);

    expect(getDirectCards(pathGrid)).toHaveLength(5);
    expectGridTemplate(pathGrid, "repeat(5, minmax(0, 1fr))");
    expect(getCardTitles(pathGrid)).toEqual([
      "Hosted CoCalc",
      "CoCalc Plus",
      "CoCalc Star",
      "Deployment options",
      "Site licensing",
    ]);
  });

  it("keeps responsive grid fallbacks explicit for tablet and phone widths", () => {
    const { container } = renderHome();
    const css = getHomeCss(container);

    expect(css).toContain("@media (max-width: 920px)");
    expect(css).toContain(".cocalc-public-home-audience-grid");
    expect(css).toContain(".cocalc-public-home-product-grid");
    expect(css).toContain(".cocalc-public-home-path-grid");
    expect(css).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr)) !important;",
    );

    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain(".cocalc-public-home-feature-grid");
    expect(css).toContain(".cocalc-public-home-difference-grid");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) !important;");
  });

  it("keeps repeated cards scannable instead of letting copy sprawl", () => {
    const { container } = renderHome();

    expectCardsStayCompact(
      within(screen.getByRole("region", { name: "Core workflows" })).getByRole(
        "group",
        { name: "CoCalc workflow feature cards" },
      ),
      { maxCardText: 230, maxTitleText: 28 },
    );
    expectCardsStayCompact(
      getGrid(container, ".cocalc-public-home-audience-grid"),
      { maxCardText: 205, maxTitleText: 36 },
    );
    expectCardsStayCompact(
      getGrid(container, ".cocalc-public-home-product-grid"),
      { maxCardText: 175, maxTitleText: 24 },
    );
    expectCardsStayCompact(
      getGrid(container, ".cocalc-public-home-difference-grid"),
      { maxCardText: 245, maxTitleText: 36 },
    );
    expectCardsStayCompact(
      getGrid(container, ".cocalc-public-home-path-grid"),
      {
        maxCardText: 190,
        maxTitleText: 24,
      },
    );

    for (const link of within(
      getGrid(container, ".cocalc-public-home-path-grid"),
    ).getAllByRole("link")) {
      expect(textLength(link)).toBeLessThanOrEqual(24);
    }
  });

  it("keeps the main story direct for researchers and decision makers", () => {
    const { container } = renderHome();

    const h1 = container.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(textLength(h1[0])).toBeLessThanOrEqual(70);

    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(
      sectionHeadings.map((heading) => heading.textContent?.trim()),
    ).toEqual([
      "Keep the record with the work.",
      "Built for research groups, courses, and platform teams.",
      "Work where the project already lives.",
      "Choose the operating model that fits your team.",
      "A workspace built around the project.",
      "Pick the next step that matches your situation.",
    ]);
    for (const heading of sectionHeadings) {
      expect(textLength(heading)).toBeLessThanOrEqual(72);
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
      screen.getByRole("region", { name: "Project continuity" }),
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
