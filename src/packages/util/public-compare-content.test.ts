import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
  PUBLIC_COMPARE_DEPLOYMENT_BULLET,
  PUBLIC_COMPARE_HISTORY_SECTIONS,
  PUBLIC_COMPARE_HISTORY_TITLE,
  PUBLIC_COMPARE_SCALE_TITLE,
} from "./public-compare-content";
import { getPublicFeaturePage } from "./public-feature-pages";
import { PUBLIC_PRODUCT_AVAILABILITY } from "./public-product-availability";

const COCALC_AI = { cocalc_product: "launchpad", dns: "cocalc.ai" };

// The operating-boundary bullet while Launchpad and Rocket are hidden; CoCalc
// Plus and Star are both a local installation.
const HIDDEN_PRODUCTS_DEPLOYMENT_BULLET =
  "You need a hosted service, or a local or single-VM installation";

afterEach(() => jest.restoreAllMocks());

function showAllProducts() {
  for (const id of ["plus", "launchpad", "rocket"] as const) {
    jest.replaceProperty(PUBLIC_PRODUCT_AVAILABILITY, id, true);
  }
}

// The record's bullets as this site shows them while products are hidden.
function hiddenProductBullets(bullets?: readonly string[]) {
  return bullets?.map((bullet) =>
    bullet === PUBLIC_COMPARE_DEPLOYMENT_BULLET
      ? HIDDEN_PRODUCTS_DEPLOYMENT_BULLET
      : bullet,
  );
}

function cocalcBullets(config?: { cocalc_product?: string; dns?: string }) {
  return getPublicCompareSections(config).find(
    ({ title }) => title === "Choose CoCalc when",
  )?.bullets;
}

describe("Compare page content", () => {
  it("finds the collaboration bullet in the Compare record exactly once", () => {
    const bullets = getPublicFeaturePage("compare")?.sections?.flatMap(
      ({ bullets }) => bullets ?? [],
    );
    expect(
      bullets?.filter(
        (bullet) => bullet === PUBLIC_COMPARE_COLLABORATION_BULLET,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(bullets)).not.toContain("recovery");
  });

  it("names snapshots and backups only on cocalc.ai", () => {
    const registry = getPublicFeaturePage("compare")?.sections?.find(
      ({ title }) => title === "Choose CoCalc when",
    )?.bullets;

    expect(cocalcBullets(COCALC_AI)).toEqual(
      hiddenProductBullets(
        registry?.map((bullet) =>
          bullet === PUBLIC_COMPARE_COLLABORATION_BULLET
            ? PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET
            : bullet,
        ),
      ),
    );
    expect(
      cocalcBullets({ ...COCALC_AI, dns: "https://cocalc.ai:443/" }),
    ).toContain(PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET);
    for (const config of [
      undefined,
      {},
      { cocalc_product: "launchpad", dns: "cocalc.example.edu" },
      { cocalc_product: "launchpad", dns: "dev.cocalc.ai" },
      { cocalc_product: "rocket", dns: "cocalc.ai" },
      { cocalc_product: "rocket", dns: "cocalc.example.com" },
    ]) {
      expect(cocalcBullets(config)).toEqual(hiddenProductBullets(registry));
    }
  });

  it("names only the ways to run CoCalc that the public pages show", () => {
    expect(
      getPublicFeaturePage("compare")?.sections?.flatMap(
        ({ bullets }) => bullets ?? [],
      ),
    ).toContain(PUBLIC_COMPARE_DEPLOYMENT_BULLET);
    expect(cocalcBullets(COCALC_AI)).toContain(
      HIDDEN_PRODUCTS_DEPLOYMENT_BULLET,
    );
    expect(JSON.stringify(cocalcBullets(COCALC_AI))).not.toContain(
      "private deployment",
    );

    // With every product shown, the record's bullet is shown as written.
    showAllProducts();
    expect(cocalcBullets(COCALC_AI)).toContain(
      PUBLIC_COMPARE_DEPLOYMENT_BULLET,
    );
  });

  it("drops the collaboration bullet on CoCalc Plus", () => {
    const bullets = cocalcBullets({ cocalc_product: "plus", dns: "localhost" });

    expect(bullets).toHaveLength(3);
    expect(JSON.stringify(bullets)).not.toContain("Collaborators need");
  });

  it("changes no other Compare section for any site", () => {
    const registry = getPublicFeaturePage("compare")?.sections ?? [];
    for (const config of [COCALC_AI, { cocalc_product: "plus" }, undefined]) {
      // the record's sections; cocalc.ai adds its own after them (below)
      const sections = getPublicCompareSections(config).slice(
        0,
        registry.length,
      );
      expect(sections.map(({ title }) => title)).toEqual(
        registry.map(({ title }) => title),
      );
      expect(
        sections.filter(({ title }) => title !== "Choose CoCalc when"),
      ).toEqual(registry.filter(({ title }) => title !== "Choose CoCalc when"));
    }
  });
});

describe("Compare page history and backup sections", () => {
  const titles = (config?: { cocalc_product?: string; dns?: string }) =>
    getPublicCompareSections(config).map(({ title }) => title);

  it("are added on cocalc.ai only, after the record's sections", () => {
    const record = getPublicFeaturePage("compare")!.sections!.map(
      ({ title }) => title,
    );
    expect(titles(COCALC_AI)).toEqual([
      ...record,
      PUBLIC_COMPARE_HISTORY_TITLE,
      PUBLIC_COMPARE_SCALE_TITLE,
    ]);
    for (const config of [
      { cocalc_product: "rocket", dns: "cocalc.example.edu" },
      { cocalc_product: "launchpad", dns: "cocalc.example.edu" },
      { cocalc_product: "launchpad", dns: "staging.cocalc.ai" },
      { cocalc_product: "plus", dns: "localhost:5173" },
      undefined,
    ]) {
      expect(titles(config)).toEqual(record);
    }
  });

  it("compare three ways to keep history, CoCalc.ai's last", () => {
    const [history] = PUBLIC_COMPARE_HISTORY_SECTIONS;
    expect(history.cards?.map(({ title }) => title)).toEqual([
      "A virtual machine per user",
      "Ephemeral agent sandboxes",
      "A CoCalc.ai project",
    ]);
  });

  it("publish no schedule, retention, or certification claims", () => {
    const text = JSON.stringify(PUBLIC_COMPARE_HISTORY_SECTIONS);
    // retention and cadence depend on the project's runtime and schedules
    expect(text).not.toMatch(/\d+\s*(minute|hour|day|week|month)s?\b/i);
    expect(text).not.toMatch(/certified|compliant|SOC/i);
  });
});
