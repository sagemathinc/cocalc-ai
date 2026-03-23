/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import type { NewsItem } from "@cocalc/util/types/news";
import PublicContentApp, { getContentViewFromPath } from "../app";

describe("getContentViewFromPath", () => {
  it("supports content routes under a base path", () => {
    expect(getContentViewFromPath("/about")).toBe("about");
    expect(getContentViewFromPath("/base/policies")).toBe("policies");
    expect(getContentViewFromPath("/base/news")).toBe("news");
  });
});

describe("PublicContentApp", () => {
  it("renders the about index", () => {
    render(
      <PublicContentApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialView="about"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "About Launchpad" }),
    ).not.toBeNull();
    expect(screen.getByText("See upcoming events")).not.toBeNull();
  });

  it("renders configured policy cards", () => {
    render(
      <PublicContentApp
        config={{ imprint: "enabled", policies: "enabled", site_name: "Hub" }}
        initialView="policies"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Hub policies" }),
    ).not.toBeNull();
    expect(screen.getByText("Imprint")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Policies", level: 2 }),
    ).not.toBeNull();
  });

  it("renders the public news list from initial data", () => {
    const initialNews: NewsItem[] = [
      {
        channel: "feature",
        date: 1710000000,
        id: "1",
        tags: ["launchpad"],
        text: "A long markdown body about **Launchpad**.",
        title: "Launchpad update",
      },
    ];
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialNews={initialNews}
        initialView="news"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad news" }),
    ).not.toBeNull();
    expect(screen.getByText("Launchpad update")).not.toBeNull();
    expect(screen.getByText("#launchpad")).not.toBeNull();
  });
});
