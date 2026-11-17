/*
Finding 028 B-3a: the release gate for the staging fault-phase hook (DESIGN
v1.21 §7, SA C2, vanta V-d): no test hook in production bytes.

- No production source file (anything under src/packages except tests, the
  fault-test directory itself and node_modules) imports the hook, its
  directory, or contains its marker.
- No production build output (the dist/ directories of the packages a host
  or bay runs) contains the marker.  FOUND = fail.
- The backend package does not ship the fault-test sources or their build.
- The checker can fail: a synthetic production file that imports the hook is
  reported (the mutation the design asks for).
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const packages = join(__dirname, "../../../..");
const MARKER = "COCALC_028_STAGING_FAULT_PHASE_HOOK_d41f";
const IMPORT = /(fault-test\/|fault-phase-hook|installFaultPhaseHook)/;

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|__test__)\//.test(rel) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

// production files under root that reference the hook (sources) or carry
// its marker (sources and build output)
export function findFaultHookReferences(
  root: string,
  { sources }: { sources: boolean },
): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      const rel = relative(root, path);
      if (e.isDirectory()) {
        if (
          e.name === "node_modules" ||
          e.name === ".git" ||
          e.name === "fault-test" ||
          e.name === "dist-fault-test" ||
          (sources && e.name === "dist")
        ) {
          continue;
        }
        walk(path);
        continue;
      }
      if (!e.isFile() || !/\.(c|m)?[jt]sx?$/.test(e.name)) continue;
      if (sources && isTestPath(rel)) continue;
      const text = fs.readFileSync(path, "utf8");
      if (text.includes(MARKER) || (sources && IMPORT.test(text))) {
        found.push(rel);
      }
    }
  };
  walk(root);
  return found;
}

describe("028 B-3a: the fault-phase hook never reaches production bytes", () => {
  it("the hook carries the marker the gate looks for", () => {
    const hook = fs.readFileSync(
      join(packages, "backend/fault-test/fault-phase-hook.ts"),
      "utf8",
    );
    expect(hook).toContain(MARKER);
  });

  it("no production source imports the hook or contains its marker", () => {
    const offenders = ["backend", "conat", "project-host", "server", "lite", "hub"]
      .flatMap((pkg) =>
        findFaultHookReferences(join(packages, pkg), { sources: true }).map(
          (f) => `${pkg}/${f}`,
        ),
      )
      // storage.ts names the callback setter and the phases, never the hook
      .filter((f) => f !== "conat/persist/storage.ts");
    expect(offenders).toEqual([]);
  });

  it("storage only exposes a no-op callback: it names no hook module and no marker", () => {
    const storage = fs.readFileSync(
      join(packages, "conat/persist/storage.ts"),
      "utf8",
    );
    expect(storage).not.toContain(MARKER);
    expect(storage).not.toMatch(/fault-test\/|fault-phase-hook/);
    expect(storage).toMatch(/let faultPhase:[\s\S]*?= undefined;/);
  });

  it("no production build output contains the marker (FOUND = fail)", () => {
    const dists = ["backend", "conat", "project-host", "server", "lite"]
      .map((pkg) => join(packages, pkg, "dist"))
      .filter((d) => fs.existsSync(d));
    // the persist packages are always built before these tests run
    expect(dists.map((d) => relative(packages, d))).toEqual(
      expect.arrayContaining(["backend/dist", "conat/dist"]),
    );
    const found = dists.flatMap((d) =>
      findFaultHookReferences(d, { sources: false }).map(
        (f) => `${relative(packages, d)}/${f}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it("the backend package ships neither the fault-test sources nor their build", () => {
    const pkg = JSON.parse(
      fs.readFileSync(join(packages, "backend/package.json"), "utf8"),
    );
    for (const pattern of pkg.files) {
      expect(pattern).not.toMatch(/fault-test/);
    }
    expect(pkg.files).toEqual(
      expect.not.arrayContaining(["**", "*", "./"]),
    );
    const tsconfig = fs.readFileSync(join(packages, "backend/tsconfig.json"), "utf8");
    expect(tsconfig).toContain('"fault-test"');
  });

  it("can fail: a production file importing the hook, or a build carrying the marker, is reported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fault-gate-"));
    try {
      fs.mkdirSync(join(dir, "persist"));
      fs.writeFileSync(
        join(dir, "persist", "server.ts"),
        'import { installFaultPhaseHook } from "@cocalc/backend/fault-test/fault-phase-hook";\n',
      );
      fs.writeFileSync(join(dir, "persist", "ok.ts"), "export const x = 1;\n");
      expect(findFaultHookReferences(dir, { sources: true })).toEqual([
        "persist/server.ts",
      ]);
      fs.mkdirSync(join(dir, "built"));
      fs.writeFileSync(join(dir, "built", "bundle.js"), `var m="${MARKER}";\n`);
      expect(findFaultHookReferences(join(dir, "built"), { sources: false })).toEqual([
        "bundle.js",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
