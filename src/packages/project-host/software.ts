import fs from "node:fs";
import path from "node:path";
import type { HostRuntimeArtifactRetentionPolicy } from "@cocalc/conat/project-host/api";
import { effectiveRuntimeRetentionPolicy } from "./runtime-retention-policy";
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
  version_bytes?: Array<{
    version: string;
    bytes: number;
  }>;
  installed_bytes_total?: number;
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
  retention_policy?: HostRuntimeArtifactRetentionPolicy;
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

function collectInstalledVersionDirs(roots: string[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === "current") continue;
        const fullPath = path.join(root, entry.name);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            versions.set(entry.name, fullPath);
          }
        } catch {
          // ignore broken or unreadable entries
        }
      }
    } catch {
      // ignore missing roots
    }
  }
  return versions;
}

function pathSizeBytes(target: string, seen = new Set<string>()): number {
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    // keep original path
  }
  if (seen.has(real)) return 0;
  seen.add(real);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += pathSizeBytes(path.join(target, entry.name), seen);
    }
  } catch {
    // ignore unreadable directories
  }
  return total;
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
  include_sizes,
  referenced_versions,
  retention_policy,
}: {
  artifact: InstalledRuntimeArtifact;
  currentPath: string;
  roots: string[];
  include_sizes?: boolean;
  referenced_versions?: Array<{
    version: string;
    project_count: number;
  }>;
  retention_policy?: HostRuntimeArtifactRetentionPolicy;
}): InstalledRuntimeArtifactStatus {
  const installed = collectInstalledVersionDirs(roots);
  const installed_versions = uniqSortedDescending([...installed.keys()]);
  const version_bytes = include_sizes
    ? installed_versions.map((version) => ({
        version,
        bytes: pathSizeBytes(installed.get(version)!),
      }))
    : undefined;
  return {
    artifact,
    current_version: versionFromCurrentPath(currentPath),
    current_build_id: readBuildIdFromCurrentPath(currentPath),
    installed_versions,
    ...(version_bytes
      ? {
          version_bytes,
          installed_bytes_total: version_bytes.reduce(
            (total, entry) => total + entry.bytes,
            0,
          ),
        }
      : {}),
    referenced_versions,
    retention_policy,
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

export function getInstalledRuntimeArtifacts(opts?: {
  include_sizes?: boolean;
}): InstalledRuntimeArtifactStatus[] {
  const projectHostCurrent = projectHostCurrentPath();
  const projectBundlesRoot =
    process.env.COCALC_PROJECT_BUNDLES ?? DEFAULT_BUNDLE_ROOT;
  const projectBundleCurrent = path.join(projectBundlesRoot, "current");
  const toolsCurrent =
    process.env.COCALC_PROJECT_TOOLS ?? DEFAULT_TOOLS_CURRENT;
  const references = listRuntimeArtifactReferences();
  const include_sizes = opts?.include_sizes === true;
  const retentionPolicy = effectiveRuntimeRetentionPolicy();
  return [
    describeInstalledArtifact({
      artifact: "project-host",
      currentPath: projectHostCurrent,
      roots: projectHostInventoryRoots(projectHostCurrent),
      include_sizes,
      retention_policy: retentionPolicy["project-host"],
    }),
    describeInstalledArtifact({
      artifact: "project-bundle",
      currentPath: projectBundleCurrent,
      roots: siblingInventoryRoots(projectBundleCurrent),
      include_sizes,
      referenced_versions: references.project_bundle,
      retention_policy: retentionPolicy["project-bundle"],
    }),
    describeInstalledArtifact({
      artifact: "tools",
      currentPath: toolsCurrent,
      roots: siblingInventoryRoots(toolsCurrent),
      include_sizes,
      referenced_versions: references.tools,
      retention_policy: retentionPolicy.tools,
    }),
  ];
}
