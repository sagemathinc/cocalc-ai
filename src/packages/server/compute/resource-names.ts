/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComputeEnvironment } from "./config";
import { createHash } from "node:crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

export function computeDeploymentNamespace(): string | undefined {
  const deployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID?.trim();
  if (!deployment) return;
  return createHash("sha256")
    .update(JSON.stringify([deployment, getConfiguredBayId()]))
    .digest("hex")
    .slice(0, 16);
}

export function computeVmDnsLabelPrefix(): string {
  const namespace = computeDeploymentNamespace();
  return namespace ? `vmd-${namespace}-` : "vm-";
}

export function computeVmDnsLabelIsOwned(label: string): boolean {
  const namespace = computeDeploymentNamespace();
  return (
    !!namespace && new RegExp(`^vmd-${namespace}-[a-f0-9]{32}$`).test(label)
  );
}

export function computeResourceIsOwned(
  name: string | null | undefined,
  environment: ComputeEnvironment,
  resource: "vm" | "vol" = "vm",
): boolean {
  return (
    !!computeDeploymentNamespace() &&
    new RegExp(
      `^${environmentPrefix(environment, resource)}[a-f0-9]{24}(?:-[a-z0-9-]+)?$`,
    ).test(name ?? "")
  );
}

const LEGACY_VM_PREFIX = "cocalc-vm-";
const LEGACY_VOLUME_PREFIX = "cocalc-vol-";

function environmentPrefix(
  environment: ComputeEnvironment,
  resource: "vm" | "vol",
): string {
  const namespace = computeDeploymentNamespace();
  // Do not nest under a legacy prefix: unchanged older hubs sweep that prefix.
  if (namespace)
    return `cocalc-d${namespace}-${environment.slice(0, 1)}-${resource}-`;
  // Production predates environment-scoped names. Preserve its namespace so
  // existing resources remain discoverable while isolating every non-prod bay
  // that may intentionally share the same cloud project or tenant.
  if (environment === "production") {
    return resource === "vm" ? LEGACY_VM_PREFIX : LEGACY_VOLUME_PREFIX;
  }
  return `cocalc-${environment}-${resource}-`;
}

export function managedComputeVmProviderPrefix(
  environment: ComputeEnvironment,
): string {
  return environmentPrefix(environment, "vm");
}

export function managedComputeVolumeProviderPrefix(
  environment: ComputeEnvironment,
): string {
  return environmentPrefix(environment, "vol");
}

export function managedComputeVmProviderName(
  id: string,
  environment: ComputeEnvironment,
): string {
  return `${managedComputeVmProviderPrefix(environment)}${id.replaceAll("-", "").slice(0, 24)}`;
}

export function managedComputeVolumeProviderName(
  id: string,
  environment: ComputeEnvironment,
): string {
  return `${managedComputeVolumeProviderPrefix(environment)}${id.replaceAll("-", "").slice(0, 24)}`;
}

export function managedComputeVmResourceBelongsToEnvironment(
  name: string | null | undefined,
  environment: ComputeEnvironment,
): boolean {
  return `${name ?? ""}`.startsWith(
    managedComputeVmProviderPrefix(environment),
  );
}

export function managedComputeVolumeResourceBelongsToEnvironment(
  name: string | null | undefined,
  environment: ComputeEnvironment,
): boolean {
  return `${name ?? ""}`.startsWith(
    managedComputeVolumeProviderPrefix(environment),
  );
}
