import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";

import {
  PROTECTED_SURFACE_BASELINES,
  PROTECTED_SURFACE_OVERRIDES,
  type ProtectedSurface,
  type ProtectedSurfaceBaseline,
  type ProtectedSurfaceOverride,
} from "./protected-overrides";

const PROTECTED_SURFACES: readonly {
  surface: ProtectedSurface;
  matches: (file: string) => boolean;
}[] = [
  {
    surface: "home/",
    matches: (file) =>
      file === "public/home" || file.startsWith("public/home/"),
  },
  {
    surface: "theme.ts",
    matches: (file) => file === "public/theme.ts",
  },
];

function gitLines(args: string[]): string[] {
  const output = gitOutput(args);
  return output ? output.split("\n").filter(Boolean) : [];
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function normalizePublicPath(file: string): string {
  return file.trim().replace(/^src\/packages\/frontend\//, "");
}

function uniqueSorted(files: string[]): string[] {
  return Array.from(new Set(files.map(normalizePublicPath))).sort();
}

function requireGitCommit(ref: string): string {
  try {
    return gitOutput(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `Protected surface gate could not resolve git ref "${ref}". Set PROTECTED_BASE_REF to a valid commit-ish or run with at least one parent commit.`,
    );
  }
}

function protectedDiffBase(): string {
  const baseRef = process.env.PROTECTED_BASE_REF?.trim();
  if (!baseRef) {
    return requireGitCommit("HEAD~1");
  }

  try {
    return gitOutput(["merge-base", baseRef, "HEAD"]);
  } catch {
    throw new Error(
      `Protected surface gate could not resolve a merge-base for PROTECTED_BASE_REF="${baseRef}" and HEAD.`,
    );
  }
}

function changedPublicFiles(): string[] {
  const base = protectedDiffBase();
  return uniqueSorted(
    gitLines(["diff", "--name-only", `${base}..HEAD`, "--", "public"]),
  );
}

function protectedSurfaceForFile(file: string): ProtectedSurface | undefined {
  return PROTECTED_SURFACES.find(({ matches }) => matches(file))?.surface;
}

function overrideForSurface(
  surface: ProtectedSurface,
  overrides: readonly ProtectedSurfaceOverride[] = PROTECTED_SURFACE_OVERRIDES,
): ProtectedSurfaceOverride | undefined {
  return overrides.find((override) => override.surface === surface);
}

function baselineForFile(
  surface: ProtectedSurface,
  file: string,
  baselines: readonly ProtectedSurfaceBaseline[] = PROTECTED_SURFACE_BASELINES,
): ProtectedSurfaceBaseline | undefined {
  return baselines.find(
    (baseline) => baseline.surface === surface && baseline.path === file,
  );
}

function readFileSha256(file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

interface ProtectedGateOptions {
  readonly baselines?: readonly ProtectedSurfaceBaseline[];
  readonly fileSha256?: (file: string) => string | undefined;
  readonly overrides?: readonly ProtectedSurfaceOverride[];
}

function fileMatchesBaselineWithOptions(
  surface: ProtectedSurface,
  file: string,
  options: ProtectedGateOptions = {},
): boolean {
  const baseline = baselineForFile(
    surface,
    file,
    options.baselines ?? PROTECTED_SURFACE_BASELINES,
  );
  const fileSha256 = options.fileSha256 ?? readFileSha256;
  return !!baseline && fileSha256(file) === baseline.sha256;
}

function protectedSurfaceOffenders(
  files: string[],
  options: ProtectedGateOptions = {},
): string[] {
  const overrides = options.overrides ?? PROTECTED_SURFACE_OVERRIDES;
  return files.flatMap((file) => {
    const surface = protectedSurfaceForFile(file);
    if (
      !surface ||
      overrideForSurface(surface, overrides) ||
      fileMatchesBaselineWithOptions(surface, file, options)
    ) {
      return [];
    }
    return [
      `${file} (${surface}) needs a committed override or matching baseline in public/__tests__/protected-overrides.ts`,
    ];
  });
}

function protectedBaselineDriftOffenders(
  options: ProtectedGateOptions = {},
): string[] {
  const baselines = options.baselines ?? PROTECTED_SURFACE_BASELINES;
  const fileSha256 = options.fileSha256 ?? readFileSha256;
  const overrides = options.overrides ?? PROTECTED_SURFACE_OVERRIDES;

  return baselines.flatMap((baseline) => {
    if (
      fileSha256(baseline.path) === baseline.sha256 ||
      overrideForSurface(baseline.surface, overrides)
    ) {
      return [];
    }
    return [
      `${baseline.path} (${baseline.surface}) differs from its protected baseline; restore the accepted file or add a committed override in public/__tests__/protected-overrides.ts`,
    ];
  });
}

describe("public protected-surface gate", () => {
  it("hard-gates only home and theme at the file-path level", () => {
    expect(protectedSurfaceForFile("public/home/app.tsx")).toBe("home/");
    expect(protectedSurfaceForFile("public/home/__tests__/app.test.tsx")).toBe(
      "home/",
    );
    expect(protectedSurfaceForFile("public/theme.ts")).toBe("theme.ts");

    expect(protectedSurfaceForFile("public/pricing/app.tsx")).toBeUndefined();
    expect(
      protectedSurfaceForFile("public/features/dedicated-compute-page.tsx"),
    ).toBeUndefined();
  });

  it("keeps override entries auditable", () => {
    for (const override of PROTECTED_SURFACE_OVERRIDES) {
      expect(PROTECTED_SURFACES.map(({ surface }) => surface)).toContain(
        override.surface,
      );
      expect(override.reason.trim()).not.toBe("");
      expect(override.approvedBy.trim()).not.toBe("");
      if (override.surface === "theme.ts") {
        expect(override.reason).toContain("alias-only, no new hue");
      }
    }
    expect(overrideForSurface("theme.ts")).toBeUndefined();
    expect(overrideForSurface("home/")).toBeUndefined();
    for (const baseline of PROTECTED_SURFACE_BASELINES) {
      expect(PROTECTED_SURFACES.map(({ surface }) => surface)).toContain(
        baseline.surface,
      );
      expect(baseline.path.trim()).not.toBe("");
      expect(baseline.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(baseline.reason.trim()).not.toBe("");
      expect(baseline.approvedBy.trim()).not.toBe("");
      if (baseline.surface === "home/") {
        expect(baseline.path).toMatch(/^public\/home\//);
      }
    }
  });

  it("resolves a committed diff base for the protected scan", () => {
    expect(protectedDiffBase()).toMatch(/^[a-f0-9]{40}$/);
  });

  it("blocks home baseline drift, but allows an explicit override fixture", () => {
    const homeAppPath = "public/home/app.tsx";
    const driftSha256 = "0".repeat(64);
    const hashFixture = (file: string): string | undefined => {
      if (file === homeAppPath) {
        return driftSha256;
      }
      return baselineForFile("home/", file)?.sha256 ?? readFileSha256(file);
    };
    const overrideFixture: readonly ProtectedSurfaceOverride[] = [
      {
        surface: "home/",
        reason: "test fixture for a Blaec-approved home override",
        approvedBy: "Blaec",
      },
    ];

    expect(
      protectedSurfaceOffenders([homeAppPath], {
        fileSha256: hashFixture,
        overrides: [],
      }),
    ).toEqual([
      `${homeAppPath} (home/) needs a committed override or matching baseline in public/__tests__/protected-overrides.ts`,
    ]);
    expect(
      protectedBaselineDriftOffenders({
        fileSha256: hashFixture,
        overrides: [],
      }),
    ).toEqual([
      `${homeAppPath} (home/) differs from its protected baseline; restore the accepted file or add a committed override in public/__tests__/protected-overrides.ts`,
    ]);
    expect(
      protectedSurfaceOffenders([homeAppPath], {
        fileSha256: hashFixture,
        overrides: overrideFixture,
      }),
    ).toEqual([]);
    expect(
      protectedBaselineDriftOffenders({
        fileSha256: hashFixture,
        overrides: overrideFixture,
      }),
    ).toEqual([]);
  });

  it("blocks changed protected public files without an override", () => {
    expect([
      ...protectedSurfaceOffenders(changedPublicFiles()),
      ...protectedBaselineDriftOffenders(),
    ]).toEqual([]);
  });
});
