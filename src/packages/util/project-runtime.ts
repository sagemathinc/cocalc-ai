/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "path";

export const DEFAULT_PROJECT_RUNTIME_USER = "user";
export const DEFAULT_PROJECT_RUNTIME_UID = 2001;
export const DEFAULT_PROJECT_RUNTIME_GID = 2001;
export const DEFAULT_PROJECT_RUNTIME_HOME = "/home/user";
export const PROJECT_RUNTIME_MODEL = "launchpad-root-start-v1";
export const PROJECT_RUNTIME_USERNS_SCHEME = "podman-keep-id-v1";
export const PROJECT_RUNTIME_BOOTSTRAP_PACKAGES = [
  "sudo",
  "ca-certificates",
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
