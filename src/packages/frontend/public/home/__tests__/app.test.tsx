/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";

import PublicHomeApp from "../app";

const originalFetch = global.fetch;
const BLOCKED_HOMEPAGE_CATEGORY_PATTERNS = [
  /AI[- ]?IDE/i,
  /AI coding tool/i,
  /agent console/i,
  /cloud coding agent/i,
  /isolated notebook/i,
  /notebook platform/i,
  /prompt[- ]to[- ]app/i,
  /sandbox API/i,
  /sovereign cloud/i,
] as const;
const BLOCKED_HOMEPAGE_CLAIM_PATTERNS = [
  ...BLOCKED_HOMEPAGE_CATEGORY_PATTERNS,
  /CoCalc Star/i,
  /Install CoCalc Star/i,
  /Review Star/i,
  /Run CoCalc Star/i,
  /Single-VM appliance/i,
  /Public VM/i,
  /Run by VM owner/i,
  /fast team starts/i,
  /quickest start/i,
  /Free local runtime/i,
  /self-service team starts/i,
  /Pricing and licensing/i,
  /Operational proof/i,
  /production private cloud/i,
  /production-ready/i,
  /production readiness/i,
  /multi-bay/i,
  /setup time/i,
  /setup-time/i,
  /one[- ]click/i,
  /instant(?:ly)?/i,
  /in minutes/i,
  /minutes? to (?:start|set up|setup|deploy|migrate|restore)/i,
  /turnkey/i,
  /restore time/i,
  /restore-time/i,
  /guaranteed/i,
  /uptime/i,
  /high availability/i,
  /response[- ]time/i,
  /support tiers?/i,
  /priority support/i,
  /dedicated support/i,
  /24\/7/i,
  /24x7/i,
  /white[- ]glove/i,
  /zero outbound/i,
  /no outbound/i,
  /zero telemetry/i,
  /telemetry[- ]free/i,
  /offline-only/i,
  /offline only/i,
  /air-gapped/i,
  /air gapped/i,
  /airgap/i,
  /\bSLA\b/i,
  /sovereignty/i,
  /SOC\s*2/i,
  /HIPAA/i,
  /FERPA/i,
  /GDPR/i,
  /compliant/i,
  /certified/i,
  /secure by default/i,
  /private by default/i,
  /isolated by default/i,
  /single[- ]tenant/i,
  /\bBYOC\b/i,
  /bring your own cloud/i,
  /data residency/i,
  /end-to-end encrypted/i,
  /E2E encrypted/i,
  /no data leaves/i,
  /automatic project transfer/i,
  /automatic migration/i,
  /seamless migration/i,
  /managed migration/i,
  /grandfathered hosted prices/i,
  /free tier/i,
  /free plan/i,
  /free forever/i,
  /no credit card/i,
  /credit-card/i,
  /credit card/i,
  /card payment/i,
  /Stripe/i,
  /fully managed/i,
  /managed private/i,
  /vendor[- ]operated private/i,
  /CoCalc[- ]operated private/i,
  /enterprise[- ]ready/i,
  /enterprise[- ]grade/i,
  /production[- ]grade/i,
  /mission[- ]critical/i,
  /validated demo/i,
  /research-demo/i,
  /Live CoCalc project preview/i,
  /Live context/i,
  /live workspace snapshot/i,
  /live project snapshot/i,
  /live demo/i,
  /demo surface/i,
  /without setting up/i,
  /Consistent lab setup/i,
  /Consistent lab environment/i,
  /Run with CoCalc/i,
  /benchmark/i,
] as const;
const BLOCKED_HOMEPAGE_CLAIM_ATTRIBUTES = [
  "alt",
  "aria-label",
  "title",
] as const;
const ALLOWED_EXTERNAL_HOMEPAGE_HREFS = [
  "https://software.cocalc.ai/software/cocalc-plus/index.html",
] as const;
const ALLOWED_INTERNAL_HOMEPAGE_HREF_PATTERNS = [
  /^#cookie-preferences$/,
  /^\/$/,
  /^\/about$/,
  /^\/auth\/sign-in$/,
  /^\/auth\/sign-up$/,
  /^\/docs$/,
  /^\/features$/,
  /^\/features\/(ai|compare|jupyter-notebook|latex-editor|python|teaching|terminal)$/,
  /^\/guides$/,
  /^\/news(?:\/.*)?$/,
  /^\/policies$/,
  /^\/policies\/trust$/,
  /^\/pricing$/,
  /^\/products$/,
  /^\/products\/cocalc-(launchpad|plus|rocket)$/,
  /^\/projects$/,
  /^\/settings$/,
  /^\/support$/,
  /^\/support\/new\?/,
] as const;

function getHomepageClaimCorpus(container: HTMLElement): string {
  const corpus = [container.textContent ?? ""];

  for (const element of Array.from(container.querySelectorAll("*"))) {
    for (const attribute of BLOCKED_HOMEPAGE_CLAIM_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) {
        corpus.push(value);
      }
    }
  }

  return corpus.join("\n");
}

function expectBlockedHomepageClaimsAbsent(container: HTMLElement) {
  const corpus = getHomepageClaimCorpus(container);
  for (const pattern of BLOCKED_HOMEPAGE_CLAIM_PATTERNS) {
    expect(corpus).not.toMatch(pattern);
  }
}

function expectHomepageSectionsLabeled(container: HTMLElement) {
  const sections = Array.from(container.querySelectorAll("section"));
  expect(sections.length).toBeGreaterThan(0);

  for (const section of sections) {
    expect(section.getAttribute("aria-label")?.trim()).toBeTruthy();
  }
}

