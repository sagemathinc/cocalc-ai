/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

import PublicHomeApp from "../app";
import { PUBLIC_COLORS, publicAccent } from "../../theme";
import { COLORS } from "@cocalc/util/theme";
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
      "AI agents in CoCalc",
      "Who CoCalc helps",
      "Core workflows",
      "Ways to run CoCalc",
      "Why CoCalc is different",
      "Next step",
    ]);
    expectHomepageSectionsLabeled(container);
    expect(
      screen.getByText("Shared Linux Workspace").closest(".ant-typography"),
    ).toHaveStyle({ color: PUBLIC_COLORS.linkHover });

    // Section identity + order are canaried by the aria-label array above.
    // Here we only hold the h2 count and an anti-sprawl length bound, so the
    // per-section headline wording can change without a test edit.
    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(sectionHeadings).toHaveLength(6);
    for (const heading of sectionHeadings) {
      expect(textLength(heading)).toBeLessThanOrEqual(SECTION_H2_MAX);
    }

    const hero = screen.getByRole("region", {
      name: "CoCalc hero",
    });
    const heroHeadings = within(hero).getAllByRole("heading", { level: 1 });
    expect(heroHeadings).toHaveLength(1);
    expect(heroHeadings[0]).toHaveTextContent(
      "A persistent shared computer for technical work.",
    );
    expect(textLength(heroHeadings[0])).toBeLessThanOrEqual(HERO_H1_MAX);
    expect(
      within(hero).queryByText("Shared Projects for Agent-Driven Research"),
    ).toBeNull();
    expect(
      within(hero).queryByText("Shared Projects for Research and Teaching"),
    ).toBeNull();
    expect(
      within(hero).queryByText(
        "Shared Projects for Computational Research and Teaching",
      ),
    ).toBeNull();
    expect(
      within(hero).queryByText(
        "Shared Projects for your Tools, AI Agents, and Collaborators",
      ),
    ).toBeNull();
    expect(
      within(hero).queryByText(
        "Your tools, AI agents, and team — together in one project.",
      ),
    ).toBeNull();
    expect(
      within(hero).queryByText(
        "Your tools, your AI agents, and your team — together in one project.",
      ),
    ).toBeNull();
    expect(
      within(hero).queryByText("One shared project for the whole job."),
    ).toBeNull();
    expect(
      within(hero).queryByText(
        "Shared projects for Research, Technical Teams, and Teaching",
      ),
    ).toBeNull();
    // Select the hero lead by structure (the element after the H1) instead of
    // pinning the sentence; assert it stays short and carries the key ideas.
    const heroLead = hero.querySelector(".cocalc-public-home-hero-title + *");
    expect(heroLead).not.toBeNull();
    expect(textLength(heroLead as Element)).toBeLessThanOrEqual(210);
    expect(hero.textContent ?? "").toMatch(/Shared Linux Workspace/i);
    expect(hero.textContent ?? "").toMatch(/People and AI agents work/i);
    expect(hero.textContent ?? "").toMatch(/same Linux project/i);
    expect(hero.textContent ?? "").toMatch(
      /ready whenever the work continues/i,
    );
    expect(hero.textContent ?? "").not.toMatch(
      /collaborative technical computing online since 2013/i,
    );
    expect(hero.textContent ?? "").not.toMatch(/Jupyter notebooks/i);
    expect(hero.textContent ?? "").not.toMatch(/Linux terminals/i);
    expect(hero.textContent ?? "").not.toMatch(/isolated project/i);
    expect(within(hero).queryByText(/notebooks, code, documents/i)).toBeNull();
    expect(within(hero).queryByText(/hosted, local, single-VM/i)).toBeNull();
    expect(
      within(hero)
        .getByRole("img", {
          name: "A persistent CoCalc project shared by people and AI agents",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/home-hero.jpg");
    expect(
      within(hero)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero).getByRole("link", { name: "Ways to run CoCalc" }),
    ).toHaveAttribute("href", "/products");
    expect(within(hero).queryByRole("link", { name: "SageMath" })).toBeNull();
    expect(
      within(hero).queryByText(/keeps technical work collaborative/i),
    ).toBeNull();
    // No chip/tag row in the hero; the only links are the two CTAs.
    expect(hero.querySelectorAll(".ant-tag")).toHaveLength(0);
    expect(within(hero).getAllByRole("link")).toHaveLength(2);
    // The hero CTA panel must stay a light panel.
    const heroCtaPanel = hero.querySelector(".cocalc-public-home-actions");
    expect(heroCtaPanel).not.toBeNull();
    expect(
      (heroCtaPanel as HTMLElement).getAttribute("style") ?? "",
    ).not.toMatch(DARK_FEATURE_CARD_STYLE);

    const agents = screen.getByRole("region", {
      name: "AI agents in CoCalc",
    });
    expect(agents.textContent ?? "").toMatch(/Agent-ready by design/i);
    expect(
      within(agents).getByRole("heading", {
        level: 2,
        name: "Agents work where your project lives.",
      }),
    ).not.toBeNull();
    expect(agents.textContent ?? "").toMatch(
      /Use Codex, Claude Code, or another shell-capable agent/i,
    );
    for (const title of [
      "Runs where your work lives",
      "You stay in review",
      "Bring the agent you use",
    ]) {
      expect(
        within(agents).getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
    }
    expect(agents.textContent ?? "").not.toMatch(/Self-hosted CoCalc/i);
    expect(agents.textContent ?? "").not.toMatch(
      /Launchpad, Rocket, Star, or Plus/i,
    );

    const audiences = screen.getByRole("region", {
      name: "Who CoCalc helps",
    });
    expect(
      within(audiences).getByRole("heading", {
        level: 2,
        name: "Built for research, technical teams, and teaching.",
      }),
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
      "IT and platform teams",
      "Technical courses and workshops",
    ]) {
      expect(
        within(audiences).getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
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
      expect(
        within(workflowCards).getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
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
    ]) {
      expect(
        within(products).getByRole("heading", { level: 3, name: option }),
      ).not.toBeNull();
    }
    for (const option of [
      "Hosted",
      "Local",
      "One VM",
      "Private",
      "Enterprise",
    ]) {
      expect(within(products).getByText(option)).not.toBeNull();
    }
    expect(within(products).getByText("Local")).toHaveStyle({
      color: publicAccent(COLORS.ANTD_GREEN_D),
    });
    expect(within(products).getByText("One VM")).toHaveStyle({
      color: publicAccent(COLORS.BRWN),
    });
    expect(within(products).getByText("Private")).toHaveStyle({
      color: publicAccent(COLORS.BRWN),
    });
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
      within(products).getByText(
        "Lightweight private deployment for pilots, labs, workshops, and small teams.",
      ),
    ).not.toBeNull();
    expect(
      within(products).queryByText(/customer-operated private deployment/i),
    ).toBeNull();

    const difference = screen.getByRole("region", {
      name: "Why CoCalc is different",
    });
    expect(within(difference).getByText("Review together")).toHaveStyle({
      color: publicAccent(COLORS.ANTD_GREEN_D),
    });
    expect(within(difference).getByText("Keep moving")).toHaveStyle({
      color: publicAccent(COLORS.BRWN),
    });
    for (const title of [
      "Project-centered workflow",
      "Inspection before handoff",
      "Practical recovery",
      "Operating model choice",
    ]) {
      expect(
        within(difference).getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
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
    expect(
      within(continuityDialog).getByText(
        /notebooks, files, outputs, documents, terminals/i,
      ),
    ).not.toBeNull();
    for (const title of [
      "Context survives handoff",
      "Review stays close",
      "Recovery remains practical",
    ]) {
      expect(within(continuityDialog).getByText(title)).not.toBeNull();
    }
    expect(
      within(continuityDialog).getByText(/same project state/i),
    ).not.toBeNull();
    expect(
      within(continuityDialog).getByText(/project record stays available/i),
    ).not.toBeNull();
    expect(
      within(continuityDialog).getByText(/useful states easier to recover/i),
    ).not.toBeNull();
    expect(
      within(continuityDialog).getByRole("link", {
        name: "Read project docs",
      }),
    ).toHaveAttribute("href", "/docs/projects/project-list");
    fireEvent.click(
      within(difference).getByRole("button", {
        name: /Inspection before handoff/i,
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByRole("link", {
        name: "Read chat docs",
      }),
    ).toHaveAttribute("href", "/docs/collaboration/chat");
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText(/AI-assisted edits, notebooks, terminals/i),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText("Review together"),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText(/compare results and decide how to move forward/i),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText(/patches, test output, screenshots/i),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Inspection before handoff" }),
      ).getByText(/commands, outputs/i),
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
      within(recoveryDialog).getByText(
        /history, TimeTravel, snapshots, backups, and project context together/i,
      ),
    ).not.toBeNull();
    expect(
      within(recoveryDialog).getByRole("link", {
        name: "Read TimeTravel docs",
      }),
    ).toHaveAttribute("href", "/docs/files/timetravel");
    expect(
      within(recoveryDialog).getByText(/notebooks, files, documents/i),
    ).not.toBeNull();
    expect(
      within(recoveryDialog).getByText(/known project state/i),
    ).not.toBeNull();
    expect(
      within(recoveryDialog).getByText(/discussion keep recovery tied/i),
    ).not.toBeNull();
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
        name: "Review product paths",
      }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(
        screen.getByRole("dialog", { name: "Operating model choice" }),
      ).getByText(/where the workspace runs and who operates it/i),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Operating model choice" }),
      ).getByText("Match where it runs"),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Operating model choice" }),
      ).getByText(/upgrades, data boundaries/i),
    ).not.toBeNull();
    expect(
      within(
        screen.getByRole("dialog", { name: "Operating model choice" }),
      ).getByText(/procurement, security, platform/i),
    ).not.toBeNull();

    const path = screen.getByRole("region", { name: "Next step" });
    // The next-step CTA panel must stay a light panel.
    expect(path.getAttribute("style") ?? "").not.toMatch(
      DARK_FEATURE_CARD_STYLE,
    );
    expect(
      within(path).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(path).getByRole("link", { name: "Review product paths" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(path).getByRole("link", { name: "Talk with CoCalc" }),
    ).toHaveAttribute("href", "/support");
    expect(
      within(path).queryByRole("link", {
        name: "Review trust and compliance",
      }),
    ).toBeNull();
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
    expect(
      screen.getAllByRole("link", { name: "Compare operating models" }),
    ).toHaveLength(1);
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

  it("links to built-in trust materials on the default CoCalc site", () => {
    render(
      <PublicHomeApp
        config={{ policy_pages: "sagemathinc", site_name: "CoCalc" }}
      />,
    );

    expect(
      within(screen.getByRole("region", { name: "Next step" })).getByRole(
        "link",
        {
          name: "Review trust and compliance",
        },
      ),
    ).toHaveAttribute("href", "/policies/trust");
  });
});
