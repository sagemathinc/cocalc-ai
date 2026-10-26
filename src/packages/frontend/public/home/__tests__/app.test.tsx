/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PUBLIC_SIGN_UP_LABEL } from "@cocalc/util/public-site-policy";
import PublicHomeApp from "../app";
import type { PublicPolicyPages } from "../../config";
import { PUBLIC_HOME_SECTION_TITLES as TITLES } from "@cocalc/util/public-home-content";
import { PUBLIC_PRODUCT_AVAILABILITY } from "@cocalc/util/public-product-availability";
import { COMPANY_NAME } from "@cocalc/util/theme";
import { installMatchMediaStub } from "../../__tests__/test-helpers";

const cocalcAi = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  is_launchpad: true,
  site_name: "CoCalc Launchpad",
};

beforeAll(installMatchMediaStub);
afterEach(() => jest.restoreAllMocks());

function hero(name = "CoCalc") {
  return screen.getByRole("region", { name: `${name} hero` });
}

function finalSection() {
  return screen.getByRole("region", { name: TITLES.final });
}

describe("PublicHomeApp", () => {
  it("connects the broad agent entry to outcomes, evaluation and useful next steps", () => {
    render(<PublicHomeApp config={cocalcAi} />);

    expect(document.title).toBe("Build and Use Software with AI | CoCalc");
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).toHaveAttribute("href", "/");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(hero()).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Build and use software with AI.",
    );
    expect(
      within(hero()).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(hero()).getByRole("link", { name: "See how agents work" }),
    ).toHaveAttribute("href", "/features/ai");

    const process = screen.getByRole("region", { name: TITLES.process });
    expect(within(process).getAllByRole("heading", { level: 3 })).toHaveLength(
      3,
    );
    expect(
      within(process).getByRole("heading", {
        name: "Refine through conversation",
      }),
    ).toBeInTheDocument();
    const outcomes = screen.getByRole("region", { name: TITLES.outcomes });
    expect(within(outcomes).getAllByRole("heading", { level: 3 })).toHaveLength(
      4,
    );
    expect(
      within(outcomes).getByRole("link", { name: "Try an application task" }),
    ).toHaveAttribute(
      "href",
      "/docs/ai/my-agents#turn-a-recurring-task-into-an-app",
    );
    expect(
      within(outcomes).getByRole("link", { name: "Try an analysis task" }),
    ).toHaveAttribute(
      "href",
      "/docs/ai/my-agents#investigate-a-change-in-your-data",
    );
    expect(
      within(outcomes).getByRole("link", { name: "Publish project images" }),
    ).toHaveAttribute("href", "/docs/projects/publish-rootfs");
    expect(
      within(outcomes).getByRole("link", {
        name: "Explore the shared browser",
      }),
    ).toHaveAttribute("href", "/features/web-browser");

    const guides = screen.getByRole("navigation", {
      name: "Capability guides and implementation documentation",
    });
    expect(
      within(guides).getByRole("link", { name: "Use the CoCalc CLI" }),
    ).toHaveAttribute("href", "/docs/cli/use-cocalc-cli");
    expect(
      within(guides).getByRole("link", { name: "Decide whether CoCalc fits" }),
    ).toHaveAttribute("href", "/features/compare");
    expect(
      within(finalSection()).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(finalSection()).getByRole("link", { name: "Talk to us" }),
    ).toHaveAttribute("href", "/support");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each<[boolean, string, string]>([
    [false, "Open your agents", "/agents"],
    [true, "Open projects", "/projects"],
  ])(
    "routes authenticated visitors with AI disabled=%s",
    (disabled, label, href) => {
      render(
        <PublicHomeApp
          config={{
            ...cocalcAi,
            is_authenticated: true,
            openai_disabled: disabled,
          }}
        />,
      );
      for (const region of [hero(), finalSection()]) {
        expect(
          within(region).getByRole("link", { name: label }),
        ).toHaveAttribute("href", href);
        expect(
          within(region).queryByRole("link", { name: "Start on CoCalc.ai" }),
        ).toBeNull();
      }
      if (disabled) {
        expect(
          within(hero()).getByRole("heading", { level: 1 }),
        ).toHaveTextContent("Build and use software.");
        expect(within(hero()).queryByRole("img")).toBeNull();
        expect(
          screen.queryByRole("link", { name: "Agent Networks" }),
        ).toBeNull();
        expect(
          screen.queryByRole("region", { name: TITLES.process }),
        ).toBeNull();
      }
    },
  );

  it("preserves a custom site's brand and does not advertise canonical-only funding or image publishing", () => {
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "rocket",
          dns: "work.example.org",
          site_name: "Acme Work",
          logo_square: "/custom-logo.svg",
          policy_pages: "custom",
        }}
      />,
    );
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "Acme Work home",
      }),
    ).toBeInTheDocument();
    expect(
      within(hero("Acme Work")).getByRole("link", {
        name: PUBLIC_SIGN_UP_LABEL,
      }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      screen.queryByRole("link", { name: "Publish project images" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Compare memberships" }),
    ).toBeNull();
    expect(
      screen.queryByText(/Use Codex or Claude with the access/),
    ).toBeNull();
    expect(
      within(finalSection()).queryByRole("link", {
        name: "Review trust and compliance",
      }),
    ).toBeNull();
  });

  it.each<PublicPolicyPages>(["none", "custom", "sagemathinc"])(
    "links built-in trust material only under policy_pages=%s",
    (policy_pages) => {
      render(<PublicHomeApp config={{ ...cocalcAi, policy_pages }} />);
      const trust = within(finalSection()).queryByRole("link", {
        name: "Review trust and compliance",
      });
      if (policy_pages === "sagemathinc")
        expect(trust).toHaveAttribute("href", "/policies/trust");
      else expect(trust).toBeNull();
    },
  );

  it("keeps the company attribution in the footer", () => {
    render(<PublicHomeApp config={cocalcAi} />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      `© ${new Date().getFullYear()} ${COMPANY_NAME}`,
    );
  });

  it("keeps setup detail collapsed and keyboard-reachable without a modal", async () => {
    const user = userEvent.setup();
    render(<PublicHomeApp config={cocalcAi} />);
    const evaluation = screen.getByRole("region", { name: TITLES.evaluation });
    const summary = within(evaluation).getByText("Which agents can I use?", {
      selector: "summary",
    });
    const disclosure = summary.closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(
      within(evaluation).getByRole("link", { name: "Connect AI access" }),
    ).not.toBeVisible();

    within(evaluation)
      .getByRole("link", { name: "Give an agent CoCalc access" })
      .focus();
    await user.tab();
    expect(summary).toHaveFocus();
    // jsdom/user-event models native summary clicks, but not its Enter/Space
    // activation. Real-browser keyboard activation remains a separate check.
    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    await user.tab();
    expect(
      within(disclosure).getByRole("link", { name: "Connect AI access" }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(disclosure).getByRole("link", { name: "Use Claude Code" }),
    ).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(summary).toHaveFocus();
    await user.click(summary);
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("PublicHomeApp deployment choices", () => {
  it("hides unavailable deployment kinds and follows the existing product switches", () => {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "plus", true);
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "star", true);
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "launchpad", false);
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "rocket", false);
    const view = render(<PublicHomeApp config={cocalcAi} />);
    const section = screen.getByRole("region", { name: TITLES.deployment });
    expect(section).toHaveTextContent(
      "Choose hosted, local, or single-VM deployment.",
    );
    expect(section).not.toHaveTextContent(/organization-operated|enterprise/);
    expect(
      within(section).getByRole("link", { name: "Where to run CoCalc" }),
    ).toHaveAttribute("href", "/products");

    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "launchpad", true);
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, "rocket", true);
    view.rerender(<PublicHomeApp config={cocalcAi} />);
    expect(section).toHaveTextContent(/organization-operated/);
  });

  it("shows Plus no screenshot of Agent controls when AI is disabled", () => {
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "plus",
          dns: "localhost",
          is_authenticated: true,
          openai_disabled: true,
          site_name: "CoCalc",
        }}
      />,
    );
    expect(within(hero()).queryByRole("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("project-notebook-20260916");
  });

  it("keeps Plus local and avoids hosted agents, browser, collaborator and compute promises", () => {
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "plus",
          dns: "localhost",
          site_name: "CoCalc",
        }}
      />,
    );
    expect(
      within(hero()).getByRole("link", { name: "Open your project" }),
    ).toHaveAttribute("href", "/projects");
    expect(within(hero()).getByRole("img")).toHaveAttribute(
      "src",
      "/public/landing/project-notebook-20260916.jpg",
    );
    expect(
      within(hero()).getByText(/files and software on your computer/),
    ).toBeInTheDocument();
    for (const name of [
      "Agent Networks",
      "Add project collaborators",
      "Explore the shared browser",
      "Try an application task",
      "Try an analysis task",
      "Choose computing resources",
      "Give an agent CoCalc access",
      "Publish project images",
    ]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(
      screen.queryByText(
        /Review results together|membership.*included AI allowance/,
      ),
    ).toBeNull();
  });
});