function getHomepageTopLevelSectionLabels(container: HTMLElement): string[] {
  const contentFlex = container.querySelector(
    ".cocalc-public-content",
  )?.firstElementChild;
  expect(contentFlex).not.toBeNull();

  return Array.from(contentFlex?.children ?? [])
    .filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element.tagName.toLowerCase() === "section",
    )
    .map((section) => section.getAttribute("aria-label") ?? "");
}

function expectHomepageLinkTargetsControlled(container: HTMLElement) {
  const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a"));
  expect(links.length).toBeGreaterThan(0);
  const unexpectedInternalHrefs: string[] = [];

  for (const link of links) {
    const href = link.getAttribute("href");
    expect(href).toBeTruthy();
    if (href == null) continue;

    const isExternal =
      /^https?:\/\//i.test(href) || /^(mailto|tel):/i.test(href);
    if (isExternal) {
      expect(ALLOWED_EXTERNAL_HOMEPAGE_HREFS).toContain(href);
    } else {
      expect(href.startsWith("/") || href.startsWith("#")).toBe(true);
      if (
        !ALLOWED_INTERNAL_HOMEPAGE_HREF_PATTERNS.some((pattern) =>
          pattern.test(href),
        )
      ) {
        unexpectedInternalHrefs.push(href);
      }
    }
  }
  expect(unexpectedInternalHrefs).toEqual([]);
}

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
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders the top nav and major landing sections", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "blog",
          date: 1700000000,
          id: 1,
          tags: ["launch"],
          text: "This is a **news** item.",
          title: "Launch update",
        },
      ],
    }) as typeof fetch;
    const { container } = render(
      <PublicHomeApp
        config={{ site_name: "Launchpad", site_description: "Hello world" }}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "Launchpad home",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "CoCalc.ai",
      }),
    ).not.toBeNull();
    const hero = screen.getByRole("region", {
      name: "CoCalc.ai technical workspace",
    });
    expect(
      within(hero).getByText("AI-native technical workspace"),
    ).not.toBeNull();
    expect(
      within(hero)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(hero)
        .getByRole("link", { name: "Compare deployment options" })
        .getAttribute("href"),
    ).toBe("/products");
    const heroActions = hero.querySelector(".cocalc-public-home-hero-actions");
    expect(heroActions).not.toBeNull();
    expect(
      within(heroActions as HTMLElement)
        .getByRole("link", { name: "Start on CoCalc.ai" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(heroActions as HTMLElement)
        .getByRole("link", { name: "Compare deployment options" })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(heroActions as HTMLElement)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/auth/sign-up", "/products"]);
    const heroRouteChooser = within(hero).getByRole("group", {
      name: "CoCalc.ai hero route chooser",
    });
    expectLinkHrefs(heroRouteChooser, [
      "/auth/sign-up",
      "/features",
      "/products",
    ]);
    expect(
      within(heroRouteChooser).getByText("Start from the project"),
    ).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText(
        "Then pick the workflow or operating path.",
      ),
    ).not.toBeNull();
    const heroContinuityRail = within(heroRouteChooser).getByRole("group", {
      name: "CoCalc.ai project continuity rail",
    });
    expect(
      within(heroContinuityRail).getByText("What moves with the project"),
    ).not.toBeNull();
    for (const signal of [
      "Files",
      "Runtime",
      "AI context",
      "Review trail",
      "Notebooks, source trees, datasets",
      "Kernels, terminals, services",
      "Prompts, patches, review notes",
      "Snapshots, TimeTravel, history",
    ]) {
      expect(within(heroContinuityRail).getByText(signal)).not.toBeNull();
    }
    expect(within(heroRouteChooser).getByText("Workspace")).not.toBeNull();
    expect(within(heroRouteChooser).getByText("Workflows")).not.toBeNull();
    expect(within(heroRouteChooser).getByText("Deployment")).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText("Create a project"),
    ).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText("Browse workflows"),
    ).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText("Choose deployment path"),
    ).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText(
        "Start with the project that holds files, notebooks, terminals, and Codex work.",
      ),
    ).not.toBeNull();
    expect(
      within(heroRouteChooser).getByText(
        "Use products when the question is hosted, local, or customer-operated.",
      ),
    ).not.toBeNull();
    expect(
      within(hero).queryByRole("link", { name: "Install CoCalc Plus" }),
    ).toBeNull();
    expect(
      within(hero).queryByRole("link", { name: "Discuss site licensing" }),
    ).toBeNull();
    expect(
      within(hero).queryByRole("group", {
        name: "CoCalc.ai operating modes",
      }),
    ).toBeNull();
    const projectOutcomes = screen.getByRole("group", {
      name: "CoCalc.ai project outcomes",
    });
    expect(
      within(projectOutcomes).getByText("One place to work"),
    ).not.toBeNull();
    expect(within(projectOutcomes).getByText("Real compute")).not.toBeNull();
    expect(
      within(projectOutcomes).getByText("A lasting record"),
    ).not.toBeNull();
    expect(
      within(hero).queryByRole("group", {
        name: "CoCalc.ai workspace context cues",
      }),
    ).toBeNull();
    expect(
      within(hero).queryByText("Project context kept together"),
    ).toBeNull();
    expect(
      within(hero).queryByRole("group", {
        name: "CoCalc project context preview",
      }),
    ).toBeNull();
    const heroSnapshot = within(hero).getByRole("complementary", {
      name: "CoCalc.ai project context snapshot",
    });
    expect(
      within(heroSnapshot).getByText("Project context snapshot"),
    ).not.toBeNull();
    expect(within(heroSnapshot).getByText("Notebook output")).not.toBeNull();
    expect(within(heroSnapshot).getByText("Terminal state")).not.toBeNull();
    expect(within(heroSnapshot).getByText("Codex patch")).not.toBeNull();
    expect(within(heroSnapshot).getByText("History checkpoint")).not.toBeNull();
    const heroWorkspaceTrail = within(heroSnapshot).getByRole("group", {
      name: "CoCalc.ai hero workspace trail",
    });
    expect(
      within(heroWorkspaceTrail).getByText("Workspace trail"),
    ).not.toBeNull();
    expect(
      within(heroWorkspaceTrail).getByText(
        "Files, runtime, agent work, review.",
      ),
    ).not.toBeNull();
    expect(within(heroWorkspaceTrail).getByText("Capture")).not.toBeNull();
    expect(within(heroWorkspaceTrail).getByText("Run")).not.toBeNull();
    expect(within(heroWorkspaceTrail).getByText("Ask")).not.toBeNull();
    expect(within(heroWorkspaceTrail).getByText("Review")).not.toBeNull();
    expect(
      within(heroSnapshot)
        .getByRole("link", { name: "Create a workspace" })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    const workspaceScope = screen.getByRole("region", {
      name: "CoCalc.ai workspace scope",
    });
    expect(
      within(workspaceScope).getByRole("heading", {
        name: "The workspace holds the pieces technical work needs.",
      }),
    ).not.toBeNull();
    expect(
      within(workspaceScope).getByText(
        /common artifacts visible before choosing a notebook/i,
      ),
    ).not.toBeNull();
    const workspaceArtifacts = within(workspaceScope).getByRole("group", {
      name: "CoCalc.ai workspace artifacts",
    });
    for (const artifact of [
      "Code",
      "Notebooks",
      "Documents",
      "Compute",
      "Files",
      "AI",
      "Collaboration",
      "History",
      "Source trees and patches",
      "Jupyter output and notes",
      "LaTeX, Markdown, handouts",
      "Kernels, shells, services",
      "Project files and data",
      "Codex turns and chat",
      "People and shared review",
      "Snapshots and TimeTravel",
    ]) {
      expect(within(workspaceArtifacts).getByText(artifact)).not.toBeNull();
    }
    const workspaceDecisionCues = within(workspaceScope).getByRole("group", {
      name: "CoCalc.ai workspace decision cues",
    });
    for (const cue of [
      "Material",
      "Runtime",
      "Collaboration",
      "Operating boundary",
      "Files, notebooks, data, and notes.",
      "Kernels, terminals, packages, and services.",
      "People, Codex turns, and review notes.",
      "Hosted, local, or customer-operated path.",
    ]) {
      expect(within(workspaceDecisionCues).getByText(cue)).not.toBeNull();
    }
    const workspaceStartPlanner = within(workspaceScope).getByRole("group", {
      name: "CoCalc.ai workspace start planner",
    });
    expectLinkHrefs(workspaceStartPlanner, [
      "/auth/sign-up",
      "/features/terminal",
      "/features/ai",
      "/features/compare",
    ]);
    expect(
      within(workspaceStartPlanner).getByText("Start planner"),
    ).not.toBeNull();
    expect(
      within(workspaceStartPlanner).getByText(
        "Follow one project through the first tool choice.",
      ),
    ).not.toBeNull();
    for (const step of [
      "Workspace",
      "Runtime",
      "Assistance",
      "Review point",
      "Create workspace",
      "Add runtime",
      "Ask with context",
      "Review the state",
      "Put source, notebooks, data, and notes in one project before choosing tools.",
      "Open a terminal or notebook where the files already live.",
      "Use Codex or chat when the project record should inform changes.",
      "Check snapshots, history, or comparisons before handing off.",
    ]) {
      expect(within(workspaceStartPlanner).getByText(step)).not.toBeNull();
    }
    const continuityMap = screen.getByRole("region", {
      name: "CoCalc.ai workspace continuity map",
    });
    expect(
      within(continuityMap).getByRole("heading", {
        name: "Keep the work surface connected to the work.",
      }),
    ).not.toBeNull();
    expect(
      within(continuityMap).getByText(
        /first notebook, command, prompt, or deployment choice/i,
      ),
    ).not.toBeNull();
    const continuityCheckpoints = within(continuityMap).getByRole("group", {
      name: "CoCalc.ai continuity checkpoints",
    });
    expectLinkHrefs(continuityCheckpoints, [
      "/features/compare",
      "/features/terminal",
      "/features/ai",
      "/features/compare",
    ]);
    expect(
      within(continuityCheckpoints)
        .getByRole("link", { name: /Start with the material/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(continuityCheckpoints)
        .getByRole("link", { name: /Run beside the files/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(continuityCheckpoints)
        .getByRole("link", { name: /Ask with project context/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(within(continuityCheckpoints).getByText("Material")).not.toBeNull();
    expect(within(continuityCheckpoints).getByText("Runtime")).not.toBeNull();
    expect(within(continuityCheckpoints).getByText("Codex")).not.toBeNull();
    expect(within(continuityCheckpoints).getByText("Review")).not.toBeNull();
    expect(
      within(continuityCheckpoints).getByText("Files, notebooks, data"),
    ).not.toBeNull();
    expect(
      within(continuityCheckpoints).getByText("Commands, output, services"),
    ).not.toBeNull();
    expect(
      within(continuityCheckpoints).getByText("Prompts, patches, notes"),
    ).not.toBeNull();
    expect(
      within(continuityCheckpoints).getByText("Snapshots, history, review"),
    ).not.toBeNull();
    const entryActions = within(continuityMap).getByRole("group", {
      name: "CoCalc.ai entry actions",
    });
    expectLinkHrefs(entryActions, ["/auth/sign-up", "/features", "/products"]);
    expect(
      within(entryActions)
        .getByRole("link", { name: /Create a workspace/i })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    expect(
      within(entryActions)
        .getByRole("link", { name: /Browse workflows/i })
        .getAttribute("href"),
    ).toBe("/features");
    expect(
      within(entryActions)
        .getByRole("link", { name: /Compare deployments/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(within(entryActions).getByText("Workspace")).not.toBeNull();
    expect(within(entryActions).getByText("Work surfaces")).not.toBeNull();
    expect(within(entryActions).getByText("Operating path")).not.toBeNull();
    expect(
      within(entryActions).getByText(
        "Open the project boundary first when files, notebooks, terminals, and agent work need one home.",
      ),
    ).not.toBeNull();
    expect(
      within(entryActions).getByText(
        "Then choose the notebook, terminal, AI, teaching, or writing surface that fits the task.",
      ),
    ).not.toBeNull();
    expect(
      within(entryActions).getByText(
        "Then compare hosted, local, and customer-operated options when the runtime boundary matters.",
      ),
    ).not.toBeNull();
    const continuityLayers = within(continuityMap).getByRole("group", {
      name: "CoCalc.ai continuity layers",
    });
    expect(
      within(continuityLayers).getByText("Continuity layers"),
    ).not.toBeNull();
    expect(
      within(continuityLayers).getByText(
        "Source, execution, assistance, recovery.",
      ),
    ).not.toBeNull();
    expect(within(continuityLayers).getByText("Source")).not.toBeNull();
    expect(within(continuityLayers).getByText("Execution")).not.toBeNull();
    expect(within(continuityLayers).getByText("Assistance")).not.toBeNull();
    expect(within(continuityLayers).getByText("Recovery")).not.toBeNull();
    expect(
      within(continuityLayers).getByText(
        "Files and notebooks establish the shared source.",
      ),
    ).not.toBeNull();
    const continuityHandoffCheckpoints = within(continuityMap).getByRole(
      "group",
      {
        name: "CoCalc.ai continuity handoff checkpoints",
      },
    );
    expect(
      within(continuityHandoffCheckpoints).getByText("Handoff checkpoints"),
    ).not.toBeNull();
    expect(
      within(continuityHandoffCheckpoints).getByText(
        "What should still be visible before moving on.",
      ),
    ).not.toBeNull();
    for (const checkpoint of [
      "Source record",
      "Execution context",
      "Review notes",
      "Next surface",
      "Files, notebooks, and documents are the shared reference.",
      "Terminal output, kernels, and services show how results were produced.",
      "Codex turns, discussion, and comparison views keep decisions visible.",
      "Open the next notebook, terminal, agent, or product path from the same project.",
    ]) {
      expect(
        within(continuityHandoffCheckpoints).getByText(checkpoint),
      ).not.toBeNull();
    }
    const nextSurfaceChecks = within(continuityMap).getByRole("group", {
      name: "CoCalc.ai next surface checks",
    });
    expect(
      within(nextSurfaceChecks).getByText("Next surface checks"),
    ).not.toBeNull();
    expect(
      within(nextSurfaceChecks).getByText(
        "What to confirm before switching surfaces.",
      ),
    ).not.toBeNull();
    for (const check of [
      "Reference is visible",
      "Runtime is named",
      "Agent scope is clear",
      "Review point is saved",
      "Notebook, source, data, and notes are still linked from the project.",
      "Kernel, shell, package, or service notes show how the result was produced.",
      "Prompt, patch, and discussion context describe what the agent should use.",
      "Snapshot, comparison, or review note marks the state to continue from.",
    ]) {
      expect(within(nextSurfaceChecks).getByText(check)).not.toBeNull();
    }
    expect(
      screen.queryByRole("region", {
        name: "CoCalc.ai landing route map",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai primary landing routes",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai first decision flow",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai workspace route loop",
      }),
    ).toBeNull();
    const workspacePreview = screen.getByRole("region", {
      name: "CoCalc.ai workspace preview",
    });
    expect(
      within(workspacePreview).getByRole("heading", {
        name: "The project is the unit of work.",
      }),
    ).not.toBeNull();
    const projectPreview = within(workspacePreview).getByRole("group", {
      name: "CoCalc project context preview",
    });
    expect(
      within(projectPreview).getByText("research-workspace"),
    ).not.toBeNull();
    expect(within(projectPreview).getByText("Codex thread")).not.toBeNull();
    expect(
      within(projectPreview).getByText("Project workspace"),
    ).not.toBeNull();
    expect(within(projectPreview).getByText("Project files")).not.toBeNull();
    expect(
      within(projectPreview).getByText("Shared project state"),
    ).not.toBeNull();
    const projectSequence = within(projectPreview).getByRole("group", {
      name: "CoCalc.ai project work sequence",
    });
    expectLinkHrefs(projectSequence, [
      "/features/compare",
      "/features/terminal",
      "/features/ai",
      "/features/compare",
    ]);
    expect(
      within(projectSequence).getByText("Project work sequence"),
    ).not.toBeNull();
    expect(within(projectSequence).getByText("Files to review")).not.toBeNull();
    expect(within(projectSequence).getByText("Capture")).not.toBeNull();
    expect(within(projectSequence).getByText("Run")).not.toBeNull();
    expect(within(projectSequence).getByText("Ask")).not.toBeNull();
    expect(within(projectSequence).getByText("Review")).not.toBeNull();
    expect(
      within(projectSequence).getByText(
        "Notebooks, code, data, and notes enter the project.",
      ),
    ).not.toBeNull();
    expect(
      within(projectSequence).getByText(
        "Shells and notebooks work against the same files.",
      ),
    ).not.toBeNull();
    expect(
      within(projectSequence).getByText(
        "Codex can use the project record when helping.",
      ),
    ).not.toBeNull();
    expect(
      within(projectSequence).getByText(
        "Output, snapshots, and TimeTravel keep review nearby.",
      ),
    ).not.toBeNull();
    expect(
      within(projectSequence)
        .getByRole("link", { name: /Capture/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectSequence)
        .getByRole("link", { name: /Run/i })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(projectSequence)
        .getByRole("link", { name: /Ask/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(projectSequence)
        .getByRole("link", { name: /Review/i })
        .getAttribute("href"),
    ).toBe("/features/compare");
    const continuityCues = within(projectPreview).getByRole("group", {
      name: "CoCalc.ai continuity cues",
    });
    expect(within(continuityCues).getByText("Continuity cues")).not.toBeNull();
    expect(
      within(continuityCues).getByText("What carries forward"),
    ).not.toBeNull();
    expect(within(continuityCues).getByText("Project context")).not.toBeNull();
    expect(within(continuityCues).getByText("Execution trail")).not.toBeNull();
    expect(within(continuityCues).getByText("Decision trail")).not.toBeNull();
    expect(within(continuityCues).getByText("Recovery trail")).not.toBeNull();
    expect(
      within(continuityCues).getByText(
        "Files, notebooks, data, prompts, and notes stay in one inspectable project.",
      ),
    ).not.toBeNull();
    expect(
      within(continuityCues).getByText(
        "Notebook output and terminal sessions remain near the code that produced them.",
      ),
    ).not.toBeNull();
    expect(
      within(continuityCues).getByText(
        "Chat, Codex turns, and review notes preserve why changes were made.",
      ),
    ).not.toBeNull();
    expect(
      within(continuityCues).getByText(
        "Snapshots and TimeTravel keep earlier states available when work changes.",
      ),
    ).not.toBeNull();
    expect(
      within(projectPreview).queryByRole("group", {
        name: "CoCalc.ai workspace record",
      }),
    ).toBeNull();
    expect(within(projectPreview).queryByText("Workspace record")).toBeNull();
    expect(
      within(projectPreview).queryByText("What stays attached"),
    ).toBeNull();
    expect(within(projectPreview).queryByText("Active work")).toBeNull();
    expect(within(projectPreview).queryByText("Notebook run")).toBeNull();
    expect(within(projectPreview).queryByText("Shell session")).toBeNull();
    expect(within(projectPreview).queryByText("Codex turn")).toBeNull();
    expect(within(projectPreview).queryByText("Review trail")).toBeNull();
    expect(
      within(projectPreview).queryByRole("group", {
        name: "CoCalc.ai context carried forward",
      }),
    ).toBeNull();
    expect(
      within(projectPreview).queryByRole("group", {
        name: "CoCalc.ai active project work",
      }),
    ).toBeNull();
    expect(within(projectPreview).queryByText("Handoff queue")).toBeNull();
    expect(within(projectPreview).queryByText("Project record")).toBeNull();
    expect(
      within(projectPreview)
        .getByRole("link", { name: /Start a project/i })
        .getAttribute("href"),
    ).toBe("/auth/sign-up");
    const projectSurfaceLinks = within(projectPreview).getByRole("group", {
      name: "CoCalc.ai project surface links",
    });
    expectLinkHrefs(projectSurfaceLinks, [
      "/auth/sign-up",
      "/features/compare",
      "/features/terminal",
      "/features/ai",
      "/features/compare",
    ]);
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Open files" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Run terminal" })
        .getAttribute("href"),
    ).toBe("/features/terminal");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Ask Codex" })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(projectSurfaceLinks)
        .getByRole("link", { name: "Review history" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    expect(
      within(projectSurfaceLinks).getByText("One context, multiple surfaces"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Source, notebooks, data"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Shells and services"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Agent work thread"),
    ).not.toBeNull();
    expect(
      within(projectSurfaceLinks).getByText("Snapshots and TimeTravel"),
    ).not.toBeNull();
    const removedDuplicateRegions = [
      "CoCalc.ai project handoff path",
      "CoCalc.ai intent router",
      "CoCalc.ai first workspace choice",
      "CoCalc.ai project intake checklist",
      "CoCalc.ai review handoff checklist",
      "CoCalc.ai workspace breadth",
      "CoCalc.ai project state map",
      "Common CoCalc.ai starting points",
      "CoCalc.ai starter project recipes",
      "CoCalc.ai workflow path routing",
      "CoCalc.ai first-step routes",
      "Homepage boundary and detail routes",
      "Why CoCalc keeps work in projects",
      "CoCalc.ai next action routes",
      "CoCalc.ai collaboration review path",
      "CoCalc.ai work input routes",
    ];
    for (const name of removedDuplicateRegions) {
      expect(screen.queryByRole("region", { name })).toBeNull();
    }
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai artifact route shortcuts",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai starting signal routes" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai handoff checklist" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai route handoff summary" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai route confirmation checks",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai next-route notes" }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai collaboration review steps",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai material route cards" }),
    ).toBeNull();
    expect(screen.queryByText("After the first click")).toBeNull();
    expect(
      screen.queryByText("Review shared work before the next step."),
    ).toBeNull();
    expect(
      screen.queryByText("Open the work where it already belongs."),
    ).toBeNull();
    expect(screen.queryByText("Browse feature routes")).toBeNull();
    expect(screen.queryByText("Notebook or data table")).toBeNull();
    expect(screen.queryByText("Command or service")).toBeNull();
    expect(screen.queryByText("Script or source tree")).toBeNull();
    expect(screen.queryByText("Paper or handout")).toBeNull();
    const coreWorkflows = screen.getByRole("region", {
      name: "CoCalc.ai core workflows",
    });
    expect(
      within(coreWorkflows)
        .getByRole("img", { name: "CoCalc project workflow map" })
        .getAttribute("src"),
    ).toBe("/public/landing/project-workflows.jpg");
    expect(
      within(coreWorkflows).getByText("Project-centered workflow map"),
    ).not.toBeNull();
    expect(
      within(coreWorkflows)
        .getByRole("link", { name: "Map project context" })
        .getAttribute("href"),
    ).toBe("/features/compare");
    const coreWorkflowCards = within(coreWorkflows).getByRole("group", {
      name: "CoCalc.ai core workflow cards",
    });
    expectLinkHrefs(coreWorkflowCards, [
      "/features/jupyter-notebook",
      "/features/terminal",
      "/features/ai",
    ]);
    expect(
      within(coreWorkflows).queryByRole("link", { name: /LaTeX Editor/i }),
    ).toBeNull();
    expect(
      within(coreWorkflows).queryByRole("link", { name: /Whiteboard/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: "Not another isolated notebook, IDE, or agent console.",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Route by the work your group does.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /See AI workflows/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Open notebooks/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Explore teaching/i }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent News" }),
      ).not.toBeNull(),
    );
    expect(getHomepageTopLevelSectionLabels(container)).toEqual([
      "CoCalc.ai technical workspace",
      "CoCalc.ai workspace scope",
      "CoCalc.ai workspace continuity map",
      "CoCalc.ai workspace preview",
      "CoCalc.ai core workflows",
      "CoCalc.ai audience paths",
      "CoCalc.ai product options",
      "CoCalc.ai controlled detail routes",
      "CoCalc.ai recent news",
      "CoCalc.ai final calls to action",
    ]);
    expect(
      screen
        .getAllByRole("link", { name: "Install CoCalc Plus" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["https://software.cocalc.ai/software/cocalc-plus/index.html"]);
    const deploymentLinks = screen.getAllByRole("link", {
      name: "Compare deployment options",
    });
    expect(deploymentLinks.length).toBeGreaterThan(0);
    expect(
      deploymentLinks.every(
        (link) => link.getAttribute("href") === "/products",
      ),
    ).toBe(true);
    const siteLicenseLinks = screen.getAllByRole("link", {
      name: "Discuss site licensing",
    });
    expect(siteLicenseLinks.length).toBeGreaterThan(0);
    expect(
      siteLicenseLinks.every((link) => {
        const href = link.getAttribute("href");
        return (
          href?.startsWith("/support/new?") &&
          href.includes("subject=Site+license")
        );
      }),
    ).toBe(true);
    expectBlockedHomepageClaimsAbsent(container);
    expectHomepageLinkTargetsControlled(container);
    expect(container.querySelector('a[href*="cocalc-star"]')).toBeNull();
    expectHomepageSectionsLabeled(container);
    expect(
      screen
        .getAllByRole("link", { name: "Explore shared features" })[0]
        .getAttribute("href"),
    ).toBe("/features");
    const exploreAllFeaturesLinks = screen.getAllByRole("link", {
      name: "Explore all features",
    });
    expect(exploreAllFeaturesLinks.length).toBeGreaterThan(0);
    expect(
      exploreAllFeaturesLinks.every(
        (link) => link.getAttribute("href") === "/features",
      ),
    ).toBe(true);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(screen.queryByText("Split tools")).toBeNull();
    expect(screen.queryByText("CoCalc project context")).toBeNull();
    expect(
      screen.queryByText(
        /The point is not that every workflow uses every tool/i,
      ),
    ).toBeNull();
    expect(
      within(coreWorkflows)
        .getByRole("link", { name: /Jupyter Notebooks/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      screen.queryByRole("group", { name: "CoCalc.ai next action cards" }),
    ).toBeNull();
    const audiencePaths = screen.getByRole("region", {
      name: "CoCalc.ai audience paths",
    });
    const audienceRouteRows = within(audiencePaths).getByRole("group", {
      name: "CoCalc.ai audience route rows",
    });
    expectLinkHrefs(audienceRouteRows, [
      "/features/ai",
      "/features/jupyter-notebook",
      "/features/teaching",
    ]);
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Engineering teams/i })
        .getAttribute("href"),
    ).toBe("/features/ai");
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Research labs/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(
      within(audiencePaths)
        .getByRole("link", { name: /Technical courses/i })
        .getAttribute("href"),
    ).toBe("/features/teaching");
    const engineeringStartingContext = within(audiencePaths).getByRole(
      "group",
      {
        name: "Engineering teams starting context",
      },
    );
    expect(
      within(engineeringStartingContext).getByText("Repo and config"),
    ).not.toBeNull();
    expect(
      within(engineeringStartingContext).getByText("Service logs"),
    ).not.toBeNull();
    expect(
      within(engineeringStartingContext).getByText("Patch notes"),
    ).not.toBeNull();
    const researchStartingContext = within(audiencePaths).getByRole("group", {
      name: "Research labs starting context",
    });
    expect(
      within(researchStartingContext).getByText("Notebook output"),
    ).not.toBeNull();
    expect(
      within(researchStartingContext).getByText("Dataset files"),
    ).not.toBeNull();
    expect(
      within(researchStartingContext).getByText("Environment notes"),
    ).not.toBeNull();
    const courseStartingContext = within(audiencePaths).getByRole("group", {
      name: "Technical courses starting context",
    });
    expect(
      within(courseStartingContext).getByText("Assignment source"),
    ).not.toBeNull();
    expect(
      within(courseStartingContext).getByText("Student submissions"),
    ).not.toBeNull();
    expect(
      within(courseStartingContext).getByText("Grading notes"),
    ).not.toBeNull();
    const engineeringCues = within(audiencePaths).getByRole("group", {
      name: "Engineering teams project context cues",
    });
    expect(within(engineeringCues).getByText("Source")).not.toBeNull();
    expect(
      within(engineeringCues).getByText("Services and tests"),
    ).not.toBeNull();
    expect(
      within(engineeringCues).getByText("Patches and review"),
    ).not.toBeNull();
    const researchCues = within(audiencePaths).getByRole("group", {
      name: "Research labs project context cues",
    });
    expect(within(researchCues).getByText("Notebooks")).not.toBeNull();
    expect(within(researchCues).getByText("Data")).not.toBeNull();
    expect(within(researchCues).getByText("Snapshots")).not.toBeNull();
    const courseCues = within(audiencePaths).getByRole("group", {
      name: "Technical courses project context cues",
    });
    expect(within(courseCues).getByText("Coursework")).not.toBeNull();
    expect(within(courseCues).getByText("Student projects")).not.toBeNull();
    expect(within(courseCues).getByText("Notebook grading")).not.toBeNull();
    expect(screen.getByText("Operating path chooser")).not.toBeNull();
    expect(screen.getByText("Choose who runs the workspace")).not.toBeNull();
    const operatingBoundaryShortcuts = screen.getByRole("group", {
      name: "CoCalc.ai operating boundary shortcuts",
    });
    expectLinkHrefs(operatingBoundaryShortcuts, [
      "/",
      "/products/cocalc-plus",
      "/products",
    ]);
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /Managed CoCalc\.ai/i })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /One-user local/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(operatingBoundaryShortcuts)
        .getByRole("link", { name: /Customer-operated/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(operatingBoundaryShortcuts).getByText(
        "Compare Launchpad and Rocket for customer-operated paths.",
      ),
    ).not.toBeNull();
    const productOptions = screen.getByRole("region", {
      name: "CoCalc.ai product options",
    });
    const operatingBoundaryQuestions = within(productOptions).getByRole(
      "group",
      {
        name: "CoCalc.ai operating boundary questions",
      },
    );
    expect(
      within(operatingBoundaryQuestions).getByText(
        "Operating boundary questions",
      ),
    ).not.toBeNull();
    expect(
      within(operatingBoundaryQuestions).getByText(
        "Choose the path by responsibility.",
      ),
    ).not.toBeNull();
    for (const question of [
      "Who operates it?",
      "Where does it run?",
      "Who needs access?",
      "What needs review?",
      "CoCalc, one local user, or a customer team.",
      "Hosted service, local machine, or private deployment.",
      "Individual, project team, course, lab, or organization.",
      "Product page, trust policy, or support conversation.",
    ]) {
      expect(
        within(operatingBoundaryQuestions).getByText(question),
      ).not.toBeNull();
    }
    const sharedOperatingContext = within(productOptions).getByRole("group", {
      name: "CoCalc.ai shared operating context",
    });
    expect(
      within(sharedOperatingContext).getByText("Same workspace model"),
    ).not.toBeNull();
    expect(
      within(sharedOperatingContext).getByText(
        "Visible across operating paths.",
      ),
    ).not.toBeNull();
    for (const context of ["Projects", "Files", "Workflows", "History"]) {
      expect(within(sharedOperatingContext).getByText(context)).not.toBeNull();
    }
    const deploymentPathCards = within(productOptions).getByRole("group", {
      name: "CoCalc.ai deployment path cards",
    });
    expectLinkHrefs(deploymentPathCards, [
      "/",
      "/products/cocalc-plus",
      "/products/cocalc-launchpad",
      "/products/cocalc-rocket",
    ]);
    expect(
      within(deploymentPathCards)
        .getByRole("link", { name: /CoCalc\.ai: Hosted service/i })
        .getAttribute("href"),
    ).toBe("/");
    expect(
      within(deploymentPathCards)
        .getByRole("link", { name: /CoCalc Plus: Local runtime/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(deploymentPathCards)
        .getByRole("link", {
          name: /CoCalc Launchpad: Private deployment/i,
        })
        .getAttribute("href"),
    ).toBe("/products/cocalc-launchpad");
    expect(
      within(deploymentPathCards)
        .getByRole("link", { name: /CoCalc Rocket: Private cloud/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-rocket");
    expect(screen.getByText("Deployment path")).not.toBeNull();
    expect(screen.getAllByText("Next step").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Operator").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Best fit").length).toBeGreaterThan(0);
    expect(screen.getByText("Run by CoCalc")).not.toBeNull();
    expect(screen.getByText("Run by you")).not.toBeNull();
    expect(screen.getByText("Run by your team")).not.toBeNull();
    expect(
      screen.getByText("Customer-operated with CoCalc guidance"),
    ).not.toBeNull();
    for (const productCue of [
      "Managed service",
      "Hosted projects",
      "One-user local",
      "Browser workspace",
      "Private team",
      "Customer operated",
      "Infrastructure plan",
      "CoCalc guidance",
    ]) {
      expect(screen.getAllByText(productCue).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Shared course environment")).not.toBeNull();
    expect(
      screen.getByText("Managed accounts, hosted projects, and team access"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Private cloud planning with customer-operated infrastructure boundaries",
      ),
    ).not.toBeNull();
    expect(screen.getByText("Start hosted")).not.toBeNull();
    expect(screen.getAllByText("Review Launchpad").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Site licensing wraps the path you choose."),
    ).not.toBeNull();
    const detailRoutes = screen.getByRole("region", {
      name: "CoCalc.ai controlled detail routes",
    });
    expect(
      within(detailRoutes).getByRole("heading", {
        name: "Use detail pages for boundary questions.",
      }),
    ).not.toBeNull();
    const boundaryDetailRouteLinks = within(detailRoutes).getByRole("group", {
      name: "CoCalc.ai boundary detail route links",
    });
    expectLinkHrefs(boundaryDetailRouteLinks, [
      "/policies/trust",
      "/products/cocalc-plus",
      "/products",
      "/support",
      expect.stringContaining("/support/new?"),
    ]);
    expect(
      within(detailRoutes)
        .getByRole("link", { name: /Trust policy/i })
        .getAttribute("href"),
    ).toBe("/policies/trust");
    expect(
      within(detailRoutes)
        .getByRole("link", { name: /CoCalc Plus details/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      within(detailRoutes)
        .getByRole("link", { name: /Deployment comparison/i })
        .getAttribute("href"),
    ).toBe("/products");
    expect(
      within(detailRoutes)
        .getByRole("link", { name: /Support/i })
        .getAttribute("href"),
    ).toBe("/support");
    const hostedTransitionLink = within(detailRoutes).getByRole("link", {
      name: /Hosted transition questions/i,
    });
    expect(hostedTransitionLink.getAttribute("href")).toContain(
      "/support/new?",
    );
    expect(hostedTransitionLink.getAttribute("href")).toContain(
      "subject=Hosted+transition",
    );
    expect(
      screen.getByRole("region", { name: "CoCalc.ai final calls to action" }),
    ).not.toBeNull();
    const finalCallsToAction = screen.getByRole("region", {
      name: "CoCalc.ai final calls to action",
    });
    const finalDeploymentPathActions = within(finalCallsToAction).getByRole(
      "group",
      {
        name: "CoCalc.ai final deployment path actions",
      },
    );
    expectLinkHrefs(finalDeploymentPathActions, [
      "/auth/sign-up",
      "https://software.cocalc.ai/software/cocalc-plus/index.html",
      "/products",
    ]);
    expect(
      within(finalDeploymentPathActions).getByRole("link", {
        name: "Start on CoCalc.ai",
      }),
    ).not.toBeNull();
    expect(
      within(finalDeploymentPathActions).getByRole("link", {
        name: "Install CoCalc Plus",
      }),
    ).not.toBeNull();
    expect(
      within(finalDeploymentPathActions).getByRole("link", {
        name: "Compare deployment options",
      }),
    ).not.toBeNull();
    expect(
      within(finalDeploymentPathActions).queryByRole("link", {
        name: "Review Launchpad",
      }),
    ).toBeNull();
    expect(
      within(finalDeploymentPathActions).queryByRole("link", {
        name: "Plan Rocket",
      }),
    ).toBeNull();
    expect(
      within(finalCallsToAction).getByText(
        "Choose a hosted, local, or private path.",
      ),
    ).not.toBeNull();
    expect(
      within(finalCallsToAction).getByText(
        "Local runtime for one user on Linux or Mac.",
      ),
    ).not.toBeNull();
    expect(
      within(finalCallsToAction).getByText(
        "Compare hosted, local, and customer-operated paths before choosing a runtime boundary.",
      ),
    ).not.toBeNull();
    expect(
      within(finalCallsToAction).getByText(
        "Site licensing is the organizational wrapper.",
      ),
    ).not.toBeNull();
    expect(
      within(finalCallsToAction)
        .getAllByRole("link", { name: "Compare deployment options" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/products"]);
    const finalSiteLicenseLink = within(finalCallsToAction).getByRole("link", {
      name: "Discuss site licensing",
    });
    expect(finalSiteLicenseLink.getAttribute("href")).toContain(
      "/support/new?",
    );
    expect(finalSiteLicenseLink.getAttribute("href")).toContain(
      "subject=Site+license",
    );
    expect(
      screen
        .getByRole("link", { name: /CoCalc Launchpad/i })
        .getAttribute("href"),
    ).toBe("/products/cocalc-launchpad");
    expect(screen.getByRole("link", { name: "All news" })).not.toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "CoCalc.ai agent-ready project checklist",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Human and Codex handoff workflow",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "CoCalc.ai agent turn evidence checklist",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Review trail for technical work",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Operational workspace signals for CoCalc.ai",
      }),
    ).toBeNull();
  });

  it("uses CoCalc marketing branding for the default hosted Launchpad preview", async () => {
    global.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as typeof fetch;
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          site_name: "CoCalc Launchpad",
        }}
      />,
    );

    expect(document.title).toBe("CoCalc.ai");
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("banner")).queryByRole("link", {
        name: "CoCalc Launchpad home",
      }),
    ).toBeNull();
  });

  it("shows direct app actions when authenticated", () => {
    global.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as typeof fetch;
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
      />,
    );

    expect(
      screen.getAllByRole("link", { name: "Open projects" }).length,
    ).toBeGreaterThan(0);
    expect(
      within(
        screen.getByRole("group", { name: "CoCalc project context preview" }),
      )
        .getByRole("link", { name: "Open projects" })
        .getAttribute("href"),
    ).toBe("/projects");
    expect(
      within(
        screen.getByRole("group", {
          name: "CoCalc.ai entry actions",
        }),
      )
        .getByRole("link", { name: /Open projects/i })
        .getAttribute("href"),
    ).toBe("/projects");
    expectLinkHrefs(
      screen.getByRole("group", {
        name: "CoCalc.ai entry actions",
      }),
      ["/projects", "/features", "/products"],
    );
    expectLinkHrefs(
      screen.getByRole("group", {
        name: "CoCalc.ai workspace start planner",
      }),
      ["/projects", "/features/terminal", "/features/ai", "/features/compare"],
    );
    expect(
      within(
        screen.getByRole("group", {
          name: "CoCalc.ai workspace start planner",
        }),
      )
        .getByRole("link", { name: /Open projects/i })
        .getAttribute("href"),
    ).toBe("/projects");
    expectLinkHrefs(
      screen.getByRole("group", {
        name: "CoCalc.ai hero route chooser",
      }),
      ["/projects", "/features", "/products"],
    );
    expectLinkHrefs(
      screen.getByRole("group", {
        name: "CoCalc.ai continuity checkpoints",
      }),
      [
        "/features/compare",
        "/features/terminal",
        "/features/ai",
        "/features/compare",
      ],
    );
    expect(
      within(
        screen.getByRole("group", {
          name: "CoCalc.ai hero route chooser",
        }),
      ).getByText("Open projects"),
    ).not.toBeNull();
    expect(
      screen.queryByRole("group", {
        name: "CoCalc.ai route confirmation checks",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "CoCalc.ai first-step routes" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Support" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
