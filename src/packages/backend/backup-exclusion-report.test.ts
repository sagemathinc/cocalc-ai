import { createHash } from "node:crypto";
import {
  backupReportHeaderSha256,
  verifyBackupExclusionReport,
} from "./backup-exclusion-report";

function rows(): any[] {
  return [
    {
      schema_version: 1,
      type: "header",
      exclude_larger_than_bytes: "4",
      max_report_bytes: "32768",
      sources: [{ encoding: "unix-bytes-hex", value: "2e" }],
      normal_filters: {},
      excludes: {},
      save_options: {},
      admission: {},
    },
    {
      schema_version: 1,
      type: "excluded",
      reason: "apparent_size",
      path: {
        encoding: "unix-bytes-hex",
        value: Buffer.from("./big").toString("hex"),
      },
      apparent_bytes: "1099511627776",
      file_version: {
        inode: "9007199254740993",
        mtime_ns: "1788600000000000000",
        ctime_ns: "1788600000000000001",
        mode: 33188,
        uid: 1000,
        gid: 1000,
      },
    },
    {
      schema_version: 1,
      type: "complete",
      inventory: {
        retained: {
          entries: "1",
          files: "1",
          apparent_bytes: "4",
          chunk_references_bound: "1",
          content_reference_bytes_bound: "67",
          node_metadata_bytes: "100",
          max_path_depth: "1",
        },
        inspected_entries: "2",
        inspected_node_metadata_bytes: "200",
        inspected_max_path_depth: "1",
        excluded_files: "1",
        excluded_apparent_bytes: "1099511627776",
      },
    },
  ];
}

function encode(records: any[]): Buffer {
  return Buffer.from(
    records.map((value) => JSON.stringify(value) + "\n").join(""),
  );
}

async function* chunks(data: Buffer, fragment = 73): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.length; i += fragment)
    yield data.subarray(i, i + fragment);
}

function verify(
  records = rows(),
  options: Record<string, any> = {},
  data = encode(records),
) {
  return verifyBackupExclusionReport({
    chunks: chunks(data),
    sha256: createHash("sha256").update(data).digest("hex"),
    header_sha256: backupReportHeaderSha256(records[0]),
    policy_sha256: "a".repeat(64),
    max_bytes: 32768,
    max_record_bytes: 4096,
    max_entries: 10,
    max_path_depth: 10,
    ...options,
  });
}

it("verifies exact large counters with bounded samples even on one-byte chunks", async () => {
  const report = rows();
  const result = await verify(report, { chunks: chunks(encode(report), 1) });
  expect(result.excluded_apparent_bytes).toBe("1099511627776");
  expect(result.sample).toEqual([
    {
      path_hex: "626967",
      apparent_bytes: "1099511627776",
      acknowledgement_key: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  ]);
  expect((await verify(report, { sample_limit: 0 })).sample).toEqual([]);
});

it("keeps per-file presentation identity across reports but changes it for replacements and policy changes", async () => {
  const initial = await verify();
  const changed = rows();
  changed[1].file_version.ctime_ns = "1788600000000000002";
  expect((await verify(changed)).sample[0].acknowledgement_key).not.toBe(
    initial.sample[0].acknowledgement_key,
  );
  expect(
    (await verify(rows(), { policy_sha256: "b".repeat(64) })).sample[0]
      .acknowledgement_key,
  ).not.toBe(initial.sample[0].acknowledgement_key);
  const laterReport = rows();
  laterReport[0].admission = { "max-entries": "100" };
  expect((await verify(laterReport)).sample[0].acknowledgement_key).toBe(
    initial.sample[0].acknowledgement_key,
  );
});

it.each([null, "mtime", "no"])(
  "cannot acknowledge unknown or overridden ctime %s",
  async (value) => {
    const report = rows();
    if (value == null) report[1].file_version.ctime_ns = null;
    else report[0].save_options["set-ctime"] = value;
    expect((await verify(report)).sample[0].acknowledgement_key).toBeNull();
  },
);

it("does not alias hostile Linux names through text decoding", async () => {
  const report = rows();
  report[1].path.value = "ff0a2a3f";
  const first = await verify(report);
  report[1].path.value = "fe0a2a3f";
  expect(first.sample[0].path_hex).toBe("ff0a2a3f");
  expect((await verify(report)).sample[0].acknowledgement_key).not.toBe(
    first.sample[0].acknowledgement_key,
  );
});

it.each([
  "../secret",
  "/etc/passwd",
  "a/../../x",
  "a//b",
  "a/./b",
  "a/",
  ".",
  "a\0b",
])(
  "rejects escaping/noncanonical path %s without leaking it in the error",
  async (name) => {
    const report = rows();
    report[1].path.value = Buffer.from(name).toString("hex");
    await expect(verify(report)).rejects.toThrow(
      /^Invalid or incomplete backup exclusion evidence$/,
    );
  },
);

it.each([
  { sha256: "b".repeat(64) },
  { header_sha256: "b".repeat(64) },
  { max_bytes: 3000, max_record_bytes: 2000 },
  { max_record_bytes: 10 },
  { max_entries: 1 },
  { sample_limit: 101 },
  { max_path_depth: 0 },
])("rejects digest or budget mismatch %j", async (options) => {
  await expect(verify(rows(), options)).rejects.toThrow();
});

it.each([
  (r: any[]) => r.pop(),
  (r: any[]) => r.push(r[1]),
  (r: any[]) => r.splice(1, 0, r[0]),
  (r: any[]) => {
    r[2].inventory.excluded_files = "2";
  },
  (r: any[]) => {
    r[2].inventory.excluded_apparent_bytes = "1099511627777";
  },
  (r: any[]) => {
    r[2].inventory.inspected_entries = "1";
  },
  (r: any[]) => {
    r[2].inventory.retained.files = "2";
  },
  (r: any[]) => {
    r[2].inventory.retained.apparent_bytes = 4;
  },
  (r: any[]) => {
    r[1].apparent_bytes = "4";
  },
  (r: any[]) => {
    r[1].file_version.inode = "18446744073709551616";
  },
  (r: any[]) => {
    r[0].sources[0].value = "2e2e";
  },
])(
  "rejects incomplete or internally inconsistent evidence %#",
  async (mutate) => {
    const report = rows();
    mutate(report);
    await expect(verify(report)).rejects.toThrow();
  },
);

it("requires the complete footer and final newline even when the prefix digest matches", async () => {
  const report = rows();
  await expect(
    verify(report, {}, encode(report).subarray(0, -1)),
  ).rejects.toThrow();
  const data = Buffer.concat([encode(report), Buffer.from("\n")]);
  await expect(verify(report, {}, data)).rejects.toThrow();
});

it("propagates download failure rather than returning an already-seen footer", async () => {
  async function* failed() {
    yield encode(rows());
    throw new Error("download failed");
  }
  await expect(verify(rows(), { chunks: failed() })).rejects.toThrow(
    "download failed",
  );
});

it("accepts a completed empty exclusion list without implying restore capacity", async () => {
  const report = rows();
  report.splice(1, 1);
  report[1].inventory.excluded_files = "0";
  report[1].inventory.excluded_apparent_bytes = "0";
  report[1].inventory.inspected_entries = "1";
  const result = await verify(report);
  expect(result.excluded_files).toBe("0");
  expect(result).not.toHaveProperty("archive_ready");
});
