/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import { normalizeProviderId } from "@cocalc/cloud";
import type { HostPublicRouteMode } from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import siteURL from "@cocalc/database/settings/site-url";
import {
  ensureCloudflareTunnelForHost,
  type CloudflareTunnel,
} from "./cloudflare-tunnel";
import { deriveProjectHostHostname } from "./derived-domains";
import {
  deleteHostDns,
  ensureCloudflareProjectHostSslRule,
  ensureHostDns,
  ensureProxiedAddressDns,
  getCloudflareIpv4Cidrs,
  getCloudflareZoneSslMode,
} from "./dns";
import { enqueueHostDnsReconciliation } from "./host-dns-reconciliation";
import { getProviderContext } from "./provider-context";
import { reconcileCloudHostBootstrapOverSsh } from "@cocalc/server/conat/api/hosts-bootstrap-reconcile";
import {
  probeProjectHostPublicRoute,
  type ProjectHostPublicRouteProbeResult,
} from "@cocalc/server/hosts/public-route-probe";

const logger = getLogger("server:cloud:public-route");
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_DEADLINE_MS = Math.max(
  2 * 60_000,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_VERIFY_DEADLINE_MS ?? 10 * 60_000,
  ),
);
const PROBE_RETRY_MS = 2_000;
const STABLE_ROUTE_CONFIRMATION_MS = Math.max(
  0,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_STABLE_CONFIRMATION_MS ?? 5 * 60_000,
  ),
);
const STABLE_ROUTE_SUCCESS_INTERVAL_MS = Math.max(
  0,
  Number(
    process.env.COCALC_HOST_PUBLIC_ROUTE_STABLE_SUCCESS_INTERVAL_MS ?? 30_000,
  ),
);
const STABLE_ROUTE_REQUIRED_SUCCESSES = 3;

type HostRow = {
  id: string;
  name?: string;
  region?: string;
  status?: string;
  public_url?: string | null;
  internal_url?: string | null;
  ssh_server?: string | null;
  metadata?: Record<string, any>;
};

type RouteProgress = (update: {
  phase: string;
  message: string;
  detail?: Record<string, any>;
  progress?: number;
}) => Promise<void> | void;

function pool() {
  return getPool();
}

export function activeHostPublicRouteMode(row: {
  metadata?: Record<string, any>;
}): HostPublicRouteMode {
  return row.metadata?.public_route?.active_mode === "cloudflare-proxy"
    ? "cloudflare-proxy"
    : "cloudflare-tunnel";
}

export function desiredHostPublicRouteMode(row: {
  metadata?: Record<string, any>;
}): HostPublicRouteMode {
  const desired = row.metadata?.public_route?.desired_mode;
  if (desired === "cloudflare-proxy" || desired === "cloudflare-tunnel") {
    return desired;
  }
  return normalizeProviderId(row.metadata?.machine?.cloud) === "gcp"
    ? "cloudflare-proxy"
    : "cloudflare-tunnel";
}

export function hostPublicRouteMigrationInProgress(row: {
  metadata?: Record<string, any>;
}): boolean {
  return row.metadata?.public_route?.status === "preparing";
}

async function loadHost(id: string): Promise<HostRow> {
  const { rows } = await pool().query<HostRow>(
    `SELECT id, name, region, status, public_url, internal_url, ssh_server, metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return rows[0];
}

async function setMetadataField(
  id: string,
  field: string,
  value: Record<string, any>,
): Promise<void> {
  await pool().query(
    `UPDATE project_hosts
        SET metadata=jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[$2]::text[], $3::jsonb, true),
            updated=NOW()
      WHERE id=$1 AND deleted IS NULL`,
    [id, field, JSON.stringify(value)],
  );
}

async function setRouteState(
  id: string,
  value: Record<string, any>,
): Promise<void> {
  await setMetadataField(id, "public_route", value);
}

function stableHostnameForHost(row: HostRow, settings: Record<string, any>) {
  const hostname = deriveProjectHostHostname(row.id, settings);
  if (!hostname) throw new Error("project-host DNS is not configured");
  return hostname;
}

function directProbeHostname(stableHostname: string): string {
  const labels = stableHostname.split(".");
  if (labels.length < 2) {
    throw new Error(`invalid project-host hostname: ${stableHostname}`);
  }
  const id = createHash("sha256")
    .update(stableHostname)
    .digest("hex")
    .slice(0, 16);
  return [`direct-check-${id}`, ...labels.slice(1)].join(".");
}

async function probeCloudflareRoute({
  hostname,
  origin,
  expected_host_id,
  deadlineMs = PROBE_DEADLINE_MS,
  requiredSuccesses = 1,
  confirmationMs = 0,
}: {
  hostname: string;
  origin: string;
  expected_host_id: string;
  deadlineMs?: number;
  requiredSuccesses?: number;
  confirmationMs?: number;
}): Promise<ProjectHostPublicRouteProbeResult> {
  const deadline = Date.now() + deadlineMs;
  let lastError = "route probe did not run";
  let consecutiveSuccesses = 0;
  let firstSuccessAt: number | undefined;
  while (Date.now() < deadline) {
    try {
      const result = await probeProjectHostPublicRoute({
        public_url: `https://${hostname}`,
        origin,
        expected_host_id,
        timeout_ms: PROBE_TIMEOUT_MS,
      });
      const now = Date.now();
      firstSuccessAt ??= now;
      consecutiveSuccesses += 1;
      if (
        consecutiveSuccesses >= requiredSuccesses &&
        now - firstSuccessAt >= confirmationMs
      ) {
        return result;
      }
      await delay(STABLE_ROUTE_SUCCESS_INTERVAL_MS);
      continue;
    } catch (err) {
      lastError = `${err}`;
      consecutiveSuccesses = 0;
      firstSuccessAt = undefined;
    }
    await delay(PROBE_RETRY_MS);
  }
  throw new Error(`public route probe failed for ${hostname}: ${lastError}`);
}

