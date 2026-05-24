/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import { docsPath, getDocsEntry, searchDocsEntries } from "@cocalc/docs";
import PublicDocsApp from "../app";
import { getDocsRouteFromPath } from "../routes";

describe("public/docs", () => {
  it("parses docs routes", () => {
    expect(getDocsRouteFromPath("/docs")).toEqual({ view: "docs-index" });
    expect(getDocsRouteFromPath("/docs/projects/project-secrets")).toEqual({
      slug: "projects/project-secrets",
      view: "docs-detail",
    });
    expect(docsPath("projects/project-secrets")).toBe(
      "/docs/projects/project-secrets",
    );
  });

  it("searches structured docs entries", () => {
    expect(getDocsEntry("projects.project-secrets")?.title).toBe(
      "Project secrets",
    );
    expect(
      searchDocsEntries("secrets api token").map((entry) => entry.id),
    ).toEqual(["projects.project-secrets"]);
  });

  it("renders the docs index", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "docs-index" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Current docs for this CoCalc instance.",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: /Project secrets/ }),
    ).toHaveAttribute("href", "/docs/projects/project-secrets");
  });

  it("renders a docs detail page with action metadata", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: "projects/project-secrets",
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Project secrets" }),
    ).not.toBeNull();
    expect(screen.getByText("settings.environment.secrets")).not.toBeNull();
    expect(
      within(screen.getByText("Deep actions").closest(".ant-card")!)
        .getByRole("button", { name: "Open project secrets" })
        .getAttribute("data-cocalc-action-id"),
    ).toBe("settings.environment.secrets");
  });
});
