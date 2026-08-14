/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { RemoteInstance } from "@cocalc/cloud";
import type { ComputeVmConfig } from "./config";

function sameResourceUri(observed: unknown, expected: string) {
  const normalized = `${observed ?? ""}`.replace(
    /^https:\/\/[^/]+\/compute\/v1\//,
    "",
  );
  return normalized === expected;
}

export function assertComputeVmSecurity(
  instance: RemoteInstance,
  config: ComputeVmConfig,
  expectedSubnetwork?: string,
): void {
  const observed = instance.metadata?.gcp_security ?? {};
  const violations: string[] = [];
  if (observed.service_account_count !== 0) {
    violations.push("service account is attached");
  }
  if (observed.can_ip_forward !== false) {
    violations.push("IP forwarding is enabled");
  }
  if (observed.deletion_protection !== false) {
    violations.push("deletion protection is enabled");
  }
  if (observed.block_project_ssh_keys !== true) {
    violations.push("project-wide SSH keys are not blocked");
  }
  if (
    !Array.isArray(observed.tags) ||
    !observed.tags.includes(config.gcp_network_tag)
  ) {
    violations.push(
      `required network tag '${config.gcp_network_tag}' is missing`,
    );
  }
  if (
    observed.external_access_config_count !== 0 &&
    `${observed.network_tier ?? ""}`.toUpperCase() !== "STANDARD"
  ) {
    violations.push("external interface is not Standard Tier");
  }
  if (observed.external_ipv6 !== false) {
    violations.push("external IPv6 is enabled");
  }
  if (
    expectedSubnetwork &&
    !sameResourceUri(observed.subnetwork, expectedSubnetwork)
  ) {
    violations.push("instance is not attached to the configured subnetwork");
  }
  if (violations.length) {
    throw new Error(
      `managed compute VM security invariant failed: ${violations.join("; ")}`,
    );
  }
}
