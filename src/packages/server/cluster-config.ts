/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";

export type ClusterRole = "standalone" | "seed" | "attached";

export interface ClusterConfig {
  role: ClusterRole;
  seed_bay_id: string;
  seed_conat_server?: string;
  seed_conat_password?: string;
}

function configuredEnv(name: string): string | undefined {
  const value = `${process.env[name] ?? ""}`.trim();
  return value || undefined;
}

export function getConfiguredClusterRole(): ClusterRole {
  const role = configuredEnv("COCALC_CLUSTER_ROLE") ?? "standalone";
  switch (role) {
    case "standalone":
    case "seed":
    case "attached":
      return role;
    default:
      throw new Error(
        `invalid COCALC_CLUSTER_ROLE '${role}'; expected standalone, seed, or attached`,
      );
  }
}

export function getConfiguredClusterSeedBayId(): string {
  return (
    configuredEnv("COCALC_CLUSTER_SEED_BAY_ID") ??
    (getConfiguredClusterRole() === "attached" ? "bay-0" : getConfiguredBayId())
  );
}

export function getClusterConfig(): ClusterConfig {
  return {
    role: getConfiguredClusterRole(),
    seed_bay_id: getConfiguredClusterSeedBayId(),
    seed_conat_server: configuredEnv("COCALC_CLUSTER_SEED_CONAT_SERVER"),
    seed_conat_password: configuredEnv("COCALC_CLUSTER_SEED_CONAT_PASSWORD"),
  };
}

export function isMultiBayCluster(): boolean {
  return getConfiguredClusterRole() !== "standalone";
}
