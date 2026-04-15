/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInstalledRuntimeArtifacts } from "./software";

function makeVersionDir(root: string, version: string, build_id?: string) {
  const dir = path.join(root, version);
  fs.mkdirSync(dir, { recursive: true });
  if (build_id) {
    fs.writeFileSync(
      path.join(dir, "build-identity.json"),
      JSON.stringify({ build_id }),
    );
  }
  return dir;
}

describe("getInstalledRuntimeArtifacts", () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  it("tracks installed project-host bundle versions from bundle-layout roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-software-"));
    const bundleRoot = path.join(root, "project-host", "bundles");
    fs.mkdirSync(bundleRoot, { recursive: true });
    makeVersionDir(bundleRoot, "1001");
    const current = makeVersionDir(bundleRoot, "1002", "build-1002");
    fs.symlinkSync(current, path.join(bundleRoot, "current"));
    process.env.COCALC_PROJECT_HOST_BUNDLE_ROOT = bundleRoot;
    const artifact = getInstalledRuntimeArtifacts().find(
      (entry) => entry.artifact === "project-host",
    );
    expect(artifact).toEqual({
      artifact: "project-host",
      current_version: "1002",
      current_build_id: "build-1002",
      installed_versions: ["1002", "1001"],
    });
  });

  it("tracks installed project bundle and tools versions from current symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-software-"));
    const bundlesRoot = path.join(root, "project-bundles");
    const toolsRoot = path.join(root, "tools");
    fs.mkdirSync(bundlesRoot, { recursive: true });
    fs.mkdirSync(toolsRoot, { recursive: true });
    makeVersionDir(bundlesRoot, "bundle-a");
    const currentBundle = makeVersionDir(
      bundlesRoot,
      "bundle-b",
      "bundle-build-b",
    );
    fs.symlinkSync(currentBundle, path.join(bundlesRoot, "current"));
    makeVersionDir(toolsRoot, "tools-a");
    const currentTools = makeVersionDir(toolsRoot, "tools-b", "tools-build-b");
    fs.symlinkSync(currentTools, path.join(toolsRoot, "current"));
    process.env.COCALC_PROJECT_BUNDLES = bundlesRoot;
    process.env.COCALC_PROJECT_TOOLS = path.join(toolsRoot, "current");
    const inventory = getInstalledRuntimeArtifacts();
    expect(
      inventory.find((entry) => entry.artifact === "project-bundle"),
    ).toEqual({
      artifact: "project-bundle",
      current_version: "bundle-b",
      current_build_id: "bundle-build-b",
      installed_versions: ["bundle-b", "bundle-a"],
    });
    expect(inventory.find((entry) => entry.artifact === "tools")).toEqual({
      artifact: "tools",
      current_version: "tools-b",
      current_build_id: "tools-build-b",
      installed_versions: ["tools-b", "tools-a"],
    });
  });
});
