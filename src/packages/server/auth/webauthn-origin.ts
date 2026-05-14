/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request } from "express";

import getCustomize from "@cocalc/database/settings/customize";
import {
  getSitePublicOriginForRequest,
  normalizeHostname,
  normalizeOrigin,
} from "@cocalc/server/bay-public-origin";

export type WebAuthnRelyingParty = {
  origin: string;
  rp_id: string;
  rp_name: string;
};

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function assertWebAuthnOrigin(origin: string): void {
  const url = new URL(origin);
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && isLocalhost(url.hostname)) {
    return;
  }
  throw new Error("passkeys require HTTPS or localhost development");
}

export async function getWebAuthnRelyingPartyForRequest(
  req?: Request,
): Promise<WebAuthnRelyingParty> {
  const origin = normalizeOrigin(await getSitePublicOriginForRequest(req));
  if (!origin) {
    throw new Error("unable to determine public origin for passkeys");
  }
  assertWebAuthnOrigin(origin);
  const rp_id = normalizeHostname(origin);
  if (!rp_id) {
    throw new Error("unable to determine relying party id for passkeys");
  }
  const customize = await getCustomize(["siteName"]);
  return {
    origin,
    rp_id,
    rp_name: `${customize.siteName ?? "CoCalc"}`.trim() || "CoCalc",
  };
}
