const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
const schemaQuery = jest.fn(async () => ({ rows: [] }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: schemaQuery, connect }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-test",
}));

import { recordBackupOutcome as recordBackupOutcomeInternal } from "./outcomes";
import { backupExclusionObjectKey } from "@cocalc/backend/backup-exclusion-store";
import { backupReportHeaderSha256 } from "@cocalc/backend/backup-exclusion-report";
import type { BackupOutcomeReceipt } from "@cocalc/util/types/backup-evidence";

const project = "00000000-0000-4000-8000-000000000001";
const host = "00000000-0000-4000-8000-000000000002";
const bucket = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "test-backups",
};
const recordBackupOutcome = (
  opts: Omit<Parameters<typeof recordBackupOutcomeInternal>[0], "bucket">,
) => recordBackupOutcomeInternal({ ...opts, bucket });
function receipt(): BackupOutcomeReceipt {
  const binding = {
    schema_version: 1 as const,
    project_id: project,
    backup_id: "b".repeat(64),
    source: {
      subvolume_uuid: project,
      snapshot_uuid: host,
      generation: "9007199254740993",
      captured_at: "2026-09-05T00:00:00.000Z",
    },
    policy_sha256: "a".repeat(64),
    report: {
      bytes: 1000,
      sha256: "c".repeat(64),
      header_sha256: "d".repeat(64),
    },
  };
  return {
    producer: {
      binding,
      policy_version: 1,
      binary_sha256: "e".repeat(64),
      exclude_larger_than_bytes: "100",
      outcome: "partial_policy_exclusions",
      excluded_files: "1",
      report_path: `/var/lib/cocalc-rustic-reports/${host}.ndjson`,
      read_limits: {
        max_bytes: 2000,
        max_record_bytes: 2000,
        max_entries: 100,
        max_path_depth: 10,
      },
    },
    object_key: backupExclusionObjectKey(binding),
    bucket: bucket.name,
    excluded_apparent_bytes: "1000",
    sample: [
      {
        path_hex: "66696c65",
        apparent_bytes: "1000",
        acknowledgement_key: null,
      },
    ],
  };
}

let storedDigest: string;
beforeEach(() => {
  jest.clearAllMocks();
  storedDigest = backupReportHeaderSha256(receipt());
  query.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT host_id")) return { rows: [{ host_id: host }] };
    if (sql.startsWith("SELECT receipt_sha256"))
      return { rows: [{ receipt_sha256: storedDigest }] };
    return { rows: [] };
  });
});

it("records immutable partial history transactionally without updating freshness", async () => {
  expect(
    await recordBackupOutcome({
      project_id: project,
      host_id: host,
      receipt: receipt(),
    }),
  ).toEqual({ receipt_sha256: storedDigest });
  const sql = query.mock.calls.map(([text]) => text);
  expect(sql[0]).toBe("BEGIN");
  expect(sql[1]).toContain("FOR SHARE");
  expect(query.mock.calls[1][1]).toEqual([project, "bay-test"]);
  expect(sql[2]).toContain("ON CONFLICT (project_id, backup_id) DO NOTHING");
  expect(query.mock.calls[2][1][3]).toBe("partial_policy_exclusions");
  expect(sql.at(-1)).toBe("COMMIT");
  expect(sql.join(" ")).not.toMatch(/UPDATE projects|last_backup/);
  expect(release).toHaveBeenCalledTimes(1);
});

it("refuses a receipt when placement changes before the locked write", async () => {
  query.mockImplementation(async () => ({ rows: [{ host_id: project }] }));
  await expect(
    recordBackupOutcome({
      project_id: project,
      host_id: host,
      receipt: receipt(),
    }),
  ).rejects.toThrow("placement or owning bay changed");
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledTimes(1);
});

it("refuses conflicting evidence for an already-recorded snapshot", async () => {
  storedDigest = "different";
  await expect(
    recordBackupOutcome({
      project_id: project,
      host_id: host,
      receipt: receipt(),
    }),
  ).rejects.toThrow("conflicts with immutable");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([undefined, "bad"])(
  "requires host identity %s before touching the database",
  async (host_id) => {
    await expect(
      recordBackupOutcome({ project_id: project, host_id, receipt: receipt() }),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  },
);

it("rejects cross-project bindings before opening a transaction", async () => {
  const value = receipt();
  value.producer.binding.project_id = host;
  await expect(
    recordBackupOutcome({ project_id: project, host_id: host, receipt: value }),
  ).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
});

it("rejects stale or substituted bucket identity before opening a transaction", async () => {
  await expect(
    recordBackupOutcomeInternal({
      project_id: project,
      host_id: host,
      receipt: receipt(),
      bucket: { ...bucket, name: "different-bucket" },
    }),
  ).rejects.toThrow("bucket assignment changed");
  expect(connect).not.toHaveBeenCalled();
});

it("propagates commit failure instead of confirming success", async () => {
  const original = query.getMockImplementation()!;
  query.mockImplementation(async (...args) => {
    if (args[0] === "COMMIT") throw new Error("commit failed");
    return await original(...args);
  });
  await expect(
    recordBackupOutcome({
      project_id: project,
      host_id: host,
      receipt: receipt(),
    }),
  ).rejects.toThrow("commit failed");
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledTimes(1);
});
