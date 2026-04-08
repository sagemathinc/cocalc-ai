/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  conatPassword as defaultPassword,
  conatServer as defaultAddress,
} from "@cocalc/backend/data";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
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
  return {
    address: configuredEnv("COCALC_INTER_BAY_CONAT_SERVER") ?? defaultAddress,
    password:
      configuredEnv("COCALC_INTER_BAY_CONAT_PASSWORD") ?? defaultPassword,
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
