/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile, writeFile } from "node:fs/promises";
import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-runner:rootfs-preflight");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

export const ROOTFS_PREFLIGHT_VERSION = 6;
export const ROOTFS_NORMALIZER_VERSION = ROOTFS_PREFLIGHT_VERSION;

export type RootfsPreflightMetadata = {
  version: number;
  // Historical on-disk field name preserved for compatibility with existing
  // cached metadata.
  normalized_at: string;
  image: string;
  rootfs_path: string;
  distro_family: "debian" | "rhel" | "sles" | "unknown";
  package_manager: "apt-get" | "dnf" | "microdnf" | "yum" | "zypper" | "none";
  shell: string;
  glibc: true;
  sudo_present: boolean;
  ca_certificates_present: boolean;
};

export type RootfsNormalizationMetadata = RootfsPreflightMetadata;

type RawPreflightResult = Omit<
  RootfsPreflightMetadata,
  "version" | "normalized_at" | "image" | "rootfs_path"
>;

type RootfsPreflightProgress = (update: {
  message: string;
  detail?: Record<string, unknown>;
}) => void;

function parsePreflightOutput(stdout: string): unknown {
  const trimmed = `${stdout ?? ""}`.trim();
  if (!trimmed) {
    return {};
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning earlier lines
    }
  }
  return JSON.parse(trimmed);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isCurrentMetadata(metadata?: RootfsPreflightMetadata): boolean {
  return (
    metadata?.version === ROOTFS_PREFLIGHT_VERSION && metadata.glibc === true
  );
}

export async function loadRootfsPreflightMetadata(
  metadataPath: string,
): Promise<RootfsPreflightMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as RootfsPreflightMetadata;
  } catch (err) {
    const message = `${err}`;
    if (
      message.includes("ENOENT") ||
      message.includes("no such file") ||
      message.includes("No such file")
    ) {
      return;
    }
    throw new Error(
      `invalid RootFS preflight metadata at '${metadataPath}': ${err}`,
    );
  }
}

export function requireCurrentRootfsPreflightMetadata({
  image,
  metadataPath,
  metadata,
}: {
  image: string;
  metadataPath: string;
  metadata?: RootfsPreflightMetadata;
}): RootfsPreflightMetadata {
  if (isCurrentMetadata(metadata)) {
    return metadata!;
  }
  const current = `v${ROOTFS_PREFLIGHT_VERSION}`;
  const version = metadata?.version;
  const actual = version == null ? "missing" : `v${version}`;
  throw new Error(
    `cached RootFS image '${image}' does not satisfy CoCalc runtime preflight ${current} (found ${actual} at ${metadataPath}); delete the cached image or reprovision the host`,
  );
}

function validatePreflightResult(result: unknown): RawPreflightResult {
  if (result == null || typeof result !== "object") {
    throw new Error("rootfs preflight returned invalid JSON");
  }
  const value = result as Record<string, unknown>;
  const distro_family = `${value.distro_family ?? ""}`.trim();
  const package_manager = `${value.package_manager ?? ""}`.trim();
  const shell = `${value.shell ?? ""}`.trim();
  if (
    !["debian", "rhel", "sles", "unknown"].includes(distro_family) ||
    !["apt-get", "dnf", "microdnf", "yum", "zypper", "none"].includes(
      package_manager,
    ) ||
    !shell.startsWith("/") ||
    value.glibc !== true ||
    typeof value.sudo_present !== "boolean" ||
    typeof value.ca_certificates_present !== "boolean"
  ) {
    throw new Error(
      `rootfs preflight returned an unexpected result: ${JSON.stringify(
        value,
      )}`,
    );
  }
  return {
    distro_family: distro_family as RawPreflightResult["distro_family"],
    package_manager: package_manager as RawPreflightResult["package_manager"],
    shell,
    glibc: true,
    sudo_present: value.sudo_present as boolean,
    ca_certificates_present: value.ca_certificates_present as boolean,
  };
}

export async function writeRootfsPreflightMetadata({
  metadataPath,
  metadata,
}: {
  metadataPath: string;
  metadata: RootfsPreflightMetadata;
}): Promise<void> {
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

export async function preflightRootfsInPlace({
  image,
  rootfsPath,
  onProgress,
  skipOwnershipBridge,
}: {
  image: string;
  rootfsPath: string;
  onProgress?: RootfsPreflightProgress;
  skipOwnershipBridge?: boolean;
}): Promise<RootfsPreflightMetadata> {
  onProgress?.({
    message: "checking RootFS preflight prerequisites",
    detail: {
      image,
      rootfs_path: rootfsPath,
      skip_ownership_bridge: skipOwnershipBridge === true,
    },
  });
  logger.info("preflighting rootfs", {
    image,
    rootfs_path: rootfsPath,
    version: ROOTFS_PREFLIGHT_VERSION,
    skip_ownership_bridge: skipOwnershipBridge === true,
  });
  let stdout = "";
  try {
    const result = await executeCode({
      command: "sudo",
      args: ["-n", STORAGE_WRAPPER, "normalize-rootfs", rootfsPath],
      env: skipOwnershipBridge
        ? { COCALC_ROOTFS_SKIP_OWNERSHIP_BRIDGE: "1" }
        : undefined,
      err_on_exit: true,
      verbose: false,
      timeout: 45 * 60,
    });
    stdout = `${result.stdout ?? ""}`.trim();
  } catch (err) {
    throw new Error(`failed RootFS preflight for '${image}': ${err}`);
  }
  const metadata: RootfsPreflightMetadata = {
    version: ROOTFS_PREFLIGHT_VERSION,
    normalized_at: nowIso(),
    image,
    rootfs_path: rootfsPath,
    ...validatePreflightResult(parsePreflightOutput(stdout)),
  };
  onProgress?.({
    message: "validated RootFS bootstrap prerequisites",
    detail: {
      image,
      distro_family: metadata.distro_family,
      package_manager: metadata.package_manager,
    },
  });
  return metadata;
}

export const loadRootfsNormalizationMetadata = loadRootfsPreflightMetadata;
export const requireCurrentRootfsNormalizationMetadata =
  requireCurrentRootfsPreflightMetadata;
export const writeRootfsNormalizationMetadata = writeRootfsPreflightMetadata;
export const normalizeRootfsInPlace = preflightRootfsInPlace;
