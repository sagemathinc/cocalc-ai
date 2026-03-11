/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppTemplateCatalogEntry } from "@cocalc/conat/project/api/apps";
import { detectInstalledTemplatesFromCatalog } from "./control";

describe("catalog-driven template detection", () => {
  const runner = jest.fn(
    async ({ cmd }: { cmd: string; timeoutMs?: number }) =>
      ({
        "command -v missing-tool": {
          available: false,
          status: "missing" as const,
          details: "missing-tool not found in PATH",
        },
        "command -v present-tool": {
          available: true,
          status: "available" as const,
          details: "/usr/bin/present-tool",
        },
        "command -v flaky-tool": {
          available: false,
          status: "unknown" as const,
          details: "install check timed out",
        },
      })[cmd] ?? {
        available: false,
        status: "missing" as const,
        details: `unexpected command: ${cmd}`,
      },
  );

  beforeEach(() => {
    runner.mockClear();
  });

  test("treats multiple detect commands as fallbacks", async () => {
    const templates: AppTemplateCatalogEntry[] = [
      {
        id: "fallback-service",
        title: "Fallback Service",
        category: "test",
        priority: 1,
        detect: {
          commands: ["command -v missing-tool", "command -v present-tool"],
        },
        preset: {
          id: "fallback-service",
          title: "Fallback Service",
          kind: "service",
          command: "present-tool",
        },
      },
    ];

    await expect(
      detectInstalledTemplatesFromCatalog(templates, runner),
    ).resolves.toEqual([
      {
        key: "fallback-service",
        label: "Fallback Service",
        available: true,
        status: "available",
        details: "/usr/bin/present-tool",
      },
    ]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test("returns unknown when a service template does not define install detection", async () => {
    const templates: AppTemplateCatalogEntry[] = [
      {
        id: "no-detect-service",
        title: "No Detect Service",
        category: "test",
        priority: 1,
        preset: {
          id: "no-detect-service",
          title: "No Detect Service",
          kind: "service",
          command: "no-detect-service",
        },
      },
    ];

    await expect(
      detectInstalledTemplatesFromCatalog(templates, runner),
    ).resolves.toEqual([
      {
        key: "no-detect-service",
        label: "No Detect Service",
        available: false,
        status: "unknown",
        details: "no install check defined in template catalog",
      },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  test("treats static templates as built in", async () => {
    const templates: AppTemplateCatalogEntry[] = [
      {
        id: "static-site",
        title: "Static Site",
        category: "test",
        priority: 1,
        preset: {
          id: "static-site",
          title: "Static Site",
          kind: "static",
          static_root_relative: "public",
        },
      },
    ];

    await expect(
      detectInstalledTemplatesFromCatalog(templates, runner),
    ).resolves.toEqual([
      {
        key: "static-site",
        label: "Static Site",
        available: true,
        status: "available",
        details: "built in static hosting",
      },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  test("prefers unknown over missing when all checks are inconclusive", async () => {
    const templates: AppTemplateCatalogEntry[] = [
      {
        id: "flaky-service",
        title: "Flaky Service",
        category: "test",
        priority: 1,
        detect: {
          commands: ["command -v flaky-tool", "command -v missing-tool"],
        },
        preset: {
          id: "flaky-service",
          title: "Flaky Service",
          kind: "service",
          command: "flaky-service",
        },
      },
    ];

    await expect(
      detectInstalledTemplatesFromCatalog(templates, runner),
    ).resolves.toEqual([
      {
        key: "flaky-service",
        label: "Flaky Service",
        available: false,
        status: "unknown",
        details: "install check timed out",
      },
    ]);
  });
});
