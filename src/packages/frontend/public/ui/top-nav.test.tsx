/** @jest-environment jsdom */

import type { ReactElement } from "react";

import { act, render, screen, within } from "@testing-library/react";

import PublicTopNav from "./top-nav";

describe("PublicTopNav", () => {
  async function renderTopNav(node: ReactElement) {
    const result = render(node);
    await act(async () => {
      await Promise.resolve();
    });
    return result;
  }

  it("uses Projects as the authenticated app entry and omits Settings", async () => {
    await renderTopNav(<PublicTopNav isAuthenticated siteName="Launchpad" />);

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Launchpad" })).toBeNull();
  });

  it("uses sign-in and sign-up links for anonymous visitors", async () => {
    await renderTopNav(<PublicTopNav siteName="Launchpad" />);

    expect(screen.getByRole("link", { name: "Sign in" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Sign up" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
  });

  it("renders center public page navigation without Support", async () => {
    await renderTopNav(<PublicTopNav showPolicies siteName="Launchpad" />);

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(
      within(publicPages)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Home", "Features", "Pricing", "News", "About", "Policies"]);
    expect(screen.getByRole("link", { name: "Support" })).not.toBeNull();
  });

  it("selects the active center public page", async () => {
    await renderTopNav(
      <PublicTopNav active="policies" showPolicies siteName="Launchpad" />,
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
      within(publicPages).getByRole("menuitem", { name: "Home" }).closest("li"),
    ).not.toHaveClass("ant-menu-item-selected");
  });

  it("marks Support active without selecting a center public page", async () => {
    await renderTopNav(<PublicTopNav active="support" siteName="Launchpad" />);

    const publicPages = screen.getByRole("menu", {
      name: "Public pages",
    });
    expect(publicPages.querySelector(".ant-menu-item-selected")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Support" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});
