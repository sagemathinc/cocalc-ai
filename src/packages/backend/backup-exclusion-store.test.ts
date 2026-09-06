import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { dirname } from "node:path";
import { backupReportHeaderSha256 } from "./backup-exclusion-report";
import {
  backupExclusionObjectKey,
  readBackupExclusionReport,
  storeBackupExclusionReport,
} from "./backup-exclusion-store";
import type { BackupExclusionBinding } from "./backup-exclusion-store";
import { getR2ObjectToFile, putR2ObjectFromFile } from "./r2";

jest.mock("./r2", () => ({
  getR2ObjectToFile: jest.fn(),
  putR2ObjectFromFile: jest.fn(),
}));

const put = jest.mocked(putR2ObjectFromFile);
const get = jest.mocked(getR2ObjectToFile);
const stored = new Map<string, Buffer>();
let temporaryPaths: string[];
let temporaryDirs: string[];
let tempSpy: jest.SpyInstance;
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const header = {
    schema_version: 1,
    type: "header",
    exclude_larger_than_bytes: "4",
    max_report_bytes: "32768",
    sources: [{ encoding: "unix-bytes-hex", value: "2e" }],
    save_options: {},
    normal_filters: {},
    excludes: {},
    admission: {},
  };
  const bytes = Buffer.from(
    [
      header,
      {
        schema_version: 1,
        type: "excluded",
        reason: "apparent_size",
        path: { encoding: "unix-bytes-hex", value: "ff0a2a" },
        apparent_bytes: "1099511627776",
        file_version: {
          inode: "9007199254740993",
          mtime_ns: "1",
          ctime_ns: "2",
          uid: 1000,
          gid: 1000,
          mode: 33188,
        },
      },
      {
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
          inspected_entries: "1",
          inspected_node_metadata_bytes: "100",
          inspected_max_path_depth: "1",
          excluded_files: "1",
          excluded_apparent_bytes: "1099511627776",
        },
      },
    ]
      .map((row) => JSON.stringify(row) + "\n")
      .join(""),
  );
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
      sha256: hash(bytes),
      header_sha256: backupReportHeaderSha256(header),
      bytes: bytes.length,
    },
  };
  return { bytes, binding };
}

function options(binding = fixture().binding) {
  return {
    auth: {
      endpoint: "https://example.test",
      accessKey: "test",
      secretKey: "test",
      bucket: "backups",
    },
    binding,
    limits: {
      max_bytes: 32768,
      max_record_bytes: 4096,
      max_entries: 10,
      max_path_depth: 10,
    },
    timeout_ms: 1000,
  };
}

async function* chunks(bytes = fixture().bytes) {
  yield bytes;
}

beforeEach(() => {
  jest.resetAllMocks();
  stored.clear();
  temporaryPaths = [];
  temporaryDirs = [];
  const original = filesystem.mkdtemp;
  tempSpy = jest.spyOn(filesystem, "mkdtemp").mockImplementation((async (
    ...args: Parameters<typeof original>
  ) => {
    const path = await original(...args);
    temporaryDirs.push(path as string);
    return path;
  }) as typeof original);
  put.mockImplementation(
    async ({ key, filePath, payloadSha256, contentLength, signal }) => {
      signal?.throwIfAborted();
      temporaryPaths.push(filePath);
      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      const bytes = await readFile(filePath);
      expect(hash(bytes)).toBe(payloadSha256);
      expect(bytes.length).toBe(contentLength);
      stored.set(key, bytes);
    },
  );
  get.mockImplementation(async ({ key, outputPath, maxBytes, signal }) => {
    signal?.throwIfAborted();
    temporaryPaths.push(outputPath);
    const bytes = stored.get(key);
    if (!bytes) throw new Error("not found");
    if (maxBytes == null || bytes.length > maxBytes)
      throw new Error("byte limit");
    await writeFile(outputPath, bytes);
    return { sha256: hash(bytes), bytes: bytes.length };
  });
});

afterEach(async () => {
  tempSpy.mockRestore();
  for (const dir of temporaryDirs)
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  for (const path of temporaryPaths)
    await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
});

it("stores and independently reads a bound, lossless report with private bounded staging", async () => {
  const receipt = await storeBackupExclusionReport({
    ...options(),
    chunks: chunks(),
  });
  expect(receipt.inventory.excluded_apparent_bytes).toBe("1099511627776");
  expect(receipt.inventory.sample[0].path_hex).toBe("ff0a2a");
  expect(put).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
  expect(receipt.object_key).toMatch(
    /^project-backup-exclusions\/v1\/.*\.ndjson$/,
  );
  const downloaded = await readBackupExclusionReport(
    options(),
    async (metadata, stream) => {
      expect(metadata).toEqual(receipt);
      const parts: Buffer[] = [];
      for await (const part of stream) parts.push(Buffer.from(part));
      return Buffer.concat(parts);
    },
  );
  expect(downloaded).toEqual(fixture().bytes);
});

