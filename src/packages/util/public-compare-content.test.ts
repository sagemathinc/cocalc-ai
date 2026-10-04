import {
  getPublicCompareSections,
  PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET,
  PUBLIC_COMPARE_COLLABORATION_BULLET,
} from "./public-compare-content";
import { getPublicFeaturePage } from "./public-feature-pages";

const COCALC_AI = { cocalc_product: "launchpad", dns: "cocalc.ai" };

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
      registry?.map((bullet) =>
        bullet === PUBLIC_COMPARE_COLLABORATION_BULLET
          ? PUBLIC_COMPARE_COCALC_AI_COLLABORATION_BULLET
          : bullet,
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
      expect(cocalcBullets(config)).toEqual(registry);
    }
  });

  it("drops the collaboration bullet on CoCalc Plus", () => {
    const bullets = cocalcBullets({ cocalc_product: "plus", dns: "localhost" });

    expect(bullets).toHaveLength(3);
    expect(JSON.stringify(bullets)).not.toContain("Collaborators need");
  });

  it("changes no other Compare section for any site", () => {
    const registry = getPublicFeaturePage("compare")?.sections ?? [];
    for (const config of [COCALC_AI, { cocalc_product: "plus" }, undefined]) {
      const sections = getPublicCompareSections(config);
      expect(sections.map(({ title }) => title)).toEqual(
        registry.map(({ title }) => title),
      );
      expect(
        sections.filter(({ title }) => title !== "Choose CoCalc when"),
      ).toEqual(registry.filter(({ title }) => title !== "Choose CoCalc when"));
    }
  });
});
