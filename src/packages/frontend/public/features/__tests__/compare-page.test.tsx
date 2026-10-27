/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
  PUBLIC_COMPARE_HISTORY_SECTIONS,
  PUBLIC_COMPARE_HISTORY_TITLE,
} from "@cocalc/util/public-compare-content";
import { PUBLIC_PRODUCT_AVAILABILITY } from "@cocalc/util/public-product-availability";
import PublicFeaturesApp from "../app";

afterEach(() => jest.restoreAllMocks());

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

      // the fit lists; cocalc.ai's history sections are checked below
      for (const section of getPublicCompareSections(config)) {
        if (section.bullets == null || !section.title.startsWith("Choose "))
          continue;
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

// The rows that name the ways to run CoCalc read the product switches when
// the page renders, so they follow a switch that changes.
describe("Compare page ways to run CoCalc", () => {
  function operatingRow(): HTMLElement {
    return screen.getByRole("rowheader", { name: "Who operates it?" })
      .parentElement!;
  }

  it("names hosted, local and single-VM deployment while Launchpad and Rocket are hidden", () => {
    renderCompare(COCALC_AI);

    expect(operatingRow().textContent).toContain(
      "Teams need hosted, local, and single-VM deployment choices.",
    );
    expect(
      screen.getByText("Hosted, local, and single-VM deployment."),
    ).not.toBeNull();
    expect(operatingRow().textContent).not.toMatch(/private/);
  });

  it("names every way to run CoCalc once every product is shown", () => {
    for (const id of ["plus", "launchpad", "rocket"] as const) {
      jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
    }
    renderCompare(COCALC_AI);

    expect(operatingRow().textContent).toContain(
      "Teams need hosted, local, single-VM, and private deployment choices.",
    );
    expect(
      screen.getByText("Hosted, local, single-VM, and private deployment."),
    ).not.toBeNull();
  });
});

describe("Compare page history and backups", () => {
  it("shows the three ways to keep history and how it scales on cocalc.ai", () => {
    renderCompare(COCALC_AI);
    const [history, scale] = PUBLIC_COMPARE_HISTORY_SECTIONS;
    const section = screen.getByRole("region", {
      name: "CoCalc.ai history and backups",
    });
    expect(
      within(section)
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual([...history.cards!.map(({ title }) => title), scale.title]);
    for (const card of history.cards!) {
      expect(within(section).getByText(card.body)).not.toBeNull();
    }
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(scale.bullets);
    expect(
      within(section)
        .getByRole("link", { name: "How recovery works" })
        .getAttribute("href"),
    ).toMatch(/docs\/research\/recover-work$/);
  });

  it("is shown on cocalc.ai before /customize returns the product", () => {
    // jsdom's host is not cocalc.ai; on cocalc.ai the page's host decides
    // until the configuration arrives (isCocalcAiLaunchpadSite)
    renderCompare({ dns: "cocalc.ai", site_name: "CoCalc" });
    expect(
      screen.getByRole("heading", { name: PUBLIC_COMPARE_HISTORY_TITLE }),
    ).not.toBeNull();
  });

  it.each([
    ["a Rocket site", ROCKET],
    ["CoCalc Plus", PLUS],
    [
      "a customer Launchpad site",
      { cocalc_product: "launchpad", dns: "cocalc.example.edu" },
    ],
  ])("is not shown on %s", (_site, config) => {
    renderCompare(config);
    expect(
      screen.queryByRole("heading", { name: PUBLIC_COMPARE_HISTORY_TITLE }),
    ).toBeNull();
  });
});
