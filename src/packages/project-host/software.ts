import fs from "node:fs";
import path from "node:path";

export type SoftwareVersions = {
  project_host?: string;
  project_host_build_id?: string;
  project_bundle?: string;
  project_bundle_build_id?: string;
  tools?: string;
};

const DEFAULT_BUNDLE_ROOT = "/opt/cocalc/project-bundles";
const DEFAULT_TOOLS_CURRENT = "/opt/cocalc/tools/current";
const DEFAULT_PROJECT_HOST_CURRENT = "/opt/cocalc/project-host/current";

function versionFromCurrentPath(currentPath: string): string | undefined {
  try {
    const realPath = fs.realpathSync(currentPath);
    const base = path.basename(realPath);
    if (base && base !== "current") {
      return base;
    }
  } catch {
    // ignore missing paths
  }
  return undefined;
}

function readBuildIdFromCurrentPath(currentPath: string): string | undefined {
  try {
    const realPath = fs.realpathSync(currentPath);
    const raw = fs.readFileSync(
      path.join(realPath, "build-identity.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    const build_id = `${parsed?.build_id ?? ""}`.trim();
    return build_id || undefined;
  } catch {
    return undefined;
  }
}

function getProjectBundleVersion(): string | undefined {
  const bundlesRoot = process.env.COCALC_PROJECT_BUNDLES ?? DEFAULT_BUNDLE_ROOT;
  return versionFromCurrentPath(path.join(bundlesRoot, "current"));
}

function getToolsVersion(): string | undefined {
  const toolsPath = process.env.COCALC_PROJECT_TOOLS ?? DEFAULT_TOOLS_CURRENT;
  return versionFromCurrentPath(toolsPath);
}

function runtimeProjectHostVersion(): string | undefined {
  const runtimeRoot = path.resolve(__dirname, "..");
  const bundleRoot = path.dirname(runtimeRoot);
  const marker = path.basename(bundleRoot);
  if (marker !== "bundles" && marker !== "versions") return undefined;
  const version = path.basename(runtimeRoot);
  return version && version !== "current" ? version : undefined;
}

function readRuntimeBuildId(): string | undefined {
  try {
    const runtimeRoot = path.resolve(__dirname, "..");
    const raw = fs.readFileSync(
      path.join(runtimeRoot, "build-identity.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    const build_id = `${parsed?.build_id ?? ""}`.trim();
    return build_id || undefined;
  } catch {
    return undefined;
  }
}

function getProjectHostVersion(): string | undefined {
  const current =
    process.env.COCALC_PROJECT_HOST_CURRENT ?? DEFAULT_PROJECT_HOST_CURRENT;
  const fromRuntime = runtimeProjectHostVersion();
  const fromLink = versionFromCurrentPath(current);
  return (
    fromRuntime ??
    fromLink ??
    process.env.COCALC_PROJECT_HOST_VERSION ??
    process.env.npm_package_version ??
    undefined
  );
}

export function getSoftwareVersions(): SoftwareVersions {
  const projectHostCurrent =
    process.env.COCALC_PROJECT_HOST_CURRENT ?? DEFAULT_PROJECT_HOST_CURRENT;
  const projectBundlesRoot =
    process.env.COCALC_PROJECT_BUNDLES ?? DEFAULT_BUNDLE_ROOT;
  const projectBundleCurrent = path.join(projectBundlesRoot, "current");
  return {
    project_host: getProjectHostVersion(),
    project_host_build_id:
      readRuntimeBuildId() ?? readBuildIdFromCurrentPath(projectHostCurrent),
    project_bundle: getProjectBundleVersion(),
    project_bundle_build_id: readBuildIdFromCurrentPath(projectBundleCurrent),
    tools: getToolsVersion(),
  };
}
