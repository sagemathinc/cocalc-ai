import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@jest/globals";

import { getBootstrapLifecycle } from "./bootstrap-lifecycle";

const savedEnv = {
  COCALC_PROJECT_HOST_BOOTSTRAP_DIR:
    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR,
  COCALC_PROJECT_HOST_CURRENT: process.env.COCALC_PROJECT_HOST_CURRENT,
  COCALC_PROJECT_BUNDLES: process.env.COCALC_PROJECT_BUNDLES,
  COCALC_PROJECT_TOOLS: process.env.COCALC_PROJECT_TOOLS,
};

afterEach(() => {
  process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR =
    savedEnv.COCALC_PROJECT_HOST_BOOTSTRAP_DIR;
  process.env.COCALC_PROJECT_HOST_CURRENT =
    savedEnv.COCALC_PROJECT_HOST_CURRENT;
  process.env.COCALC_PROJECT_BUNDLES = savedEnv.COCALC_PROJECT_BUNDLES;
  process.env.COCALC_PROJECT_TOOLS = savedEnv.COCALC_PROJECT_TOOLS;
});

function makeVersionedCurrent(root: string, version: string) {
  const target = path.join(root, version);
  fs.mkdirSync(target, { recursive: true });
  const current = path.join(root, "current");
  try {
    fs.unlinkSync(current);
  } catch {}
  fs.symlinkSync(target, current);
}

describe("bootstrap lifecycle reporting", () => {
  it("reports in-sync lifecycle when desired and installed versions match", () => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-bootstrap-lifecycle-sync-"),
    );
    const bootstrapDir = path.join(base, "bootstrap");
    const projectHostRoot = path.join(base, "project-host");
    const projectBundlesRoot = path.join(base, "project-bundles");
    const toolsRoot = path.join(base, "tools");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    makeVersionedCurrent(projectHostRoot, "ph-20260330");
    makeVersionedCurrent(projectBundlesRoot, "pb-20260330");
    makeVersionedCurrent(toolsRoot, "tools-20260330");
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap-desired-state.json"),
      JSON.stringify({
        recorded_at: "2026-03-30T20:00:00Z",
        bootstrap: { selector: "latest" },
        helper_schema_version: "20260330-v1",
        runtime_wrapper_version: "20260330-v1",
        project_host_bundle: { version: "ph-20260330" },
        project_bundle: { version: "pb-20260330" },
        tools_bundle: { version: "tools-20260330" },
        cloudflared: { enabled: false },
      }),
    );
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap-state.json"),
      JSON.stringify({
        recorded_at: "2026-03-30T20:01:00Z",
        helper_schema_version: "20260330-v1",
        runtime_wrapper_version: "20260330-v1",
        installed: {
          project_host_bundle_version: "ph-20260330",
          project_bundle_version: "pb-20260330",
          tools_bundle_version: "tools-20260330",
        },
        last_reconcile_result: "success",
      }),
    );

    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = bootstrapDir;
    process.env.COCALC_PROJECT_HOST_CURRENT = path.join(
      projectHostRoot,
      "current",
    );
    process.env.COCALC_PROJECT_BUNDLES = projectBundlesRoot;
    process.env.COCALC_PROJECT_TOOLS = path.join(toolsRoot, "current");

    const lifecycle = getBootstrapLifecycle();
    expect(lifecycle?.summary_status).toBe("in_sync");
    expect(lifecycle?.drift_count).toBe(0);
    expect(
      lifecycle?.items.find((item) => item.key === "project_bundle")?.status,
    ).toBe("match");
  });

  it("reports drift when the running bundle differs from desired state", () => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "cocalc-bootstrap-lifecycle-drift-"),
    );
    const bootstrapDir = path.join(base, "bootstrap");
    const projectHostRoot = path.join(base, "project-host");
    const projectBundlesRoot = path.join(base, "project-bundles");
    const toolsRoot = path.join(base, "tools");
    fs.mkdirSync(bootstrapDir, { recursive: true });
    makeVersionedCurrent(projectHostRoot, "ph-20260330");
    makeVersionedCurrent(projectBundlesRoot, "pb-older");
    makeVersionedCurrent(toolsRoot, "tools-20260330");
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap.py"),
      "#!/usr/bin/env python3\n",
    );
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap-desired-state.json"),
      JSON.stringify({
        recorded_at: "2026-03-30T20:00:00Z",
        bootstrap: { selector: "latest" },
        helper_schema_version: "20260330-v1",
        runtime_wrapper_version: "20260330-v1",
        project_host_bundle: { version: "ph-20260330" },
        project_bundle: { version: "pb-20260330" },
        tools_bundle: { version: "tools-20260330" },
        cloudflared: { enabled: false },
      }),
    );
    fs.writeFileSync(
      path.join(bootstrapDir, "bootstrap-state.json"),
      JSON.stringify({
        recorded_at: "2026-03-30T20:01:00Z",
        helper_schema_version: "20260330-v1",
        runtime_wrapper_version: "20260330-v1",
        installed: {
          project_host_bundle_version: "ph-20260330",
          project_bundle_version: "pb-older",
          tools_bundle_version: "tools-20260330",
        },
        last_reconcile_result: "success",
      }),
    );

    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = bootstrapDir;
    process.env.COCALC_PROJECT_HOST_CURRENT = path.join(
      projectHostRoot,
      "current",
    );
    process.env.COCALC_PROJECT_BUNDLES = projectBundlesRoot;
    process.env.COCALC_PROJECT_TOOLS = path.join(toolsRoot, "current");

    const lifecycle = getBootstrapLifecycle();
    expect(lifecycle?.summary_status).toBe("drifted");
    expect(lifecycle?.drift_count).toBe(1);
    expect(
      lifecycle?.items.find((item) => item.key === "project_bundle"),
    ).toMatchObject({
      desired: "pb-20260330",
      installed: "pb-older",
      status: "drift",
    });
  });
});
