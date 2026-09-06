import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupReportHeaderSha256 } from "./backup-exclusion-report";
import { withBackupExclusionIndex } from "./backup-exclusion-index";
import type { BackupExclusionIndex } from "./backup-exclusion-index";
import type { BackupExclusionBinding } from "@cocalc/util/types/backup-evidence";

let dir: string;
let paths: string[];
let spy: jest.SpyInstance;

async function fixture(count = 123, duplicate = false) {
  const header = {
    schema_version: 1,
    type: "header",
    exclude_larger_than_bytes: "4",
    max_report_bytes: "2097152",
    sources: [{ encoding: "unix-bytes-hex", value: "2e" }],
    save_options: {},
  };
  const records: unknown[] = [header];
  for (let i = 0; i < count; i++)
    records.push({
      schema_version: 1,
      type: "excluded",
      reason: "apparent_size",
      path: {
        encoding: "unix-bytes-hex",
        value: Buffer.concat([
          Buffer.from([255, 10]),
          Buffer.from(String(duplicate ? 0 : i)),
        ]).toString("hex"),
      },
      apparent_bytes: "1099511627776",
      file_version: {
        inode: String(i + 1),
        mtime_ns: "1",
        ctime_ns: "2",
        uid: 1000,
        gid: 1000,
        mode: 33188,
      },
    });
  records.push({
    schema_version: 1,
    type: "complete",
    inventory: {
      retained: {
        entries: "0",
        files: "0",
        apparent_bytes: "0",
        chunk_references_bound: "0",
        content_reference_bytes_bound: "0",
        node_metadata_bytes: "0",
        max_path_depth: "0",
      },
      inspected_entries: String(count),
      inspected_node_metadata_bytes: String(count * 100),
      inspected_max_path_depth: "1",
      excluded_files: String(count),
      excluded_apparent_bytes: String(BigInt(count) * 1099511627776n),
    },
  });
  const bytes = Buffer.from(
    records.map((r) => JSON.stringify(r) + "\n").join(""),
  );
  const path = join(dir, "report.ndjson");
  await writeFile(path, bytes, { mode: 0o600 });
  const binding: BackupExclusionBinding = {
    schema_version: 1,
    project_id: "00000000-0000-4000-8000-000000000001",
    backup_id: "a".repeat(64),
    source: {
      subvolume_uuid: "00000000-0000-4000-8000-000000000002",
      snapshot_uuid: "00000000-0000-4000-8000-000000000003",
      captured_at: "2026-09-05T00:00:00.000Z",
      generation: "9007199254740993",
    },
    policy_sha256: "b".repeat(64),
    report: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      header_sha256: backupReportHeaderSha256(header),
    },
  };
  return {
    path,
    binding,
    limits: {
      max_bytes: 2097152,
      max_record_bytes: 4096,
      max_entries: 5000,
      max_path_depth: 10,
    },
    max_index_bytes: 2097152,
    timeout_ms: 10000,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exclusion-index-test-"));
  paths = [];
  const original = filesystem.mkdtemp;
  spy = jest.spyOn(filesystem, "mkdtemp").mockImplementation((async (
    ...args: Parameters<typeof original>
  ) => {
    const path = await original(...args);
    paths.push(String(path));
    return path;
  }) as typeof original);
});

afterEach(async () => {
  spy.mockRestore();
  for (const path of paths)
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await rm(dir, { recursive: true, force: true });
});

