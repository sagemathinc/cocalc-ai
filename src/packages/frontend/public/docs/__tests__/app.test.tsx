/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import {
  docsPath,
  getDocsEntry,
  listDocsEntries,
  searchDocsEntries,
} from "@cocalc/docs";
import PublicDocsApp from "../app";
import { getDocsRouteFromPath } from "../routes";

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
    expect(getDocsRouteFromPath("/docs/print")).toEqual({
      view: "docs-print",
    });
    expect(docsPath("projects/project-secrets")).toBe(
      "/docs/projects/project-secrets",
    );
  });

  it("searches structured docs entries", () => {
    const secrets = getDocsEntry("projects.project-secrets");
    expect(secrets?.title).toBe("Project secrets");
    expect(secrets?.image?.src).toBe(
      "/public/docs/project-secrets-ea9872ae.webp",
    );
    expect(secrets?.image?.presentation).toBe("icon");
    expect(
      searchDocsEntries("secrets api token").map((entry) => entry.id)[0],
    ).toBe("projects.project-secrets");
    expect(
      searchDocsEntries("custom jupyter kernel uv venv").map(
        (entry) => entry.id,
      )[0],
    ).toBe("jupyter.custom-kernels");
    expect(
      searchDocsEntries("use jupyter notebooks collaborative durable").map(
        (entry) => entry.id,
      )[0],
    ).toBe("jupyter.use-jupyter");
    expect(
      searchDocsEntries("terminal persistent linux shell").map(
        (entry) => entry.id,
      )[0],
    ).toBe("terminal.use-terminal");
    const terminal = getDocsEntry("terminal.use-terminal");
    expect(terminal?.image?.src).toBe("/public/docs/terminal-56905fa2.webp");
    expect(terminal?.image?.presentation).toBe("icon");
    expect(
      searchDocsEntries("browser notebook cli automation").map(
        (entry) => entry.id,
      )[0],
    ).toBe("cli.use-cocalc-cli");
    expect(
      searchDocsEntries("api key cli automation").map((entry) => entry.id)[0],
    ).toBe("api.http-api");
    expect(
      searchDocsEntries("http api basic authentication").map(
        (entry) => entry.id,
      )[0],
    ).toBe("api.http-api");
    expect(
      searchDocsEntries("low memory oom kernel restart").map(
        (entry) => entry.id,
      )[0],
    ).toBe("troubleshooting.memory");
    const runtime = getDocsEntry("projects.runtime-image");
    expect(runtime?.image?.src).toBe(
      "/public/docs/runtime-image-09add8c9.webp",
    );
    expect(runtime?.image?.presentation).toBe("icon");
    const timetravel = getDocsEntry("files.timetravel");
    expect(timetravel?.image?.src).toBe(
      "/public/docs/timetravel-0f06290b.webp",
    );
    expect(timetravel?.image?.presentation).toBe("icon");
    expect(
      searchDocsEntries("websocket sign in browser connectivity").map(
        (entry) => entry.id,
      )[0],
    ).toBe("troubleshooting.connectivity");
    expect(getDocsEntry("admin.users")).toBeUndefined();
    expect(
      searchDocsEntries("impersonation password reset 2FA").map(
        (entry) => entry.id,
      ),
    ).not.toContain("admin.users");
    expect(getDocsEntry("admin.users", { includeAdmin: true })?.title).toBe(
      "Manage users as an admin",
    );
    expect(
      searchDocsEntries("impersonation password reset 2FA", 8, {
        includeAdmin: true,
      }).map((entry) => entry.id)[0],
    ).toBe("admin.users");
  });

  it("has hashed icon art for every docs entry", () => {
    for (const entry of listDocsEntries()) {
      expect(entry.image?.presentation).toBe("icon");
      expect(entry.image?.src).toMatch(
        /^\/public\/docs\/[-a-z0-9]+-[a-f0-9]{8}\.webp$/,
      );
      expect(entry.image?.thumbnailSrc).toBe(entry.image?.src);
      expect(entry.image?.alt).toBeTruthy();
    }
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
      screen.getByRole("heading", { name: "All documentation pages" }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        `${listDocsEntries().length} pages in ${
          new Set(listDocsEntries().map((entry) => entry.category)).size
        } categories`,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(/Create projects, choose runtime settings/),
    ).not.toBeNull();
    expect(
      screen.getAllByRole("link", { name: /Start chapter/ })[0],
    ).toHaveAttribute("href", "/docs/projects/create-project");
    expect(
      screen.getAllByRole("link", { name: /Project secrets/ })[0],
    ).toHaveAttribute("href", "/docs/projects/project-secrets");
    expect(
      screen.getAllByRole("link", { name: /Use chat/ })[0],
    ).toHaveAttribute("href", "/docs/collaboration/chat");
    expect(
      screen.getByRole("link", { name: /Print-friendly/ }),
    ).toHaveAttribute("href", "/docs/print");
    expect(
      screen.queryByRole("link", { name: /Continue learning/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Manage users as an admin/ }),
    ).toBeNull();
  });

  it("renders public docs as a print-friendly single page", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "docs-print" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Complete documentation" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: /Back to docs/ })).toHaveAttribute(
      "href",
      "/docs",
    );
    expect(screen.getByText("Print")).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Manage users as an admin" }),
    ).toBeNull();
  });

  it("does not render admin docs through public direct routes", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: "admin/users",
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByText("That documentation page does not exist yet."),
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Manage users as an admin" }),
    ).toBeNull();
  });

  it("does not render docs font size controls on public docs pages", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "docs-index" }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Increase docs font size" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset docs font size" }),
    ).toBeNull();
    expect(window.localStorage.getItem("cocalc-docs-font-size")).toBeNull();
  });

  it("renders public docs detail without the docs font-size wrapper", () => {
    window.localStorage.setItem("cocalc-docs-font-size", "30");

    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: "projects/project-secrets",
          view: "docs-detail",
        }}
      />,
    );

    expect(screen.queryByTestId("docs-font-scope")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset docs font size" }),
    ).toBeNull();

    const markdownCardBody = screen
      .getByTestId("docs-markdown")
      .closest(".ant-card-body");
    const markdownCard = screen
      .getByTestId("docs-markdown")
      .closest(".ant-card");

    expect(markdownCard).not.toBeNull();
    expect(markdownCardBody).not.toBeNull();
    expect(markdownCard!).toHaveStyle({ fontSize: "inherit" });
    expect(markdownCardBody!).toHaveStyle({ fontSize: "inherit" });
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
    ).toHaveAttribute("src", "/public/docs/project-secrets-ea9872ae.webp");
    expect(screen.getByText("settings.environment.secrets")).not.toBeNull();
    expect(
      within(screen.getByText("Open this in CoCalc").closest(".ant-card")!)
        .getByRole("button", { name: "Open project secrets" })
        .getAttribute("data-cocalc-action-id"),
    ).toBe("settings.environment.secrets");
  });
});
