/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { DEFAULT_SEED_BAY_ID } from "@cocalc/util/bay";
import { readFileSync } from "node:fs";

export type ClusterRole = "standalone" | "seed" | "attached";

export interface ClusterConfig {
  cluster_id: string;
  role: ClusterRole;
  seed_bay_id: string;
  seed_conat_server?: string;
  seed_conat_password?: string;
}

function configuredEnv(name: string): string | undefined {
  const value = `${process.env[name] ?? ""}`.trim();
  return value || undefined;
}

export function getConfiguredBayCredential(): string | undefined {
  const filename = configuredEnv("COCALC_BAY_CREDENTIAL_FILE");
  if (filename) {
    const value = readFileSync(filename, "utf8").trim();
    if (!value) throw Error(`empty bay credential file '${filename}'`);
    return value;
  }
  return configuredEnv("COCALC_BAY_CREDENTIAL");
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
    (getConfiguredClusterRole() === "attached"
      ? DEFAULT_SEED_BAY_ID
      : getConfiguredBayId())
  );
}

export function getConfiguredClusterId(): string {
  return configuredEnv("COCALC_CLUSTER_ID") ?? "standalone";
}

export function getClusterConfig(): ClusterConfig {
  return {
    cluster_id: getConfiguredClusterId(),
    role: getConfiguredClusterRole(),
    seed_bay_id: getConfiguredClusterSeedBayId(),
    seed_conat_server: configuredEnv("COCALC_CLUSTER_SEED_CONAT_SERVER"),
    seed_conat_password: configuredEnv("COCALC_CLUSTER_SEED_CONAT_PASSWORD"),
  };
}

/**
 * Static configured bay ids.
 *
 * Do not use this for request routing, ownership lookup, or hot-path fanout.
 * Prefer project/host/account directory lookups. Use this only for static
 * configuration, startup validation, low-frequency admin aggregation, or
 * bounded maintenance tasks where touching every bay is explicitly intended.
 */
export function getConfiguredClusterBayIdsForStaticEnumerationOnly(): string[] {
  const fromEnv =
    `${process.env.COCALC_CLUSTER_BAY_IDS ?? process.env.HUB_CLUSTER_BAY_IDS ?? ""}`
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const fallback = [
    getConfiguredBayId(),
    ...(getConfiguredClusterRole() === "attached"
      ? [getConfiguredClusterSeedBayId()]
      : []),
  ];
  return [...new Set([...fromEnv, ...fallback])];
}

export function isMultiBayCluster(): boolean {
  return getConfiguredClusterRole() !== "standalone";
}
