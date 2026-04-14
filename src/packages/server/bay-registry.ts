/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { BayInfo } from "@cocalc/conat/hub/api/system";
import type {
  BayRegistryEntry,
  BayRegistryListRequest,
  BayRegistryManagedTunnel,
  BayRegistryRegisterRequest,
  BayRegistryRegisterResult,
} from "@cocalc/conat/inter-bay/api";
import {
  createInterBayBayRegistryClient,
  type InterBayBayRegistryApi,
} from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import {
  getConfiguredBayId,
  getConfiguredBayLabel,
  getConfiguredBayRegion,
} from "@cocalc/server/bay-config";
import {
  deriveBayHostnameFromSiteDns,
  getBayPublicOrigin,
  getConfiguredSiteDnsHostname,
  getCurrentBayPublicTarget,
  normalizeHostname,
} from "@cocalc/server/bay-public-origin";
import { getConfiguredClusterRole, isMultiBayCluster } from "./cluster-config";
import {
  deleteAppSubdomainDns,
  ensureHostnameCnameDns,
  hasDns,
} from "@cocalc/server/cloud/dns";
import {
  ensureCloudflareTunnelForBay,
  type CloudflareTunnel,
} from "@cocalc/server/cloud/cloudflare-tunnel";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const logger = getLogger("server:bay-registry");
const TABLE = "cluster_bay_registry";
const HEARTBEAT_INTERVAL_MS = 60_000;

let ensureTablePromise: Promise<void> | undefined;
let heartbeatStarted = false;

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function normalizedNullable(value: unknown): string | null {
  const v = trim(value);
  return v || null;
}

function currentRoleForRegistry(): string {
  const role = getConfiguredClusterRole();
  return role === "standalone" ? "combined" : role;
}

function isIpLike(hostname: string): boolean {
  return /^[0-9.]+$/.test(hostname) || hostname.includes(":");
}

function isDnsTargetCandidate(hostname: string | null): hostname is string {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false;
  }
  if (isIpLike(hostname)) return false;
  return hostname.includes(".");
}

async function ensureTable(): Promise<void> {
  ensureTablePromise ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        bay_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        region TEXT,
        role TEXT NOT NULL,
        public_origin TEXT,
        public_target TEXT,
        public_target_kind TEXT,
        dns_hostname TEXT,
        dns_record_id TEXT,
        managed_tunnel JSONB,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS managed_tunnel JSONB`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_last_seen_idx ON ${TABLE} (last_seen DESC)`,
    );
  })();
  await ensureTablePromise;
}

function mapRow(row: any): BayRegistryEntry {
  return {
    bay_id: trim(row.bay_id),
    label: trim(row.label) || trim(row.bay_id),
    region: normalizedNullable(row.region),
    role: trim(row.role) || "attached",
    public_origin: normalizedNullable(row.public_origin),
    public_target: normalizedNullable(row.public_target),
    public_target_kind: normalizedNullable(row.public_target_kind),
    dns_hostname: normalizedNullable(row.dns_hostname),
    dns_record_id: normalizedNullable(row.dns_record_id),
    last_seen:
      row.last_seen instanceof Date
        ? row.last_seen.toISOString()
        : new Date(row.last_seen ?? Date.now()).toISOString(),
  };
}

function mapManagedTunnel(value: unknown): BayRegistryManagedTunnel | null {
  const tunnel = value as CloudflareTunnel | undefined | null;
  if (!tunnel?.id || !tunnel?.hostname || !tunnel?.tunnel_secret) {
    return null;
  }
  return {
    id: tunnel.id,
    name: tunnel.name,
    hostname: tunnel.hostname,
    tunnel_secret: tunnel.tunnel_secret,
    account_id: tunnel.account_id,
    record_id: tunnel.record_id,
    token: tunnel.token,
  };
}

