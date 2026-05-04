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

  it("uses Projects as the authenticated app entry and omits Settings", async () => {
    await render(
      <PublicConfigProvider
        config={{ is_authenticated: true, site_name: "Launchpad" }}
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("link", { name: "Launchpad home" })).not.toBeNull();
  });

  it("uses sign-in and sign-up links for anonymous visitors", async () => {
    await renderTopNav(<PublicTopNav />);

    expect(screen.getByRole("link", { name: "Sign in" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign up" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
  });

  it("renders logo and public page navigation with Support at the end", async () => {
    await render(
      <PublicConfigProvider
        config={{ show_policies: true, site_name: "Launchpad" }}
      >
        <PublicTopNav />
      </PublicConfigProvider>,
    );

    expect(screen.getByRole("link", { name: "Launchpad home" })).not.toBeNull();
    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Features",
      "Products",
      "Pricing",
      "News",
      "About",
      "Policies",
      "Support",
    ]);
  });

  it("selects the active public page in the menu", async () => {
    await render(
      <PublicConfigProvider
        config={{ show_policies: true, site_name: "Launchpad" }}
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
        config={{ show_policies: true, site_name: "Launchpad" }}
      >
        <PublicTopNav active="support" />
      </PublicConfigProvider>,
    );

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
});
