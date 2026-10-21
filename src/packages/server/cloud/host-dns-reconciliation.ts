/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { normalizeProviderId } from "@cocalc/cloud";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { enqueueCloudVmWork, enqueueCloudVmWorkOnce } from "./db";
import { ensureHostDns, inspectHostDns } from "./dns";
import { syncHostContentDns } from "./host-content-dns";
import { getProviderContext } from "./provider-context";

const logger = getLogger("server:cloud:host-dns-reconciliation");
const pool = () => getPool();

// The work queue survives hub restarts; the periodic sweep independently
// recreates missing work and detects out-of-band provider or DNS changes.
export const HOST_DNS_RECONCILIATION_ACTION = "reconcile_dns";
const SWEEP_LOCK_KEY = "cloud:host-dns-reconciliation-sweep:v1";
const DEFAULT_VERIFY_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_BASE_MS = 10_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_ALERT_FAILURES = 5;
const DEFAULT_PROVIDER_OBSERVATION_TIMEOUT_MS = 30_000;
const DNS_FLEET_FAILURE_WINDOW_MS = 5 * 60_000;
const DNS_FLEET_ALERT_DEDUP_MINUTES = 4 * 60;

type HostRow = {
  id: string;
  name?: string | null;
  region?: string | null;
  status?: string | null;
  bay_id?: string | null;
  ssh_server?: string | null;
  metadata?: Record<string, any>;
};

type DnsFleetFailureRow = {
  checked_hosts: number;
  host_id?: string | null;
  host_name?: string | null;
  error?: string | null;
};