async function getEntryLocal(bay_id: string): Promise<BayRegistryEntry | null> {
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT bay_id, label, region, role, public_origin, public_target,
            public_target_kind, dns_hostname, dns_record_id, last_seen
       FROM ${TABLE}
      WHERE bay_id=$1
      LIMIT 1`,
    [bay_id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function getManagedTunnelLocal(
  bay_id: string,
): Promise<CloudflareTunnel | undefined> {
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT managed_tunnel
       FROM ${TABLE}
      WHERE bay_id=$1
      LIMIT 1`,
    [bay_id],
  );
  return (rows[0]?.managed_tunnel as CloudflareTunnel | undefined) ?? undefined;
}

async function reconcileDnsForEntry(
  entry: BayRegistryEntry,
): Promise<Pick<BayRegistryEntry, "dns_hostname" | "dns_record_id">> {
  const site_hostname = await getConfiguredSiteDnsHostname();
  const dns_hostname =
    deriveBayHostnameFromSiteDns({ bay_id: entry.bay_id, site_hostname }) ??
    null;
  if (!dns_hostname || !(await hasDns())) {
    return {
      dns_hostname,
      dns_record_id: normalizedNullable(entry.dns_record_id),
    };
  }
  let public_target = normalizedNullable(
    normalizeHostname(entry.public_target),
  );
  if (!public_target) {
    public_target = normalizedNullable(normalizeHostname(entry.public_origin));
  }
  if (isDnsTargetCandidate(public_target) && public_target !== dns_hostname) {
    const { record_id } = await ensureHostnameCnameDns({
      hostname: dns_hostname,
      target_hostname: public_target,
      record_id: entry.dns_record_id ?? undefined,
    });
    return { dns_hostname, dns_record_id: record_id };
  }
  if (entry.dns_record_id) {
    await deleteAppSubdomainDns({ record_id: entry.dns_record_id });
  }
  return { dns_hostname, dns_record_id: null };
}

export async function registerBayPresenceLocal(
  request: BayRegistryRegisterRequest,
): Promise<BayRegistryRegisterResult> {
  await ensureTable();
  const bay_id = trim(request.bay_id);
  if (!bay_id) {
    throw new Error("bay_id is required");
  }
  const existing = await getEntryLocal(bay_id);
  const managedTunnel = await getManagedTunnelLocal(bay_id);
  const next: BayRegistryEntry = {
    bay_id,
    label: trim(request.label) || existing?.label || bay_id,
    region: normalizedNullable(request.region ?? existing?.region),
    role: trim(request.role) || existing?.role || "attached",
    public_origin: normalizedNullable(
      request.public_origin ?? existing?.public_origin,
    ),
    public_target: normalizedNullable(
      normalizeHostname(request.public_target) ?? existing?.public_target,
    ),
    public_target_kind:
      normalizedNullable(request.public_target_kind) ??
      (normalizeHostname(request.public_target) ? "hostname" : null) ??
      existing?.public_target_kind ??
      null,
    dns_hostname: existing?.dns_hostname ?? null,
    dns_record_id: existing?.dns_record_id ?? null,
    last_seen: new Date().toISOString(),
  };
  let nextManagedTunnel = managedTunnel ?? null;
  if (
    getConfiguredClusterRole() === "seed" &&
    next.role === "attached" &&
    !next.public_target
  ) {
    nextManagedTunnel =
      (await ensureCloudflareTunnelForBay({
        bay_id,
        existing: managedTunnel ?? undefined,
      })) ?? null;
    const managedTarget = normalizedNullable(nextManagedTunnel?.id)
      ? `${nextManagedTunnel?.id}.cfargotunnel.com`
      : null;
    if (managedTarget) {
      next.public_target = managedTarget;
      next.public_target_kind = "hostname";
    }
  }
  if (getConfiguredClusterRole() === "seed") {
    Object.assign(next, await reconcileDnsForEntry(next));
  }
  await getPool().query(
    `INSERT INTO ${TABLE}
       (bay_id, label, region, role, public_origin, public_target,
        public_target_kind, dns_hostname, dns_record_id, managed_tunnel,
        last_seen, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::JSONB,NOW(),NOW())
     ON CONFLICT (bay_id) DO UPDATE SET
       label=EXCLUDED.label,
       region=EXCLUDED.region,
       role=EXCLUDED.role,
       public_origin=EXCLUDED.public_origin,
       public_target=EXCLUDED.public_target,
       public_target_kind=EXCLUDED.public_target_kind,
       dns_hostname=EXCLUDED.dns_hostname,
       dns_record_id=EXCLUDED.dns_record_id,
       managed_tunnel=EXCLUDED.managed_tunnel,
       last_seen=NOW(),
       updated=NOW()`,
    [
      next.bay_id,
      next.label,
      next.region,
      next.role,
      next.public_origin,
      next.public_target,
      next.public_target_kind,
      next.dns_hostname,
      next.dns_record_id,
      nextManagedTunnel ? JSON.stringify(nextManagedTunnel) : null,
    ],
  );
  return {
    ...((await getEntryLocal(bay_id)) ?? next),
    managed_tunnel: mapManagedTunnel(nextManagedTunnel),
  };
}

