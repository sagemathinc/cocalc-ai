/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { CloudflaredDiagnosticSnapshot } from "@cocalc/conat/project-host/api";

export const EXPECTED_CLOUDFLARED_VERSION = "2026.10.3";

const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
const MAX_METRIC_LINES = 160;
const METRIC_NAMES = new Set([
  "tunnel_ids",
  "cloudflared_tunnel_server_locations",
  "cloudflared_tunnel_tunnel_register_fail",
  "cloudflared_tunnel_tunnel_register_success",
  "cloudflared_tunnel_tunnel_rpc_fail",
  "cloudflared_rpc_client_failures",
  "cloudflared_rpc_client_operations",
  "quic_client_total_connections",
  "quic_client_closed_connections",
  "quic_client_dropped_packets",
  "quic_client_lost_packets",
  "quic_client_latest_rtt",
  "quic_client_smoothed_rtt",
  "quic_client_min_rtt",
]);

type CommandResult = {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
};

export type CloudflaredDiagnosticDependencies = {
  execute: (command: string, args: string[]) => Promise<CommandResult>;
  readJournal: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
};

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : `${error}`;
}

function boundedText(value: unknown, max = 16_000): string {
  return `${value ?? ""}`.slice(0, max);
}

export function parseCloudflaredVersion(value: string): string | undefined {
  return value.match(/cloudflared version\s+([^\s(]+)/i)?.[1];
}

export function parseCloudflaredProcess(
  value: string,
): NonNullable<CloudflaredDiagnosticSnapshot["process"]> | undefined {
  const line = value.trim().split("\n")[0];
  if (!line) return;
  const [pid, state, elapsed, rss, threads] = line.split(/\s+/);
  const parsedPid = Number(pid);
  if (!Number.isFinite(parsedPid) || parsedPid <= 0) return;
  return {
    pid: parsedPid,
    state: state || undefined,
    elapsed: elapsed || undefined,
    rss_kb: Number.isFinite(Number(rss)) ? Number(rss) : undefined,
    threads: Number.isFinite(Number(threads)) ? Number(threads) : undefined,
  };
}

export function selectCloudflaredMetrics(value: string): string[] {
  const selected: string[] = [];
  for (const line of value.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const name = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/)?.[1];
    if (!name || !METRIC_NAMES.has(name)) continue;
    selected.push(line.slice(0, 1000));
    if (selected.length >= MAX_METRIC_LINES) break;
  }
  return selected;
}

export function normalizeCloudflaredProtocol(
  value: unknown,
): string | undefined {
  if (value == null) return;
  if (value === 0 || value === "0") return "http2";
  if (value === 1 || value === "1") return "quic";
  return `${value}`;
}

export function parseCloudflaredConfiguredProtocol(
  value: string,
): CloudflaredDiagnosticSnapshot["configured_protocol"] | undefined {
  const protocol = value.trim().toLowerCase();
  if (protocol === "auto" || protocol === "quic" || protocol === "http2") {
    return protocol;
  }
}

export function parseCloudflaredTunnel(
  value: unknown,
): NonNullable<CloudflaredDiagnosticSnapshot["tunnel"]> | undefined {
  if (!value || typeof value !== "object") return;
  const tunnel = value as Record<string, any>;
  const connections = Array.isArray(tunnel.connections)
    ? tunnel.connections.slice(0, 16).map((connection: any) => ({
        index: Number.isFinite(Number(connection?.index))
          ? Number(connection.index)
          : undefined,
        connected:
          typeof connection?.isConnected === "boolean"
            ? connection.isConnected
            : undefined,
        protocol: normalizeCloudflaredProtocol(connection?.protocol),
        edge_address:
          connection?.edgeAddress == null
            ? undefined
            : Array.isArray(connection.edgeAddress)
              ? connection.edgeAddress.join(".")
              : `${connection.edgeAddress}`,
      }))
    : [];
  return {
    tunnel_id: `${tunnel.tunnelID ?? ""}` || undefined,
    connector_id: `${tunnel.connectorID ?? ""}` || undefined,
    connections,
  };
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeout_ms: number,
): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeout_ms),
  });
  return { status: response.status, text: await response.text() };
}

async function findMetricsServer(
  fetchImpl: typeof fetch,
  timeout_ms: number,
): Promise<{ url: string; status: number; text: string } | undefined> {
  const results = await Promise.all(
    METRICS_PORTS.map(async (port) => {
      const url = `http://127.0.0.1:${port}`;
      try {
        const ready = await fetchText(fetchImpl, `${url}/ready`, timeout_ms);
        return { url, ...ready };
      } catch {
        return;
      }
    }),
  );
  return results.find((result) => result != null);
}