type DnsFleetFailureContext = {
  checked_hosts: number;
  recent_failed_hosts: number;
  failed_host_ids: string[];
  failure_classes: Record<string, number>;
  shared_failure_threshold: number;
  shared_cloudflare_failure: boolean;
  samples: Array<{
    host_id: string;
    host_name?: string;
    error: string;
  }>;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function verifyIntervalMs(): number {
  return Math.max(
    60_000,
    positiveNumber(
      process.env.COCALC_HOST_DNS_RECONCILIATION_VERIFY_INTERVAL_MS,
      DEFAULT_VERIFY_INTERVAL_MS,
    ),
  );
}

function retryDelayMs(attempt: number): number {
  const base = positiveNumber(
    process.env.COCALC_HOST_DNS_RECONCILIATION_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
  );
  const max = positiveNumber(
    process.env.COCALC_HOST_DNS_RECONCILIATION_RETRY_MAX_MS,
    DEFAULT_RETRY_MAX_MS,
  );
  return Math.min(max, base * 2 ** Math.min(8, Math.max(0, attempt)));
}

function alertFailures(): number {
  return Math.max(
    2,
    Math.floor(
      positiveNumber(
        process.env.COCALC_HOST_DNS_RECONCILIATION_ALERT_FAILURES,
        DEFAULT_ALERT_FAILURES,
      ),
    ),
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : `${err}`;
}

function dnsControlPlaneFailureClass(error: string): string {
  const value = error.toLowerCase();
  const mentionsCloudflare = value.includes("cloudflare");
  const abortedByTimeout =
    value.includes("timeout") &&
    value.includes("operation was aborted due to timeout");
  if (!mentionsCloudflare && !abortedByTimeout) return "other";
  if (/\b(?:http )?52[0-9]\b/.test(value)) return "cloudflare_52x";
  if (value.includes("timed out") || value.includes("timeout")) {
    return "timeout";
  }
  if (
    value.includes("fetch failed") ||
    /\b(eai_again|econnreset|etimedout|econnrefused|enotfound)\b/.test(value) ||
    value.includes("socket hang up")
  ) {
    return "network_fetch";
  }
  return "cloudflare_api";
}

function buildDnsFleetFailureContext({
  current_error,
  rows,
}: {
  current_error: string;
  rows: DnsFleetFailureRow[];
}): DnsFleetFailureContext {
  const checkedHosts = Number(rows[0]?.checked_hosts ?? 0);
  const failures = rows.filter(
    (row): row is DnsFleetFailureRow & { host_id: string; error: string } =>
      !!row.host_id && !!row.error,
  );
  const failureClasses: Record<string, number> = {};
  for (const failure of failures) {
    const failureClass = dnsControlPlaneFailureClass(failure.error);
    failureClasses[failureClass] = (failureClasses[failureClass] ?? 0) + 1;
  }
  const sharedCloudflareFailures =
    (failureClasses.cloudflare_52x ?? 0) +
    (failureClasses.cloudflare_api ?? 0) +
    (failureClasses.network_fetch ?? 0) +
    (failureClasses.timeout ?? 0);
  const threshold = Math.max(2, Math.ceil(checkedHosts / 2));
  return {
    checked_hosts: checkedHosts,
    recent_failed_hosts: failures.length,
    failed_host_ids: failures.map(({ host_id }) => host_id).slice(0, 32),
    failure_classes: failureClasses,
    shared_failure_threshold: threshold,
    shared_cloudflare_failure:
      checkedHosts >= 3 &&
      dnsControlPlaneFailureClass(current_error) !== "other" &&
      sharedCloudflareFailures >= threshold,
    samples: failures.slice(0, 5).map(({ host_id, host_name, error }) => ({
      host_id,
      ...(host_name ? { host_name } : {}),
      error,
    })),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isDirectGcpDnsHost(row: HostRow): boolean {
  return (
    row.status === "running" &&
    `${row.metadata?.desired_state ?? "running"}` === "running" &&
    normalizeProviderId(row.metadata?.machine?.cloud) === "gcp" &&
    row.metadata?.public_route?.active_mode === "cloudflare-proxy" &&
    !!`${row.metadata?.runtime?.instance_id ?? ""}`.trim() &&
    !!`${row.metadata?.runtime?.zone ?? ""}`.trim()
  );
}

async function loadHost(host_id: string): Promise<HostRow | undefined> {
  const { rows } = await pool().query<HostRow>(
    `
      SELECT id, name, region, status, bay_id, ssh_server, metadata
      FROM project_hosts
      WHERE id=$1
        AND deleted IS NULL
        AND COALESCE(NULLIF(BTRIM(bay_id), ''), $2)=$2
    `,
    [host_id, getConfiguredBayId()],
  );
  return rows[0];
}

async function updateObservedRuntime(opts: {
  host_id: string;
  public_ip: string;
  private_ip?: string;
  internal_hostname?: string;
  provider_status?: string;
}): Promise<HostRow | undefined> {
  const observed = {
    public_ip: opts.public_ip,
    ...(opts.private_ip ? { private_ip: opts.private_ip } : {}),
    ...(opts.internal_hostname
      ? { internal_hostname: opts.internal_hostname }
      : {}),
    ...(opts.provider_status ? { provider_status: opts.provider_status } : {}),
    observed_at: new Date().toISOString(),
  };
  const { rows } = await pool().query<HostRow>(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{runtime}',
            COALESCE(metadata -> 'runtime', '{}'::jsonb) || $3::jsonb,
            true
          ),
          ssh_server=$4,
          updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND status='running'
        AND COALESCE(NULLIF(BTRIM(bay_id), ''), $2)=$2
        AND metadata -> 'public_route' ->> 'active_mode'='cloudflare-proxy'
        AND metadata -> 'machine' ->> 'cloud'='gcp'
      RETURNING id, name, region, status, bay_id, ssh_server, metadata
    `,
    [
      opts.host_id,
      getConfiguredBayId(),
      JSON.stringify(observed),
      `${opts.public_ip}:2222`,
    ],
  );
  return rows[0];
}

async function recordVerified(opts: {
  host_id: string;
  public_ip: string;
  dns: { name: string; record_id: string };
}): Promise<boolean> {
  const now = new Date().toISOString();
  const state = {
    status: "verified",
    desired_ip: opts.public_ip,
    observed_dns_ip: opts.public_ip,
    record_id: opts.dns.record_id,
    hostname: opts.dns.name,
    attempted_at: now,
    verified_at: now,
    consecutive_failures: 0,
  };
  const { rowCount } = await pool().query(
    `
      UPDATE project_hosts
      SET metadata=jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{dns}',
              $3::jsonb,
              true
            ),
            '{dns_reconciliation}',
            $4::jsonb,
            true
          ),
          public_url=$5,
          updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND COALESCE(NULLIF(BTRIM(bay_id), ''), $2)=$2
        AND metadata -> 'runtime' ->> 'public_ip'=$6
    `,
    [
      opts.host_id,
      getConfiguredBayId(),
      JSON.stringify(opts.dns),
      JSON.stringify(state),
      `https://${opts.dns.name}`,
      opts.public_ip,
    ],
  );
  return !!rowCount;
}

