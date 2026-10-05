/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PublicPage } from "./shell";

const cocalcAi = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  site_name: "CoCalc",
};

function footerNavLinks(name: string): (string | null)[][] {
  return within(screen.getByRole("navigation", { name }))
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
}

// The same sites and page links as the crawler footer test in
// hub/servers/app/public-shell.test.ts, so the two footers agree.
describe("PublicPage footer page links", () => {
  it.each([
    ["cocalc.ai", cocalcAi],
    [
      "a self-hosted Launchpad",
      {
        cocalc_product: "launchpad",
        dns: "launchpad.example.edu",
        is_launchpad: true,
        site_name: "CoCalc Launchpad",
      },
    ],
    [
      "a customer-operated deployment",
      {
        cocalc_product: "rocket",
        dns: "cocalc.example.com",
        site_name: "CoCalc",
      },
    ],
    [
      "CoCalc Plus",
      { cocalc_product: "plus", dns: "localhost:5000", site_name: "CoCalc" },
    ],
  ])("links the footer's pages on %s", (_site, config) => {
    render(<PublicPage config={config}>Body</PublicPage>);

    expect(footerNavLinks("Platform footer links")).toEqual([
      ["Features", "/features"],
      ["Products", "/products"],
      ["Pricing", "/pricing"],
    ]);
    expect(footerNavLinks("Resources footer links")).toEqual([
      ["Documentation", "/docs"],
      ["Guides", "/guides"],
      ["Support", "/support"],
    ]);
    // Contact, and Policies or Cookies where configured, follow.
    expect(footerNavLinks("Company footer links").slice(0, 3)).toEqual([
      ["About", "/about"],
      ["News", "/news"],
      ["Contact", "/support"],
    ]);
  });

  it("reaches News from the keyboard and follows it with Enter", async () => {
    const user = userEvent.setup();
    render(<PublicPage config={cocalcAi}>Body</PublicPage>);
    const company = screen.getByRole("navigation", {
      name: "Company footer links",
    });
    const news = within(company).getByRole("link", { name: "News" });
    const follow = jest.fn((event: Event) => event.preventDefault());
    news.addEventListener("click", follow);

    within(company).getByRole("link", { name: "About" }).focus();
    await user.tab();
    expect(news).toHaveFocus();

    // Space is a button key; a link does not follow it.
    await user.keyboard(" ");
    expect(follow).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(follow).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(
      within(company).getByRole("link", { name: "Contact" }),
    ).toHaveFocus();
  });
});
