/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { getFrontendSourceFingerprintSync } from "./frontend-build-fingerprint";

describe("getFrontendSourceFingerprintSync", () => {
  it("tracks the newest repo file and ignores node_modules", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "frontend-fingerprint-"));
    try {
      const frontendRoot = join(repoRoot, "src", "packages", "frontend");
      const utilRoot = join(repoRoot, "src", "packages", "util");
      const nodeModulesRoot = join(frontendRoot, "node_modules");
      mkdirSync(frontendRoot, { recursive: true });
      mkdirSync(utilRoot, { recursive: true });
      mkdirSync(nodeModulesRoot, { recursive: true });

      const older = join(frontendRoot, "entry.tsx");
      const newest = join(utilRoot, "theme.ts");
      const ignored = join(nodeModulesRoot, "ignored.js");
      writeFileSync(older, "export const older = true;\n");
      writeFileSync(newest, "export const newest = true;\n");
      writeFileSync(ignored, "export const ignored = true;\n");

      utimesSync(older, 1, 10);
      utimesSync(newest, 1, 20);
      utimesSync(ignored, 1, 30);

      const info = getFrontendSourceFingerprintSync({
        repoRoot,
        sourceRoots: [frontendRoot, utilRoot],
        now: new Date("2026-03-11T12:00:00.000Z"),
      });

      expect(info.available).toBe(true);
      expect(info.latest_path).toBe("src/packages/util/theme.ts");
      expect(info.latest_mtime_ms).toBeCloseTo(20_000);
      expect(info.watched_roots).toEqual([
        "src/packages/frontend",
        "src/packages/util",
      ]);
      expect(info.fingerprint).toContain("src/packages/util/theme.ts");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports unavailable when no source roots exist", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "frontend-fingerprint-empty-"));
    try {
      const info = getFrontendSourceFingerprintSync({
        repoRoot,
        sourceRoots: [],
        now: new Date("2026-03-11T12:00:00.000Z"),
      });

      expect(info.available).toBe(false);
      expect(info.reason).toBe("no repo roots found");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("respects a single configured source root when git ls-files is available", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "frontend-fingerprint-git-"));
    try {
      execSync("git init -q", { cwd: repoRoot, stdio: "ignore" });
      const frontendRoot = join(repoRoot, "src", "packages", "frontend");
      const docsRoot = join(repoRoot, "docs");
      mkdirSync(frontendRoot, { recursive: true });
      mkdirSync(docsRoot, { recursive: true });

      const watched = join(frontendRoot, "entry.tsx");
      const unrelated = join(docsRoot, "notes.md");
      writeFileSync(watched, "export const watched = true;\n");
      writeFileSync(unrelated, "updated docs\n");

      utimesSync(watched, 1, 10);
      utimesSync(unrelated, 1, 20);

      const info = getFrontendSourceFingerprintSync({
        repoRoot,
        sourceRoots: [frontendRoot],
        now: new Date("2026-03-15T12:00:00.000Z"),
      });

      expect(info.available).toBe(true);
      expect(info.latest_path).toBe("src/packages/frontend/entry.tsx");
      expect(info.watched_roots).toEqual(["src/packages/frontend"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
