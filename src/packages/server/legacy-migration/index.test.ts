/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyProjectArchiveUncompressedBytes } from ".";

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
});
