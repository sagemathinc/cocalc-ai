/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import PublicHomeApp from "../app";
import { PUBLIC_COLORS, publicAccent } from "../../theme";
import {
  getPublicHomeHighlights,
  PUBLIC_HOME_EYEBROW,
  PUBLIC_HOME_HEADLINE,
  PUBLIC_HOME_HIGHLIGHTS,
  PUBLIC_HOME_INTRO,
  PUBLIC_HOME_SECONDARY_CTA,
  PUBLIC_HOME_TRUST_LINE,
} from "@cocalc/util/public-home-content";
import { COLORS } from "@cocalc/util/theme";
import {
  combineLeak,
  DARK_FEATURE_CARD_STYLE,
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

    expect(document.title).toBe("Build and Use Software with AI | CoCalc");
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
      "Why CoCalc is different",
      "Next step",
    ]);
    expectHomepageSectionsLabeled(container);
    expect(
      within(screen.getByRole("region", { name: "CoCalc hero" }))
        .getByText("CoCalc")
        .closest(".ant-typography"),
    ).toHaveStyle({ color: PUBLIC_COLORS.linkHover });

    // Section identity + order are canaried by the aria-label array above.
    // Here we only hold the h2 count and an anti-sprawl length bound, so the
    // per-section headline wording can change without a test edit.
    const sectionHeadings = Array.from(container.querySelectorAll("h2"));
    expect(sectionHeadings).toHaveLength(3);
    for (const heading of sectionHeadings) {
      expect(textLength(heading)).toBeLessThanOrEqual(SECTION_H2_MAX);
    }

    const hero = screen.getByRole("region", {
      name: "CoCalc hero",
    });
    const heroHeadings = within(hero).getAllByRole("heading", { level: 1 });
    expect(heroHeadings).toHaveLength(1);
    expect(heroHeadings[0]).toHaveTextContent(
      "Build and use software with AI.",
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
    expect(heroLead?.textContent ?? "").toMatch(/shared project/i);
    expect(heroLead?.textContent ?? "").toMatch(/take over the work yourself/i);
    expect(hero.textContent ?? "").not.toMatch(/Jupyter notebooks/i);
    expect(hero.textContent ?? "").not.toMatch(/Linux terminals/i);
    expect(hero.textContent ?? "").not.toMatch(/isolated project/i);
    expect(within(hero).queryByText(/notebooks, code, documents/i)).toBeNull();
    expect(within(hero).queryByText(/hosted, local, single-VM/i)).toBeNull();
    expect(
      within(hero)
        .getByRole("img", {
          name: "A saved CoCalc Jupyter notebook with synthetic runtime results and TimeTravel and Agent controls",
        })
        .getAttribute("src"),
    ).toBe("/public/landing/project-notebook-20260916.jpg");
    // The image keeps its alt text and has no caption.
    expect(hero.querySelector("figcaption")).toBeNull();
    expect(
      within(hero)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero).getByRole("link", { name: "See how it works" }),
    ).toHaveAttribute("href", "/features/ai");
    expect(within(hero).queryByRole("link", { name: "SageMath" })).toBeNull();
    expect(
      within(hero).queryByText(/keeps technical work collaborative/i),
    ).toBeNull();
    // The hero has one chip row on purpose: plain-text highlights styled as
    // pills (list items, not antd Tags or links). The only links are the two
    // CTAs.
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
        name: "Give AI agents the files and tools they need.",
      }),
    ).not.toBeNull();
    expect(agents.textContent ?? "").toMatch(
      /Use the integrated Codex agent or Claude Code, or run other command-line agents in project terminals/i,
    );
    expect(
      within(agents).getByRole("link", { name: "See agent workflows" }),
    ).toHaveAttribute("href", "/features/ai");
    expect(
      within(agents).getByRole("link", {
        name: "Compare with agent sandboxes",
      }),
    ).toHaveAttribute("href", "/features/compare");
    for (const title of [
      "Work with files and services",
      "Review agent changes",
      "Integrated chat or terminal",
    ]) {
      expect(
        within(agents).getByRole("heading", { level: 3, name: title }),
      ).not.toBeNull();
    }
    expect(agents.textContent ?? "").not.toMatch(/Self-hosted CoCalc/i);
    expect(agents.textContent ?? "").not.toMatch(
      /Launchpad, Rocket, Star, or Plus/i,
    );

    // Home no longer carries the audience cards, the tool catalogue or the
    // list of products. Features lists the tool pages, and Products the
    // products.
    for (const removed of [
      "Who CoCalc helps",
      "Core workflows",
      "Ways to run CoCalc",
    ]) {
      expect(screen.queryByRole("region", { name: removed })).toBeNull();
    }
    const home = container.querySelector(".cocalc-public-home") as HTMLElement;
    for (const removedLink of [
      /Researchers, analysts, and builders/,
      /Organizations and platform teams/,
      /Educators and learners/,
      "Browse feature workflows",
      /Jupyter Notebooks/,
      /LaTeX Editor/,
      /Whiteboard/,
      "Compare operating models",
      "Pricing and licensing",
    ]) {
      expect(
        within(home).queryByRole("link", { name: removedLink }),
      ).toBeNull();
    }
    for (const product of [
      "CoCalc Plus",
      "CoCalc Star",
      "CoCalc Launchpad",
      "CoCalc Rocket",
    ]) {
      expect(within(home).queryByText(product)).toBeNull();
    }
    expect(home.innerHTML).not.toContain("products/cocalc-");
    expect(
      within(home).queryByRole("img", { name: /project terminal/i }),
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
      within(path).getByRole("link", {
        name: "Review support and sales",
      }),
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
    expect(container.innerHTML).not.toMatch(
      combineLeak(INTERNAL_IMPLEMENTATION_TERMS),
    );
    expect(container.textContent ?? "").not.toMatch(
      STALE_REPETITIVE_HOME_LINES,
    );
  });

  // The removed sections sat between the agent links and the difference
  // cards, so the keyboard path now goes straight from one to the other.
  it.each([
    ["Enter", "{Enter}"],
    ["Space", "[Space]"],
  ])(
    "keeps a keyboard path from the agent links to the difference cards (%s)",
    async (_key, keys) => {
      const user = userEvent.setup();
      render(
        <PublicHomeApp
          config={{
            cocalc_product: "launchpad",
            is_launchpad: true,
            site_name: "CoCalc Launchpad",
          }}
        />,
      );
      const compare = within(
        screen.getByRole("region", { name: "AI agents in CoCalc" }),
      ).getByRole("link", { name: "Compare with agent sandboxes" });
      compare.focus();
      expect(compare).toHaveFocus();

      await user.tab();
      const firstCard = within(
        screen.getByRole("region", { name: "Why CoCalc is different" }),
      ).getByRole("button", { name: /Project-centered workflow/ });
      expect(firstCard).toHaveFocus();

      expect(screen.queryByRole("dialog")).toBeNull();
      await user.keyboard(keys);
      expect(
        screen.getByRole("dialog", { name: "Project-centered workflow" }),
      ).not.toBeNull();
    },
  );

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

  // cocalc.ai's /customize reports the Launchpad product, so the cocalc.ai
  // cases do too: a rule that left out Launchpad would fail them.
  const cocalcAi = {
    cocalc_product: "launchpad",
    dns: "cocalc.ai",
    is_launchpad: true,
    site_name: "CoCalc",
  };

  it("renders the first screen from the shared Home content, like the crawler fallback", () => {
    render(<PublicHomeApp config={cocalcAi} />);
    const hero = screen.getByRole("region", { name: "CoCalc hero" });

    expect(within(hero).getByText(PUBLIC_HOME_EYEBROW)).not.toBeNull();
    expect(within(hero).getByRole("heading", { level: 1 }).textContent).toBe(
      PUBLIC_HOME_HEADLINE,
    );
    expect(
      hero.querySelector(".cocalc-public-home-hero-title + *")?.textContent,
    ).toBe(PUBLIC_HOME_INTRO);
    expect(
      within(hero)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([...PUBLIC_HOME_HIGHLIGHTS]);
    expect(PUBLIC_HOME_HIGHLIGHTS).toHaveLength(3);
    expect(
      hero.querySelector(".cocalc-public-home-trust-line")?.textContent,
    ).toBe(PUBLIC_HOME_TRUST_LINE);
    expect(
      within(hero).getByRole("link", { name: PUBLIC_HOME_SECONDARY_CTA.label }),
    ).toHaveAttribute("href", `/${PUBLIC_HOME_SECONDARY_CTA.href}`);
  });

  // The same sites and expected chips as the crawler fallback test in
  // hub/servers/app/public-prerender.test.ts, so the two renderings agree.
  it.each([
    [
      "the default CoCalc brand on cocalc.ai",
      cocalcAi,
      [
        "Codex and Claude Code in one project",
        "Collaborators see edits live",
        "Restore earlier versions",
      ],
    ],
    [
      "CoCalc Plus, the local one-user runtime",
      { cocalc_product: "plus", dns: "localhost", site_name: "CoCalc" },
      ["Restore earlier versions"],
    ],
    [
      "CoCalc Plus on the canonical host",
      { cocalc_product: "plus", dns: "cocalc.ai", site_name: "CoCalc" },
      ["Restore earlier versions"],
    ],
    [
      "a self-hosted Launchpad host",
      {
        cocalc_product: "launchpad",
        dns: "launchpad.example.edu",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      },
      ["Collaborators see edits live", "Restore earlier versions"],
    ],
  ])(
    "shows only the highlights that hold on each site: %s",
    (_site, config, expected) => {
      render(<PublicHomeApp config={config} />);
      const hero = screen.getByRole("region", { name: "CoCalc hero" });

      expect(
        within(hero)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(expected);
      expect(getPublicHomeHighlights(config)).toEqual(expected);
    },
  );

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
