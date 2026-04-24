/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react";

import type { NewsItem } from "@cocalc/util/types/news";
import PublicContentApp from "../app";
import {
  contentPath,
  getContentRouteFromPath,
  isPublicContentTarget,
} from "../routes";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn(
    () => new Promise<Response>(() => undefined),
  ) as typeof fetch;
});

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  global.fetch = originalFetch;
});

describe("getContentRouteFromPath", () => {
  it("supports deeper content routes under a base path", () => {
    expect(getContentRouteFromPath("/about")).toEqual({ view: "about" });
    expect(getContentRouteFromPath(contentPath("about/events"))).toEqual({
      view: "about-events",
    });
    expect(getContentRouteFromPath(contentPath("about/status"))).toEqual({
      view: "about-status",
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
    expect(getContentRouteFromPath(contentPath("pricing"))).toEqual({
      view: "pricing",
    });
    expect(getContentRouteFromPath(contentPath("pricing/courses"))).toEqual({
      view: "pricing",
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
    expect(getContentRouteFromPath(contentPath("software"))).toEqual({
      view: "software",
    });
    expect(
      getContentRouteFromPath(contentPath("software/cocalc-launchpad")),
    ).toEqual({ view: "software-cocalc-launchpad" });
    expect(
      getContentRouteFromPath(contentPath("software/cocalc-plus")),
    ).toEqual({ view: "software-cocalc-plus" });
  });

  it("recognizes software routes when booting from a static content entry", () => {
    expect(isPublicContentTarget("/software/cocalc-plus")).toBe(true);
    expect(isPublicContentTarget("/base/software/cocalc-plus")).toBe(true);
    expect(isPublicContentTarget("/pricing")).toBe(true);
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

  it("shows Projects but not Settings in the shared nav when authenticated", () => {
    render(
      <PublicContentApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={{ view: "about" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("renders the pricing page from live membership tier data", () => {
    render(
      <PublicContentApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialMembershipTiers={[
          {
            id: "member",
            label: "Member",
            llm_limits: { units_5h: 150, units_7d: 500 },
            price_monthly: 25,
            price_yearly: 225,
            priority: 20,
            project_defaults: {
              disk_quota: 10000,
              memory: 8000,
              mintime: 3600,
            },
            store_visible: true,
          },
        ]}
        initialRoute={{ view: "pricing" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Pricing" }),
    ).not.toBeNull();
    expect(screen.getByText("Membership-first pricing")).not.toBeNull();
    expect(screen.getByText("Member")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "Open Store" }).length).toBe(2);
    expect(
      screen.getByText(/the one planned pay-as-you-go exception/i),
    ).not.toBeNull();
  });

  it("hides the shared Policies nav item when public policies are disabled", () => {
    render(
      <PublicContentApp
        config={{ show_policies: false, site_name: "Launchpad" }}
        initialRoute={{ view: "about" }}
      />,
    );

    expect(screen.queryByRole("link", { name: "Policies" })).toBeNull();
  });

  it("renders configured policy cards", () => {
    render(
      <PublicContentApp
        config={{
          imprint: "enabled",
          policies: "enabled",
          show_policies: true,
          site_name: "Hub",
        }}
        initialRoute={{ view: "policies" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Hub Policies" }),
    ).not.toBeNull();
    expect(screen.getByText("Imprint")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Policies", level: 3 }),
    ).not.toBeNull();
  });

  it("shows built-in policy pages even without custom policy settings", () => {
    render(
      <PublicContentApp
        config={{ show_policies: true, site_name: "Launchpad" }}
        initialRoute={{ view: "policies" }}
      />,
    );

    expect(screen.getByText("Terms of service")).not.toBeNull();
    expect(screen.getByText("Privacy")).not.toBeNull();
    expect(screen.getByText("Trust")).not.toBeNull();
  });

  it("renders the team page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "about-team" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Team" }),
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
    expect(
      screen.getByText("Chief Executive Officer and Founder of SageMath, Inc."),
    ).not.toBeNull();
    expect(screen.getByText("Experience")).not.toBeNull();
    expect(screen.getByText("Personal website")).not.toBeNull();
  });

  it("renders the exact privacy policy page", async () => {
    render(
      <PublicContentApp
        config={{ show_policies: true, site_name: "Launchpad" }}
        initialRoute={{ policySlug: "privacy", view: "policies-detail" }}
      />,
    );

    expect(await screen.findByText("CoCalc - Privacy Policy")).not.toBeNull();
    expect(
      screen.getByText(/Protecting your privacy is really important to us/i),
    ).not.toBeNull();
  });

  it("renders the exact third-party policy page", async () => {
    render(
      <PublicContentApp
        config={{ show_policies: true, site_name: "Launchpad" }}
        initialRoute={{ policySlug: "thirdparties", view: "policies-detail" }}
      />,
    );

    expect(
      await screen.findByText("CoCalc - Third Parties Statements"),
    ).not.toBeNull();
    expect(screen.getByText("Cloudflare")).not.toBeNull();
    expect(screen.getByText("Salesloft")).not.toBeNull();
  });

  it("renders the exact terms page", async () => {
    render(
      <PublicContentApp
        config={{ show_policies: true, site_name: "Launchpad" }}
        initialRoute={{ policySlug: "terms", view: "policies-detail" }}
      />,
    );

    expect(await screen.findByText("CoCalc - Terms of Service")).not.toBeNull();
    expect(
      screen.getByText(/Once you POST TO THE GENERAL PUBLIC/i),
    ).not.toBeNull();
  });

  it("hides policy pages when public policies are disabled", () => {
    render(
      <PublicContentApp
        config={{ show_policies: false, site_name: "Launchpad" }}
        initialRoute={{ view: "policies" }}
      />,
    );

    expect(screen.getByText("Public policy pages are disabled")).not.toBeNull();
    expect(screen.queryByText("Terms of service")).toBeNull();
  });

  it("shows an external policy link instead of built-in policy pages", () => {
    render(
      <PublicContentApp
        config={{
          show_policies: true,
          site_name: "Launchpad",
          terms_of_service_url: "https://example.com/policies",
        }}
        initialRoute={{ view: "policies" }}
      />,
    );

    expect(screen.getByText("Public policy information")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open policy page" }),
    ).not.toBeNull();
    expect(screen.queryByText("Terms of service")).toBeNull();
  });

  it("uses the external policy link for direct policy routes as well", () => {
    render(
      <PublicContentApp
        config={{
          show_policies: true,
          site_name: "Launchpad",
          terms_of_service_url: "https://example.com/policies",
        }}
        initialRoute={{ policySlug: "privacy", view: "policies-detail" }}
      />,
    );

    expect(screen.getByText("Public policy information")).not.toBeNull();
    expect(screen.queryByText("CoCalc - Privacy Policy")).toBeNull();
  });

  it("renders the public news list from initial data", async () => {
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
      await screen.findByRole("heading", { name: "Launchpad News" }),
    ).not.toBeNull();
    expect(await screen.findByText("Launchpad update")).not.toBeNull();
    expect(screen.getByText("#launchpad")).not.toBeNull();
  });

  it("renders rich markdown in public news cards", async () => {
    const initialNews: NewsItem[] = [
      {
        channel: "feature",
        date: 1710000000,
        id: "1",
        text: [
          "This is a test.",
          "",
          "- foo",
          "- bar",
          "",
          "![Image](/blobs/example.png?uuid=test-uuid)",
        ].join("\n"),
        title: "Markdown update",
      },
    ];
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => initialNews,
    }) as typeof fetch;

    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialNews={initialNews}
        initialRoute={{ view: "news" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Image" })).not.toBeNull(),
    );
    expect(screen.getByText("foo")).not.toBeNull();
    expect(screen.getByText("bar")).not.toBeNull();
  });

  it("shows admin news actions on the public news page for admins", async () => {
    const initialNews: NewsItem[] = [
      {
        channel: "feature",
        date: 1710000000,
        id: "1",
        text: "Body",
        title: "Launchpad update",
      },
    ];
    render(
      <PublicContentApp
        config={{ is_admin: true, site_name: "Launchpad" }}
        initialNews={initialNews}
        initialRoute={{ view: "news" }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Manage news" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: "Create post" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Create event" })).not.toBeNull();
  });

  it("refreshes the public news list even when bootstrap data is stale", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "feature",
          date: 1710001000,
          id: "2",
          tags: ["fresh"],
          text: "Fresh body",
          title: "Fresh update",
        },
      ],
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;

    try {
      render(
        <PublicContentApp
          config={{ site_name: "Launchpad" }}
          initialNews={[
            {
              channel: "feature",
              date: 1710000000,
              id: "1",
              text: "Stale body",
              title: "Stale update",
            },
          ]}
          initialRoute={{ view: "news" }}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText("Fresh update")).not.toBeNull(),
      );
      expect(screen.queryByText("Stale update")).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
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

  it("renders the software overview page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "software" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Software" }),
    ).not.toBeNull();
    expect(screen.getByText("CoCalc Launchpad")).not.toBeNull();
    expect(screen.getByText("Hosted CoCalc")).not.toBeNull();
  });

  it("renders the cocalc launchpad page", () => {
    render(
      <PublicContentApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "software-cocalc-launchpad" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "CoCalc Launchpad" }),
    ).not.toBeNull();
    expect(screen.getByText("Install CoCalc Launchpad")).not.toBeNull();
    expect(screen.getByText("What the installer does")).not.toBeNull();
  });
});
