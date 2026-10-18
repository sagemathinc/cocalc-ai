/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
DNS for per-project content origins (trust-free step 6).

Each project host with direct ingress gets one proxied wildcard record,
  *.h-<host>.<content domain>  ->  the host's public address,
covering every <project>.h-<host>.<content domain> origin on it.

Lifecycle invariant: the record must stop resolving BEFORE the host's address
can be released (stop, delete, hard restart, a failed start's cleanup), or a
reused address would serve those origins.  So:

- What was created is recorded in metadata.content_dns, and release deletes
  from that record, not from the current setting: clearing or changing the
  content domain cannot strand records.
- Release runs as its own step before every address release and throws on
  failure, so the caller keeps the host (and its address) and retries.
- A sweeper deletes any wildcard whose host is gone, off, or no longer at
  that address: a backstop for crashes, lost metadata and manual edits.
- Ensuring is best effort: a failure only makes content links on that host
  fail until reconciliation retries.
*/

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "../bay-config";
import {
  hostContentWildcardHostname,
  normalizeContentDomain,
} from "@cocalc/util/project-content-origin";
import {
  inferCloudflareBaseDomain,
  normalizeCloudflareHostname,
} from "./derived-domains";
import {
  deleteHostnameDns,
  ensureProxiedAddressDnsWithToken,
  listRouteRecordsUnder,
} from "./dns";

const logger = getLogger("server:cloud:host-content-dns");

export interface HostContentDnsRecord {
  name: string;
  record_id: string;
  domain: string;
  ip: string;
  updated_at: string;
}

interface HostRowLike {
  id: string;
  metadata?: Record<string, any> | null;
}

// The content domain, or undefined if none is configured or it is not a
// separate registrable domain: a domain equal to, under, or above the
// site's own would share the site's cookies with content pages.
export function resolveProjectContentDomain(
  settings: Record<string, any>,
): string | undefined {
  const domain = normalizeContentDomain(settings.project_content_dns);
  if (!domain) return undefined;
  const siteHost = normalizeCloudflareHostname(settings.dns);
  const siteBase = inferCloudflareBaseDomain(siteHost);
  for (const site of [siteHost, siteBase]) {
    if (!site) continue;
    if (
      domain === site ||
      domain.endsWith(`.${site}`) ||
      site.endsWith(`.${domain}`)
    ) {
      logger.warn(
        "project content domain ignored: it must be a separate registrable domain from the site",
        { domain, site },
      );
      return undefined;
    }
  }
  return domain;
}

function contentToken(settings: Record<string, any>): string | undefined {
  for (const value of [
    settings.project_content_cloudflare_api_token,
    settings.project_hosts_cloudflare_tunnel_api_token,
  ]) {
    const token = `${value ?? ""}`.trim();
    if (token) return token;
  }
  return undefined;
}

function recordedContentDns(
  row: HostRowLike,
): HostContentDnsRecord | undefined {
  const value = row.metadata?.content_dns;
  if (!value || typeof value !== "object") return undefined;
  const name = `${value.name ?? ""}`.trim().toLowerCase();
  if (!name.startsWith("*.h-")) return undefined;
  return { ...value, name } as HostContentDnsRecord;
}

async function setContentDnsMetadata(
  host_id: string,
  value: HostContentDnsRecord | null,
): Promise<void> {
  // Field-level updates, so a concurrent whole-metadata write of another
  // field cannot be undone here (and this cannot undo it).
  if (value == null) {
    await getPool().query(
      `UPDATE project_hosts
          SET metadata = COALESCE(metadata, '{}'::jsonb) - 'content_dns',
              updated = NOW()
        WHERE id = $1`,
      [host_id],
    );
  } else {
    await getPool().query(
      `UPDATE project_hosts
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{content_dns}', $2::jsonb, true),
              updated = NOW()
        WHERE id = $1 AND deleted IS NULL`,
      [host_id, JSON.stringify(value)],
    );
  }
}

function isZoneNotFound(err: unknown): boolean {
  return `${(err as Error)?.message ?? err}`.includes(
    "cloudflare zone not found",
  );
}

// Point the host's content wildcard at its current address and record it.
// Best effort: never throws.
export async function syncHostContentDns(row: HostRowLike): Promise<void> {
  try {
    const settings = await getServerSettings();
    const domain = resolveProjectContentDomain(settings);
    const token = contentToken(settings);
    const ip = `${row.metadata?.runtime?.public_ip ?? ""}`.trim();
    const recorded = recordedContentDns(row);
    if (!token) return;
    if (!domain) {
      // The feature was turned off: remove what this host still has.
      if (recorded) await releaseHostContentDns(row);
      return;
    }
    if (!ip) return;
    const name = hostContentWildcardHostname({ host_id: row.id, domain });
    if (recorded && recorded.name !== name) {
      // The content domain changed: the old record goes first.
      await deleteHostnameDns({ hostname: recorded.name, token });
    }
    const { record_id } = await ensureProxiedAddressDnsWithToken({
      name,
      ipAddress: ip,
      token,
    });
    await setContentDnsMetadata(row.id, {
      name,
      record_id,
      domain,
      ip,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn("unable to ensure project content DNS for host", {
      host_id: row.id,
      err: `${err}`,
    });
  }
}

// Remove every content record of the host, recorded or derived from the
// current setting.  Throws unless they are all gone, so the caller does not
// release the address.
export async function releaseHostContentDns(row: HostRowLike): Promise<void> {
  const settings = await getServerSettings();
  const recorded = recordedContentDns(row);
  const names = new Set<string>();
  if (recorded) names.add(recorded.name);
  const domain = resolveProjectContentDomain(settings);
  if (domain) {
    names.add(hostContentWildcardHostname({ host_id: row.id, domain }));
  }
  if (names.size === 0) return;
  const token = contentToken(settings);
  if (!token) {
    if (recorded) {
      throw new Error(
        `cannot remove project content DNS ${recorded.name}: no Cloudflare API token is configured`,
      );
    }
    return;
  }
  for (const hostname of names) {
    try {
      await deleteHostnameDns({ hostname, token });
    } catch (err) {
      // No zone means no record of ours can exist there -- unless one was
      // recorded, in which case the token may simply have lost access.
      if (isZoneNotFound(err) && hostname !== recorded?.name) continue;
      throw err;
    }
  }
  if (recorded) await setContentDnsMetadata(row.id, null);
}

const KEEP_STATUSES = new Set([
  "running",
  "starting",
  "restarting",
  "draining",
  "error",
]);

function hostIdFromWildcard(name: string, domain: string): string | undefined {
  const suffix = `.${domain}`;
  if (!name.startsWith("*.h-") || !name.endsWith(suffix)) return undefined;
  const hex = name.slice("*.h-".length, -suffix.length);
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isValidUUID(id) ? id : undefined;
}

export interface SweepOptions {
  localBayId?: string;
  // Which bay owns a host this bay has no row for; null if no bay knows it.
  resolveHostBay?: (host_id: string) => Promise<{ bay_id: string } | null>;
}

async function defaultResolveHostBay(
  host_id: string,
): Promise<{ bay_id: string } | null> {
  const { resolveHostBay } = await import("../inter-bay/directory");
  return await resolveHostBay(host_id, { include_deleted: true });
}

// Delete content wildcards whose host is gone, off, or no longer at the
// address the record points to, in the current content domain and in every
// domain still recorded on a host.  Records of hosts owned by another bay
// are left to that bay; a record whose host no bay knows is deleted.
export async function sweepProjectContentDns(
  opts: SweepOptions = {},
): Promise<{
  checked: number;
  deleted: number;
}> {
  const localBayId = opts.localBayId ?? getConfiguredBayId();
  const resolveHostBay = opts.resolveHostBay ?? defaultResolveHostBay;
  const settings = await getServerSettings();
  const token = contentToken(settings);
  if (!token) return { checked: 0, deleted: 0 };
  const current = resolveProjectContentDomain(settings);
  const domains = new Set<string>();
  if (current) domains.add(current);
  const { rows: recordedDomains } = await getPool().query(
    `SELECT DISTINCT metadata->'content_dns'->>'domain' AS domain
       FROM project_hosts
      WHERE metadata ? 'content_dns'`,
  );
  for (const { domain } of recordedDomains) {
    const normalized = normalizeContentDomain(domain);
    if (normalized) domains.add(normalized);
  }
  let checked = 0;
  let deleted = 0;
  for (const domain of domains) {
    let records: Awaited<ReturnType<typeof listRouteRecordsUnder>>;
    try {
      records = await listRouteRecordsUnder({ domain, token });
    } catch (err) {
      logger.warn("project content DNS sweep could not list records", {
        domain,
        err: `${err}`,
      });
      continue;
    }
    const byName = new Map<string, typeof records>();
    for (const record of records) {
      if (!hostIdFromWildcard(record.name, domain)) continue;
      byName.set(record.name, [...(byName.get(record.name) ?? []), record]);
    }
    for (const [name, group] of byName) {
      checked += 1;
      const host_id = hostIdFromWildcard(name, domain)!;
      const { rows } = await getPool().query(
        `SELECT status, deleted, COALESCE(bay_id, $2) AS bay_id,
                metadata->'runtime'->>'public_ip' AS ip
           FROM project_hosts WHERE id = $1`,
        [host_id, localBayId],
      );
      const host = rows[0];
      if (host != null && `${host.bay_id}` !== localBayId) continue;
      if (host == null) {
        let owner: { bay_id: string } | null;
        try {
          owner = await resolveHostBay(host_id);
        } catch (err) {
          logger.warn("project content DNS sweep could not resolve host bay", {
            host_id,
            err: `${err}`,
          });
          continue;
        }
        if (owner != null && owner.bay_id !== localBayId) continue;
      }
      const keep =
        domain === current &&
        host != null &&
        host.deleted == null &&
        KEEP_STATUSES.has(`${host.status ?? ""}`) &&
        !!host.ip &&
        group.every((record) => record.type === "A" && record.content === host.ip);
      if (keep) continue;
      try {
        await deleteHostnameDns({ hostname: name, token });
        deleted += 1;
        logger.info("removed stale project content DNS", {
          name,
          host_id,
          status: host?.status,
        });
      } catch (err) {
        logger.warn("unable to remove stale project content DNS", {
          name,
          err: `${err}`,
        });
      }
    }
  }
  return { checked, deleted };
}
