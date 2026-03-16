/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment jsdom */

import type { FrontendSourceFingerprintInfo } from "@cocalc/conat/hub/api/system";
import {
  createMismatchSignature,
  describeFrontendFingerprintMismatch,
  hideBanner,
  renderBanner,
  resetDebugBuildCheckBannerState,
} from "./debug-build-check";

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
  beforeEach(() => {
    resetDebugBuildCheckBannerState();
  });

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

describe("stale-build banner controls", () => {
  beforeEach(() => {
    resetDebugBuildCheckBannerState();
  });

  it("uses a stable mismatch signature", () => {
    expect(createMismatchSignature(makeInfo(), makeInfo())).toBe(
      "abc:10:src/packages/frontend/app.tsx::abc:10:src/packages/frontend/app.tsx",
    );
  });

  it("cleans up the banner when hidden", () => {
    document.body.innerHTML =
      '<div id="cocalc-debug-build-warning" style="display:block"></div>';
    hideBanner();
    const banner = document.getElementById("cocalc-debug-build-warning");
    expect(banner?.style.display).toBe("none");
  });

  it("renders a dismiss button that hides the current mismatch banner", () => {
    renderBanner({
      checked_at: "2026-03-15T12:00:00.000Z",
      build: makeInfo(),
      source: makeInfo({
        fingerprint: "abc:20:src/packages/frontend/chat/message.tsx",
        latest_mtime_ms: 20,
        latest_mtime_iso: "2026-03-15T12:01:00.000Z",
        latest_path: "src/packages/frontend/chat/message.tsx",
      }),
      mismatch: true,
      summary: "Repository files changed on disk after this tab loaded.",
    });

    const banner = document.getElementById("cocalc-debug-build-warning");
    expect(banner).toBeTruthy();
    const dismiss = document.querySelector(
      'button[aria-label="Dismiss stale frontend build warning"]',
    ) as HTMLButtonElement | null;
    expect(dismiss).toBeTruthy();
    dismiss?.click();
    expect(banner?.style.display).toBe("none");
  });
});
