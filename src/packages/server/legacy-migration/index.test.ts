/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  MAX_LEGACY_ARCHIVE_SELECTION_PATH_LENGTH,
  MAX_LEGACY_ARCHIVE_SELECTION_PATHS,
  MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST,
  legacyProjectArchiveUncompressedBytes,
  normalizeLegacyArchiveSelectionPathList,
  normalizeLegacyProjectImportIds,
} from ".";

describe("legacy migration manifest helpers", () => {
  it("extracts advisory uncompressed project archive sizes", () => {
    expect(
      legacyProjectArchiveUncompressedBytes({ uncompressed_bytes: 123 }),
    ).toBe(123);
    expect(
      legacyProjectArchiveUncompressedBytes({
        archive: { tar_bytes: "456" },
      }),
    ).toBe(456);
    expect(
      legacyProjectArchiveUncompressedBytes({
        stats: { total_file_bytes: 789.9 },
      }),
    ).toBe(789);
  });

  it("ignores missing or invalid archive sizes", () => {
    expect(legacyProjectArchiveUncompressedBytes(null)).toBeUndefined();
    expect(legacyProjectArchiveUncompressedBytes({})).toBeUndefined();
    expect(
      legacyProjectArchiveUncompressedBytes({ uncompressed_bytes: -1 }),
    ).toBeUndefined();
    expect(
      legacyProjectArchiveUncompressedBytes({ uncompressed_bytes: "nope" }),
    ).toBeUndefined();
  });

  it("normalizes and bounds project import request ids", () => {
    expect(normalizeLegacyProjectImportIds([" a ", "b", "a", ""])).toEqual([
      "a",
      "b",
    ]);
    expect(() => normalizeLegacyProjectImportIds([])).toThrow(
      "select at least one legacy project",
    );
    expect(() =>
      normalizeLegacyProjectImportIds(
        Array.from(
          { length: MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST + 1 },
          (_, i) => `project-${i}`,
        ),
      ),
    ).toThrow(
      `import at most ${MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST} legacy projects at a time`,
    );
  });

  it("normalizes and bounds selective restore paths", () => {
    expect(
      normalizeLegacyArchiveSelectionPathList([" a ", "b", "a", ""], "paths"),
    ).toEqual(["a", "b"]);
    expect(
      normalizeLegacyArchiveSelectionPathList(undefined, "paths"),
    ).toBeUndefined();
    expect(() =>
      normalizeLegacyArchiveSelectionPathList(
        Array.from(
          { length: MAX_LEGACY_ARCHIVE_SELECTION_PATHS + 1 },
          (_, i) => `path-${i}`,
        ),
        "include_paths",
      ),
    ).toThrow(
      `include_paths can include at most ${MAX_LEGACY_ARCHIVE_SELECTION_PATHS} paths`,
    );
    expect(() =>
      normalizeLegacyArchiveSelectionPathList(
        ["x".repeat(MAX_LEGACY_ARCHIVE_SELECTION_PATH_LENGTH + 1)],
        "exclude_paths",
      ),
    ).toThrow(
      `exclude_paths contains a path longer than ${MAX_LEGACY_ARCHIVE_SELECTION_PATH_LENGTH} characters`,
    );
    expect(() =>
      normalizeLegacyArchiveSelectionPathList(["bad\0path"], "paths"),
    ).toThrow("paths contains a path with a NUL byte");
  });
});
