/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFile, writeFile } from "node:fs/promises";
import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";

const logger = getLogger("project-runner:rootfs-normalize");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

export const ROOTFS_NORMALIZER_VERSION = 1;

export type RootfsNormalizationMetadata = {
  version: number;
  normalized_at: string;
  image: string;
  rootfs_path: string;
  distro_family: "debian" | "rhel" | "sles";
  package_manager: "apt-get" | "dnf" | "microdnf" | "yum" | "zypper";
  shell: string;
  glibc: true;
  sudo: true;
  ca_certificates: true;
  curl: true;
  runtime_user: string;
  runtime_uid: number;
  runtime_gid: number;
  runtime_home: string;
};

type RawNormalizationResult = Omit<
  RootfsNormalizationMetadata,
  "version" | "normalized_at" | "image" | "rootfs_path"
>;

type RootfsNormalizationProgress = (update: {
  message: string;
  detail?: Record<string, unknown>;
}) => void;

function parseNormalizationOutput(stdout: string): unknown {
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

function isCurrentMetadata(metadata?: RootfsNormalizationMetadata): boolean {
  return (
    metadata?.version === ROOTFS_NORMALIZER_VERSION &&
    metadata.runtime_user === DEFAULT_PROJECT_RUNTIME_USER &&
    metadata.runtime_uid === DEFAULT_PROJECT_RUNTIME_UID &&
    metadata.runtime_gid === DEFAULT_PROJECT_RUNTIME_GID &&
    metadata.runtime_home === DEFAULT_PROJECT_RUNTIME_HOME &&
    metadata.glibc === true &&
    metadata.sudo === true &&
    metadata.ca_certificates === true &&
    metadata.curl === true
  );
}

export async function loadRootfsNormalizationMetadata(
  metadataPath: string,
): Promise<RootfsNormalizationMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as RootfsNormalizationMetadata;
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
      `invalid RootFS normalization metadata at '${metadataPath}': ${err}`,
    );
  }
}

export function requireCurrentRootfsNormalizationMetadata({
  image,
  metadataPath,
  metadata,
}: {
  image: string;
  metadataPath: string;
  metadata?: RootfsNormalizationMetadata;
}): RootfsNormalizationMetadata {
  if (isCurrentMetadata(metadata)) {
    return metadata!;
  }
  const current = `v${ROOTFS_NORMALIZER_VERSION}`;
  const version = metadata?.version;
  const actual = version == null ? "missing" : `v${version}`;
  throw new Error(
    `cached RootFS image '${image}' is not normalized for CoCalc runtime contract ${current} (found ${actual} at ${metadataPath}); delete the cached image or reprovision the host`,
  );
}

function validateNormalizationResult(result: unknown): RawNormalizationResult {
  if (result == null || typeof result !== "object") {
    throw new Error("rootfs normalizer returned invalid JSON");
  }
  const value = result as Record<string, unknown>;
  const distro_family = `${value.distro_family ?? ""}`.trim();
  const package_manager = `${value.package_manager ?? ""}`.trim();
  const shell = `${value.shell ?? ""}`.trim();
  const runtime_user = `${value.runtime_user ?? ""}`.trim();
  const runtime_home = `${value.runtime_home ?? ""}`.trim();
  const runtime_uid = Number(value.runtime_uid);
  const runtime_gid = Number(value.runtime_gid);
  if (
    !["debian", "rhel", "sles"].includes(distro_family) ||
    !["apt-get", "dnf", "microdnf", "yum", "zypper"].includes(
      package_manager,
    ) ||
    !shell.startsWith("/") ||
    runtime_user !== DEFAULT_PROJECT_RUNTIME_USER ||
    runtime_home !== DEFAULT_PROJECT_RUNTIME_HOME ||
    runtime_uid !== DEFAULT_PROJECT_RUNTIME_UID ||
    runtime_gid !== DEFAULT_PROJECT_RUNTIME_GID ||
    value.glibc !== true ||
    value.sudo !== true ||
    value.ca_certificates !== true ||
    value.curl !== true
  ) {
    throw new Error(
      `rootfs normalizer returned an unexpected contract result: ${JSON.stringify(
        value,
      )}`,
    );
  }
  return {
    distro_family: distro_family as RawNormalizationResult["distro_family"],
    package_manager:
      package_manager as RawNormalizationResult["package_manager"],
    shell,
    glibc: true,
    sudo: true,
    ca_certificates: true,
    curl: true,
    runtime_user,
    runtime_uid,
    runtime_gid,
    runtime_home,
  };
}

export async function writeRootfsNormalizationMetadata({
  metadataPath,
  metadata,
}: {
  metadataPath: string;
  metadata: RootfsNormalizationMetadata;
}): Promise<void> {
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

export async function normalizeRootfsInPlace({
  image,
  rootfsPath,
  onProgress,
}: {
  image: string;
  rootfsPath: string;
  onProgress?: RootfsNormalizationProgress;
}): Promise<RootfsNormalizationMetadata> {
  onProgress?.({
    message: "normalizing RootFS for CoCalc runtime",
    detail: { image, rootfs_path: rootfsPath },
  });
  logger.info("normalizing rootfs", {
    image,
    rootfs_path: rootfsPath,
    version: ROOTFS_NORMALIZER_VERSION,
  });
  let stdout = "";
  try {
    const result = await executeCode({
      command: "sudo",
      args: ["-n", STORAGE_WRAPPER, "normalize-rootfs", rootfsPath],
      err_on_exit: true,
      verbose: false,
      timeout: 45 * 60,
    });
    stdout = `${result.stdout ?? ""}`.trim();
  } catch (err) {
    throw new Error(`failed normalizing RootFS image '${image}': ${err}`);
  }
  const metadata: RootfsNormalizationMetadata = {
    version: ROOTFS_NORMALIZER_VERSION,
    normalized_at: nowIso(),
    image,
    rootfs_path: rootfsPath,
    ...validateNormalizationResult(parseNormalizationOutput(stdout)),
  };
  onProgress?.({
    message: "validated RootFS runtime contract",
    detail: {
      image,
      distro_family: metadata.distro_family,
      package_manager: metadata.package_manager,
    },
  });
  return metadata;
}
