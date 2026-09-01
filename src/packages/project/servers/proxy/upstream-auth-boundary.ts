/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ClientRequest, IncomingMessage } from "node:http";

import { LEGACY_APP_PROXY_EXPOSURE_HEADER } from "@cocalc/backend/auth/app-proxy";
import {
  PROJECT_PROXY_ACCOUNT_ID_HEADER,
  PROJECT_PROXY_AUTH_HEADER,
} from "@cocalc/backend/auth/project-proxy-auth";
import { stripProjectHostProxyAuthCookies } from "@cocalc/conat/auth/project-host-proxy-boundary";

export function sanitizeAppUpstreamRequest(
  proxyReq: ClientRequest,
  req: IncomingMessage,
): void {
  for (const header of [
    PROJECT_PROXY_AUTH_HEADER,
    PROJECT_PROXY_ACCOUNT_ID_HEADER,
    LEGACY_APP_PROXY_EXPOSURE_HEADER,
  ]) {
    proxyReq.removeHeader(header);
  }

  const cookie = stripProjectHostProxyAuthCookies(req.headers.cookie);
  if (cookie) {
    proxyReq.setHeader("cookie", cookie);
  } else {
    proxyReq.removeHeader("cookie");
  }
}
