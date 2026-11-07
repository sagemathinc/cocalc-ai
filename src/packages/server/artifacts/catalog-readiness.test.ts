import {
  afterCatalogCommit,
  artifactCatalogHintsEnabled,
  nudgeArtifactCatalogHints,
  registerArtifactCatalogHintNudge,
  resetArtifactCatalogReadinessForTests,
} from "./catalog-readiness";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => "pool",
}));

const original = process.env.COCALC_ARTIFACT_CATALOG_HINTS;
afterEach(() => {
  resetArtifactCatalogReadinessForTests();
  if (original === undefined) delete process.env.COCALC_ARTIFACT_CATALOG_HINTS;
  else process.env.COCALC_ARTIFACT_CATALOG_HINTS = original;
});

test("hints are a bay setting, the same on a worker that runs no drainer (R2)", () => {
  delete process.env.COCALC_ARTIFACT_CATALOG_HINTS;
  // No drainer was started in this process (like a non-primary worker
  // before its drainer starts): the answer does not depend on it.
  expect(artifactCatalogHintsEnabled()).toBe(true);
  process.env.COCALC_ARTIFACT_CATALOG_HINTS = "off";
  expect(artifactCatalogHintsEnabled()).toBe(false);
  process.env.COCALC_ARTIFACT_CATALOG_HINTS = "on";
  expect(artifactCatalogHintsEnabled()).toBe(true);
});

test("a nudge wakes this worker's drainer, and is harmless without one", () => {
  expect(() => nudgeArtifactCatalogHints()).not.toThrow();
  const wake = jest.fn();
  registerArtifactCatalogHintNudge(wake);
  nudgeArtifactCatalogHints();
  expect(afterCatalogCommit("committed")).toBe("committed");
  expect(wake).toHaveBeenCalledTimes(2);
  registerArtifactCatalogHintNudge(undefined);
  nudgeArtifactCatalogHints();
  expect(wake).toHaveBeenCalledTimes(2);
});
