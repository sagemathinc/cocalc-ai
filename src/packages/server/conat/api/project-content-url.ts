/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Content-origin links for project files (trust-free step 6, phase 3).

The hub signs a short-lived read capability and returns

  https://<project>.h-<host>.<content domain>/_c/<capability>/files/<path>

which the project's host serves on an origin of its own, with no cookies
(project-host/content-origin.ts).  Only owners and collaborators get one,
matching what the host checks on every request.

When the content origin can't serve this project, the result says why
instead of throwing, so the frontend can fall back to today's behavior:
  - "off": no content domain is configured;
  - "no-host": the project has no host yet;
  - "host-not-ready": the host has no content DNS record for this domain;
  - "other-bay": the project or its host belongs to another bay (the
    capability must be signed with that bay's key; not wired up yet).
*/

import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import {
  issueProjectContentCapability,
  PROJECT_CONTENT_CAPABILITY_MIN_TTL_SECONDS,
  PROJECT_CONTENT_CAPABILITY_TTL_SECONDS,
} from "@cocalc/conat/auth/project-content-capability";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isValidUUID } from "@cocalc/util/misc";
import {
  hostContentWildcardHostname,
  projectContentHostname,
} from "@cocalc/util/project-content-origin";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  recordedContentDns,
  resolveProjectContentDomain,
} from "@cocalc/server/cloud/host-content-dns";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";

export type ProjectContentUrlUnavailable =
  | "off"
  | "no-host"
  | "host-not-ready"
  | "other-bay";

export type ProjectContentUrl =
  | { url: string; expires_at: number }
  | { unavailable: ProjectContentUrlUnavailable };

const MAX_PATH_LENGTH = 4096;

// The path as URL segments, or an error.  Absolute and home-relative paths
// both work: the host's file route re-adds the leading slash.
export function encodeContentFilePath(path: unknown): string {
  const raw = `${path ?? ""}`;
  if (raw.length > MAX_PATH_LENGTH || raw.includes("\0")) {
    throw new Error("invalid path");
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("invalid path");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export async function issueProjectContentUrlLocal({
  account_id,
  project_id,
  path,
  browser_session_exp_s,
  now_ms = Date.now(),
}: {
  account_id: string;
  project_id: string;
  path: string;
  // A restricted (testing) browser session must not outlive its link.
  browser_session_exp_s?: number;
  now_ms?: number;
}): Promise<ProjectContentUrl> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error("invalid project or account");
  }
  const filePath = encodeContentFilePath(path);
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) {
    throw new Error("account is banned");
  }

  const domain = resolveProjectContentDomain(await getServerSettings());
  if (!domain) return { unavailable: "off" };

  const localBayId = getConfiguredBayId();
  const { rows: projects } = await getPool().query<{
    host_id: string | null;
    bay_id: string;
    group: string | null;
  }>(
    `SELECT host_id, COALESCE(owning_bay_id, $3) AS bay_id,
            users -> $2::text ->> 'group' AS "group"
       FROM projects
      WHERE project_id = $1 AND deleted IS NOT true`,
    [project_id, account_id, localBayId],
  );
  const project = projects[0];
  if (project == null) {
    const ownership = await resolveProjectBay(project_id);
    if (ownership != null && ownership.bay_id !== localBayId) {
      return { unavailable: "other-bay" };
    }
    throw new Error("project not found");
  }
  if (project.bay_id !== localBayId) return { unavailable: "other-bay" };
  // The host makes the same check on every request; viewers have restricted
  // read policies that a whole-project capability would bypass.
  if (!isProjectCollaboratorGroup(project.group)) {
    throw new Error("not authorized for project content");
  }
  const host_id = project.host_id;
  if (!host_id) return { unavailable: "no-host" };

  const { rows: hosts } = await getPool().query<{
    bay_id: string;
    deleted: unknown;
    metadata: Record<string, any> | null;
  }>(
    `SELECT COALESCE(bay_id, $2) AS bay_id, deleted, metadata
       FROM project_hosts WHERE id = $1`,
    [host_id, localBayId],
  );
  const host = hosts[0];
  if (host == null || host.deleted) return { unavailable: "host-not-ready" };
  if (host.bay_id !== localBayId) return { unavailable: "other-bay" };
  const recorded = recordedContentDns({ id: host_id, metadata: host.metadata });
  if (recorded?.name !== hostContentWildcardHostname({ host_id, domain })) {
    return { unavailable: "host-not-ready" };
  }

  let ttl_seconds = PROJECT_CONTENT_CAPABILITY_TTL_SECONDS;
  if (browser_session_exp_s != null) {
    ttl_seconds = Math.min(
      ttl_seconds,
      Math.floor(browser_session_exp_s - now_ms / 1000),
    );
    if (ttl_seconds < PROJECT_CONTENT_CAPABILITY_MIN_TTL_SECONDS) {
      throw new Error("browser session expires too soon");
    }
  }
  const { token, expires_at } = issueProjectContentCapability({
    project_id,
    host_id,
    account_id,
    // Projects don't carry a content epoch yet (the host also reads 0); the
    // "revoke links" button adds one.
    epoch: 0,
    private_key: getProjectHostAuthTokenPrivateKey(),
    ttl_seconds,
    now_ms,
  });
  const hostname = projectContentHostname({ project_id, host_id, domain });
  return {
    url: `https://${hostname}/_c/${token}/files/${filePath}`,
    expires_at,
  };
}
