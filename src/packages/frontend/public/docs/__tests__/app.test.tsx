/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";

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
    expect(getDocsRouteFromPath("/docs/self-hosting/cocalc-star")).toEqual({
      slug: "self-hosting/cocalc-star",
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
    expect(getDocsEntry("terminal.ssh-access")?.image?.src).toBe(
      "/public/docs/ssh-access-32a43270.webp",
    );
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
      searchDocsEntries("cocalc star public vm https").map(
        (entry) => entry.id,
      )[0],
    ).toBe("self-hosting.cocalc-star");
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
    expect(getDocsEntry("projects.rstudio-project")).toBeUndefined();
    expect(
      getDocsEntry("projects.rstudio-project", {
        siteProfile: "cocalc-ai",
      })?.title,
    ).toBe("Create a project with RStudio");
    expect(getDocsEntry("jupyter.octave-kernel")).toBeUndefined();
    expect(
      searchDocsEntries("octave jupyter kernel matlab gnuplot").map(
        (entry) => entry.id,
      ),
    ).not.toContain("jupyter.octave-kernel");
    const octaveKernel = getDocsEntry("jupyter.octave-kernel", {
      siteProfile: "cocalc-ai",
    });
    expect(octaveKernel?.title).toBe("Install the Octave Jupyter kernel");
    expect(octaveKernel?.category).toBe("Jupyter");
    expect(octaveKernel?.slug).toBe("jupyter/install-octave-kernel");
    expect(octaveKernel?.body).toContain(
      "Python remains the normal default Jupyter kernel",
    );
    expect(octaveKernel?.body).toMatch(
      /does not mean Octave is preinstalled in the\s+CoCalc Legacy image/,
    );
    expect(octaveKernel?.body).toContain("not a RootFS publishing workflow");
    expect(octaveKernel?.body).not.toMatch(
      /SECURITY_DENY|rootfs-shell-missing|6f21c231|f9b09f79/i,
    );
    expect(
      searchDocsEntries("octave jupyter kernel matlab gnuplot", 8, {
        siteProfile: "cocalc-ai",
      }).map((entry) => entry.id)[0],
    ).toBe("jupyter.octave-kernel");
    expect(
      searchDocsEntries("impersonation password reset 2FA", 8, {
        includeAdmin: true,
      }).map((entry) => entry.id)[0],
    ).toBe("admin.users");
  });

  it("has hashed icon art for docs entries that define icon art", () => {
    for (const entry of listDocsEntries()) {
      if (entry.image == null) continue;
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
        name: "Current docs for this Launchpad instance.",
      }),
    ).not.toBeNull();
    expect(
      screen.queryByText("Current docs for this CoCalc instance."),
    ).toBeNull();
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
      screen.queryByText(/Create projects, choose runtime settings/),
    ).toBeNull();
    expect(screen.getAllByText("Self Hosting").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link", { name: /Install CoCalc Star/ })
        .some(
          (link) =>
            link.getAttribute("href") === "/docs/self-hosting/cocalc-star",
        ),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: /Start chapter/ })).toBeNull();
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
    expect(
      screen.queryByRole("link", { name: /Create a project with RStudio/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", {
        name: /Install the Octave Jupyter kernel/,
      }),
    ).toBeNull();
  });

  it("renders crawlable navigation on public docs detail pages", () => {
    const entry = getDocsEntry("projects/create-project");
    if (entry == null) throw new Error("missing create-project docs entry");
    const categoryEntries = listDocsEntries().filter(
      (candidate) => candidate.category === entry.category,
    );
    const currentIndex = categoryEntries.findIndex(
      (candidate) => candidate.id === entry.id,
    );
    const nextEntry = categoryEntries[currentIndex + 1];
    if (nextEntry == null) throw new Error("missing next projects docs entry");

    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: entry.slug,
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "All docs index" }),
    ).toHaveAttribute("href", "/docs");
    expect(
      screen.getAllByText(
        `Page ${currentIndex + 1} of ${categoryEntries.length} in ${entry.category}`,
      ),
    ).toHaveLength(2);
    for (const nextLink of screen.getAllByRole("link", { name: "Next" })) {
      expect(nextLink).toHaveAttribute("href", docsPath(nextEntry.slug));
    }
  });

  it("renders the cocalc.ai-only RStudio docs page when host-gated", () => {
    render(
      <PublicDocsApp
        config={{ dns: "cocalc.ai", site_name: "CoCalc" }}
        initialRoute={{
          slug: "projects/rstudio-project",
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create a project with RStudio" }),
    ).not.toBeNull();
    expect(screen.getByText("RStudio and Jupyter")).not.toBeNull();
  });

  it("renders the cocalc.ai-only Octave kernel docs page when host-gated", () => {
    expect(
      listDocsEntries({ siteProfile: "cocalc-ai" }).map((entry) => entry.id),
    ).toContain("jupyter.octave-kernel");

    render(
      <PublicDocsApp
        config={{ dns: "cocalc.ai", site_name: "CoCalc" }}
        initialRoute={{
          slug: "jupyter/install-octave-kernel",
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Install the Octave Jupyter kernel",
      }),
    ).not.toBeNull();
    expect(screen.getByText(/project-local setup/)).not.toBeNull();
    expect(
      screen.getAllByText(/--no-install-recommends/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/Octave is selectable in notebooks/),
    ).not.toBeNull();
    expect(screen.getByTestId("docs-markdown").textContent).toMatch(
      /gnuplot\s+graphics toolkit is discouraged/,
    );
    expect(screen.queryByText(/SECURITY_DENY/)).toBeNull();
  });

  it("renders CoCalc at a glance only on cocalc.ai", () => {
    const initialRoute = {
      slug: "documentation/cocalc-at-a-glance",
      view: "docs-detail",
    } as const;
    const { unmount } = render(
      <PublicDocsApp
        config={{ dns: "cocalc.ai", site_name: "CoCalc" }}
        initialRoute={initialRoute}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "CoCalc at a glance" }),
    ).not.toBeNull();
    const body = screen.getByTestId("docs-markdown");
    expect(body.textContent).toMatch(
      /Claude Code is an experimental preview on sites that enable it/,
    );
    expect(within(body).getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "href",
      "/pricing",
    );
    unmount();

    render(
      <PublicDocsApp
        config={{ dns: "example.com", site_name: "CoCalc" }}
        initialRoute={initialRoute}
      />,
    );
    expect(
      screen.getByText("That documentation page does not exist yet."),
    ).not.toBeNull();
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

  it("renders the cocalc star self-hosting docs page", () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: "self-hosting/cocalc-star",
          view: "docs-detail",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Install CoCalc Star" }),
    ).not.toBeNull();
    expect(
      screen.getByText(/complete CoCalc site in one Docker container/),
    ).not.toBeNull();
    expect(screen.getAllByText(/sagemathinc\/star/).length).toBeGreaterThan(0);
  });

  it("renders docs markdown code blocks with the Slate code renderer", async () => {
    render(
      <PublicDocsApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{
          slug: "terminal/use-terminal",
          view: "docs-detail",
        }}
      />,
    );

    const markdown = screen.getByTestId("docs-markdown");
    expect(markdown).toHaveClass("cocalc-docs-markdown");
    await waitFor(() =>
      expect(markdown.querySelector(".cocalc-slate-code-block")).not.toBeNull(),
    );
    expect(
      markdown.querySelector(".cocalc-slate-code-block .token"),
    ).not.toBeNull();
    const copyButton = markdown.querySelector(
      ".cocalc-code-copy-button--overlay",
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton).toHaveAccessibleName("Copy to clipboard");
    expect(copyButton).toHaveTextContent("");
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
    const actionCard = screen
      .getByText("Open this in CoCalc")
      .closest(".ant-card")!;
    expect(
      within(actionCard).getByText("settings.environment.secrets"),
    ).not.toBeNull();
    expect(
      within(actionCard)
        .getByRole("button", { name: "Open project secrets" })
        .getAttribute("data-cocalc-action-id"),
    ).toBe("settings.environment.secrets");
  });
});