async function ensureTunnelRoute({
  row,
  origin,
}: {
  row: HostRow;
  origin: string;
}): Promise<CloudflareTunnel> {
  const tunnel = await ensureCloudflareTunnelForHost({
    host_id: row.id,
    existing: row.metadata?.cloudflare_tunnel,
  });
  if (!tunnel?.hostname) {
    throw new Error("Cloudflare Tunnel is not configured for this host");
  }
  await setMetadataField(row.id, "cloudflare_tunnel", tunnel);
  await probeCloudflareRoute({
    hostname: tunnel.hostname,
    origin,
    expected_host_id: row.id,
  });
  return tunnel;
}

export async function ensureDirectCloudflareIngressForHost(row: {
  id: string;
  region?: string;
  metadata?: Record<string, any>;
}) {
  const providerId = normalizeProviderId(row.metadata?.machine?.cloud);
  if (providerId !== "gcp") {
    throw new Error(
      "direct Cloudflare-proxied project-host routing currently supports GCP only",
    );
  }
  const runtime = row.metadata?.runtime;
  if (!runtime?.instance_id || !runtime?.zone || !runtime?.public_ip) {
    throw new Error("host runtime does not have a public GCP address");
  }
  const { entry, creds } = await getProviderContext(providerId, {
    region: row.region,
  });
  if (!entry.provider.ensurePublicIngress) {
    throw new Error("GCP provider cannot reconcile public HTTPS ingress");
  }
  const sourceRanges = await getCloudflareIpv4Cidrs();
  return await entry.provider.ensurePublicIngress(
    runtime,
    { ports: [443], source_ranges: sourceRanges },
    creds,
  );
}

export async function reconcileDirectCloudflareRouteForHost(row: {
  id: string;
  region?: string;
  metadata?: Record<string, any>;
}) {
  const runtime = row.metadata?.runtime;
  if (!runtime?.public_ip) {
    throw new Error("host runtime does not have a public GCP address");
  }
  await enqueueHostDnsReconciliation(row.id, "public-route-auto-repair");
  // A replacement VM can have a new public IP while the stable Cloudflare
  // record still points at its predecessor. Repair DNS first: ingress
  // reconciliation fetches Cloudflare's current edge ranges and must not
  // prevent the authoritative runtime address from being published.
  const dns = await ensureHostDns({
    host_id: row.id,
    ipAddress: runtime.public_ip,
    record_id:
      row.metadata?.dns?.record_id ??
      row.metadata?.cloudflare_tunnel?.record_id,
  });
  await setMetadataField(row.id, "dns", dns);
  const publicIngress = await ensureDirectCloudflareIngressForHost(row);
  return {
    public_ip: runtime.public_ip,
    public_ingress: publicIngress,
    dns,
  };
}

