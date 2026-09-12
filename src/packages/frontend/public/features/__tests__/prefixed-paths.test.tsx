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
        config={{ site_name: "CoCalc" }}
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
