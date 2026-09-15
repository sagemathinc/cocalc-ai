/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  conatPassword as defaultPassword,
  conatServer as defaultAddress,
} from "@cocalc/backend/data";
import {
  BAY_CREDENTIAL_COOKIE_NAME,
  HUB_PASSWORD_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";
import {
  getClusterConfig,
  getConfiguredBayCredential,
} from "@cocalc/server/cluster-config";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  connect,
  type Client,
  type ClientOptions,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";

export interface InterBayFabricConfig {
  address: string;
  cookieName: string;
  credential: string;
  bayId: string;
}

function configuredEnv(name: string): string | undefined {
  const value = `${process.env[name] ?? ""}`.trim();
  return value || undefined;
}

export function getInterBayFabricConfig(): InterBayFabricConfig {
  const explicitAddress = configuredEnv("COCALC_INTER_BAY_CONAT_SERVER");
  const explicitPassword = configuredEnv("COCALC_INTER_BAY_CONAT_PASSWORD");
  const cluster = getClusterConfig();
  if (cluster.role === "standalone" && (explicitAddress || explicitPassword)) {
    return {
      address: explicitAddress ?? defaultAddress,
      cookieName: HUB_PASSWORD_COOKIE_NAME,
      credential: explicitPassword ?? defaultPassword,
      bayId: "hub",
    };
  }
  if (cluster.role !== "standalone") {
    if (cluster.role === "attached" && !cluster.seed_conat_server) {
      throw new Error(
        "attached bay requires COCALC_CLUSTER_SEED_CONAT_SERVER or COCALC_INTER_BAY_CONAT_SERVER",
      );
    }
    const bayCredential = getConfiguredBayCredential();
    if (!bayCredential) {
      throw new Error(
        "multibay fabric requires a distinct COCALC_BAY_CREDENTIAL",
      );
    }
    return {
      address: explicitAddress ?? cluster.seed_conat_server ?? defaultAddress,
      cookieName: BAY_CREDENTIAL_COOKIE_NAME,
      credential: bayCredential,
      bayId: getConfiguredBayId(),
    };
  }
  return {
    address: defaultAddress,
    cookieName: HUB_PASSWORD_COOKIE_NAME,
    credential: defaultPassword,
    bayId: "hub",
  };
}

export function getInterBayFabricClient(
  opts: Pick<ClientOptions, "noCache"> = {},
): Client {
  const { address, cookieName, credential, bayId } = getInterBayFabricConfig();
  if (!credential) {
    throw new Error("missing inter-bay Conat credential");
  }
  return connect({
    address,
    noCache: opts.noCache,
    inboxPrefix: inboxPrefix({ hub_id: `bay:${bayId}` }),
    extraHeaders: {
      Cookie: `${cookieName}=${credential}`,
    },
  });
}
