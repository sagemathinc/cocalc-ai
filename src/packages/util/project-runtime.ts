/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "path";

export const DEFAULT_PROJECT_RUNTIME_USER = "user";
export const DEFAULT_PROJECT_RUNTIME_UID = 2001;
export const DEFAULT_PROJECT_RUNTIME_GID = 2001;
export const DEFAULT_PROJECT_RUNTIME_HOME = "/home/user";

// A separate host uid for the project user (project_runtime_uid_mode
// "separate"): the first uid of a dedicated subordinate block of the host's
// runtime user, which host bootstrap appends after the container ranges.
export const PROJECT_RUNTIME_UID_BLOCK = { start: 1073741824, length: 65536 };
export const PROJECT_RUNTIME_SEPARATE_UID = PROJECT_RUNTIME_UID_BLOCK.start;
// The first root-helper schema with `project-view` and `--idmap` overlays.
export const PROJECT_VIEW_HELPER_SCHEMA = 59;
export const PROJECT_RUNTIME_UID_MODES = ["keep-id", "separate"] as const;
export type ProjectRuntimeUidMode = (typeof PROJECT_RUNTIME_UID_MODES)[number];
export const PROJECT_RUNTIME_MODEL = "launchpad-root-start-v1";
export const PROJECT_RUNTIME_USERNS_SCHEME = "podman-keep-id-v1";
export const PROJECT_RUNTIME_BOOTSTRAP_PACKAGES = [
  "sudo",
  "ca-certificates",
  "libatomic1",
] as const;
export const LEGACY_PROJECT_RUNTIME_HOME = "/root";
export const PROJECT_RUNTIME_HOME_ALIASES = [
  DEFAULT_PROJECT_RUNTIME_HOME,
  LEGACY_PROJECT_RUNTIME_HOME,
] as const;

export function projectRuntimeRootfsContractLabels(): Record<string, string> {
  return {
    "com.cocalc.rootfs.runtime_model": PROJECT_RUNTIME_MODEL,
    "com.cocalc.rootfs.runtime_userns": PROJECT_RUNTIME_USERNS_SCHEME,
    "com.cocalc.rootfs.runtime_user": DEFAULT_PROJECT_RUNTIME_USER,
    "com.cocalc.rootfs.runtime_uid": `${DEFAULT_PROJECT_RUNTIME_UID}`,
    "com.cocalc.rootfs.runtime_gid": `${DEFAULT_PROJECT_RUNTIME_GID}`,
    "com.cocalc.rootfs.runtime_home": DEFAULT_PROJECT_RUNTIME_HOME,
    "com.cocalc.rootfs.runtime_bootstrap":
      PROJECT_RUNTIME_BOOTSTRAP_PACKAGES.join(","),
  };
}

export function rootfsLabelsSatisfyCurrentProjectRuntimeContract(
  labels?: Record<string, unknown> | null,
): boolean {
  if (!labels) return false;
  const expected = projectRuntimeRootfsContractLabels();
  for (const [key, value] of Object.entries(expected)) {
    if (`${labels[key] ?? ""}` !== value) {
      return false;
    }
  }
  return true;
}

export function projectRuntimeHomeRelativePath(
  rawPath: string,
): string | undefined {
  const normalized = path.posix.normalize(
    `${rawPath ?? ""}`.replace(/\\/g, "/"),
  );
  if (!normalized || normalized === "." || normalized === "/") {
    return undefined;
  }
  for (const home of PROJECT_RUNTIME_HOME_ALIASES) {
    if (normalized === home) {
      return "";
    }
    if (normalized.startsWith(`${home}/`)) {
      return path.posix.relative(home, normalized);
    }
  }
  return undefined;
}

export function isProjectRuntimeHomeAliasPath(rawPath: string): boolean {
  return projectRuntimeHomeRelativePath(rawPath) != null;
}

