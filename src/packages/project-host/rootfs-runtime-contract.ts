/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executePodman } from "@cocalc/backend/podman";
import { createHash } from "node:crypto";
import {
  projectRuntimeRootfsContractLabels,
  rootfsLabelsSatisfyCurrentProjectRuntimeContract,
} from "@cocalc/util/project-runtime";

const USERNS_MAP_SHA256_LABEL = "com.cocalc.rootfs.userns_map_sha256";

function normalizeUsernsMap(raw: string): string {
  return `${raw ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

export function projectRuntimeUsernsMapFingerprint({
  uidMap,
  gidMap,
}: {
  uidMap: string;
  gidMap: string;
}): string {
  return createHash("sha256")
    .update(
      `uid:${normalizeUsernsMap(uidMap)}\ngid:${normalizeUsernsMap(gidMap)}\n`,
    )
    .digest("hex");
}

export async function readCurrentProjectRuntimeUsernsMapFingerprint(): Promise<string> {
  const [{ stdout: uidMap }, { stdout: gidMap }] = await Promise.all([
    executePodman(["unshare", "cat", "/proc/self/uid_map"], {
      err_on_exit: true,
    }),
    executePodman(["unshare", "cat", "/proc/self/gid_map"], {
      err_on_exit: true,
    }),
  ]);
  return projectRuntimeUsernsMapFingerprint({
    uidMap: `${uidMap ?? ""}`,
    gidMap: `${gidMap ?? ""}`,
  });
}

export function projectRuntimeRootfsContractLabelsForCurrentHost({
  usernsMapFingerprint,
}: {
  usernsMapFingerprint: string;
}): Record<string, string> {
  return {
    ...projectRuntimeRootfsContractLabels(),
    [USERNS_MAP_SHA256_LABEL]: usernsMapFingerprint,
  };
}

export function rootfsInspectLabels(
  inspectData?: Record<string, any>,
): Record<string, unknown> | undefined {
  const labels = inspectData?.Config?.Labels;
  if (!labels || typeof labels !== "object") {
    return undefined;
  }
  return labels as Record<string, unknown>;
}

export function inspectLabelsSatisfyCurrentProjectRuntimeContract({
  labels,
  usernsMapFingerprint,
}: {
  labels?: Record<string, unknown> | null;
  usernsMapFingerprint: string;
}): boolean {
  return (
    rootfsLabelsSatisfyCurrentProjectRuntimeContract(labels) &&
    `${labels?.[USERNS_MAP_SHA256_LABEL] ?? ""}` === usernsMapFingerprint
  );
}