async function prepareDirectRoute({
  row,
  stableHostname,
  origin,
  onProgress,
}: {
  row: HostRow;
  stableHostname: string;
  origin: string;
  onProgress?: RouteProgress;
}): Promise<{ name: string; record_id: string }> {
  const runtime = row.metadata?.runtime;
  if (!runtime?.instance_id || !runtime?.zone || !runtime?.public_ip) {
    throw new Error("host runtime does not have a public GCP address");
  }

  const sslRule = await ensureCloudflareProjectHostSslRule({
    hostname: stableHostname,
    host_id: row.id,
  });
  let zoneSslMode: Record<string, any>;
  try {
    zoneSslMode = await getCloudflareZoneSslMode(stableHostname);
  } catch (err) {
    zoneSslMode = { error: `${err}` };
  }
  const cloudflareOrigin = {
    project_host_ssl_rule: sslRule,
    zone_ssl_mode: zoneSslMode,
  };

  await onProgress?.({
    phase: "firewall",
    message: "restricting direct HTTPS ingress to Cloudflare edges",
    progress: 15,
  });
  const publicIngress = await ensureDirectCloudflareIngressForHost(row);
  await onProgress?.({
    phase: "firewall",
    message: "direct HTTPS ingress is reconciled",
    detail: {
      public_ingress: publicIngress ?? null,
      cloudflare_origin: cloudflareOrigin,
    },
    progress: 20,
  });

  await onProgress?.({
    phase: "bootstrap",
    message: "enabling the direct HTTPS listener",
    progress: 30,
  });
  const bootstrapRow = await loadHost(row.id);
  await reconcileCloudHostBootstrapOverSsh({
    host_id: row.id,
    row: bootstrapRow,
    scope: "full",
  });

  const probeHostname = directProbeHostname(stableHostname);
  let probeRecordId: string | undefined;
  try {
    await onProgress?.({
      phase: "origin-probe",
      message: "verifying the direct origin through an isolated DNS record",
      detail: { hostname: probeHostname },
      progress: 55,
    });
    const probeDns = await ensureProxiedAddressDns({
      name: probeHostname,
      ipAddress: runtime.public_ip,
    });
    probeRecordId = probeDns.record_id;
    try {
      await probeCloudflareRoute({
        hostname: probeHostname,
        origin,
        expected_host_id: row.id,
      });
    } catch (err) {
      throw new Error(
        `${err}; provider ingress diagnostics: ${JSON.stringify(publicIngress ?? null)}; Cloudflare origin diagnostics: ${JSON.stringify(cloudflareOrigin)}`,
      );
    }
  } finally {
    if (probeRecordId) {
      await deleteHostDns({
        record_id: probeRecordId,
        name: probeHostname,
      }).catch((err) => {
        logger.warn("failed cleaning direct-route probe record", {
          host_id: row.id,
          hostname: probeHostname,
          err: `${err}`,
        });
      });
    }
  }

  await onProgress?.({
    phase: "dns-cutover",
    message: "changing the stable route from tunnel CNAME to proxied A",
    progress: 75,
  });
  const dns = await ensureHostDns({
    host_id: row.id,
    ipAddress: runtime.public_ip,
    record_id:
      row.metadata?.dns?.record_id ??
      row.metadata?.cloudflare_tunnel?.record_id,
  });
  await setMetadataField(row.id, "dns", dns);
  await probeCloudflareRoute({
    hostname: stableHostname,
    origin,
    expected_host_id: row.id,
    requiredSuccesses: STABLE_ROUTE_REQUIRED_SUCCESSES,
    confirmationMs: STABLE_ROUTE_CONFIRMATION_MS,
  });
  return dns;
}

export async function migrateHostPublicRouteInternal({
  id,
  mode,
  onProgress,
}: {
  id: string;
  mode: HostPublicRouteMode;
  onProgress?: RouteProgress;
}): Promise<{
  host_id: string;
  mode: HostPublicRouteMode;
  hostname: string;
}> {
  if (mode !== "cloudflare-tunnel" && mode !== "cloudflare-proxy") {
    throw new Error(
      "public route mode must be cloudflare-tunnel or cloudflare-proxy",
    );
  }
  const row = await loadHost(id);
  const providerId = normalizeProviderId(row.metadata?.machine?.cloud);
  if (providerId === "self-host" || providerId === "local") {
    throw new Error(
      "public route migration is only supported for managed cloud hosts",
    );
  }
  if (row.status !== "running") {
    throw new Error("host must be running to change its public route");
  }
  const settings = await getServerSettings();
  const stableHostname = stableHostnameForHost(row, settings);
  const origin = new URL(await siteURL()).origin;
  const previousMode = activeHostPublicRouteMode(row);
  const startedAt = new Date().toISOString();
  await setRouteState(row.id, {
    ...(row.metadata?.public_route ?? {}),
    desired_mode: mode,
    active_mode: previousMode,
    status: "preparing",
    started_at: startedAt,
    error: null,
  });

  try {
    if (mode === "cloudflare-proxy") {
      await prepareDirectRoute({
        row,
        stableHostname,
        origin,
        onProgress,
      });
    } else {
      await onProgress?.({
        phase: "dns-cutover",
        message: "restoring the stable route to Cloudflare Tunnel",
        progress: 60,
      });
      await ensureTunnelRoute({ row: await loadHost(row.id), origin });
    }
    const completedAt = new Date().toISOString();
    await setRouteState(row.id, {
      desired_mode: mode,
      active_mode: mode,
      status: "active",
      started_at: startedAt,
      completed_at: completedAt,
      error: null,
    });
    await onProgress?.({
      phase: "done",
      message: `public route is active via ${mode}`,
      detail: { hostname: stableHostname, mode },
      progress: 100,
    });
    return { host_id: row.id, mode, hostname: stableHostname };
  } catch (err) {
    let rollbackError: unknown;
    try {
      await ensureTunnelRoute({ row: await loadHost(row.id), origin });
    } catch (rollbackErr) {
      rollbackError = rollbackErr;
    }
    const message = `${err}`;
    await setRouteState(row.id, {
      desired_mode: mode,
      active_mode: "cloudflare-tunnel",
      status: rollbackError ? "rollback-failed" : "failed",
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: message,
      ...(rollbackError ? { rollback_error: `${rollbackError}` } : {}),
    });
    if (rollbackError) {
      throw new Error(
        `${message}; restoring Cloudflare Tunnel also failed: ${rollbackError}`,
      );
    }
    throw err;
  }
}
