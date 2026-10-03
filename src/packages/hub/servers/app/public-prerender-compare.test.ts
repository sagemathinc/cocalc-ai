import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
} from "@cocalc/util/public-compare-content";
import { renderPublicRoutePrerender } from "./public-prerender";

const COMPARE_ROUTE = {
  section: "features",
  route: { view: "detail", slug: "compare" },
} as const;

const COCALC_AI = { cocalc_product: "launchpad", dns: "cocalc.ai" };
const ROCKET = { cocalc_product: "rocket", dns: "cocalc.example.edu" };
const PLUS = { cocalc_product: "plus", dns: "localhost:5173" };

function renderCompare(config?: { cocalc_product?: string; dns?: string }) {
  return renderPublicRoutePrerender(COMPARE_ROUTE, "/", config);
}

describe("Compare page initial HTML", () => {
  it.each([
    ["cocalc.ai", COCALC_AI],
    ["a Rocket site", ROCKET],
    ["CoCalc Plus", PLUS],
    ["an unknown site", undefined],
  ])(
    "renders the same fit-list bullets as the React page on %s",
    (_site, config) => {
      const html = renderCompare(config);
      for (const section of getPublicCompareSections(config)) {
        if (section.bullets == null) continue;
        expect(html).toContain(
          `<h2>${section.title}</h2><ul>${section.bullets
            .map((bullet) => `<li>${bullet}</li>`)
            .join("")}</ul>`,
        );
      }
    },
  );

  it("names snapshots and backups only on cocalc.ai", () => {
    expect(renderCompare(COCALC_AI)).toContain(
      PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
    );
    expect(renderCompare(COCALC_AI)).not.toContain(
      `<li>${PUBLIC_COMPARE_COLLABORATION_BULLET}</li>`,
    );
    for (const config of [
      ROCKET,
      { cocalc_product: "launchpad", dns: "cocalc.example.edu" },
      undefined,
    ]) {
      const html = renderCompare(config);
      expect(html).toContain(`<li>${PUBLIC_COMPARE_COLLABORATION_BULLET}</li>`);
      expect(html).not.toContain("snapshots, and backups");
    }
    expect(renderCompare(PLUS)).not.toContain("Collaborators need");
  });
});
