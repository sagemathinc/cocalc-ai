import {
  backupMaxFileBytes,
  BACKUP_CEILING_MAX_FILE_BYTES,
  BACKUP_DEFAULT_MAX_FILE_BYTES,
  BACKUP_MIN_MAX_FILE_BYTES,
  hasOversizedFiles,
  isOversizedFilesMessage,
  oversizedFilesMessage,
} from "./backups";

describe("backupMaxFileBytes", () => {
  it("is the disk quota, clamped", () => {
    expect(backupMaxFileBytes(40_000_000_000)).toBe(40_000_000_000);
    expect(backupMaxFileBytes(100_000_000)).toBe(BACKUP_MIN_MAX_FILE_BYTES);
    expect(backupMaxFileBytes(5 * 1000 ** 4)).toBe(
      BACKUP_CEILING_MAX_FILE_BYTES,
    );
  });

  it("uses the default when the quota is unknown", () => {
    for (const quota of [undefined, null, 0, -1, NaN, Infinity]) {
      expect(backupMaxFileBytes(quota)).toBe(BACKUP_DEFAULT_MAX_FILE_BYTES);
    }
  });
});

describe("hasOversizedFiles", () => {
  it("is true only for reports that list skipped files", () => {
    const report = { max_file_bytes: 1, count: 1, files: [] };
    expect(hasOversizedFiles(report)).toBe(true);
    expect(hasOversizedFiles({ ...report, count: 0 })).toBe(false);
    expect(hasOversizedFiles(null)).toBe(false);
    expect(hasOversizedFiles({ count: 2 })).toBe(false);
  });
});

describe("isOversizedFilesMessage", () => {
  const report = {
    count: 2,
    max_file_bytes: 10 * 1000 ** 3,
    files: [{ path: "data/big.bin", size: 11 * 1000 ** 3 }],
  };

  it("recognizes the refusal, also when wrapped in other errors", () => {
    const message = oversizedFilesMessage("archive this project", report);
    expect(isOversizedFilesMessage(message)).toBe(true);
    expect(
      isOversizedFilesMessage(
        `ProjectArchiveStorageError: FinalAutomaticArchiveBackupError: final automatic archive backup failed: Error: ${message}`,
      ),
    ).toBe(true);
    expect(
      isOversizedFilesMessage(
        oversizedFilesMessage("move this project", { ...report, count: 1 }),
      ),
    ).toBe(true);
  });

  it("does not match other failures", () => {
    for (const text of [
      "final automatic archive backup failed: timeout",
      "EFBIG: 'x' is larger than 10 bytes",
      undefined,
      null,
    ]) {
      expect(isOversizedFilesMessage(text)).toBe(false);
    }
  });
});
