import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
  PUBLIC_COMPARE_HISTORY_SECTIONS,
  PUBLIC_COMPARE_HISTORY_TITLE,
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
      // the fit lists; cocalc.ai's history sections are checked below
      for (const section of getPublicCompareSections(config)) {
        if (section.bullets == null || !section.title.startsWith("Choose "))
          continue;
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

  it("renders the history and backup sections on cocalc.ai only, as the page does", () => {
    const html = renderCompare(COCALC_AI);
    const [history, scale] = PUBLIC_COMPARE_HISTORY_SECTIONS;
    for (const card of history.cards!) {
      expect(html).toContain(`<h3>${card.title}</h3><p>${card.body}</p>`);
    }
    expect(html).toContain(
      `<h2>${scale.title}</h2><p>${scale.paragraphs![0]}</p><ul>${scale
        .bullets!.map((bullet) => `<li>${bullet}</li>`)
        .join("")}</ul>`,
    );
    for (const config of [ROCKET, PLUS, undefined]) {
      expect(renderCompare(config)).not.toContain(PUBLIC_COMPARE_HISTORY_TITLE);
    }
  });
});
