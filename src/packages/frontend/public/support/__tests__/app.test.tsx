/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import PublicSupportApp, { getSupportViewFromPath } from "../app";

describe("getSupportViewFromPath", () => {
  it("supports support routes under a base path", () => {
    expect(getSupportViewFromPath("/support")).toBe("index");
    expect(getSupportViewFromPath("/base/support/new")).toBe("new");
    expect(getSupportViewFromPath("/base/support/tickets")).toBe("tickets");
  });
});

describe("PublicSupportApp", () => {
  it("renders the support index with ticket actions when zendesk is enabled", () => {
    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: true }}
        initialView="index"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad support" }),
    ).not.toBeNull();
    expect(screen.getByText("New support ticket")).not.toBeNull();
    expect(screen.getByText("Ticket status")).not.toBeNull();
  });

  it("does not advertise ticket actions when zendesk is disabled", () => {
    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: false }}
        initialView="index"
      />,
    );

    expect(screen.queryByRole("button", { name: "New ticket" })).toBeNull();
    expect(screen.queryByRole("button", { name: "My tickets" })).toBeNull();
  });
});
