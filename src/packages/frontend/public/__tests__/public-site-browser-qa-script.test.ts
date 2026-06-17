import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const frontendRoot = process.cwd();
const scriptPath = join(frontendRoot, "scripts/public-site-browser-qa.mjs");
const scriptSource = readFileSync(scriptPath, "utf8");

describe("public-site browser QA script", () => {
  it("exposes reusable route groups for public-site passes", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--list-groups"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feature-index: /features");
    expect(result.stdout).toContain("/features/ai");
    expect(result.stdout).toContain("guides: /guides");
    expect(result.stdout).toContain("conversion-spine:");
    expect(result.stdout).toContain("product-details:");
  });

  it("documents the CLI and keeps generated artifacts out of the repo", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--base-url <url>");
    expect(result.stdout).toContain("--group <name>");
    expect(result.stdout).toContain("--route <path>");
    expect(result.stdout).toContain("/tmp/cocalc-public-qa-*");
    expect(scriptSource).toContain(
      'const ARTIFACT_PREFIX = "cocalc-public-qa-"',
    );
    expect(scriptSource).toContain(
      "mkdtempSync(join(tmpdir(), ARTIFACT_PREFIX))",
    );
    expect(scriptSource).toContain("Refusing to write artifacts outside /tmp");
    expect(scriptSource).toContain('join(outDir, "results.json")');
  });

  it("checks durable rendered-page invariants rather than subjective design approval", () => {
    expect(scriptSource).toContain("GLOBAL_FORBIDDEN_TEXT");
    expect(scriptSource).toContain("expectedOrder");
    expect(scriptSource).toContain("requireLinks");
    expect(scriptSource).toContain("requireSelectors");
    expect(scriptSource).toContain("styleChecks");
    expect(scriptSource).toContain("no horizontal overflow");
    expect(scriptSource).toContain("stale route text absent");
    expect(scriptSource).not.toContain("approve visual design");
  });

  it("guards conversion-spine and product-path boundaries", () => {
    expect(scriptSource).toContain('"Ways to Run CoCalc"');
    expect(scriptSource).toContain('"CoCalc.ai Pricing and Licensing"');
    expect(scriptSource).toContain('"context=feature-compare"');
    expect(scriptSource).toContain('"Boundary: local, one-user runtime"');
    expect(scriptSource).toContain('"Boundary: one public VM"');
    expect(scriptSource).toContain('"Boundary: bounded private deployment"');
    expect(scriptSource).toContain('"Boundary: planned private cloud"');
    expect(scriptSource).toContain('"context=product-cocalc-launchpad"');
    expect(scriptSource).toContain('"context=product-cocalc-rocket"');
  });
});