it("indexes once, pages all raw paths and fences handles after the lease", async () => {
  const options = await fixture();
  let held!: BackupExclusionIndex;
  await withBackupExclusionIndex(options, async (index) => {
    held = index;
    expect((await stat(paths[0])).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths[0], "index.sqlite"))).mode & 0o777).toBe(
      0o600,
    );
    expect(index.bytes).toBeLessThanOrEqual(options.max_index_bytes);
    // Once built, pages do not read or rescan the source report.
    await rm(options.path);
    const first = index.page();
    expect(first.files).toHaveLength(50);
    expect(first.files[0].path_hex).toBe("ff0a30");
    expect(first.files[0].apparent_bytes).toBe("1099511627776");
    expect(first.files[0].acknowledgement_key).toMatch(/^[0-9a-f]{64}$/);
    const second = index.page(first.next_cursor);
    const third = index.page(second.next_cursor);
    expect(second.files).toHaveLength(50);
    expect(third.files).toHaveLength(23);
    expect(third.next_cursor).toBeNull();
    expect(
      new Set(
        [...first.files, ...second.files, ...third.files].map(
          (x) => x.path_hex,
        ),
      ).size,
    ).toBe(123);
    expect(index.has(first.files[0])).toBe(true);
    expect(index.has({ ...first.files[0], apparent_bytes: "5" })).toBe(false);
    expect(
      index.has({ ...first.files[0], acknowledgement_key: "f".repeat(64) }),
    ).toBe(false);
    first.files[0].path_hex = "00";
    expect(index.page().files[0].path_hex).toBe("ff0a30");
    index.inventory.excluded_files = "0";
    expect(index.page().excluded_files).toBe("123");
  });
  expect(() => held.page()).toThrow("lease has ended");
});

it.each([0, 1, 50, 100])(
  "handles exact page boundaries (%i entries)",
  async (count) => {
    await withBackupExclusionIndex(await fixture(count), async (index) => {
      let page = index.page();
      let total = page.files.length;
      while (page.next_cursor) {
        page = index.page(page.next_cursor);
        total += page.files.length;
      }
      expect(total).toBe(count);
      expect(index.inventory.excluded_files).toBe(String(count));
    });
  },
);

it("refuses malformed, cross-backup, out-of-range or imprecise cursors", async () => {
  await withBackupExclusionIndex(await fixture(), async (index) => {
    const cursor = index.page().next_cursor!;
    const prefix = cursor.split(":")[0];
    for (const value of [
      "",
      "../index.sqlite",
      "f".repeat(64) + ":50",
      prefix + ":0",
      prefix + ":123",
      prefix + ":9007199254740993",
      prefix + ":01",
      "x".repeat(101),
    ])
      expect(() => index.page(value)).toThrow("Invalid backup exclusion index");
  });
});

it.each(["hash", "footer", "bytes", "duplicate"])(
  "never exposes a provisional index on %s failure",
  async (failure) => {
    const options = await fixture(123, failure === "duplicate");
    if (failure === "hash") options.binding.report.sha256 = "f".repeat(64);
    if (failure === "bytes") options.binding.report.bytes++;
    if (failure === "footer") {
      const bytes = await readFile(options.path);
      await writeFile(
        options.path,
        bytes.subarray(0, bytes.lastIndexOf(10, bytes.length - 2) + 1),
      );
    }
    const consume = jest.fn();
    await expect(withBackupExclusionIndex(options, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
  },
);

it("bounds SQLite expansion, not just report size", async () => {
  const options = await fixture(1000);
  const consume = jest.fn();
  await expect(
    withBackupExclusionIndex({ ...options, max_index_bytes: 16384 }, consume),
  ).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it("removes the index on consumer failure and rejects cancelled leases", async () => {
  const options = await fixture();
  const controller = new AbortController();
  await expect(
    withBackupExclusionIndex(
      { ...options, signal: controller.signal },
      async (index) => {
        controller.abort(new Error("cancelled"));
        expect(() => index.page()).toThrow("cancelled");
        throw new Error("consumer failed");
      },
    ),
  ).rejects.toThrow("consumer failed");
});

it.each([0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
  "rejects an invalid index bound before staging (%s)",
  async (max_index_bytes) => {
    await expect(
      withBackupExclusionIndex(
        { ...(await fixture()), max_index_bytes },
        jest.fn(),
      ),
    ).rejects.toThrow();
    expect(paths).toHaveLength(0);
  },
);
