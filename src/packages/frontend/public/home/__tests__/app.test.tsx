/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { PUBLIC_HOME_CONTENT as content } from "@cocalc/util/public-home-content";
import PublicHomeApp from "../app";
import { installMatchMediaStub } from "../../__tests__/test-helpers";

beforeAll(installMatchMediaStub);

describe("PublicHomeApp", () => {
  it("presents one short story with working next steps", () => {
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
    ).toBeInTheDocument();
    expect(
      Array.from(
        container.querySelectorAll(".cocalc-public-home > section"),
      ).map((section) => section.getAttribute("aria-label")),
    ).toEqual([
      "CoCalc hero",
      "Why CoCalc",
      "Ways to use CoCalc",
      "Choose how to run CoCalc",
      "Next step",
    ]);
    const hero = screen.getByRole("region", { name: "CoCalc hero" });
    expect(within(hero).getByRole("heading", { level: 1 })).toHaveTextContent(
      content.hero.title,
    );
    expect(
      within(hero).getByText(content.hero.description),
    ).toBeInTheDocument();
    expect(
      within(hero).getByRole("link", { name: content.hero.startLabel }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(
      within(hero).getByRole("link", { name: content.hero.secondary.label }),
    ).toHaveAttribute("href", "/features/ai");
    expect(
      within(hero).getByRole("link", {
        name: content.hero.example.guide.label,
      }),
    ).toHaveAttribute("href", "/" + content.hero.example.guide.href);
    for (const group of [
      content.benefits,
      content.workflows,
      content.hosting,
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name: group.title }),
      ).toBeInTheDocument();
      for (const card of group.cards) {
        expect(
          screen.getByRole("heading", { level: 3, name: card.title }),
        ).toBeInTheDocument();
        expect(screen.getByText(card.description)).toBeInTheDocument();
      }
    }
    const next = screen.getByRole("region", { name: "Next step" });
    expect(
      within(next).getByRole("link", { name: content.closing.contact.label }),
    ).toHaveAttribute("href", "/support");
    expect(
      within(next).queryByRole("link", { name: content.closing.trustLabel }),
    ).toBeNull();
    expect(
      container.querySelector(".cocalc-public-home")?.textContent,
    ).not.toMatch(/teaching|course management|educators|Jupyter hosting/i);
  });

  it("keeps authenticated visitors on their project path", () => {
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "Example Workspace" }}
      />,
    );
    expect(document.title).toBe("Example Workspace");
    expect(
      screen.getByRole("region", { name: "Example Workspace hero" }),
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", {
      name: content.hero.returningLabel,
    })) {
      expect(link).toHaveAttribute("href", "/projects");
    }
    expect(
      screen.queryByRole("link", { name: content.hero.startLabel }),
    ).toBeNull();
    expect(
      screen.getByText(content.closing.returningDescription),
    ).toBeInTheDocument();
    expect(screen.queryByText(content.closing.description)).toBeNull();
  });

  it("only links built-in trust materials when configured", () => {
    render(<PublicHomeApp config={{ policy_pages: "sagemathinc" }} />);
    expect(
      within(screen.getByRole("region", { name: "Next step" })).getByRole(
        "link",
        { name: content.closing.trustLabel },
      ),
    ).toHaveAttribute("href", "/policies/trust");
  });

  it("does not send Plus readers to unavailable hosted guides", () => {
    const { container } = render(
      <PublicHomeApp config={{ cocalc_product: "plus" }} />,
    );
    const home = container.querySelector(".cocalc-public-home")!;
    expect(home.querySelector('a[href^="/docs/hosts/"]')).toBeNull();
    expect(
      home.querySelector('a[href^="/docs/research/private-dashboard"]'),
    ).toBeNull();
    expect(home.textContent).not.toMatch(
      /CoCalc.ai|collaborator|coauthor|hosted membership|project host/i,
    );
    expect(home.querySelector('a[href*="auth/sign-up"]')).toBeNull();
    expect(home.querySelector('a[href*="projects"]')).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "CoCalc hero" })).getByRole(
        "link",
        { name: "Explore CoCalc Plus" },
      ),
    ).toHaveAttribute("href", "/products/cocalc-plus#install-cocalc-plus");
    expect(
      within(
        screen.getByRole("region", { name: "Ways to use CoCalc" }),
      ).getByRole("link", { name: /Use the terminal/ }),
    ).toHaveAttribute("href", "/docs/terminal/use-terminal");
    expect(
      screen.queryByRole("link", { name: content.hero.example.fullSizeLabel }),
    ).toBeNull();
  });
});