export async function collectCloudflaredDiagnosticSnapshot({
  execute,
  readJournal,
  fetchImpl = fetch,
  timeout_ms = 1500,
}: CloudflaredDiagnosticDependencies): Promise<CloudflaredDiagnosticSnapshot> {
  const snapshot: CloudflaredDiagnosticSnapshot = {
    captured_at: new Date().toISOString(),
    expected_version: EXPECTED_CLOUDFLARED_VERSION,
  };
  const errors: string[] = [];
  const [
    versionResult,
    processResult,
    configuredProtocolResult,
    journalResult,
    metricsServer,
  ] = await Promise.all([
    execute("/usr/bin/cloudflared", ["--version"]).catch((err) => {
      errors.push(`version: ${errorText(err)}`);
      return undefined;
    }),
    execute("/bin/ps", [
      "-C",
      "cloudflared",
      "-o",
      "pid=,stat=,etimes=,rss=,nlwp=",
    ]).catch((err) => {
      errors.push(`process: ${errorText(err)}`);
      return undefined;
    }),
    execute("/usr/bin/awk", [
      "/^[[:space:]]*protocol:[[:space:]]*/ { print $2; exit }",
      "/etc/cloudflared/config.yml",
    ]).catch((err) => {
      errors.push(`configured protocol: ${errorText(err)}`);
      return undefined;
    }),
    readJournal().catch((err) => {
      errors.push(`journal: ${errorText(err)}`);
      return undefined;
    }),
    findMetricsServer(fetchImpl, timeout_ms).catch((err) => {
      errors.push(`metrics discovery: ${errorText(err)}`);
      return undefined;
    }),
  ]);

  if (versionResult?.exit_code === 0) {
    snapshot.version = parseCloudflaredVersion(`${versionResult.stdout ?? ""}`);
    snapshot.version_drift =
      snapshot.version != null &&
      snapshot.version !== EXPECTED_CLOUDFLARED_VERSION;
  } else if (versionResult) {
    errors.push(
      `version exit=${versionResult.exit_code}: ${boundedText(versionResult.stderr)}`,
    );
  }
  if (processResult?.exit_code === 0) {
    snapshot.process = parseCloudflaredProcess(`${processResult.stdout ?? ""}`);
  } else if (processResult) {
    errors.push(
      `process exit=${processResult.exit_code}: ${boundedText(processResult.stderr)}`,
    );
  }
  if (configuredProtocolResult?.exit_code === 0) {
    snapshot.configured_protocol = parseCloudflaredConfiguredProtocol(
      `${configuredProtocolResult.stdout ?? ""}`,
    );
  } else if (configuredProtocolResult) {
    errors.push(
      `configured protocol exit=${configuredProtocolResult.exit_code}: ${boundedText(configuredProtocolResult.stderr)}`,
    );
  }
  if (journalResult) snapshot.journal = boundedText(journalResult, 12_000);

  if (metricsServer) {
    snapshot.metrics_url = metricsServer.url;
    try {
      const ready = JSON.parse(metricsServer.text);
      snapshot.ready = {
        status: metricsServer.status,
        ready_connections: Number.isFinite(Number(ready.readyConnections))
          ? Number(ready.readyConnections)
          : undefined,
        connector_id: `${ready.connectorId ?? ""}` || undefined,
      };
    } catch (err) {
      snapshot.ready = { status: metricsServer.status };
      errors.push(`ready response: ${errorText(err)}`);
    }
    const [tunnelResult, metricResult] = await Promise.all([
      fetchText(
        fetchImpl,
        `${metricsServer.url}/diag/tunnel`,
        timeout_ms,
      ).catch((err) => {
        errors.push(`tunnel state: ${errorText(err)}`);
        return undefined;
      }),
      fetchText(fetchImpl, `${metricsServer.url}/metrics`, timeout_ms).catch(
        (err) => {
          errors.push(`metrics: ${errorText(err)}`);
          return undefined;
        },
      ),
    ]);
    if (tunnelResult?.status === 200) {
      try {
        snapshot.tunnel = parseCloudflaredTunnel(JSON.parse(tunnelResult.text));
      } catch (err) {
        errors.push(`tunnel response: ${errorText(err)}`);
      }
    } else if (tunnelResult) {
      errors.push(`tunnel state HTTP ${tunnelResult.status}`);
    }
    if (metricResult?.status === 200) {
      snapshot.metrics = selectCloudflaredMetrics(metricResult.text);
    } else if (metricResult) {
      errors.push(`metrics HTTP ${metricResult.status}`);
    }
  } else {
    errors.push("metrics server not found on 127.0.0.1:20241-20245");
  }

  if (errors.length) snapshot.errors = errors.slice(0, 20);
  return snapshot;
}

export function cloudflaredHeartbeatSummary(
  snapshot: CloudflaredDiagnosticSnapshot | undefined,
): Record<string, any> | undefined {
  if (!snapshot) return;
  const observedProtocols = Array.from(
    new Set(
      (snapshot.tunnel?.connections ?? [])
        .map(({ protocol }) => protocol)
        .filter(Boolean),
    ),
  );
  const configuredFallback =
    observedProtocols.length === 0 &&
    snapshot.configured_protocol != null &&
    snapshot.configured_protocol !== "auto"
      ? [snapshot.configured_protocol]
      : [];
  return {
    captured_at: snapshot.captured_at,
    expected_version: snapshot.expected_version,
    version: snapshot.version,
    version_drift: snapshot.version_drift,
    pid: snapshot.process?.pid,
    process_elapsed_s: Number(snapshot.process?.elapsed) || undefined,
    ready_status: snapshot.ready?.status,
    ready_connections: snapshot.ready?.ready_connections,
    connector_id: snapshot.ready?.connector_id ?? snapshot.tunnel?.connector_id,
    configured_protocol: snapshot.configured_protocol,
    observed_protocols: observedProtocols,
    protocols:
      observedProtocols.length > 0 ? observedProtocols : configuredFallback,
    protocol_source:
      observedProtocols.length > 0
        ? "observed"
        : configuredFallback.length > 0
          ? "configured_fallback"
          : "unknown",
    edge_addresses: (snapshot.tunnel?.connections ?? [])
      .map(({ edge_address }) => edge_address)
      .filter(Boolean),
    collection_errors: snapshot.errors?.length ?? 0,
  };
}
