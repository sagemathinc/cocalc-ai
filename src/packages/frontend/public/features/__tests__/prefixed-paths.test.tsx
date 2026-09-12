/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import PublicFeaturesApp from "../app";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/prefix",
}));

afterEach(() => jest.restoreAllMocks());

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
