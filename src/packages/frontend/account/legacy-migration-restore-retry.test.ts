/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { LegacyMigrationProjectSummary } from "@cocalc/conat/hub/api/legacy-migration";
import { restoreRetryAvailable } from "./legacy-migration-restore-retry";

function project(
  overrides: Partial<LegacyMigrationProjectSummary>,
): LegacyMigrationProjectSummary {
  return {
    legacy_project_id: "00000000-0000-4000-8000-000000000001",
    title: "My First Project",
    artifact_status: "available",
    artifact_key: "projects/a.tar.zst",
    artifact_bytes: 84_000_000,
    ...overrides,
  } as LegacyMigrationProjectSummary;
}

describe("restoreRetryAvailable", () => {
  it("offers a retry for a failed restore into an existing project", () => {
    expect(
      restoreRetryAvailable(
        project({ project_id: "p1", restore_status: "failed" }),
      ),
    ).toBe(true);
  });

  it.each([
    ["not imported yet", { restore_status: "failed" }],
    ["restored", { project_id: "p1", restore_status: "restored" }],
    ["still restoring", { project_id: "p1", restore_status: "restoring" }],
    [
      "without an archive",
      {
        project_id: "p1",
        restore_status: "failed",
        artifact_status: "missing",
      },
    ],
  ])("does not offer a retry when %s", (_label, overrides) => {
    expect(restoreRetryAvailable(project(overrides as any))).toBe(false);
  });
});
