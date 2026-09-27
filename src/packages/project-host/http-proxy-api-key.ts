/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { IncomingMessage } from "node:http";
import type { EventEmitter } from "node:events";
import { PROJECT_HOST_API_KEY_HTTP_HEADER } from "@cocalc/conat/auth/project-host-http";
import { verifyProjectHostApiKeyHttpToken } from "@cocalc/conat/auth/project-host-token";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { getProjectHostAuthPublicKey } from "./auth-public-key";
import { getProject } from "./sqlite/projects";

export function authorizeScopedHttpProxy(
  req: IncomingMessage,
  host_id: string,
  project_id: string,
) {
  const token = req.headers[PROJECT_HOST_API_KEY_HTTP_HEADER];
  if (token === undefined) return;
  // Consume the credential even on failure. Never send it to the application.
  delete req.headers[PROJECT_HOST_API_KEY_HTTP_HEADER];
  try {
    if (typeof token !== "string" || !token)
      throw new Error("invalid credential");
    const route = /^\/([^/]+)\/proxy\/([1-9][0-9]{0,4})(?:\/|\?|$)/.exec(
      req.url ?? "",
    );
    if (!route || route[1] !== project_id)
      throw new Error("invalid proxy target");
    const pathname = new URL(req.url!, "http://project-host.local").pathname;
    const prefix = `/${project_id}/proxy/${route[2]}`;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      throw new Error("ambiguous proxy target");
    }
    const claims = verifyProjectHostApiKeyHttpToken({
      token,
      host_id,
      project_id,
      port: Number(route[2]),
      public_key: getProjectHostAuthPublicKey(),
    });
    const project = getProject(project_id);
    const member = project?.users?.[claims.sub];
    const group = typeof member === "string" ? member : member?.group;
    if (
      Number(project?.runtime_lifecycle_revision) !==
        claims.api_key?.placement_revision ||
      !isProjectCollaboratorGroup(group)
    )
      throw new Error("project binding changed");
    // Other browser/account credentials must not reach the upstream application.
    delete req.headers.authorization;
    delete req.headers.cookie;
    return claims;
  } catch {
    throw Object.assign(new Error("invalid scoped project-host HTTP access"), {
      statusCode: 403,
    });
  }
}

// Admission is not permission to retain an unbounded response or WebSocket.
export function expireScopedHttpTransport(
  transport: EventEmitter & { destroy: () => unknown },
  expires_at_s: number,
  response = false,
) {
  const remaining = expires_at_s * 1000 - Date.now();
  if (remaining <= 0) {
    transport.destroy();
    return;
  }
  const events = response ? ["finish", "close"] : ["close"];
  const cleanup = () => {
    clearTimeout(timer);
    for (const event of events) transport.removeListener(event, cleanup);
  };
  const timer = setTimeout(() => {
    cleanup();
    transport.destroy();
  }, remaining);
  timer.unref();
  for (const event of events) transport.once(event, cleanup);
}
