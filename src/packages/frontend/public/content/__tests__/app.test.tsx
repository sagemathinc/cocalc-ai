/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import type { NewsItem } from "@cocalc/util/types/news";
import PublicContentApp from "../app";
import {
  contentPath,
  getContentRouteFromPath,
  isPublicContentTarget,
} from "../routes";

describe("getContentRouteFromPath", () => {
  it("supports deeper content routes under a base path", () => {
    expect(getContentRouteFromPath("/about")).toEqual({ view: "about" });
    expect(getContentRouteFromPath(contentPath("about/events"))).toEqual({
      view: "about-events",
    });
    expect(getContentRouteFromPath(contentPath("about/team"))).toEqual({
      view: "about-team",
    });
    expect(
      getContentRouteFromPath(contentPath("about/team/william-stein")),
    ).toEqual({
      teamSlug: "william-stein",
      view: "about-team-member",
    });
    expect(getContentRouteFromPath(contentPath("policies/imprint"))).toEqual({
      view: "policies-imprint",
    });
    expect(getContentRouteFromPath(contentPath("policies/policies"))).toEqual({
      view: "policies-custom",
    });
    expect(getContentRouteFromPath(contentPath("policies/privacy"))).toEqual({
      policySlug: "privacy",
      view: "policies-detail",
    });
    expect(
      getContentRouteFromPath(contentPath("news/launchpad-update-17")),
    ).toEqual({
      newsId: 17,
      view: "news-detail",
    });
    expect(
      getContentRouteFromPath(
        contentPath("news/launchpad-update-17/1712345678"),
      ),
    ).toEqual({
      newsId: 17,
      timestamp: 1712345678,
      view: "news-history",
    });
    expect(
      getContentRouteFromPath(contentPath("software/cocalc-plus")),
    ).toEqual({ view: "software-cocalc-plus" });
  });

  it("recognizes software routes when booting from a static content entry", () => {
    expect(isPublicContentTarget("/software/cocalc-plus")).toBe(true);
    expect(isPublicContentTarget("/base/software/cocalc-plus")).toBe(true);
    expect(isPublicContentTarget("/features/jupyter-notebook")).toBe(false);
  });
});

describe("PublicContentApp", () => {
  it("renders the about index", () => {
    render(
      <PublicContentApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ view: "about" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "About Launchpad" }),
    ).not.toBeNull();
    expect(
      screen.getByText("See conference appearances and other public events."),
    ).not.toBeNull();
  });

  it("shows app links in the shared nav when authenticated", () => {
    render(
      <PublicContentApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={{ view: "about" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
  });

  it("renders configured policy cards", () => {
    render(
      <PublicContentApp
        config={{ imprint: "enabled", policies: "enabled", site_name: "Hub" }}
        initialRoute={{ view: "policies" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Hub policies" }),
    ).not.toBeNull();
    expect(screen.getByText("Imprint")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Policies", level: 3 }),
    ).not.toBeNull();
  });

  it("renders the team page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "about-team" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad team" }),
    ).not.toBeNull();
    expect(screen.getByText("William Stein")).not.toBeNull();
    expect(screen.getByText("Harald Schilly")).not.toBeNull();
  });

  it("renders an individual team profile", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ teamSlug: "william-stein", view: "about-team-member" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "William Stein" }),
    ).not.toBeNull();
    expect(screen.getByText("Experience")).not.toBeNull();
    expect(screen.getByText("Personal website")).not.toBeNull();
  });

  it("renders a structured policy page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ policySlug: "privacy", view: "policies-detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Privacy policy" }),
    ).not.toBeNull();
    expect(screen.getByText("How information is used")).not.toBeNull();
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
        initialRoute={{ view: "news" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad news" }),
    ).not.toBeNull();
    expect(screen.getByText("Launchpad update")).not.toBeNull();
    expect(screen.getByText("#launchpad")).not.toBeNull();
  });

  it("renders the cocalc plus page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "software-cocalc-plus" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "CoCalc Plus" })).not.toBeNull();
    expect(screen.getByText("Install CoCalc Plus")).not.toBeNull();
    expect(
      screen.getByText(
        "The local single-user CoCalc experience for your own machine.",
      ),
    ).not.toBeNull();
  });
});
