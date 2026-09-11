/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import PublicFeaturesApp from "../app";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/prefix",
}));

it("keeps the research documentation CTA and section links on the deployment prefix", () => {
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
  ).toContain(`/prefix${page.docsUrl}`);
  for (const section of page.sections ?? []) {
    for (const link of section.links ?? []) {
      expect(
        screen.getByRole("link", { name: link.label, exact: true }),
      ).toHaveAttribute("href", `/prefix${link.href}`);
    }
  }
  expect(container.querySelector('a[href^="/docs/"]')).toBeNull();
});
