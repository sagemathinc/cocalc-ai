const query = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-test",
}));
jest.mock("./outcomes", () => ({ ensureBackupOutcomeSchema: jest.fn() }));

import { assertNoKnownBackupExclusions } from "./lifecycle-preflight";
import { backupExclusionObjectKey } from "@cocalc/backend/backup-exclusion-store";
import { backupReportHeaderSha256 } from "@cocalc/backend/backup-exclusion-report";
import type { BackupOutcomeReceipt } from "@cocalc/util/types/backup-evidence";

const project = "00000000-0000-4000-8000-000000000001";
const host = "00000000-0000-4000-8000-000000000002";
const check = () =>
  assertNoKnownBackupExclusions({
    project_id: project,
    expected_host_id: host,
  });
function row(partial = false) {
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
  const receipt: BackupOutcomeReceipt = {
    producer: {
      binding,
      policy_version: 1,
      binary_sha256: "e".repeat(64),
      exclude_larger_than_bytes: "100",
      outcome: partial ? "partial_policy_exclusions" : "complete",
      excluded_files: partial ? "1" : "0",
      report_path: `/var/lib/cocalc-rustic-reports/${host}.ndjson`,
      read_limits: {
        max_bytes: 2000,
        max_record_bytes: 2000,
        max_entries: 100,
        max_path_depth: 10,
      },
    },
    object_key: backupExclusionObjectKey(binding),
    bucket: "test-backups",
    excluded_apparent_bytes: partial ? "1000" : "0",
    sample: partial
      ? [
          {
            path_hex: "66696c65",
            apparent_bytes: "1000",
            acknowledgement_key: null,
          },
        ]
      : [],
  };
  return {
    backup_id: binding.backup_id,
    receipt,
    receipt_sha256: backupReportHeaderSha256(receipt),
  };
}
beforeEach(() => query.mockReset());

it("rejects protected partial coverage regardless of any warning acknowledgement", async () => {
  query.mockResolvedValue({ rows: [row(true)] });
  await expect(check()).rejects.toThrow(
    "Acknowledging a backup warning does not permit",
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).not.toMatch(/acknowledgement|UPDATE|DELETE/);
});

it("checks latest evidence under the expected placement and owning-bay predicate", async () => {
  query.mockResolvedValue({ rows: [row()] });
  await expect(check()).resolves.toBeUndefined();
  const [sql, params] = query.mock.calls[0];
  expect(params).toEqual([project, "bay-test", host]);
  expect(sql).toContain("p.deleted IS NOT true");
  expect(sql).toContain("COALESCE(p.owning_bay_id, $2)=$2");
  expect(sql).toContain("p.host_id IS NOT DISTINCT FROM $3::UUID");
  expect(sql).toContain(
    "ORDER BY captured_at DESC, created DESC, backup_id DESC LIMIT 1",
  );
});

it("preserves legacy checks when native coverage is not known, without manufacturing completeness", async () => {
  query.mockResolvedValue({ rows: [{ backup_id: null }] });
  await expect(check()).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledTimes(1);
});

it("rejects stale ownership/placement instead of interpreting it as no evidence", async () => {
  query.mockResolvedValue({ rows: [] });
  await expect(check()).rejects.toThrow("placement or owning bay changed");
});

it.each(["digest", "project", "backup"])(
  "rejects corrupt %s evidence",
  async (field) => {
    const value = row();
    if (field === "digest") value.receipt_sha256 = "f".repeat(64);
    if (field === "project") value.receipt.producer.binding.project_id = host;
    if (field === "backup") value.backup_id = "f".repeat(64);
    query.mockResolvedValue({ rows: [value] });
    await expect(check()).rejects.toThrow();
  },
);

it("propagates unavailable evidence rather than proceeding", async () => {
  query.mockRejectedValue(new Error("database unavailable"));
  await expect(check()).rejects.toThrow("database unavailable");
});

it("rejects malformed identities before accessing the database", async () => {
  await expect(
    assertNoKnownBackupExclusions({
      project_id: "invalid",
      expected_host_id: host,
    }),
  ).rejects.toThrow("identity");
  expect(query).not.toHaveBeenCalled();
});
