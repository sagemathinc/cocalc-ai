/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST,
  legacyProjectArchiveUncompressedBytes,
  normalizeLegacyProjectImportIds,
} from ".";
import { legacyPublicPathSlugFromRecord } from "./public-path-slugs";

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

describe("legacy public path slug helpers", () => {
  it("reconstructs legacy public URLs from owner name, project URL name, and public path name", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        {
          name: "JFM-Notebooks",
          path: "JFM-Notebooks",
          project_id: "69ad6ede-eb83-4733-aff0-afb8feb191b6",
          slug: "JFM-Notebooks",
        },
        {
          owner_name: "Cambridge",
          project_name: "S0022112023010078",
        },
      ),
    ).toBe("Cambridge/S0022112023010078/JFM-Notebooks");
  });

  it("uses legacy project URL names rather than project titles or paths", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        {
          name: "examples",
          path: "support",
          project_id: "4a5f0542-5873-4eed-a85c-a18c706e8bcd",
        },
        {
          owner_name: "wstein",
          project_name: "support",
        },
      ),
    ).toBe("wstein/support/examples");
  });

  it("falls back to the legacy project id when the project URL name is missing", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        {
          name: "examples",
          path: "support",
          project_id: "4a5f0542-5873-4eed-a85c-a18c706e8bcd",
        },
        {
          owner_name: "wstein",
        },
      ),
    ).toBe("wstein/4a5f0542-5873-4eed-a85c-a18c706e8bcd/examples");
  });

  it("does not invent owner/project URL segments without owner context", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        {
          name: "examples",
          path: "support",
          project_id: "4a5f0542-5873-4eed-a85c-a18c706e8bcd",
        },
        {},
      ),
    ).toBe("examples");
  });

  it("preserves explicit legacy URL paths when present", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        {
          url: "https://cocalc.com/Cambridge/S0022112023010078/JFM-Notebooks",
          slug: "JFM-Notebooks",
        },
        {
          owner_name: "Wrong",
          project_name: "Wrong",
        },
      ),
    ).toBe("Cambridge/S0022112023010078/JFM-Notebooks");
  });

  it("normalizes cocalc.ai share URLs to the stored share slug", () => {
    expect(
      legacyPublicPathSlugFromRecord({
        url: "https://cocalc.ai/share/Cambridge/S0022112023010078/JFM-Notebooks",
      }),
    ).toBe("Cambridge/S0022112023010078/JFM-Notebooks");
  });
});
