/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { censusPolicyFromEnvironment } from "./census-policy";
import { DEFAULT_CENSUS_LIMITS } from "./census-types";

test("default policy is stable; explicit revisions and changed limits request a distinct run", () => {
  const defaults = censusPolicyFromEnvironment({});
  expect(defaults).toEqual({
    version: "home-no-links-or-mounts-v1",
    limits: DEFAULT_CENSUS_LIMITS,
  });
  expect(
    censusPolicyFromEnvironment({
      COCALC_COLLABORATORS_CENSUS_ENTRIES: "100000",
    }),
  ).toEqual(defaults);
  const env = {
    COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION: "cleanup-2",
    COCALC_COLLABORATORS_CENSUS_ENTRIES: "200000",
  };
  const policy = censusPolicyFromEnvironment(env);
  expect(policy.version).not.toBe(defaults.version);
  expect(policy.version).toMatch(/:rescan-cleanup-2$/);
  expect(policy.limits.entries).toBe(200_000);
  expect(censusPolicyFromEnvironment(env)).toEqual(policy);
  expect(
    censusPolicyFromEnvironment({
      ...env,
      COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION: "cleanup-3",
    }).version,
  ).not.toBe(policy.version);
});
test.each(["", "../escape", "x y", "x".repeat(65)])(
  "rejects invalid revision %p",
  (revision) => {
    expect(() =>
      censusPolicyFromEnvironment({
        COCALC_COLLABORATORS_CENSUS_RESCAN_REVISION: revision,
      }),
    ).toThrow(/invalid/);
  },
);
test.each([
  "DIRECTORIES",
  "ENTRIES",
  "DIRECTORY_ENTRIES",
  "CANDIDATES",
  "DEPTH",
])("validates the %s ceiling", (key) => {
  for (const value of ["0", "-1", "1.5", "1000001", " 2", "Infinity"])
    expect(() =>
      censusPolicyFromEnvironment({
        [`COCALC_COLLABORATORS_CENSUS_${key}`]: value,
      }),
    ).toThrow(/invalid/);
});
test("depth remains bounded independently of the entry ceilings", () => {
  expect(() =>
    censusPolicyFromEnvironment({ COCALC_COLLABORATORS_CENSUS_DEPTH: "257" }),
  ).toThrow(/invalid/);
});
