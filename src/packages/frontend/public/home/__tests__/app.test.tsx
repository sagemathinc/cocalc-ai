/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";

function expectLinkHrefs(
  container: HTMLElement,
  expectedHrefs: Array<unknown>,
) {
  expect(
    within(container)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href")),
  ).toEqual(expectedHrefs);
}

function getHomepageSectionLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".cocalc-public-home > section"))
    .map((section) => section.getAttribute("aria-label") ?? "")
    .filter(Boolean);
}

function expectHomepageSectionsLabeled(container: HTMLElement) {
  const sections = Array.from(container.querySelectorAll("section"));
  expect(sections.length).toBeGreaterThan(0);
  for (const section of sections) {
    expect(section.getAttribute("aria-label")?.trim()).toBeTruthy();
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

describe("PublicHomeApp", () => {
  it("renders the delta-style public landing page structure", () => {
    const { container } = render(
      <PublicHomeApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          site_name: "CoCalc Launchpad",
        }}
      />,
    );

    expect(document.title).toBe("CoCalc Launchpad");
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc Launchpad home",
      }),
    ).not.toBeNull();
    expect(getHomepageSectionLabels(container)).toEqual([
      "CoCalc Launchpad hero",
      "The project is the product",
      "Core workflows",
      "Ways to run CoCalc",
      "Why CoCalc is different",
      "Choose your path",
    ]);
    expectHomepageSectionsLabeled(container);

    const hero = screen.getByRole("region", {
      name: "CoCalc Launchpad hero",
    });
    expect(
      within(hero).getByRole("heading", {
        level: 1,
        name: "AI-Native Technical Workspace for Humans and Agents",
      }),
    ).not.toBeNull();
    expect(
      within(hero).getByText(
        /CoCalc Launchpad brings notebooks, terminals, files, LaTeX, chat/i,
      ),
    ).not.toBeNull();
    expect(
      within(hero)
        .getByRole("img", {
          name: "CoCalc-AI collaborative project overview",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/home-hero.jpg");
    expect(
      within(hero)
        .getByRole("link", { name: "Start free" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero).getByRole("link", { name: "See plans" }),
    ).toHaveAttribute("href", "/pricing");
    expect(
      within(hero).getByRole("link", { name: "Get CoCalc Plus" }),
    ).toHaveAttribute("href", "/products/cocalc-plus");
    for (const tag of [
      "Minimal free tier",
      "Hosted plans",
      "Free CoCalc Plus",
      "Self-host with Star",
    ]) {
      expect(within(hero).getByText(tag)).not.toBeNull();
    }

    const project = screen.getByRole("region", {
      name: "The project is the product",
    });
    expect(
      within(project)
        .getByRole("img", {
          name: "One CoCalc project containing many workflows",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/project-workflows.jpg");
    expect(
      within(project).getByRole("heading", {
        name: "One durable place for technical work.",
      }),
    ).not.toBeNull();
    expect(within(project).getByText("One project boundary")).not.toBeNull();
    expect(
      within(project).getByText("Work survives the browser"),
    ).not.toBeNull();
    expect(
      within(project).getByText("People and agents share context"),
    ).not.toBeNull();

    const workflows = screen.getByRole("region", {
      name: "Core workflows",
    });
    expect(
      within(workflows).getByRole("heading", {
        name: "Use the tools you already understand, together.",
      }),
    ).not.toBeNull();
    expect(
      within(workflows).getByRole("link", { name: "All features" }),
    ).toHaveAttribute("href", "/features");
    const workflowCards = within(workflows).getByRole("group", {
      name: "CoCalc workflow feature cards",
    });
    expectLinkHrefs(workflowCards, [
      "/features/jupyter-notebook",
      "/features/latex-editor",
      "/features/terminal",
      "/features/ai",
      "/features/teaching",
      "/features/whiteboard",
    ]);
    for (const title of [
      "Jupyter Notebooks",
      "LaTeX Editor",
      "Linux Terminal",
      "Codex Agent Chat",
      "Teaching a Course",
      "Whiteboard",
    ]) {
      expect(within(workflowCards).getByText(title)).not.toBeNull();
    }

    const products = screen.getByRole("region", {
      name: "Ways to run CoCalc",
    });
    expect(
      within(products).getByRole("heading", {
        name: "Choose by who operates CoCalc.",
      }),
    ).not.toBeNull();
    expect(
      within(products).getByRole("link", { name: "Compare products" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(products).getByRole("link", { name: "CoCalc Star" }),
    ).toHaveAttribute("href", "/products/cocalc-star");
    for (const option of [
      "Hosted CoCalc",
      "CoCalc Plus",
      "Launchpad + Rocket",
      "Individual",
      "Organization",
      "Operated by CoCalc",
      "Operated on your VM",
      "Lab, class, GPU box, agent sandbox, or small team",
    ]) {
      expect(within(products).getByText(option)).not.toBeNull();
    }
    expect(within(products).getAllByText("CoCalc Star").length).toBeGreaterThan(
      0,
    );

    const difference = screen.getByRole("region", {
      name: "Why CoCalc is different",
    });
    expect(
      within(difference).getByRole("heading", {
        name: "Built for real computational work, not only polished demos.",
      }),
    ).not.toBeNull();
    for (const title of [
      "Durable execution",
      "Real Linux projects",
      "Realtime collaboration",
      "Operational safety",
    ]) {
      expect(within(difference).getByText(title)).not.toBeNull();
    }

    const path = screen.getByRole("region", { name: "Choose your path" });
    expect(
      within(path).getByRole("heading", { name: "Start using CoCalc" }),
    ).not.toBeNull();
    expect(
      within(path).getByRole("link", { name: "Create account" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(path).getByRole("link", { name: "Download CoCalc Plus" }),
    ).toHaveAttribute(
      "href",
      "https://software.cocalc.ai/software/cocalc-plus/index.html",
    );
    expect(
      within(path).getByRole("link", { name: "Install CoCalc Star" }),
    ).toHaveAttribute("href", "/products/cocalc-star");
    expect(
      within(path).getByRole("link", { name: "Compare products" }),
    ).toHaveAttribute("href", "/products");
    expect(within(path).getByRole("link", { name: "Guides" })).toHaveAttribute(
      "href",
      "/guides",
    );
    expect(within(path).getByRole("link", { name: "Support" })).toHaveAttribute(
      "href",
      "/support",
    );

    expect(screen.queryByText("Recent News")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "CoCalc.ai workspace overview" }),
    ).toBeNull();
  });

  it("shows project entry points when authenticated", () => {
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "CoCalc Launchpad" }}
      />,
    );

    expect(document.title).toBe("CoCalc Launchpad");
    expect(
      screen.getAllByRole("link", { name: "Open projects" }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen
        .getAllByRole("link", { name: "Open projects" })
        .every((link) => link.getAttribute("href") === "/projects"),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "Start free" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
