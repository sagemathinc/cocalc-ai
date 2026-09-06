import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  storeBackupExclusionReport,
  backupExclusionObjectKey,
} from "./backup-exclusion-store";
import {
  acceptBackupProducerEvidence,
  parseBackupProducerEvidence,
  validateBackupOutcomeReceipt,
} from "./backup-producer-evidence";

jest.mock("node:fs/promises", () => ({ lstat: jest.fn(), open: jest.fn() }));
jest.mock("./backup-exclusion-store", () => ({
  ...jest.requireActual("./backup-exclusion-store"),
  storeBackupExclusionReport: jest.fn(),
}));

const project = "00000000-0000-4000-8000-000000000001";
const backup = "b".repeat(64);
const raw = () => ({
  schema_version: 1,
  source: {
    subvolume_uuid: project,
    snapshot_uuid: "00000000-0000-4000-8000-000000000002",
    captured_at: "2026-09-05T00:00:00.000Z",
    generation: "9007199254740993",
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
  report_path: `/var/lib/cocalc-rustic-reports/${project}.ndjson`,
  read_limits: {
    max_bytes: 65536,
    max_record_bytes: 65536,
    max_entries: 1000,
    max_path_depth: 100,
  },
});

describe("protected backup producer evidence", () => {
  const receipt = () => {
    const producer = parseBackupProducerEvidence(raw(), project, backup);
    return {
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
    };
  };
  it("copies bounded durable metadata without extra fields", () => {
    const value = receipt();
    const result = validateBackupOutcomeReceipt(
      { ...value, secret: "ignored" },
      project,
    );
    expect(result).toEqual(value);
    value.sample[0].path_hex = "00";
    expect(result.sample[0].path_hex).toBe("66696c65");
  });
  it.each(["00", "2f66696c65", "2e2e2f66696c65", "612f2f62", "2e", "ff2f2e2e"])(
    "rejects unsafe durable sample path %s",
    (path_hex) => {
      const value = receipt();
      value.sample[0].path_hex = path_hex;
      expect(() => validateBackupOutcomeReceipt(value, project)).toThrow();
    },
  );
  it("rejects mismatched object binding, truncated sample and inconsistent totals", () => {
    const value = receipt();
    expect(() =>
      validateBackupOutcomeReceipt(
        { ...value, object_key: "other-project" },
        project,
      ),
    ).toThrow();
    expect(() =>
      validateBackupOutcomeReceipt({ ...value, sample: [] }, project),
    ).toThrow();
    expect(() =>
      validateBackupOutcomeReceipt(
        { ...value, excluded_apparent_bytes: "100" },
        project,
      ),
    ).toThrow();
    expect(() =>
      validateBackupOutcomeReceipt(
        { ...value, sample: Array(21).fill(value.sample[0]) },
        project,
      ),
    ).toThrow();
  });
  it("preserves exact generation and copies before caller mutation", () => {
    const input = raw();
    const parsed = parseBackupProducerEvidence(input, project, backup);
    input.source.generation = "1";
    input.read_limits.max_entries = 1;
    expect(parsed.binding.source.generation).toBe("9007199254740993");
    expect(parsed.read_limits.max_entries).toBe(1000);
  });

  it.each([
    { schema_version: 2 },
    { schema_version: true },
    { policy_version: 0 },
    { excluded_files: "01" },
    { excluded_files: "1001" },
    { excluded_files: "18446744073709551616" },
    { outcome: "complete" },
    { exclude_larger_than_bytes: "0" },
    { binary_sha256: "bad" },
    { report_path: "/etc/shadow" },
    { report_path: `/var/lib/cocalc-rustic-reports/../${project}.ndjson` },
    { report_path: `/var/lib/cocalc-rustic-reports/${project}.ndjson/other` },
    { report: { ...raw().report, bytes: 65537 } },
    { source: { ...raw().source, generation: 9007199254740992 } },
    { source: { ...raw().source, captured_at: "invalid" } },
    { read_limits: { ...raw().read_limits, max_entries: 0 } },
    { read_limits: { ...raw().read_limits, max_record_bytes: 65537 } },
  ])("rejects malformed producer envelope %j", (change) => {
    expect(() =>
      parseBackupProducerEvidence({ ...raw(), ...change }, project, backup),
    ).toThrow();
  });

  it.each([null, [], "string", false])(
    "rejects non-object input %j",
    (input) => {
      expect(() =>
        parseBackupProducerEvidence(input, project, backup),
      ).toThrow();
    },
  );

  it("validates externally supplied project and backup identity", () => {
    expect(() => parseBackupProducerEvidence(raw(), "bad", backup)).toThrow();
    expect(() =>
      parseBackupProducerEvidence(raw(), project, "short-id"),
    ).toThrow();
  });
});

describe("protected producer acceptance", () => {
  const record = jest.fn();
  const close = jest.fn();
  const stat = jest.fn();
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("report");
    },
  };
  const createReadStream = jest.fn(() => stream);
  const auth = {
    endpoint: "https://object.invalid",
    bucket: "test",
    accessKey: "test",
    secretKey: "test",
  };
  const accept = () =>
    acceptBackupProducerEvidence({
      evidence: parseBackupProducerEvidence(raw(), project, backup),
      auth,
      timeout_ms: 1000,
      record,
    });
  const goodStat = () => ({
    isFile: () => true,
    uid: 0,
    nlink: 1,
    mode: 0o440,
    size: 2000,
  });
  beforeEach(() => {
    jest.clearAllMocks();
    close.mockResolvedValue(undefined);
    stat.mockResolvedValue(goodStat());
    jest.mocked(lstat).mockResolvedValue({
      isDirectory: () => true,
      uid: 0,
      mode: 0o750,
    } as any);
    jest
      .mocked(open)
      .mockResolvedValue({ stat, createReadStream, close } as any);
    jest
      .mocked(storeBackupExclusionReport)
      .mockResolvedValue({ inventory: { excluded_files: "1" } } as any);
    record.mockResolvedValue(undefined);
  });

  it("waits for durable record after verified upload and keeps fd anchored", async () => {
    let release!: () => void;
    record.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = accept();
    await new Promise((resolve) => setImmediate(resolve));
    expect(record).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      raw().report_path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(createReadStream).toHaveBeenCalledWith({ autoClose: false });
    release();
    await pending;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { uid: 1000 },
    { mode: 0o640 },
    { nlink: 2 },
    { size: 1999 },
    { isFile: () => false },
  ])("rejects unprotected report inode %j", async (change) => {
    stat.mockResolvedValue({ ...goodStat(), ...change });
    await expect(accept()).rejects.toThrow();
    expect(storeBackupExclusionReport).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([{ uid: 1000 }, { mode: 0o770 }, { isDirectory: () => false }])(
    "rejects unprotected report directory %j",
    async (change) => {
      jest.mocked(lstat).mockResolvedValue({
        isDirectory: () => true,
        uid: 0,
        mode: 0o750,
        ...change,
      } as any);
      await expect(accept()).rejects.toThrow();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("does not record or succeed when upload fails", async () => {
    jest
      .mocked(storeBackupExclusionReport)
      .mockRejectedValue(new Error("upload failed"));
    await expect(accept()).rejects.toThrow("upload failed");
    expect(record).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not succeed when owning-bay recording fails", async () => {
    record.mockRejectedValue(new Error("database unavailable"));
    await expect(accept()).rejects.toThrow("database unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects disagreement between producer outcome and verified report", async () => {
    jest
      .mocked(storeBackupExclusionReport)
      .mockResolvedValue({ inventory: { excluded_files: "0" } } as any);
    await expect(accept()).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