it.each(["backup", "project", "source", "policy", "header"])(
  "separates %s bindings even for identical report bytes",
  (field) => {
    const { binding } = fixture();
    const original = backupExclusionObjectKey(binding);
    if (field === "backup") binding.backup_id = "d".repeat(64);
    if (field === "project") binding.project_id = binding.source.subvolume_uuid;
    if (field === "source") binding.source.generation = "9007199254740994";
    if (field === "policy") binding.policy_sha256 = "d".repeat(64);
    if (field === "header") binding.report.header_sha256 = "d".repeat(64);
    expect(backupExclusionObjectKey(binding)).not.toBe(original);
  },
);

it.each(["prefix", "digest", "header", "extra", "budget", "binding-size"])(
  "rejects %s evidence before upload",
  async (fault) => {
    const opt = options();
    let bytes = fixture().bytes;
    if (fault === "prefix")
      bytes = bytes.subarray(0, bytes.lastIndexOf(10, bytes.length - 2) + 1);
    if (fault === "digest") opt.binding.report.sha256 = "f".repeat(64);
    if (fault === "header") opt.binding.report.header_sha256 = "f".repeat(64);
    if (fault === "extra") bytes = Buffer.concat([bytes, Buffer.from("x")]);
    if (fault === "budget") opt.limits.max_bytes = 10;
    if (fault === "binding-size") opt.binding.report.bytes += 1;
    await expect(
      storeBackupExclusionReport({ ...opt, chunks: chunks(bytes) }),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  },
);

it("does not publish a receipt when storage readback fails", async () => {
  get.mockRejectedValueOnce(new Error("offline"));
  await expect(
    storeBackupExclusionReport({ ...options(), chunks: chunks() }),
  ).rejects.toThrow("offline");
  expect(put).toHaveBeenCalledTimes(1);
});

it("does not expose a corrupt object to the consumer, even when storage lies about its hash", async () => {
  await storeBackupExclusionReport({ ...options(), chunks: chunks() });
  get.mockImplementationOnce(async ({ outputPath }) => {
    temporaryPaths.push(outputPath);
    await writeFile(outputPath, Buffer.alloc(fixture().bytes.length, 65));
    return {
      sha256: fixture().binding.report.sha256,
      bytes: fixture().bytes.length,
    };
  });
  const consume = jest.fn();
  await expect(readBackupExclusionReport(options(), consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it("cleans private staging when a download consumer fails", async () => {
  await storeBackupExclusionReport({ ...options(), chunks: chunks() });
  await expect(
    readBackupExclusionReport(options(), async () => {
      throw new Error("consumer failed");
    }),
  ).rejects.toThrow("consumer failed");
});

it("captures binding fields before asynchronous producers can mutate caller objects", async () => {
  const opt = options();
  const expected = backupExclusionObjectKey(opt.binding);
  async function* mutating() {
    opt.binding.backup_id = "f".repeat(64);
    opt.binding.source.generation = "42";
    yield fixture().bytes;
  }
  const receipt = await storeBackupExclusionReport({
    ...opt,
    chunks: mutating(),
  });
  expect(receipt.object_key).toBe(expected);
  expect(receipt.binding.backup_id).toBe("a".repeat(64));
});

it("aborts a stalled input without uploading a provisional report", async () => {
  async function* stalled() {
    await new Promise(() => {});
    yield Buffer.from("never");
  }
  await expect(
    storeBackupExclusionReport({
      ...options(),
      timeout_ms: 20,
      chunks: stalled(),
    }),
  ).rejects.toThrow();
  expect(put).not.toHaveBeenCalled();
}, 2000);

it("cleans staging when constructing the input iterator throws", async () => {
  const input = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      throw new Error("producer setup failed");
    },
  };
  await expect(
    storeBackupExclusionReport({ ...options(), chunks: input }),
  ).rejects.toThrow("producer setup failed");
  expect(put).not.toHaveBeenCalled();
});

it.each(["../outside", "A".repeat(64), "abc"])(
  "rejects invalid backup identifier %s before any storage access",
  async (id) => {
    const opt = options();
    opt.binding.backup_id = id;
    await expect(
      storeBackupExclusionReport({ ...opt, chunks: chunks() }),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  },
);
