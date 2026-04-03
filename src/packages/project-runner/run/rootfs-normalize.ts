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

export type PulledImagePreflightResult = RawPreflightResult;

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

export async function preflightPulledOciImage({
  image,
  onProgress,
}: {
  image: string;
  onProgress?: RootfsPreflightProgress;
}): Promise<PulledImagePreflightResult> {
  onProgress?.({
    message: "probing pulled OCI image bootstrap support",
    detail: { image },
  });
  let stdout = "";
  try {
    const result = await executeCode({
      command: "podman",
      args: [
        "unshare",
        "bash",
        "-lc",
        `
set -euo pipefail
image="$1"
mnt=""
cleanup() {
  if [ -n "$mnt" ]; then
    podman image unmount "$image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
mnt="$(podman image mount "$image")"
shell_path=""
if [ -x "$mnt/bin/bash" ]; then
  shell_path="/bin/bash"
elif [ -x "$mnt/bin/sh" ]; then
  shell_path="/bin/sh"
else
  echo "OCI image preflight failed: usable shell missing (expected /bin/bash or /bin/sh)" >&2
  exit 41
fi
has_ca_certificates() {
  [ -d "$mnt/etc/ssl/certs" ] || \
    [ -f "$mnt/etc/ssl/cert.pem" ] || \
    [ -f "$mnt/etc/pki/tls/certs/ca-bundle.crt" ] || \
    [ -f "$mnt/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem" ] || \
    [ -f "$mnt/etc/ssl/ca-bundle.pem" ]
}
sudo_present=false
if [ -x "$mnt/usr/bin/sudo" ] || [ -x "$mnt/bin/sudo" ]; then
  sudo_present=true
fi
ca_certificates_present=false
if has_ca_certificates; then
  ca_certificates_present=true
fi
distro_family="unknown"
package_manager="none"
if [ -x "$mnt/usr/bin/apt-get" ] || [ -x "$mnt/bin/apt-get" ]; then
  distro_family="debian"
  package_manager="apt-get"
elif [ -x "$mnt/usr/bin/dnf" ] || [ -x "$mnt/bin/dnf" ]; then
  distro_family="rhel"
  package_manager="dnf"
elif [ -x "$mnt/usr/bin/microdnf" ] || [ -x "$mnt/bin/microdnf" ]; then
  distro_family="rhel"
  package_manager="microdnf"
elif [ -x "$mnt/usr/bin/yum" ] || [ -x "$mnt/bin/yum" ]; then
  distro_family="rhel"
  package_manager="yum"
elif [ -x "$mnt/usr/bin/zypper" ] || [ -x "$mnt/bin/zypper" ]; then
  distro_family="sles"
  package_manager="zypper"
fi
if [ ! -e "$mnt/lib64/ld-linux-x86-64.so.2" ] && \
   [ ! -e "$mnt/lib/x86_64-linux-gnu/libc.so.6" ] && \
   [ ! -e "$mnt/lib/ld-linux-aarch64.so.1" ] && \
   [ ! -e "$mnt/lib64/ld-linux-aarch64.so.1" ] && \
   [ ! -e "$mnt/lib/aarch64-linux-gnu/libc.so.6" ]; then
  echo "OCI image preflight failed: glibc is required" >&2
  exit 43
fi
if [ "$sudo_present" = false ] || [ "$ca_certificates_present" = false ]; then
  if [ "$package_manager" = "none" ]; then
    echo "OCI image preflight failed: startup bootstrap requires sudo and CA certificates, but this image has neither a supported package manager nor the required packages preinstalled" >&2
    exit 44
  fi
fi
printf '{"ok":true,"distro_family":"%s","package_manager":"%s","shell":"%s","glibc":true,"sudo_present":%s,"ca_certificates_present":%s}\n' \
  "$distro_family" "$package_manager" "$shell_path" "$sudo_present" "$ca_certificates_present"
        `,
        "cocalc-pulled-image-preflight",
        image,
      ],
      err_on_exit: true,
      verbose: false,
      timeout: 10 * 60,
    });
    stdout = `${result.stdout ?? ""}`.trim();
  } catch (err) {
    throw new Error(`failed OCI image preflight for '${image}': ${err}`);
  }
  const metadata = validatePreflightResult(parsePreflightOutput(stdout));
  onProgress?.({
    message: "validated pulled OCI image bootstrap support",
    detail: {
      image,
      distro_family: metadata.distro_family,
      package_manager: metadata.package_manager,
    },
  });
  return metadata;
}
