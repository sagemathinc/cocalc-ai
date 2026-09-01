/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  appendProjectRemediationApplyEvent,
  MAX_LEGACY_PROJECT_IMPORTS_PER_REQUEST,
  legacyProjectArchiveUncompressedBytes,
  legacyPublicPathTargetFromRetainedRecord,
  legacyPublicShareUrl,
  normalizeLegacyProjectImportIds,
  resolveLegacyPublicPathTarget,
  shouldReplayLegacyPublicPath,
} from ".";
import {
  isUnsupportedLegacyProxyPublicPath,
  legacyPublicPathSlugFromRecord,
  normalizeLegacyPublicPathDescription,
} from "./public-path-slugs";

describe("legacy migration manifest helpers", () => {
  it("preserves every remediation apply audit event", () => {
    const first = {
      applied_at: "2026-09-01T00:00:00.000Z",
      actor_account_id: "admin-1",
      authority_account_id: "owner-1",
      reason: "Restore after support review",
      support_reference: "Zendesk 20655",
      snapshot_name: "final-archive",
      safety_snapshot_name: "before-apply-1",
      diff_counts: { add: 1 },
      diff_file_count: 1,
      truncated: false,
    };
    const second = {
      ...first,
      applied_at: "2026-09-01T01:00:00.000Z",
      actor_account_id: "collaborator-1",
      reason: null,
      support_reference: null,
      safety_snapshot_name: "before-apply-2",
    };

    const metadata = appendProjectRemediationApplyEvent(
      appendProjectRemediationApplyEvent({}, first),
      second,
    );

    expect(metadata.apply_events).toEqual([first, second]);
  });

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
  it("drops historically disabled public paths from replay", () => {
    expect(shouldReplayLegacyPublicPath({ disabled: true })).toBe(false);
    expect(shouldReplayLegacyPublicPath({ disabled: "t" })).toBe(false);
    expect(shouldReplayLegacyPublicPath({ disabled: false })).toBe(true);
  });

  it("rejects unsupported legacy GitHub and gist proxy URLs", () => {
    expect(
      isUnsupportedLegacyProxyPublicPath({ url: "github/search/example" }),
    ).toBe(true);
    expect(
      isUnsupportedLegacyProxyPublicPath({
        url: "https://cocalc.com/gist/example/revision/file.ipynb",
      }),
    ).toBe(true);
    expect(
      isUnsupportedLegacyProxyPublicPath({
        url: "course/github/example",
        path: "github/example",
      }),
    ).toBe(false);
    expect(isUnsupportedLegacyProxyPublicPath({ path: "github/example" })).toBe(
      false,
    );
    expect(
      legacyPublicPathSlugFromRecord({ url: "gist/example/revision" }),
    ).toBeNull();
    expect(
      legacyPublicShareUrl({
        legacy_public_path_id: "proxy-row",
        payload: { url: "github/search/example" },
      }),
    ).toBeNull();
  });

  it("preserves exact files from current and older retained records", () => {
    expect(
      legacyPublicPathTargetFromRetainedRecord({
        path: ".",
        original_path: "admcycles tutorial.ipynb",
        original_path_type: "file",
      }),
    ).toEqual({ path: "admcycles tutorial.ipynb", path_type: "file" });
    expect(
      legacyPublicPathTargetFromRetainedRecord({
        path: "course/lesson.ipynb",
      }),
    ).toEqual({ path: "course/lesson.ipynb", path_type: "file" });
  });

  it("marks retained paths unavailable when they are absent after restore", async () => {
    await expect(
      resolveLegacyPublicPathTarget({
        row: {
          original_path: "missing/notebooks",
          original_path_type: "directory",
        },
        fs: {
          lstat: async () => {
            throw Object.assign(new Error("no such file or directory"), {
              code: "ENOENT",
            });
          },
        } as any,
        restoreComplete: true,
      }),
    ).resolves.toEqual({
      target: { path: "missing/notebooks", path_type: "directory" },
      availability_status: "unavailable",
      availability_message:
        "The published path was not found in the restored project.",
    });
  });

  it("keeps retained paths pending until restore inspection is possible", async () => {
    await expect(
      resolveLegacyPublicPathTarget({
        row: {
          original_path: "notebooks",
          original_path_type: "directory",
        },
        restoreComplete: false,
      }),
    ).resolves.toEqual({
      target: { path: "notebooks", path_type: "directory" },
      availability_status: "pending",
      availability_message:
        "This legacy project has been selected for migration, but its files have not finished restoring yet.",
    });
  });

  it("does not infer ambiguous older records as directories", () => {
    expect(
      legacyPublicPathTargetFromRetainedRecord({ path: "ambiguous-path" }),
    ).toBeUndefined();
  });

  it("normalizes escaped legacy public path description newlines", () => {
    expect(
      normalizeLegacyPublicPathDescription(
        "First paragraph.\\n\\nSecond paragraph.\\n- item",
      ),
    ).toBe("First paragraph.\n\nSecond paragraph.\n- item");
    expect(normalizeLegacyPublicPathDescription("\\newcommand")).toBe(
      "\\newcommand",
    );
  });

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

  it("skips malformed retained slugs instead of aborting replay", () => {
    expect(
      legacyPublicPathSlugFromRecord(
        { name: "../private" },
        { owner_name: "owner", project_name: "project" },
      ),
    ).toBeNull();
    expect(
      legacyPublicPathSlugFromRecord({
        url: "https://cocalc.ai/share/owner//bad-share",
      }),
    ).toBeNull();
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

  it("reconstructs historical public URLs for the migration inventory", () => {
    expect(
      legacyPublicShareUrl({
        legacy_public_path_id: "0a48957b67f375b9e3107216504ca0c4efb678fd",
        payload: {
          original_path: "tutorials/JFM Notebooks.ipynb",
          original_path_type: "file",
        },
      }),
    ).toBe(
      "https://cocalc.com/share/public_paths/0a48957b67f375b9e3107216504ca0c4efb678fd/files/tutorials/JFM%20Notebooks.ipynb",
    );
  });

  it("normalizes cocalc.ai share URLs to the stored share slug", () => {
    expect(
      legacyPublicPathSlugFromRecord({
        url: "https://cocalc.ai/share/Cambridge/S0022112023010078/JFM-Notebooks",
      }),
    ).toBe("Cambridge/S0022112023010078/JFM-Notebooks");
  });
});