export async function listBayRegistryLocal(
  _opts: BayRegistryListRequest = {},
): Promise<BayRegistryEntry[]> {
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT bay_id, label, region, role, public_origin, public_target,
            public_target_kind, dns_hostname, dns_record_id, last_seen
       FROM ${TABLE}
      ORDER BY bay_id ASC`,
  );
  return rows.map(mapRow);
}

function getRegistryClient(): InterBayBayRegistryApi {
  return createInterBayBayRegistryClient({
    client: getInterBayFabricClient({ noCache: true }),
  });
}

export async function listClusterBayRegistry(): Promise<BayRegistryEntry[]> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await listBayRegistryLocal();
  }
  return await getRegistryClient().list({});
}

export async function listClusterBayInfos(): Promise<BayInfo[]> {
  const entries = await listClusterBayRegistry();
  if (!entries.length) {
    return [
      {
        bay_id: getConfiguredBayId(),
        label: getConfiguredBayLabel(getConfiguredBayId()),
        region: getConfiguredBayRegion(),
        deployment_mode: isMultiBayCluster() ? "multi-bay" : "single-bay",
        role: currentRoleForRegistry() as BayInfo["role"],
        is_default: true,
      },
    ];
  }
  const localBayId = getConfiguredBayId();
  return entries.map((entry) => ({
    bay_id: entry.bay_id,
    label: entry.label,
    region: entry.region ?? null,
    deployment_mode: "multi-bay",
    role:
      entry.role === "seed" || entry.role === "attached"
        ? entry.role
        : "combined",
    is_default: entry.bay_id === localBayId,
  }));
}

export async function buildLocalBayRegistration(): Promise<BayRegistryRegisterRequest> {
  const bay_id = getConfiguredBayId();
  return {
    bay_id,
    label: getConfiguredBayLabel(bay_id),
    region: getConfiguredBayRegion(),
    role: currentRoleForRegistry(),
    public_origin: (await getBayPublicOrigin(bay_id)) ?? null,
    public_target: getCurrentBayPublicTarget() ?? null,
    public_target_kind: getCurrentBayPublicTarget() ? "hostname" : null,
  };
}

async function heartbeatOnce(): Promise<void> {
  if (!isMultiBayCluster()) {
    return;
  }
  const payload = await buildLocalBayRegistration();
  if (getConfiguredClusterRole() === "seed") {
    await registerBayPresenceLocal(payload);
    return;
  }
  await getRegistryClient().register(payload);
}

export function startBayRegistrationHeartbeat(): void {
  if (!isMultiBayCluster()) return;
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  void heartbeatOnce().catch((err) => {
    logger.warn("initial bay registration failed", { err: `${err}` });
  });
  const timer = setInterval(() => {
    void heartbeatOnce().catch((err) => {
      logger.warn("bay registration heartbeat failed", { err: `${err}` });
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
}
