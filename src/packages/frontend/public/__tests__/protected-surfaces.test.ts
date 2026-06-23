import { execFileSync } from "child_process";

import {
  PROTECTED_SURFACE_OVERRIDES,
  type ProtectedSurface,
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
  const output = execFileSync("git", args, { encoding: "utf8" }).trim();
  return output ? output.split("\n").filter(Boolean) : [];
}

function normalizePublicPath(file: string): string {
  return file.trim().replace(/^src\/packages\/frontend\//, "");
}

function uniqueSorted(files: string[]): string[] {
  return Array.from(new Set(files.map(normalizePublicPath))).sort();
}

function changedPublicFiles(): string[] {
  const baseRef = process.env.PROTECTED_BASE_REF?.trim();
  if (baseRef) {
    return uniqueSorted(
      gitLines(["diff", "--name-only", `${baseRef}..HEAD`, "--", "public"]),
    );
  }

  return uniqueSorted([
    ...gitLines(["diff", "--name-only", "--", "public"]),
    ...gitLines(["diff", "--name-only", "--cached", "--", "public"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard", "--", "public"]),
  ]);
}

function protectedSurfaceForFile(file: string): ProtectedSurface | undefined {
  return PROTECTED_SURFACES.find(({ matches }) => matches(file))?.surface;
}

function overrideForSurface(
  surface: ProtectedSurface,
): ProtectedSurfaceOverride | undefined {
  return PROTECTED_SURFACE_OVERRIDES.find(
    (override) => override.surface === surface,
  );
}

function protectedSurfaceOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const surface = protectedSurfaceForFile(file);
    if (!surface || overrideForSurface(surface)) {
      return [];
    }
    return [
      `${file} (${surface}) needs a committed override in public/__tests__/protected-overrides.ts`,
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
  });

  it("blocks changed protected public files without an override", () => {
    expect(protectedSurfaceOffenders(changedPublicFiles())).toEqual([]);
  });
});
