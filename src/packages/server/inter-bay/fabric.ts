/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  conatPassword as defaultPassword,
  conatServer as defaultAddress,
} from "@cocalc/backend/data";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import { getClusterConfig } from "@cocalc/server/cluster-config";
import {
  connect,
  type Client,
  type ClientOptions,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";

export interface InterBayFabricConfig {
  address: string;
  password: string;
}

function configuredEnv(name: string): string | undefined {
  const value = `${process.env[name] ?? ""}`.trim();
  return value || undefined;
}

export function getInterBayFabricConfig(): InterBayFabricConfig {
  const explicitAddress = configuredEnv("COCALC_INTER_BAY_CONAT_SERVER");
  const explicitPassword = configuredEnv("COCALC_INTER_BAY_CONAT_PASSWORD");
  if (explicitAddress || explicitPassword) {
    return {
      address: explicitAddress ?? defaultAddress,
      password: explicitPassword ?? defaultPassword,
    };
  }
  const cluster = getClusterConfig();
  if (cluster.role === "attached") {
    if (!cluster.seed_conat_server) {
      throw new Error(
        "attached bay requires COCALC_CLUSTER_SEED_CONAT_SERVER or COCALC_INTER_BAY_CONAT_SERVER",
      );
    }
    if (!cluster.seed_conat_password) {
      throw new Error(
        "attached bay requires COCALC_CLUSTER_SEED_CONAT_PASSWORD or COCALC_INTER_BAY_CONAT_PASSWORD",
      );
    }
    return {
      address: cluster.seed_conat_server,
      password: cluster.seed_conat_password,
    };
  }
  return {
    address: defaultAddress,
    password: defaultPassword,
  };
}

export function getInterBayFabricClient(
  opts: Pick<ClientOptions, "noCache"> = {},
): Client {
  const { address, password } = getInterBayFabricConfig();
  if (!password) {
    throw new Error("missing inter-bay Conat password");
  }
  return connect({
    address,
    noCache: opts.noCache,
    inboxPrefix: inboxPrefix({ hub_id: "hub" }),
    extraHeaders: {
      Cookie: `${HUB_PASSWORD_COOKIE_NAME}=${password}`,
    },
  });
}