async function recordFailure(opts: {
  host_id: string;
  desired_ip?: string;
  error: string;
}): Promise<number> {
  const { rows } = await pool().query<{ consecutive_failures: number }>(
    `
      WITH updated AS (
        UPDATE project_hosts
        SET metadata=jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{dns_reconciliation}',
              COALESCE(metadata -> 'dns_reconciliation', '{}'::jsonb)
                || jsonb_build_object(
                  'status', 'failed',
                  'desired_ip', $3::text,
                  'attempted_at', NOW(),
                  'failed_at', NOW(),
                  'error', $4::text,
                  'consecutive_failures',
                    COALESCE(
                      (metadata -> 'dns_reconciliation'
                        ->> 'consecutive_failures')::integer,
                      0
                    ) + 1
                ),
              true
            ),
            updated=NOW()
        WHERE id=$1
          AND deleted IS NULL
          AND COALESCE(NULLIF(BTRIM(bay_id), ''), $2)=$2
        RETURNING COALESCE(
          (metadata -> 'dns_reconciliation'
            ->> 'consecutive_failures')::integer,
          0
        ) AS consecutive_failures
      )
      SELECT consecutive_failures FROM updated
    `,
    [opts.host_id, getConfiguredBayId(), opts.desired_ip ?? null, opts.error],
  );
  return Number(rows[0]?.consecutive_failures ?? 0);
}

async function loadDnsFleetFailureContext(
  current_error: string,
): Promise<DnsFleetFailureContext> {
  const { rows } = await pool().query<DnsFleetFailureRow>(
    `
      WITH active AS (
        SELECT id, name, metadata
        FROM project_hosts
        WHERE deleted IS NULL
          AND status='running'
          AND COALESCE(NULLIF(BTRIM(bay_id), ''), $1)=$1
          AND COALESCE(metadata ->> 'desired_state', 'running')='running'
          AND metadata -> 'machine' ->> 'cloud'='gcp'
          AND metadata -> 'public_route' ->> 'active_mode'='cloudflare-proxy'
      ), recent AS (
        SELECT id AS host_id,
               name AS host_name,
               metadata -> 'dns_reconciliation' ->> 'error' AS error
        FROM active
        WHERE metadata -> 'dns_reconciliation' ->> 'status'='failed'
          AND NULLIF(
                metadata -> 'dns_reconciliation' ->> 'failed_at',
                ''
              )::timestamptz >= NOW() - ($2::double precision * interval '1 millisecond')
      )
      SELECT totals.checked_hosts,
             recent.host_id,
             recent.host_name,
             recent.error
      FROM (SELECT COUNT(*)::integer AS checked_hosts FROM active) AS totals
      LEFT JOIN recent ON TRUE
      ORDER BY recent.host_id
    `,
    [getConfiguredBayId(), DNS_FLEET_FAILURE_WINDOW_MS],
  );
  return buildDnsFleetFailureContext({ current_error, rows });
}

async function alertDnsReconciliationFailure({
  host,
  host_id,
  desired_ip,
  error,
  failures,
}: {
  host?: HostRow;
  host_id: string;
  desired_ip?: string;
  error: string;
  failures: number;
}): Promise<void> {
  let fleet: DnsFleetFailureContext | undefined;
  try {
    fleet = await loadDnsFleetFailureContext(error);
  } catch (err) {
    logger.error("unable to classify DNS reconciliation fleet failure", {
      host_id,
      err: errorText(err),
    });
  }
  if (fleet?.shared_cloudflare_failure) {
    const bayId = getConfiguredBayId();
    await adminAlert({
      subject: `[${bayId}] Project-host DNS reconciliation fleet degraded`,
      body: [
        "Project-host DNS reconciliation is failing across the fleet because the shared Cloudflare control plane appears degraded.",
        `bay_id=${bayId}`,
        `fleet=${JSON.stringify(fleet)}`,
        "Individual host alerts are suppressed. Durable retries remain queued and existing Cloudflare edge routes are not changed by failed reconciliation attempts.",
      ].join("\n"),
      dedupMinutes: DNS_FLEET_ALERT_DEDUP_MINUTES,
      dedupBySubject: true,
    });
    return;
  }
  await adminAlert({
    subject: `Project-host DNS reconciliation failed: ${host?.name ?? host_id}`,
    body: [
      "CoCalc could not converge a direct project-host Cloudflare route.",
      `host_id=${host_id}`,
      `desired_ip=${desired_ip || "unknown"}`,
      `consecutive_failures=${failures}`,
      `error=${error}`,
      "A durable retry remains queued.",
    ].join("\n"),
    dedupMinutes: 15,
    dedupBySubject: true,
  });
}

