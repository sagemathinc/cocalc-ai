import {
  backupMaxFileBytes,
  BACKUP_CEILING_MAX_FILE_BYTES,
  BACKUP_DEFAULT_MAX_FILE_BYTES,
  BACKUP_MIN_MAX_FILE_BYTES,
  hasOversizedFiles,
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
