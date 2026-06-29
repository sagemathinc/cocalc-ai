/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST,
  legacyProjectArchiveUncompressedBytes,
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
});
