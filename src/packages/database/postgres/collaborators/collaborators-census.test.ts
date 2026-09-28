/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
jest.mock("../../pool", () => jest.requireActual("@cocalc/database/pool"));
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { syncCollaborationCensusSchema } from "./collaborators-census-schema";
import {
  collaborationDiscoveryForHost,
  getCollaborationDiscovery,
  reportCollaborationDiscovery,
} from "./collaborators-census";
const project_id = randomUUID(),
  host_id = randomUUID(),
  account_id = randomUUID();
const authority = { host_id, owning_bay_id: "bay-test" };
const previousBay = process.env.COCALC_BAY_ID;
const base = {
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
beforeAll(async () => {
  process.env.COCALC_BAY_ID = "bay-test";
  await initEphemeralDatabase({});
  await syncCollaborationCensusSchema(getPool());
}, 60000);
beforeEach(async () => {
  await getPool().query("TRUNCATE collaboration_discovery,projects CASCADE");
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,'bay-test',$3::jsonb)",
    [
      project_id,
      host_id,
      JSON.stringify({ [account_id]: { group: "collaborator" } }),
    ],
  );
});
afterAll(async () => {
  if (previousBay == null) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = previousBay;
  await testCleanup();
});
test("read-only pending telemetry creates no catalog or room, and stale leases are unavailable", async () => {
  expect(
    await getCollaborationDiscovery({ project_id, account_id }, authority),
  ).toEqual({ status: "pending" });
  expect(await collaborationDiscoveryForHost(project_id, authority)).toEqual({
    run_id: null,
  });
  for (const table of ["collaboration_projects", "collaboration_rooms"]) {
    expect(
      (
        await getPool().query(
          `SELECT count(*) n FROM ${table} WHERE project_id=$1`,
          [project_id],
        )
      ).rows[0].n,
    ).toBe("0");
  }
  const report = { ...base, run_id: randomUUID() };
  await reportCollaborationDiscovery(
    { project_id, expected_run_id: null, report },
    authority,
  );
  expect(
    await getCollaborationDiscovery({ project_id, account_id }, authority),
  ).toMatchObject({ status: "complete", report });
  await getPool().query(
    "UPDATE collaboration_discovery SET updated_at=now()-interval '31 minutes' WHERE project_id=$1",
    [project_id],
  );
  expect(
    await getCollaborationDiscovery({ project_id, account_id }, authority),
  ).toMatchObject({ status: "unavailable", report });
});
test("immutable report replay, monotonic sequence and run replacement CAS", async () => {
  const report = { ...base, run_id: randomUUID() };
  const first = { project_id, expected_run_id: null, report };
  expect(await reportCollaborationDiscovery(first, authority)).toEqual({
    replayed: false,
  });
  expect(await reportCollaborationDiscovery(first, authority)).toEqual({
    replayed: true,
  });
  await expect(
    reportCollaborationDiscovery(
      { ...first, report: { ...report, entries: 1 } },
      authority,
    ),
  ).rejects.toThrow("reused");
  await reportCollaborationDiscovery(
    { ...first, report: { ...report, sequence: 2 } },
    authority,
  );
  await expect(reportCollaborationDiscovery(first, authority)).rejects.toThrow(
    "stale discovery sequence",
  );
  const replacement = { ...first, report: { ...base, run_id: randomUUID() } };
  await expect(
    reportCollaborationDiscovery(replacement, authority),
  ).rejects.toThrow("stale discovery run");
  await reportCollaborationDiscovery(
    { ...replacement, expected_run_id: report.run_id },
    authority,
  );
  await expect(reportCollaborationDiscovery(first, authority)).rejects.toThrow(
    "stale discovery run",
  );
});
test("wrong host/bay, revoked member and host reassignment are fenced", async () => {
  const write = {
    project_id,
    expected_run_id: null,
    report: { ...base, run_id: randomUUID() },
  };
  await expect(
    reportCollaborationDiscovery(write, {
      ...authority,
      host_id: randomUUID(),
    }),
  ).rejects.toThrow();
  await expect(
    collaborationDiscoveryForHost(project_id, {
      ...authority,
      owning_bay_id: "other",
    }),
  ).rejects.toThrow();
  await expect(
    getCollaborationDiscovery(
      { project_id, account_id: randomUUID() },
      authority,
    ),
  ).rejects.toThrow();
  await reportCollaborationDiscovery(write, authority);
  await getPool().query("UPDATE projects SET host_id=$1 WHERE project_id=$2", [
    randomUUID(),
    project_id,
  ]);
  expect(
    await getCollaborationDiscovery({ project_id, account_id }, authority),
  ).toEqual({ status: "unavailable" });
  await expect(
    reportCollaborationDiscovery(
      { ...write, report: { ...write.report, sequence: 2 } },
      authority,
    ),
  ).rejects.toThrow();
});
