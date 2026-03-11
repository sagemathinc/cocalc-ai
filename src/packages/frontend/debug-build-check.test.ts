/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { FrontendSourceFingerprintInfo } from "@cocalc/conat/hub/api/system";
import { describeFrontendFingerprintMismatch } from "./debug-build-check";

function makeInfo(
  overrides: Partial<FrontendSourceFingerprintInfo> = {},
): FrontendSourceFingerprintInfo {
  return {
    available: true,
    fingerprint: "abc:10:src/packages/frontend/app.tsx",
    git_revision: "abcdef1234567890",
    latest_mtime_ms: 10,
    latest_mtime_iso: "2026-03-11T12:00:00.000Z",
    latest_path: "src/packages/frontend/app.tsx",
    watched_roots: ["src/packages/frontend"],
    scanned_file_count: 1,
    checked_at: "2026-03-11T12:00:00.000Z",
    ...overrides,
  };
}

describe("describeFrontendFingerprintMismatch", () => {
  it("reports a match when the fingerprints are equal", () => {
    const build = makeInfo();
    const source = makeInfo();
    expect(describeFrontendFingerprintMismatch(build, source)).toBe(
      "Frontend build fingerprint matches the current repo tree.",
    );
  });

  it("reports a HEAD change when the git revision changes", () => {
    const build = makeInfo();
    const source = makeInfo({
      fingerprint: "fed:10:src/packages/frontend/app.tsx",
      git_revision: "fedcba9876543210",
    });
    expect(describeFrontendFingerprintMismatch(build, source)).toContain(
      "repo HEAD changed",
    );
  });

  it("reports a dirty source tree when only the source timestamp changes", () => {
    const build = makeInfo();
    const source = makeInfo({
      fingerprint: "abc:20:src/packages/frontend/chat/message.tsx",
      latest_mtime_ms: 20,
      latest_mtime_iso: "2026-03-11T12:01:00.000Z",
      latest_path: "src/packages/frontend/chat/message.tsx",
    });
    expect(describeFrontendFingerprintMismatch(build, source)).toBe(
      "Repository files changed on disk after this tab loaded.",
    );
  });
});