export function projectRuntimePathForProcess(
  rawPath: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (rawPath == null || !rawPath.startsWith("/")) {
    return rawPath;
  }
  const runtimeHomeRaw = `${env.COCALC_RUNTIME_HOME ?? ""}`.trim();
  const processHomeRaw = `${env.HOME ?? ""}`.trim();
  if (
    !runtimeHomeRaw ||
    !processHomeRaw ||
    !path.posix.isAbsolute(runtimeHomeRaw)
  ) {
    return rawPath;
  }
  const runtimeHome = path.posix.resolve(runtimeHomeRaw);
  const normalized = path.posix.resolve(rawPath);
  if (normalized !== runtimeHome && !normalized.startsWith(`${runtimeHome}/`)) {
    return rawPath;
  }
  const relative = path.posix.relative(runtimeHome, normalized);
  const nativePath = windowsAbsolutePath(processHomeRaw) ? path.win32 : path;
  const processHome = nativePath.resolve(processHomeRaw);
  return relative
    ? nativePath.join(processHome, ...relative.split("/"))
    : processHome;
}

function windowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function projectRuntimePathForClient(
  rawPath: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (rawPath == null) return rawPath;
  const runtimeHomeRaw = `${env.COCALC_RUNTIME_HOME ?? ""}`.trim();
  const processHomeRaw = `${env.HOME ?? ""}`.trim();
  if (
    !runtimeHomeRaw ||
    !processHomeRaw ||
    !path.posix.isAbsolute(runtimeHomeRaw)
  ) {
    return rawPath;
  }
  const nativePath = windowsAbsolutePath(processHomeRaw) ? path.win32 : path;
  if (!nativePath.isAbsolute(rawPath)) return rawPath;
  const processHome = nativePath.resolve(processHomeRaw);
  const normalized = nativePath.resolve(rawPath);
  const relative = nativePath.relative(processHome, normalized);
  if (
    relative === ".." ||
    relative.startsWith(`..${nativePath.sep}`) ||
    nativePath.isAbsolute(relative)
  ) {
    return rawPath;
  }
  const runtimeHome = path.posix.resolve(runtimeHomeRaw);
  return relative
    ? path.posix.join(runtimeHome, relative.replace(/\\/g, "/"))
    : runtimeHome;
}

export type ProjectRuntimeMode = "external" | "workspace" | "podman";

export type ProjectRuntimeIsolation =
  | "project-host"
  | "container"
  | "trusted-workspace";

export const PROJECT_RUNTIME_CAPABILITY_KEYS = [
  "rootfs",
  "host_placement",
  "gpu",
  "backups",
  "snapshots",
  "archive",
  "move",
  "ssh",
  "resource_limits",
  "cloud_hosts",
] as const;

export type ProjectRuntimeCapability =
  (typeof PROJECT_RUNTIME_CAPABILITY_KEYS)[number];

export type ProjectRuntimeCapabilities = Record<
  ProjectRuntimeCapability,
  boolean
>;

export interface ProjectRuntimeConfiguration extends ProjectRuntimeCapabilities {
  mode: ProjectRuntimeMode;
  isolation: ProjectRuntimeIsolation;
  trusted: boolean;
  label: string;
}

const FULL_CAPABILITIES: ProjectRuntimeCapabilities = {
  rootfs: true,
  host_placement: true,
  gpu: true,
  backups: true,
  snapshots: true,
  archive: true,
  move: true,
  ssh: true,
  resource_limits: true,
  cloud_hosts: true,
};

const WORKSPACE_CAPABILITIES: ProjectRuntimeCapabilities = {
  rootfs: false,
  host_placement: false,
  gpu: false,
  backups: false,
  snapshots: false,
  archive: false,
  move: false,
  ssh: false,
  resource_limits: false,
  cloud_hosts: false,
};

export function projectRuntimeConfiguration(
  mode: ProjectRuntimeMode,
): ProjectRuntimeConfiguration {
  if (mode === "workspace") {
    return {
      mode,
      isolation: "trusted-workspace",
      trusted: true,
      label: "Trusted workspace",
      ...WORKSPACE_CAPABILITIES,
    };
  }
  return {
    mode,
    isolation: mode === "podman" ? "container" : "project-host",
    trusted: false,
    label: mode === "podman" ? "Local container" : "Project host",
    ...FULL_CAPABILITIES,
  };
}

export function projectRuntimeCapabilityError(
  runtime: ProjectRuntimeConfiguration,
  capability: ProjectRuntimeCapability,
): string {
  return `${capability.replace(/_/g, " ")} is unsupported by the ${runtime.label.toLowerCase()} runtime (${runtime.mode})`;
}
