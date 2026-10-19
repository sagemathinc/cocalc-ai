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

A link reads only the file's own folder and its subfolders: HTML in a
project isn't always written by its members (course collect and peer
grading copy students' folders into other projects), so a page must not
reach the rest of the project.

When the content origin can't serve this project, the result says why
instead of throwing, so the frontend can fall back to today's behavior:
  - "off": no content domain is configured;
  - "no-host": the project has no host yet;
  - "host-not-ready": the host has no content DNS record for this domain,
    or doesn't report serving it (old software, or a missing env line);
  - "other-bay": the project or its host belongs to another bay (the
    capability must be signed with that bay's key; not wired up yet);
  - "no-access": the account isn't an owner or collaborator (viewers have
    restricted read policies a folder link would bypass).
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
  | "other-bay"
  | "no-access";

export type ProjectContentUrl =
  | { url: string; expires_at: number }
  | { unavailable: ProjectContentUrlUnavailable };

const MAX_PATH_LENGTH = 4096;

function contentPathSegments(path: unknown): string[] {
  const raw = `${path ?? ""}`;
  // Relative paths would silently mean the filesystem root.
  if (
    !raw.startsWith("/") ||
    raw.length > MAX_PATH_LENGTH ||
    raw.includes("\0")
  ) {
    throw new Error("invalid path");
  }
  const segments = raw.split("/").filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("invalid path");
  }
  return segments;
}

// The path as URL segments, or an error.  The host's file route treats the
// result as absolute (it re-adds the leading slash).
export function encodeContentFilePath(path: unknown): string {
  return contentPathSegments(path)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// The folder a link to this file may read: the file's own directory.
export function contentDirForFile(path: unknown): string {
  return `/${contentPathSegments(path).slice(0, -1).join("/")}`;
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
  const dir = contentDirForFile(path);
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
    content_epoch: string | number;
  }>(
    `SELECT host_id, COALESCE(owning_bay_id, $3) AS bay_id,
            users -> $2::text ->> 'group' AS "group",
            COALESCE(content_epoch, 0)::bigint AS content_epoch
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
    return { unavailable: "no-access" };
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
  if (
    recorded?.name !== hostContentWildcardHostname({ host_id, domain }) ||
    host.metadata?.content_origin_domain !== domain
  ) {
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
    // Bumped by "Revoke content links"; the host refuses any other value.
    epoch: Number(project.content_epoch ?? 0),
    dir,
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

export interface RevokedProjectContentLinks {
  content_epoch: number;
  // Whether the project's host has the new epoch.  If not, it catches up at
  // its next poll of project changes, or at once when it sees a new link.
  host_synced: boolean;
}

// "Revoke content links": bump the project's content epoch, so the host
// refuses every link issued before, and push it to the host now.
export async function revokeProjectContentLinksLocal({
  account_id,
  project_id,
  syncHost,
}: {
  account_id: string;
  project_id: string;
  syncHost: (project_id: string) => Promise<void>;
}): Promise<RevokedProjectContentLinks> {
  if (!isValidUUID(account_id) || !isValidUUID(project_id)) {
    throw new Error("invalid project or account");
  }
  const localBayId = getConfiguredBayId();
  const { rows } = await getPool().query<{ content_epoch: string | number }>(
    `UPDATE projects
        SET content_epoch = COALESCE(content_epoch, 0) + 1,
            -- the cursor of hosts' catch-up sync, so a failed push below is
            -- re-delivered at the host's next poll
            last_edited = NOW()
      WHERE project_id = $1
        AND deleted IS NOT true
        AND COALESCE(owning_bay_id, $3) = $3
        AND users -> $2::text ->> 'group' IN ('owner', 'collaborator')
      RETURNING content_epoch`,
    [project_id, account_id, localBayId],
  );
  if (rows[0] == null) {
    throw new Error("not authorized to revoke this project's content links");
  }
  let host_synced = false;
  try {
    await syncHost(project_id);
    host_synced = true;
  } catch {
    // The host still catches up: see RevokedProjectContentLinks.
  }
  return { content_epoch: Number(rows[0].content_epoch), host_synced };
}
