import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const PUBLIC_ROOT = join(__dirname, "..");
const PUBLIC_FEATURE_CATALOG = join(
  PUBLIC_ROOT,
  "..",
  "..",
  "util",
  "public-feature-pages.ts",
);

function publicSourceFiles(dir: string = PUBLIC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "__tests__") continue;
    if (statSync(path).isDirectory()) {
      files.push(...publicSourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    files.push(path);
  }
  return files;
}

describe("public-site overpromise canary", () => {
  it("keeps held public feature pages out of the marketing catalog", () => {
    const catalog = readFileSync(PUBLIC_FEATURE_CATALOG, "utf8");
    const heldSlugs = ["automations", "more-languages", "dedicated-compute"];

    for (const slug of heldSlugs) {
      expect(catalog).not.toMatch(new RegExp(`slug:\\s*["']${slug}["']`, "i"));
    }
  });

  it("keeps known unsupported capability claims out of public marketing source", () => {
    const disallowedClaims: Array<{ label: string; pattern: RegExp }> = [
      { label: "built-in scheduler", pattern: /\bbuilt[- ]in scheduler\b/i },
      { label: "recurring runs", pattern: /\brecurring runs?\b/i },
      {
        label: "triggered automations",
        pattern: /\btrigger(?:ed)? automations?\b/i,
      },
      {
        label: "preinstalled C/C++ stack",
        pattern: /\bpreinstalled\s+C\/C\+\+/i,
      },
      {
        label: "preinstalled Fortran stack",
        pattern: /\bpreinstalled\s+Fortran\b/i,
      },
      {
        label: "preinstalled Rust stack",
        pattern: /\bpreinstalled\s+Rust\b/i,
      },
      {
        label: "preinstalled Go stack",
        pattern: /\bpreinstalled\s+Go\b/i,
      },
      {
        label: "preinstalled Java stack",
        pattern: /\bpreinstalled\s+Java\b/i,
      },
      {
        label: "preinstalled Ruby stack",
        pattern: /\bpreinstalled\s+Ruby\b/i,
      },
      {
        label: "default Octave kernel",
        pattern: /\bdefault\s+Octave\s+kernel\b/i,
      },
      {
        label: "preinstalled Octave kernel",
        pattern:
          /\b(?:preinstalled\s+Octave\s+kernel|Octave\s+kernel\s+is\s+preinstalled)\b/i,
      },
    ];

    const hits: string[] = [];
    for (const file of [...publicSourceFiles(), PUBLIC_FEATURE_CATALOG]) {
      const contents = readFileSync(file, "utf8");
      for (const { label, pattern } of disallowedClaims) {
        if (pattern.test(contents)) {
          hits.push(`${relative(PUBLIC_ROOT, file)}: ${label}`);
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
