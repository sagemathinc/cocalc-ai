import {
  discoveryCoverage,
  validateDiscoveryReport,
} from "./collaboration-census";
const report = {
  run_id: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
  coverage: "complete" as const,
  traversal_complete: true,
  directories: 1,
  completed_directories: 1,
  entries: 0,
  candidates: 0,
  pending_candidates: 0,
  excluded_entries: 0,
  skipped_symlinks: 0,
  blocked_directories: 0,
  errors: 0,
  source_pending: 0,
  source_errors: 0,
};
test("discovery wire metadata strips unknown fields and rejects inconsistent completeness", () => {
  expect(
    validateDiscoveryReport({ ...report, paths: ["secret"] } as any),
  ).toEqual(report);
  for (const key of [
    "source_pending",
    "source_errors",
    "excluded_entries",
    "skipped_symlinks",
    "errors",
  ])
    expect(() => validateDiscoveryReport({ ...report, [key]: 1 })).toThrow();
  expect(() => validateDiscoveryReport({ ...report, sequence: NaN })).toThrow();
  expect(() =>
    validateDiscoveryReport({ ...report, traversal_complete: false }),
  ).toThrow();
});
test.each([
  "pending",
  "unavailable",
  "indexing",
  "partial",
  "complete",
] as const)(
  "%s metadata never claims overall discovery completeness",
  (status) => {
    const coverage = discoveryCoverage({ status, report });
    expect(coverage.coverage).not.toBe("complete");
    expect(coverage.coverage_message).toContain("may still be incomplete");
  },
);
