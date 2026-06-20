/** @jest-environment jsdom */

import type { ReactElement } from "react";

import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { PublicConfigProvider } from "@cocalc/frontend/public/config";
import PublicTopNav from "./top-nav";

describe("PublicTopNav", () => {
  let currentWidth = 1280;

  function setViewportWidth(width: number) {
    currentWidth = width;
  }

  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => {
        const minWidth = query.match(/\(min-width:\s*(\d+)px\)/);
        const maxWidth = query.match(/\(max-width:\s*(\d+)px\)/);
        const matchesMin = minWidth
          ? currentWidth >= Number(minWidth[1])
          : true;
        const matchesMax = maxWidth
          ? currentWidth <= Number(maxWidth[1])
          : true;
        return {
          matches: matchesMin && matchesMax,
          media: query,
          onchange: null,
          addEventListener: jest.fn(),
          addListener: jest.fn(),
          dispatchEvent: jest.fn(),
          removeEventListener: jest.fn(),
          removeListener: jest.fn(),
        };
      },
    });
  });

  beforeEach(() => {
    setViewportWidth(1280);
  });

  async function renderTopNav(node: ReactElement) {
    const result = render(
      <PublicConfigProvider config={{ site_name: "Launchpad" }}>
        {node}
      </PublicConfigProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    return result;
  }

  it("uses Projects and Settings as authenticated app actions", async () => {
    await render(
      <PublicConfigProvider
        config={{
          account_display_name: "Alice Example",
          account_email_address: "alice@example.com",
          is_authenticated: true,
          site_name: "Launchpad",
        }}
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(screen.getByText("Alice Example")).not.toBeNull();
    expect(screen.queryByText("alice@example.com")).toBeNull();
    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Launchpad home" })).not.toBeNull();
    expect(
      within(screen.getByRole("menu", { name: "Public pages" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Features",
      "Guides",
      "Docs",
      "Products",
      "Pricing",
      "News",
      "About",
      "Support",
    ]);
    expect(screen.getByRole("link", { name: "Guides" })).toHaveAttribute(
      "href",
      "/guides",
    );
  });

  it("uses sign-in and sign-up links for anonymous visitors", async () => {
    await renderTopNav(<PublicTopNav />);

    expect(screen.getByRole("link", { name: "Sign in" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign up" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveClass(
      "ant-btn-primary",
    );
    expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
  });

  it("highlights sign-in on the sign-in auth page", async () => {
    await renderTopNav(<PublicTopNav active="auth-sign-in" />);

    expect(screen.getByRole("link", { name: "Sign in" })).toHaveClass(
      "ant-btn-primary",
    );
    expect(screen.getByRole("link", { name: "Sign up" })).not.toHaveClass(
      "ant-btn-primary",
    );
  });

  it("highlights sign-up on the sign-up auth page", async () => {
    await renderTopNav(<PublicTopNav active="auth-sign-up" />);

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveClass(
      "ant-btn-primary",
    );
    expect(screen.getByRole("link", { name: "Sign in" })).not.toHaveClass(
      "ant-btn-primary",
    );
  });

  it("renders logo and public page navigation with Support at the end", async () => {
    await render(
      <PublicConfigProvider
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: "Launchpad home" })
        .querySelectorAll("img").length,
    ).toBe(1);
    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Features",
      "Guides",
      "Docs",
      "Products",
      "Pricing",
      "News",
      "About",
      "Policies",
      "Support",
    ]);
  });

  it("uses the full CoCalc lockup on regular screens for default branding", async () => {
    await render(
      <PublicConfigProvider config={{}}>
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(
      screen.getByRole("link", { name: "CoCalc home" }).querySelectorAll("img")
        .length,
    ).toBe(2);
  });

  it("uses the full CoCalc lockup when the square logo setting is empty", async () => {
    await render(
      <PublicConfigProvider config={{ logo_square: "", site_name: "CoCalc" }}>
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(
      screen.getByRole("link", { name: "CoCalc home" }).querySelectorAll("img")
        .length,
    ).toBe(2);
  });

  it("does not append the CoCalc wordmark to a custom square logo", async () => {
    await render(
      <PublicConfigProvider
        config={{ logo_square: "/custom-logo.svg", site_name: "CoCalc" }}
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    const homeLink = screen.getByRole("link", { name: "CoCalc home" });
    const images = homeLink.querySelectorAll("img");
    expect(images.length).toBe(1);
    expect(images[0].getAttribute("src")).toBe("/custom-logo.svg");
  });

  it("selects the active public page in the menu", async () => {
    await render(
      <PublicConfigProvider
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
      >
        <PublicTopNav active="policies" />
      </PublicConfigProvider>,
    );

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getByRole("menuitem", { name: "Policies" })
        .closest("li"),
    ).toHaveClass("ant-menu-item-selected");
    expect(
      within(publicPages)
        .getByRole("menuitem", { name: "Features" })
        .closest("li"),
    ).not.toHaveClass("ant-menu-item-selected");
  });

  it("selects Support in the menu when that section is active", async () => {
    await renderTopNav(<PublicTopNav active="support" />);

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getByRole("menuitem", { name: "Support" })
        .closest("li"),
    ).toHaveClass("ant-menu-item-selected");
  });

  it("selects Guides in the menu when that section is active", async () => {
    await renderTopNav(<PublicTopNav active="guides" />);

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getByRole("menuitem", { name: "Guides" })
        .closest("li"),
    ).toHaveClass("ant-menu-item-selected");
  });

  it("marks the logo link current on Home without selecting a menu item", async () => {
    await renderTopNav(<PublicTopNav active="home" />);

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(publicPages.querySelector(".ant-menu-item-selected")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Launchpad home" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("uses a compact mobile layout with a slide-down menu on small screens", async () => {
    setViewportWidth(480);
    await render(
      <PublicConfigProvider
        config={{ policy_pages: "sagemathinc", site_name: "Launchpad" }}
      >
        <PublicTopNav active="support" />
      </PublicConfigProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: "Launchpad home" })
        .querySelectorAll("img").length,
    ).toBe(1);
    expect(screen.queryByRole("menu", { name: "Public pages" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open navigation menu",
      }),
    );

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Features",
      "Guides",
      "Docs",
      "Products",
      "Pricing",
      "News",
      "About",
      "Policies",
      "Support",
    ]);
    expect(
      within(publicPages)
        .getByRole("menuitem", { name: "Support" })
        .closest("li"),
    ).toHaveClass("ant-menu-item-selected");
  });

  it("switches to the compact menu at 875px", async () => {
    setViewportWidth(875);
    await renderTopNav(<PublicTopNav />);

    expect(screen.queryByRole("menu", { name: "Public pages" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open navigation menu" }),
    ).not.toBeNull();
  });

  it("uses the full menu above 875px", async () => {
    setViewportWidth(876);
    await renderTopNav(<PublicTopNav />);

    expect(screen.getByRole("menu", { name: "Public pages" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open navigation menu" }),
    ).toBeNull();
  });

  it("ignores stale legacy policy visibility settings", async () => {
    await render(
      <PublicConfigProvider
        config={
          {
            policy_pages: "none",
            show_policies: true,
            site_name: "Launchpad",
          } as any
        }
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(screen.queryByRole("link", { name: "Policies" })).toBeNull();
  });

  it("keeps the compact default CoCalc logo to the mark only", async () => {
    setViewportWidth(480);
    await render(
      <PublicConfigProvider config={{}}>
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(
      screen.getByRole("link", { name: "CoCalc home" }).querySelectorAll("img")
        .length,
    ).toBe(1);
  });
});
