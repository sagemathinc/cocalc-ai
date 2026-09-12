/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { getDocsEntry } from "@cocalc/docs";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import PublicFeaturesApp from "../app";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/prefix",
}));

afterEach(() => jest.restoreAllMocks());

it.each(["jupyter-notebook", "latex-editor", "api"])(
  "does not link %s to guides hidden on Plus",
  (slug) => {
    const { container } = render(
      <PublicFeaturesApp
        config={{ cocalc_product: "plus", site_name: "CoCalc" }}
        initialRoute={{ view: "detail", slug }}
      />,
    );
    const prefix = "/prefix/docs/";
    const links = Array.from(container.querySelectorAll("a[href]"));
    const localDocs = links
      .map((link) => link.getAttribute("href")!)
      .filter((href) => href.startsWith(prefix));
    expect(
      localDocs.filter(
        (href) => !getDocsEntry(href.slice(prefix.length), { product: "plus" }),
      ),
    ).toEqual([]);
    for (const link of links) {
      const href = link.getAttribute("href")!;
      if (href.startsWith("https://cocalc.ai/docs/")) {
        expect(
          getDocsEntry(href.slice("https://cocalc.ai/docs/".length)),
        ).toBeDefined();
      }
    }
  },
);

it.each(["/prefix", "/docs"])(
  "keeps research documentation links on deployment %s",
  (basePath) => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      basePath,
    );
    const page = getPublicFeaturePage("research-compute")!;
    const { container } = render(
      <PublicFeaturesApp
        config={{ cocalc_product: "launchpad", site_name: "CoCalc" }}
        initialRoute={{ view: "detail", slug: page.slug }}
      />,
    );

    expect(
      screen
        .getAllByRole("link", { name: "Documentation", exact: true })
        .map((link) => link.getAttribute("href")),
    ).toContain(`${basePath}${page.docsUrl}`);
    for (const section of page.sections ?? []) {
      for (const link of section.links ?? []) {
        expect(
          screen.getByRole("link", { name: link.label, exact: true }),
        ).toHaveAttribute("href", `${basePath}${link.href}`);
      }
    }
    expect(container.querySelector('a[href^="/docs/hosts/"]')).toBeNull();
  },
);

it.each(["/prefix", "/docs"])(
  "keeps the Plus not-found return link on deployment %s",
  (basePath) => {
    jest.replaceProperty(
      jest.requireMock("@cocalc/frontend/customize/app-base-path"),
      "appBasePath",
      basePath,
    );
    const { container } = render(
      <PublicFeaturesApp
        config={{ cocalc_product: "plus", site_name: "CoCalc" }}
        initialRoute={{ view: "detail", slug: "research-compute" }}
      />,
    );
    expect(screen.getByText("Feature page not found")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Back to features" }),
    ).toHaveAttribute("href", `${basePath}/features`);
    expect(
      container.querySelector(
        `a[href="${basePath}/features/research-compute"]`,
      ),
    ).toBeNull();
    expect(
      container.querySelector(`a[href="${basePath}/docs/hosts/project-hosts"]`),
    ).toBeNull();
  },
);
