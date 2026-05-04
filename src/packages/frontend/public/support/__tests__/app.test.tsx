/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import PublicSupportApp, { getSupportViewFromPath } from "../app";

describe("getSupportViewFromPath", () => {
  it("supports support routes under a base path", () => {
    expect(getSupportViewFromPath("/support")).toBe("index");
    expect(getSupportViewFromPath("/base/support/community")).toBe("community");
    expect(getSupportViewFromPath("/base/support/new")).toBe("new");
    expect(getSupportViewFromPath("/base/support/status")).toBe("status");
    expect(getSupportViewFromPath("/base/support/tickets")).toBe("tickets");
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
    expect(screen.getByText("New support ticket")).not.toBeNull();
    expect(screen.getByText("Ticket status")).not.toBeNull();
    expect(screen.getByText("System status")).not.toBeNull();
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
    expect(await screen.findByText("GitHub discussions")).not.toBeNull();
  });

  it("renders the public status view", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        accounts: 12,
        accounts_active: { "1d": 5, "5min": 2 },
        hub_servers: [{ clients: 3 }],
        projects: 7,
        projects_edited: { "1d": 4, "5min": 1 },
        running_projects: { free: 2, member: 1 },
        time: "2026-05-01T12:00:00Z",
      }),
    }) as typeof fetch;

    render(
      <PublicSupportApp
        config={{ site_name: "Launchpad", zendesk: true }}
        initialRoute={{ view: "status" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Status" }),
    ).not.toBeNull();
    expect(await screen.findByText("Live activity snapshot")).not.toBeNull();
  });
});
