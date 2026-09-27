/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { hasApiKeyProjectCapability } from "@cocalc/server/api/api-key-scope";
import { issueProjectHostApiKeyToken } from "@cocalc/server/api/project-host-api-key";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { resolveHostConnection } from "@cocalc/server/conat/api/hosts";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { isValidUUID } from "@cocalc/util/misc";

export default async function handle(req, res) {
  try {
    const principal = await getAccountFromApiKey(req);
    if (!principal?.account_id || !principal.key_id) {
      throw new Error("must authenticate with an account API key");
    }
    const { project_id, http_proxy_port } = getParams(req);
    if (!isValidUUID(project_id)) {
      throw new Error("project_id must be a valid UUID");
    }
    if (
      http_proxy_port !== undefined &&
      (!Number.isInteger(http_proxy_port) ||
        http_proxy_port < 1 ||
        http_proxy_port > 65535)
    ) {
      throw new Error("http_proxy_port must be an integer between 1 and 65535");
    }
    if (
      http_proxy_port !== undefined &&
      !hasApiKeyProjectCapability(principal, "project:exec", project_id)
    ) {
      throw new Error("HTTP proxy access requires project:exec");
    }
    if (
      !(["project:exec", "file:read", "file:write"] as const).some(
        (capability) =>
          hasApiKeyProjectCapability(principal, capability, project_id),
      )
    ) {
      throw new Error(
        "API key does not grant project-host access to this project",
      );
    }
    const reference = await resolveProjectReferenceForMemberAllowRemote({
      account_id: principal.account_id,
      project_id,
    });
    const host_id = reference?.host_id;
    if (!host_id) {
      throw new Error("project has no assigned host");
    }
    const issued = await issueProjectHostApiKeyToken({
      account_id: principal.account_id,
      key_id: principal.key_id,
      scope_revision: principal.scope_revision ?? 0,
      project_id,
      host_id,
      ...(http_proxy_port === undefined ? {} : { http_proxy_port }),
    });
    const connection = await resolveHostConnection({
      account_id: principal.account_id,
      host_id,
      project_id,
    });
    res.json({
      project_id,
      title: reference.title,
      host_id,
      connect_url: connection.connect_url,
      local_proxy: connection.local_proxy === true,
      token: issued.token,
      expires_at: issued.expires_at,
    });
  } catch (err) {
    res.json({ error: err instanceof Error ? err.message : "request failed" });
  }
}
