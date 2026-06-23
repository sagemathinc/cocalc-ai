/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";
import {
  combineLeak,
  DARK_FEATURE_CARD_STYLE,
  expectLinkHrefs,
  HERO_H1_MAX,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  STALE_REPETITIVE_HOME_LINES,
  textLength,
} from "../../__tests__/test-helpers";

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
  const getComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, "getComputedStyle", {
    writable: true,
    value: (element: Element) => getComputedStyle(element),
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

    expect(document.title).toBe("CoCalc");
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("contentinfo")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("banner")).queryByRole("link", {
        name: "CoCalc Launchpad home",
      }),
    ).toBeNull();
    expect(getHomepageSectionLabels(container)).toEqual([
      "CoCalc hero",
      "Who CoCalc helps",
      "Core workflows",
      "Ways to run CoCalc",
      "Why CoCalc is different",
      "Next step",
    ]);
    expectHomepageSectionsLabeled(container);

    // Section identity + order are canaried by the aria-label array above.
    // Here we only hold the h2 count and an anti-sprawl length bound, so the
    // per-section headline wording can change without a test edit.
    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(sectionHeadings).toHaveLength(5);
    for (const heading of sectionHeadings) {
      expect(textLength(heading)).toBeLessThanOrEqual(SECTION_H2_MAX);
    }

    const hero = screen.getByRole("region", {
      name: "CoCalc hero",
    });
    const heroHeadings = within(hero).getAllByRole("heading", { level: 1 });
    expect(heroHeadings).toHaveLength(1);
    expect(heroHeadings[0]).toHaveTextContent(
      "One shared project for the whole job.",
    );
    expect(textLength(heroHeadings[0])).toBeLessThanOrEqual(HERO_H1_MAX);
    expect(
      within(hero).queryByText(
        "Shared projects for Research, Technical Teams, and Teaching",
      ),
    ).toBeNull();
    // Select the hero lead by structure (the element after the H1) instead of
    // pinning the sentence; assert it stays short and carries the key ideas.
    const heroLead = hero.querySelector(".cocalc-public-home-hero-title + *");
    expect(heroLead).not.toBeNull();
    expect(textLength(heroLead as Element)).toBeLessThanOrEqual(180);
    expect(hero.textContent ?? "").toMatch(/review/i);
    expect(hero.textContent ?? "").toMatch(/context|continue|keep going/i);
    expect(within(hero).queryByText(/notebooks, code, documents/i)).toBeNull();
    expect(within(hero).queryByText(/hosted, local, single-VM/i)).toBeNull();
    expect(
      within(hero)
        .getByRole("img", {
          name: "CoCalc-AI collaborative project overview",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/home-hero.jpg");
    expect(
      within(hero)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero).getByRole("link", { name: "Compare operating models" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(hero).queryByText(/keeps technical work collaborative/i),
    ).toBeNull();
    // No chip/tag row in the hero, and exactly the two CTAs (links).
    expect(hero.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(within(hero).getAllByRole("link")).toHaveLength(2);
    // The hero CTA panel must stay a light panel.
    const heroCtaPanel = hero.querySelector(".cocalc-public-home-actions");
    expect(heroCtaPanel).not.toBeNull();
    expect(
      (heroCtaPanel as HTMLElement).getAttribute("style") ?? "",
    ).not.toMatch(DARK_FEATURE_CARD_STYLE);

    const audiences = screen.getByRole("region", {
      name: "Who CoCalc helps",
    });
    expect(
      within(audiences).queryByText(/Different audiences can start/i),
    ).toBeNull();
    expect(
      within(audiences).getByRole("link", {
        name: /Research and engineering teams/i,
      }),
    ).toHaveAttribute("href", "/features/compare");
    expect(
      within(audiences).getByRole("link", {
        name: /Technical courses and workshops/i,
      }),
    ).toHaveAttribute("href", "/features/teaching");
    expect(
      within(audiences).getByRole("link", {
        name: /IT and platform teams/i,
      }),
    ).toHaveAttribute("href", "/products");
    for (const title of [
      "Research and engineering teams",
      "Technical courses and workshops",
      "IT and platform teams",
    ]) {
      expect(within(audiences).getByText(title)).not.toBeNull();
    }

    const workflows = screen.getByRole("region", {
      name: "Core workflows",
    });
    expect(
      within(workflows).getByRole("link", {
        name: "Browse feature workflows",
      }),
    ).toHaveAttribute("href", "/features");
    expect(
      within(workflows)
        .getByRole("img", {
          name: "One CoCalc workspace containing many workflows",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/project-workflows.jpg");
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
    for (const removedLabel of [
      "Compute",
      "Writing",
      "Linux",
      "Agent help",
      "Courses",
      "Visual work",
    ]) {
      expect(within(workflowCards).queryByText(removedLabel)).toBeNull();
    }

    const products = screen.getByRole("region", {
      name: "Ways to run CoCalc",
    });
    expect(
      within(products).getByRole("link", {
        name: "Compare operating models",
      }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(products).getByRole("link", { name: "Pricing and licensing" }),
    ).toHaveAttribute("href", "/pricing");
    expect(
      within(products).getByRole("link", { name: /CoCalc\.ai/i }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(products).getByRole("link", { name: /CoCalc Plus/i }),
    ).toHaveAttribute("href", "/products/cocalc-plus");
    expect(
      within(products).getByRole("link", { name: /CoCalc Star/i }),
    ).toHaveAttribute("href", "/products/cocalc-star");
    expect(
      within(products).getByRole("link", { name: /CoCalc Launchpad/i }),
    ).toHaveAttribute("href", "/products/cocalc-launchpad");
    expect(
      within(products).getByRole("link", { name: /CoCalc Rocket/i }),
    ).toHaveAttribute("href", "/products/cocalc-rocket");
    for (const option of [
      "CoCalc.ai",
      "CoCalc Plus",
      "CoCalc Star",
      "CoCalc Launchpad",
      "CoCalc Rocket",
      "Hosted",
      "Local",
      "One VM",
      "Private",
      "Enterprise",
    ]) {
      expect(within(products).getByText(option)).not.toBeNull();
    }
    for (const removedLabel of [
      "Same CoCalc project model",
      "Code",
      "Files",
      "Notebooks",
      "Documents",
      "AI",
      "Individual",
      "Organization",
    ]) {
      expect(within(products).queryByText(removedLabel)).toBeNull();
    }
    expect(
      within(products).getAllByText(/customer-operated private deployment/i)
        .length,
    ).toBeGreaterThan(0);

    const difference = screen.getByRole("region", {
      name: "Why CoCalc is different",
    });
    for (const title of [
      "Project-centered workflow",
      "Inspection before handoff",
      "Practical recovery",
      "Operating model choice",
    ]) {
      expect(within(difference).getByText(title)).not.toBeNull();
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      within(difference).getByRole("button", {
        name: /Project-centered workflow/i,
      }),
    );
    const continuityDialog = screen.getByRole("dialog", {
      name: "Project-centered workflow",
    });
    for (const title of [
      "Context survives handoff",
      "Review stays close",
      "Recovery remains practical",
    ]) {
      expect(within(continuityDialog).getByText(title)).not.toBeNull();
    }
    expect(
      within(continuityDialog).getByRole("link", {
        name: "Compare CoCalc",
      }),
    ).toHaveAttribute("href", "/features/compare");
    fireEvent.click(
      within(difference).getByRole("button", {
        name: /Inspection before handoff/i,
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByRole("link", {
        name: "Explore AI workflows",
      }),
    ).toHaveAttribute("href", "/features/ai");
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText("Review together"),
    ).not.toBeNull();
    fireEvent.click(
      within(difference).getByRole("button", {
        name: /Practical recovery/i,
      }),
    );
    const recoveryDialog = screen.getByRole("dialog", {
      name: "Practical recovery",
    });
    expect(
      within(recoveryDialog).getByRole("link", {
        name: "See TimeTravel in notebooks",
      }),
    ).toHaveAttribute("href", "/features/jupyter-notebook");
    expect(
      within(recoveryDialog).queryByRole("link", {
        name: "Explore features",
      }),
    ).toBeNull();
    fireEvent.click(
      within(difference).getByRole("button", {
        name: /Operating model choice/i,
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Operating model choice" }),
      ).getByRole("link", {
        name: "Compare operating models",
      }),
    ).toHaveAttribute("href", "/products");

    const path = screen.getByRole("region", { name: "Next step" });
    // The next-step CTA panel must stay a light panel.
    expect(path.getAttribute("style") ?? "").not.toMatch(
      DARK_FEATURE_CARD_STYLE,
    );
    expect(
      within(path).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(path).getByRole("link", { name: "Compare operating models" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(path).getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute("href", "/support");
    expect(within(path).queryByText("Hosted CoCalc")).toBeNull();
    expect(within(path).queryByText("CoCalc Plus")).toBeNull();
    expect(within(path).queryByText("CoCalc Star")).toBeNull();

    expect(screen.queryByText("Recent News")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "CoCalc.ai workspace overview" }),
    ).toBeNull();
    expect(screen.getAllByText("CoCalc Star").length).toBeGreaterThan(0);
    expect(container.innerHTML).toContain("products/cocalc-star");
    expect(container.innerHTML).not.toMatch(
      combineLeak(INTERNAL_IMPLEMENTATION_TERMS),
    );
    expect(container.textContent ?? "").not.toMatch(
      STALE_REPETITIVE_HOME_LINES,
    );
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
    expect(
      screen.queryByRole("link", { name: "Start on CoCalc.ai" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
