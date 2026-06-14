/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import PublicSupportApp from "../app";
import { getSupportViewFromPath } from "../routes";

describe("getSupportViewFromPath", () => {
  it("supports support routes under a base path", () => {
    expect(getSupportViewFromPath("/support")).toBe("index");
    expect(getSupportViewFromPath("/base/support/community")).toBe("community");
    expect(getSupportViewFromPath("/base/support/new")).toBe("new");
    expect(getSupportViewFromPath("/base/support/tickets")).toBe("tickets");
    expect(getSupportViewFromPath("/base/support/status")).toBeUndefined();
  });
});

describe("PublicSupportApp", () => {
  it("renders the support index with ticket actions when zendesk is enabled", () => {
    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: true }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Support" }),
    ).not.toBeNull();
    expect(screen.getByText("Choose a product path")).not.toBeNull();
    expect(screen.getByText("Pricing and licensing")).not.toBeNull();
    expect(screen.getByText("Contact CoCalc")).not.toBeNull();
    expect(screen.getByText("Ticket status")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare product paths" }),
    ).toHaveAttribute("href", "/products");
    expect(screen.getByRole("link", { name: "Open pricing" })).toHaveAttribute(
      "href",
      "/pricing",
    );
    expect(screen.queryByText("System status")).toBeNull();
  });

  it("uses CoCalc marketing branding for default Launchpad public support", () => {
    render(
      <PublicSupportApp
        config={{
          cocalc_product: "launchpad",
          is_launchpad: true,
          site_name: "CoCalc Launchpad",
          zendesk: false,
        }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "CoCalc Support" }),
    ).not.toBeNull();
    expect(screen.queryByText("CoCalc Launchpad Support")).toBeNull();
    expect(
      within(screen.getByRole("banner")).getByRole("link", {
        name: "CoCalc home",
      }),
    ).not.toBeNull();
  });

  it("does not advertise ticket actions when zendesk is disabled", () => {
    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: false }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "New ticket" })).toBeNull();
    expect(screen.queryByRole("button", { name: "My tickets" })).toBeNull();
  });

  it("renders the community view", async () => {
    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: true }}
        initialRoute={{ view: "community" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Community Support" }),
    ).not.toBeNull();
    expect(await screen.findByText("GitHub source code")).not.toBeNull();
    expect(screen.queryByText("Discord")).toBeNull();
    expect(screen.queryByText("GitHub discussions")).toBeNull();
    expect(screen.queryByText("Google Groups mailing list")).toBeNull();
  });
});
