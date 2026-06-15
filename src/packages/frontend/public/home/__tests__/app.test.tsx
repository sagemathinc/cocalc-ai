/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

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

    const hero = screen.getByRole("region", {
      name: "CoCalc hero",
    });
    expect(
      within(hero).getByRole("heading", {
        level: 1,
        name: "Shared projects for research, teaching, and technical teams",
      }),
    ).not.toBeNull();
    expect(
      within(hero).getByText(
        /CoCalc keeps the work in one project, so people and AI agents can review what happened/i,
      ),
    ).not.toBeNull();
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
      within(hero).getByRole("link", { name: "Compare product paths" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(hero).queryByText(/keeps technical work collaborative/i),
    ).toBeNull();
    for (const tag of [
      "Shared project record",
      "Reviewable context",
      "Course workflows",
      "Recoverable work",
    ]) {
      expect(within(hero).queryByText(tag)).toBeNull();
    }

    const audiences = screen.getByRole("region", {
      name: "Who CoCalc helps",
    });
    expect(
      within(audiences).getByRole("heading", {
        name: "Built for research, courses, and platform teams.",
      }),
    ).not.toBeNull();
    expect(
      within(audiences).getByText(
        "Start with the path that matches how your group works.",
      ),
    ).not.toBeNull();
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
      within(workflows).getByRole("heading", {
        name: "Work where the project already lives.",
      }),
    ).not.toBeNull();
    expect(
      within(workflows).getByRole("link", { name: "All features" }),
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
      within(products).getByRole("heading", {
        name: "Choose the operating model that fits your team.",
      }),
    ).not.toBeNull();
    expect(
      within(products).getByRole("link", {
        name: "Compare product paths",
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
    expect(
      within(difference).getByRole("heading", {
        name: "A workspace built around the project.",
      }),
    ).not.toBeNull();
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
        name: "Compare workspace model",
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
    expect(
      within(path).getByRole("heading", {
        name: "Ready to choose how CoCalc fits?",
      }),
    ).not.toBeNull();
    expect(
      within(path).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(path).getByRole("link", { name: "Compare product paths" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(path).getByRole("link", { name: "Talk to CoCalc" }),
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
      /project hosts|backend state|logs stay scoped|RootFS|multi-bay/i,
    );
    expect(container.textContent ?? "").not.toMatch(
      /One workspace for code, notebooks, documents, compute, and AI|Bring technical work back into one context|One workspace for research, courses, and platform teams|Make computational work easier to share, review, and continue|CoCalc is a shared project workspace for computational work/i,
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
