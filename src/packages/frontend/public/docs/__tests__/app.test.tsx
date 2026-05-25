/** @jest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";

import { docsPath, getDocsEntry, searchDocsEntries } from "@cocalc/docs";
import PublicDocsApp from "../app";
import { getDocsRouteFromPath } from "../routes";

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));

describe("public/docs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

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
    const secrets = getDocsEntry("projects.project-secrets");
    expect(secrets?.title).toBe("Project secrets");
    expect(secrets?.image?.src).toBe("/public/docs/project-secrets.svg");
    expect(
      searchDocsEntries("secrets api token").map((entry) => entry.id)[0],
    ).toBe("projects.project-secrets");
    expect(
      searchDocsEntries("custom jupyter kernel uv venv").map(
        (entry) => entry.id,
      )[0],
    ).toBe("jupyter.custom-kernels");
    expect(
      searchDocsEntries("api key cli automation").map((entry) => entry.id)[0],
    ).toBe("cli.use-cocalc-cli");
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

  it("persists docs font size controls", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "docs-index" }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Increase docs font size" }),
    );

    expect(
      screen.getByRole("button", { name: "Reset docs font size" }),
    ).toHaveTextContent("15px");
    expect(window.localStorage.getItem("cocalc-docs-font-size")).toBe("15");

    fireEvent.click(
      screen.getByRole("button", { name: "Reset docs font size" }),
    );

    expect(window.localStorage.getItem("cocalc-docs-font-size")).toBeNull();
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
    expect(
      screen.getByAltText(
        "Project secrets mounted as protected read-only files",
      ),
    ).toHaveAttribute("src", "/public/docs/project-secrets.svg");
    expect(screen.getByText("settings.environment.secrets")).not.toBeNull();
    expect(
      within(screen.getByText("Open this in CoCalc").closest(".ant-card")!)
        .getByRole("button", { name: "Open project secrets" })
        .getAttribute("data-cocalc-action-id"),
    ).toBe("settings.environment.secrets");
  });
});
