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
    expect(screen.getByText("Choose an operating model")).not.toBeNull();
    expect(screen.getByText("Pricing and licensing")).not.toBeNull();
    expect(screen.getByText("Talk with CoCalc")).not.toBeNull();
    expect(screen.getByText("Ticket status")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Compare operating models" }),
    ).toHaveAttribute("href", "/products");
    expect(
      screen.getByRole("link", { name: "Review pricing" }),
    ).toHaveAttribute("href", "/pricing");
    expect(
      screen.getByRole("button", { name: "Start support request" }),
    ).not.toBeNull();
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
        config={{ help_email: "", site_name: "Launchpad", zendesk: false }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(screen.queryByRole("button", { name: "New ticket" })).toBeNull();
    expect(screen.queryByRole("button", { name: "My tickets" })).toBeNull();
    expect(screen.getByText("Talk with CoCalc")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Email CoCalc" })).toHaveAttribute(
      "href",
      "mailto:help@cocalc.com",
    );
  });

  it("does not describe the direct contact fallback as ticket creation", async () => {
    render(
      <PublicSupportApp
        config={{ site_name: "CoCalc", zendesk: false }}
        initialRoute={{ view: "new" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Contact CoCalc Support" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Create a CoCalc Support Ticket" }),
    ).toBeNull();
    expect(
      await screen.findByText(
        "This site is not accepting support tickets directly here. Use the support page or email CoCalc, and include the context below if it applies to your request.",
      ),
    ).not.toBeNull();
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
