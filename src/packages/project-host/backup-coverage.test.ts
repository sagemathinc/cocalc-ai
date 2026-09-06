import { ProjectBackupCoverage } from "./backup-coverage";
import { BackupExclusionCache } from "@cocalc/backend/backup-exclusion-cache";
import { backupExclusionObjectKey } from "@cocalc/backend/backup-exclusion-store";
import { parseBackupProducerEvidence } from "@cocalc/backend/backup-producer-evidence";

jest.mock("@cocalc/backend/backup-exclusion-cache");
const project_id = "00000000-0000-4000-8000-000000000001";
const backup_id = "b".repeat(64);
function outcome() {
  const producer = parseBackupProducerEvidence(
    {
      schema_version: 1,
      source: {
        subvolume_uuid: project_id,
        snapshot_uuid: "00000000-0000-4000-8000-000000000002",
        captured_at: "2026-09-05T00:00:00.000Z",
        generation: "1",
      },
      policy_sha256: "a".repeat(64),
      policy_version: 1,
      exclude_larger_than_bytes: "100",
      binary_sha256: "c".repeat(64),
      outcome: "partial_policy_exclusions",
      excluded_files: "1",
      report: {
        bytes: 2000,
        sha256: "d".repeat(64),
        header_sha256: "e".repeat(64),
      },
      report_path: `/var/lib/cocalc-rustic-reports/${project_id}.ndjson`,
      read_limits: {
        max_bytes: 65536,
        max_record_bytes: 65536,
        max_entries: 1000,
        max_path_depth: 100,
      },
    },
    project_id,
    backup_id,
  );
  return {
    receipt: {
      producer,
      bucket: "test-backups",
      object_key: backupExclusionObjectKey(producer.binding),
      excluded_apparent_bytes: "101",
      sample: [
        {
          path_hex: "66696c65",
          apparent_bytes: "101",
          acknowledgement_key: null,
        },
      ],
    },
    report_download: {
      url: "https://example.test/report",
      headers: { authorization: "test" },
    },
  };
}
let access: jest.Mock;
let browser: ProjectBackupCoverage;
let page: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  access = jest.fn().mockResolvedValue(outcome());
  browser = new ProjectBackupCoverage(access, {
    max_reports: 2,
    max_report_bytes: 65536,
    max_index_bytes: 65536,
    lifetime_ms: 1000,
  });
  page = jest.mocked(BackupExclusionCache).mock.instances[0].page as jest.Mock;
  page.mockResolvedValue({
    files: outcome().receipt.sample,
    excluded_files: "1",
    next_cursor: null,
  });
});

it("uses protected evidence and returns only bounded public fields", async () => {
  const result = await browser.page({ project_id });
  expect(result).toMatchObject({
    project_id,
    backup_id,
    outcome: "partial_policy_exclusions",
    excluded_files: "1",
  });
  expect(page).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: outcome().receipt.producer.binding,
      download: outcome().report_download,
    }),
    undefined,
  );
  expect(JSON.stringify(result)).not.toContain("authorization");
  expect(JSON.stringify(result)).not.toContain("report_path");
  expect(JSON.stringify(result)).not.toContain("test-backups");
});

it("reauthorizes cache hits and refuses revoked host placement", async () => {
  await browser.page({ project_id });
  access.mockRejectedValueOnce(new Error("host placement changed"));
  await expect(browser.page({ project_id })).rejects.toThrow(
    "placement changed",
  );
  expect(access).toHaveBeenCalledTimes(2);
  expect(page).toHaveBeenCalledTimes(1);
});

it("does not call unknown or legacy evidence complete", async () => {
  access.mockResolvedValueOnce(null);
  await expect(browser.page({ project_id })).resolves.toBeNull();
  expect(page).not.toHaveBeenCalled();
});

it("requires snapshot-pinned pagination and rejects malformed identity before access", async () => {
  await expect(browser.page({ project_id, cursor: "cursor" })).rejects.toThrow(
    "exact snapshot",
  );
  await expect(browser.page({ project_id: "other" })).rejects.toThrow(
    "project",
  );
  await expect(browser.page({ project_id, backup_id: "../" })).rejects.toThrow(
    "snapshot",
  );
  expect(access).not.toHaveBeenCalled();
  await browser.page({ project_id, backup_id, cursor: "cursor" });
  expect(access).toHaveBeenCalledWith({ project_id, backup_id });
});

it("fails closed for mismatched snapshot/count or absent signed access", async () => {
  await expect(
    browser.page({ project_id, backup_id: "c".repeat(64) }),
  ).rejects.toThrow("mismatch");
  access.mockResolvedValueOnce({ receipt: outcome().receipt });
  await expect(browser.page({ project_id })).rejects.toThrow(
    "access is unavailable",
  );
  page.mockResolvedValueOnce({
    files: [],
    excluded_files: "0",
    next_cursor: null,
  });
  await expect(browser.page({ project_id })).rejects.toThrow("count");
});
