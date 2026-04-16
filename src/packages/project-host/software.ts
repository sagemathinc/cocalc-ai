import fs from "node:fs";
import path from "node:path";
import { listRuntimeArtifactReferences } from "./sqlite/projects";

export type SoftwareVersions = {
  project_host?: string;
  project_host_build_id?: string;
  project_bundle?: string;
  project_bundle_build_id?: string;
  tools?: string;
};

export type InstalledRuntimeArtifact =
  | "project-host"
  | "project-bundle"
  | "tools";

export type InstalledRuntimeArtifactStatus = {
  artifact: InstalledRuntimeArtifact;
  current_version?: string;
  current_build_id?: string;
  installed_versions: string[];
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
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

function uniqSortedDescending(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
}

function listInstalledVersionsInRoots(roots: string[]): string[] {
  const versions: string[] = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === "current") continue;
        const fullPath = path.join(root, entry.name);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            versions.push(entry.name);
          }
        } catch {
          // ignore broken or unreadable entries
        }
      }
    } catch {
      // ignore missing roots
    }
  }
  return uniqSortedDescending(versions);
}

function realpathParent(currentPath: string): string | undefined {
  try {
    return path.dirname(fs.realpathSync(currentPath));
  } catch {
    return undefined;
  }
}

function projectHostCurrentPath(): string {
  if (process.env.COCALC_PROJECT_HOST_CURRENT?.trim()) {
    return process.env.COCALC_PROJECT_HOST_CURRENT.trim();
  }
  if (process.env.COCALC_PROJECT_HOST_BUNDLE_ROOT?.trim()) {
    return path.join(
      process.env.COCALC_PROJECT_HOST_BUNDLE_ROOT.trim(),
      "current",
    );
  }
  return DEFAULT_PROJECT_HOST_CURRENT;
}

function projectHostInventoryRoots(currentPath: string): string[] {
  const currentDir = path.dirname(currentPath);
  return uniqSortedDescending(
    [
      realpathParent(currentPath),
      process.env.COCALC_PROJECT_HOST_BUNDLE_ROOT?.trim(),
      path.join(currentDir, "bundles"),
      path.join(currentDir, "versions"),
    ].filter((value): value is string => !!`${value ?? ""}`.trim()),
  );
}

function siblingInventoryRoots(currentPath: string): string[] {
  return uniqSortedDescending(
    [realpathParent(currentPath), path.dirname(currentPath)].filter(
      (value): value is string => !!`${value ?? ""}`.trim(),
    ),
  );
}

function describeInstalledArtifact({
  artifact,
  currentPath,
  roots,
  referenced_versions,
}: {
  artifact: InstalledRuntimeArtifact;
  currentPath: string;
  roots: string[];
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
}): InstalledRuntimeArtifactStatus {
  return {
    artifact,
    current_version: versionFromCurrentPath(currentPath),
    current_build_id: readBuildIdFromCurrentPath(currentPath),
    installed_versions: listInstalledVersionsInRoots(roots),
    referenced_versions,
  };
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

export function getInstalledRuntimeArtifacts(): InstalledRuntimeArtifactStatus[] {
  const projectHostCurrent = projectHostCurrentPath();
  const projectBundlesRoot =
    process.env.COCALC_PROJECT_BUNDLES ?? DEFAULT_BUNDLE_ROOT;
  const projectBundleCurrent = path.join(projectBundlesRoot, "current");
  const toolsCurrent =
    process.env.COCALC_PROJECT_TOOLS ?? DEFAULT_TOOLS_CURRENT;
  const references = listRuntimeArtifactReferences();
  return [
    describeInstalledArtifact({
      artifact: "project-host",
      currentPath: projectHostCurrent,
      roots: projectHostInventoryRoots(projectHostCurrent),
    }),
    describeInstalledArtifact({
      artifact: "project-bundle",
      currentPath: projectBundleCurrent,
      roots: siblingInventoryRoots(projectBundleCurrent),
      referenced_versions: references.project_bundle,
    }),
    describeInstalledArtifact({
      artifact: "tools",
      currentPath: toolsCurrent,
      roots: siblingInventoryRoots(toolsCurrent),
      referenced_versions: references.tools,
    }),
  ];
}
