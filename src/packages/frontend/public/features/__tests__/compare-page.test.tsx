/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
} from "@cocalc/util/public-compare-content";
import PublicFeaturesApp from "../app";

const COCALC_AI = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  site_name: "CoCalc",
};
const ROCKET = {
  cocalc_product: "rocket",
  dns: "cocalc.example.edu",
  site_name: "Example CoCalc",
};
const PLUS = { cocalc_product: "plus", site_name: "CoCalc Plus" };

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

function renderCompare(config: Record<string, string>) {
  return render(
    <PublicFeaturesApp
      config={config}
      initialRoute={{ slug: "compare", view: "detail" }}
    />,
  );
}

describe("Compare page", () => {
  it("keeps the live title as the only H1", () => {
    renderCompare(COCALC_AI);

    expect(
      screen
        .getAllByRole("heading", { level: 1 })
        .map((heading) => heading.textContent),
    ).toEqual(["CoCalc vs AI Agent Sandboxes"]);
  });

  it.each([
    ["cocalc.ai", COCALC_AI],
    ["a Rocket site", ROCKET],
    ["CoCalc Plus", PLUS],
  ])(
    "renders the same fit-list bullets as the crawler fallback on %s",
    (_site, config) => {
      renderCompare(config);

      for (const section of getPublicCompareSections(config)) {
        if (section.bullets == null) continue;
        const card = screen
          .getByRole("heading", { level: 4, name: section.title })
          .closest("article");
        expect(card).not.toBeNull();
        expect(
          within(card as HTMLElement)
            .getAllByRole("listitem")
            .map((item) => item.textContent),
        ).toEqual(section.bullets);
      }
    },
  );

  it("names snapshots and backups only on cocalc.ai", () => {
    const { unmount } = renderCompare(COCALC_AI);
    expect(
      screen.getByText(PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET),
    ).not.toBeNull();
    expect(screen.queryByText(PUBLIC_COMPARE_COLLABORATION_BULLET)).toBeNull();
    unmount();

    renderCompare(ROCKET);
    expect(
      screen.getByText(PUBLIC_COMPARE_COLLABORATION_BULLET),
    ).not.toBeNull();
    expect(screen.queryByText(/snapshots, and backups/)).toBeNull();
  });

  it("drops the collaboration bullet on CoCalc Plus", () => {
    renderCompare(PLUS);

    expect(screen.queryByText(/^Collaborators need/)).toBeNull();
    expect(
      screen.getByText(
        "The work must persist across sessions, collaborators, reviews, and handoffs",
      ),
    ).not.toBeNull();
  });
});