async function verifyDns(opts: {
  host_id: string;
  public_ip: string;
  record_id: string;
}): Promise<void> {
  const observation = await inspectHostDns({ host_id: opts.host_id });
  const expected = observation.records.filter(
    (record) =>
      record.record_id === opts.record_id &&
      record.type === "A" &&
      record.content === opts.public_ip &&
      record.proxied,
  );
  if (expected.length !== 1 || observation.records.length !== 1) {
    throw new Error(
      `Cloudflare DNS verification failed for ${observation.name}: expected one proxied A record ${opts.public_ip}, observed ${JSON.stringify(observation.records)}`,
    );
  }
}

export async function reconcileHostDns(host_id: string): Promise<{
  skipped?: string;
  public_ip?: string;
  record_id?: string;
}> {
  const initial = await loadHost(host_id);
  if (!initial) return { skipped: "host not found in this bay" };
  if (!isDirectGcpDnsHost(initial)) {
    return { skipped: "host is not an active direct-route GCP host" };
  }

  const runtime = initial.metadata?.runtime;
  const { entry, creds } = await getProviderContext("gcp", {
    region: initial.region ?? undefined,
  });
  if (!entry.provider.getInstance) {
    throw new Error("GCP provider cannot inspect the running instance");
  }
  const providerTimeoutMs = positiveNumber(
    process.env.COCALC_HOST_DNS_PROVIDER_OBSERVATION_TIMEOUT_MS,
    DEFAULT_PROVIDER_OBSERVATION_TIMEOUT_MS,
  );
  const instance = await withTimeout(
    entry.provider.getInstance(runtime, creds),
    providerTimeoutMs,
    `GCP instance lookup for ${runtime.instance_id}`,
  );
  if (!instance) {
    throw new Error(`GCP instance ${runtime.instance_id} was not found`);
  }
  const mappedStatus = instance.status
    ? (entry.provider.mapStatus?.(instance.status) ?? instance.status)
    : undefined;
  if (`${mappedStatus ?? ""}`.toLowerCase() !== "running") {
    throw new Error(
      `GCP instance ${runtime.instance_id} is not running (${instance.status ?? "unknown"})`,
    );
  }
  const publicIp = `${instance.public_ip ?? ""}`.trim();
  if (!publicIp) {
    throw new Error(`GCP instance ${runtime.instance_id} has no public IP`);
  }

  const current = await updateObservedRuntime({
    host_id,
    public_ip: publicIp,
    private_ip: instance.private_ip,
    internal_hostname: instance.internal_hostname,
    provider_status: instance.status,
  });
  if (!current) {
    return { skipped: "host stopped or changed route while reconciling" };
  }

  const dns = await ensureHostDns({
    host_id,
    ipAddress: publicIp,
    record_id:
      current.metadata?.dns?.record_id ??
      current.metadata?.cloudflare_tunnel?.record_id,
  });
  await verifyDns({
    host_id,
    public_ip: publicIp,
    record_id: dns.record_id,
  });
  if (!(await recordVerified({ host_id, public_ip: publicIp, dns }))) {
    throw new Error(
      `runtime public IP changed while verifying Cloudflare DNS for ${host_id}`,
    );
  }
  // The host's content origins follow its verified address (best effort).
  await syncHostContentDns({
    id: host_id,
    metadata: {
      ...(current.metadata ?? {}),
      runtime: { ...(current.metadata?.runtime ?? {}), public_ip: publicIp },
    },
  });
  logger.info("verified project-host DNS desired state", {
    host_id,
    hostname: dns.name,
    public_ip: publicIp,
    record_id: dns.record_id,
  });
  return { public_ip: publicIp, record_id: dns.record_id };
}

