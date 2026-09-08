import { BackupExclusionCache } from "./backup-exclusion-cache";
import { BackupEvidenceCleanupError } from "./backup-exclusion-cleanup";
import { readIndexedBackupExclusionReport } from "./backup-exclusion-index";
import { withBackupEvidenceAbort } from "./backup-exclusion-store";
import type { BackupExclusionStoreOptions } from "./backup-exclusion-store";

jest.mock("./backup-exclusion-index", () => ({
  readIndexedBackupExclusionReport: jest.fn(),
}));
const read = jest.mocked(readIndexedBackupExclusionReport);
const limits = {
  max_reports: 1,
  max_report_bytes: 32768,
  max_index_bytes: 65536,
  lifetime_ms: 10000,
};
function options(id = "a"): BackupExclusionStoreOptions {
  return {
    download: {
      url: "https://example.test/report",
      headers: { authorization: "test" },
    },
    binding: {
      schema_version: 1,
      project_id: "00000000-0000-4000-8000-000000000001",
      backup_id: id.repeat(64),
      source: {
        subvolume_uuid: "00000000-0000-4000-8000-000000000002",
        snapshot_uuid: "00000000-0000-4000-8000-000000000003",
        captured_at: "2026-09-05T00:00:00.000Z",
        generation: "1",
      },
      policy_sha256: "b".repeat(64),
      report: {
        bytes: 1000,
        sha256: "c".repeat(64),
        header_sha256: "d".repeat(64),
      },
    },
    limits: {
      max_bytes: 32768,
      max_record_bytes: 4096,
      max_entries: 100,
      max_path_depth: 10,
    },
    timeout_ms: 10000,
  };
}
const page = { files: [], next_cursor: null, excluded_files: "0" };
let cache: BackupExclusionCache;
let cleaned: number;
beforeEach(() => {
  cleaned = 0;
  read.mockReset();
  read.mockImplementation(async (opts, consume) => {
    try {
      return await withBackupEvidenceAbort(opts.signal!, () =>
        consume({
          page: () => page,
          countAcknowledged: () => "0",
          reportChunk: () => ({
            data_base64: "eA==",
            next_offset: null,
            bytes: 1,
            sha256: "a".repeat(64),
          }),
          has: () => false,
          bytes: 4096,
          inventory: {} as any,
        }),
      );
    } finally {
      cleaned++;
    }
  });
  cache = new BackupExclusionCache(limits);
});
afterEach(async () => {
  await cache.close().catch(() => {});
});

it("coalesces pending and ready pages without rereading the object", async () => {
  const first = cache.page(options());
  const second = cache.page(options());
  expect(await first).toEqual({ ...page, acknowledged_files: "0" });
  expect(await second).toEqual({ ...page, acknowledged_files: "0" });
  await cache.page(options());
  expect(read).toHaveBeenCalledTimes(1);
  expect(cache.status.reserved_bytes).toBe(98304);
  expect(cleaned).toBe(0);
  await cache.close();
  expect(cleaned).toBe(1);
  expect(cache.status.reports).toBe(0);
  await expect(cache.page(options())).rejects.toThrow("closed");
});

it("rejects capacity overflow, including while a download is pending", async () => {
  read.mockImplementationOnce(async (opts) =>
    withBackupEvidenceAbort(opts.signal!, () => new Promise(() => {})),
  );
  const pending = cache.page(options());
  const rejection = expect(pending).rejects.toThrow("closed");
  await expect(cache.page(options("e"))).rejects.toThrow("busy");
  expect(read).toHaveBeenCalledTimes(1);
  await cache.close();
  await rejection;
  expect(cache.status.reports).toBe(0);
});

it("releases ordinary failed downloads but never an uncertain cleanup", async () => {
  read.mockRejectedValueOnce(new Error("download failed"));
  await expect(cache.page(options())).rejects.toThrow("download failed");
  // The caller sees the error before the cleanup-accounting finally callback.
  await new Promise(setImmediate);
  expect(cache.status.reports).toBe(0);
  read.mockRejectedValueOnce(
    new BackupEvidenceCleanupError(new Error("disk failure")),
  );
  await expect(cache.page(options())).rejects.toThrow("cleanup failed");
  await new Promise(setImmediate);
  expect(cache.status).toEqual({
    reports: 1,
    cleanup_failures: 1,
    reserved_bytes: 98304,
  });
  await expect(cache.page(options("e"))).rejects.toThrow("busy");
  await expect(cache.page(options())).rejects.toThrow("cleanup failed");
  await expect(cache.close()).rejects.toThrow("cleanup failed");
});

it("expires idle leases and awaits cleanup", async () => {
  await cache.close();
  cache = new BackupExclusionCache({ ...limits, lifetime_ms: 30 });
  await cache.page(options());
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(cleaned).toBe(1);
  expect(cache.status.reports).toBe(0);
});

it("captures binding, credentials and limits before yielding", async () => {
  const opts = options();
  const pending = cache.page(opts);
  opts.binding.source.generation = "2";
  opts.download!.headers.authorization = "changed";
  opts.limits.max_entries = 1;
  await pending;
  const captured = read.mock.calls[0][0];
  expect(captured.binding.source.generation).toBe("1");
  expect(captured.download!.headers.authorization).toBe("test");
  expect(captured.limits.max_entries).toBe(100);
});

it("refuses bad bindings/cursors/resource sizes without loading", async () => {
  await expect(cache.page(options(), "f".repeat(64) + ":1")).rejects.toThrow(
    "cursor",
  );
  const huge = options();
  huge.binding.report.bytes = 32769;
  await expect(cache.page(huge)).rejects.toThrow("resource limits");
  const broken = options();
  broken.binding.backup_id = "../";
  await expect(cache.page(broken)).rejects.toThrow("binding");
  const unclonable = options();
  (unclonable.binding as any).extra = () => {};
  await expect(cache.page(unclonable)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(cache.status.reports).toBe(0);
});

it.each([0, -1, NaN, Infinity, 1.5])(
  "rejects invalid cache limits %s",
  (value) => {
    expect(
      () => new BackupExclusionCache({ ...limits, max_reports: value }),
    ).toThrow("limits");
  },
);