export async function handleHostDnsReconciliationWork(row: {
  vm_id: string;
  attempt?: number;
  payload?: Record<string, any>;
}): Promise<void> {
  try {
    await reconcileHostDns(row.vm_id);
  } catch (err) {
    const host = await loadHost(row.vm_id);
    const desiredIp = `${host?.metadata?.runtime?.public_ip ?? ""}`.trim();
    const error = errorText(err);
    const failures = await recordFailure({
      host_id: row.vm_id,
      desired_ip: desiredIp || undefined,
      error,
    });
    const attempt = Math.max(
      Number(row.attempt ?? 0),
      Number(row.payload?.attempt ?? 0),
    );
    await enqueueCloudVmWork({
      vm_id: row.vm_id,
      action: HOST_DNS_RECONCILIATION_ACTION,
      payload: {
        provider: "gcp",
        attempt: attempt + 1,
        reason: "retry",
      },
      not_before: new Date(Date.now() + retryDelayMs(attempt)),
    });
    if (failures >= alertFailures()) {
      await alertDnsReconciliationFailure({
        host,
        host_id: row.vm_id,
        desired_ip: desiredIp || undefined,
        error,
        failures,
      }).catch((alertErr) => {
        logger.error("unable to alert failed DNS reconciliation", {
          host_id: row.vm_id,
          err: errorText(alertErr),
        });
      });
    }
    throw err;
  }
}

async function enqueueDueHostDnsReconciliationUnlocked(opts: {
  limit: number;
}): Promise<number> {
  const cutoff = new Date(Date.now() - verifyIntervalMs());
  const { rows } = await pool().query<{ id: string }>(
    `
      SELECT id
      FROM project_hosts
      WHERE deleted IS NULL
        AND status='running'
        AND COALESCE(NULLIF(BTRIM(bay_id), ''), $1)=$1
        AND COALESCE(metadata ->> 'desired_state', 'running')='running'
        AND metadata -> 'machine' ->> 'cloud'='gcp'
        AND metadata -> 'public_route' ->> 'active_mode'='cloudflare-proxy'
        AND NULLIF(metadata -> 'runtime' ->> 'instance_id', '') IS NOT NULL
        AND NULLIF(metadata -> 'runtime' ->> 'zone', '') IS NOT NULL
        AND (
          metadata -> 'dns_reconciliation' ->> 'status' IS DISTINCT FROM
            'verified'
          OR metadata -> 'dns_reconciliation' ->> 'desired_ip'
            IS DISTINCT FROM metadata -> 'runtime' ->> 'public_ip'
          OR COALESCE(
            NULLIF(
              metadata -> 'dns_reconciliation' ->> 'verified_at',
              ''
            )::timestamptz,
            to_timestamp(0)
          ) < $2
        )
      ORDER BY COALESCE(
        NULLIF(
          metadata -> 'dns_reconciliation' ->> 'verified_at',
          ''
        )::timestamptz,
        to_timestamp(0)
      )
      LIMIT $3
    `,
    [getConfiguredBayId(), cutoff, opts.limit],
  );
  let enqueued = 0;
  for (const row of rows) {
    const workId = await enqueueCloudVmWorkOnce({
      vm_id: row.id,
      action: HOST_DNS_RECONCILIATION_ACTION,
      payload: { provider: "gcp", attempt: 0, reason: "periodic-sweep" },
    });
    if (workId) enqueued += 1;
  }
  return enqueued;
}

export async function enqueueDueHostDnsReconciliation(
  opts: { limit?: number } = {},
): Promise<number> {
  const result = await withSessionAdvisoryLock({
    lockKey: SWEEP_LOCK_KEY,
    fn: async () =>
      await enqueueDueHostDnsReconciliationUnlocked({
        limit: Math.max(1, opts.limit ?? 100),
      }),
  });
  return result ?? 0;
}

export async function enqueueHostDnsReconciliation(
  host_id: string,
  reason: string,
): Promise<string | undefined> {
  return await enqueueCloudVmWorkOnce({
    vm_id: host_id,
    action: HOST_DNS_RECONCILIATION_ACTION,
    payload: { provider: "gcp", attempt: 0, reason },
  });
}

export const _test = {
  buildDnsFleetFailureContext,
  dnsControlPlaneFailureClass,
  retryDelayMs,
  verifyIntervalMs,
  withTimeout,
};
