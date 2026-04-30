/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";

const logger = getLogger("project-host:rpc-traffic-audit");
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TOP_METHODS = 12;

type RpcTrafficStats = Record<string, number | undefined>;

export interface ProjectHostRpcTrafficRecord {
  channel: string;
  method: string;
  args?: any[];
  result?: any;
  error?: boolean;
  duration_ms?: number;
  stats?: RpcTrafficStats;
}

interface AuditEntry {
  channel: string;
  method: string;
  calls: number;
  errors: number;
  request_bytes: number;
  response_bytes: number;
  duration_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
  stats: Record<string, number>;
}

export interface ProjectHostRpcTrafficSummaryMethod {
  channel: string;
  method: string;
  calls: number;
  errors: number;
  request_bytes: number;
  response_bytes: number;
  total_bytes: number;
  avg_request_bytes: number;
  avg_response_bytes: number;
  avg_duration_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
  stats?: Record<string, number>;
}

export interface ProjectHostRpcTrafficSummary {
  interval_ms: number;
  total_calls: number;
  total_errors: number;
  total_request_bytes: number;
  total_response_bytes: number;
  total_bytes: number;
  request_bytes_per_s: number;
  response_bytes_per_s: number;
  top_methods: ProjectHostRpcTrafficSummaryMethod[];
  totals_by_channel: Array<{
    channel: string;
    calls: number;
    errors: number;
    request_bytes: number;
    response_bytes: number;
    total_bytes: number;
  }>;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function envEnabled(name: string): boolean {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function roundRate(bytes: number, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return Math.round((bytes * 10_000) / intervalMs) / 10;
}

function sumStats(stats?: RpcTrafficStats): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(stats ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

function encodeSize(mesg: any): number {
  try {
    return encode({
      encoding: DataEncoding.MsgPack,
      mesg: mesg ?? null,
    }).length;
  } catch {
    return 0;
  }
}

export function estimateProjectHostRpcRequestBytes({
  method,
  args = [],
}: {
  method: string;
  args?: any[];
}): number {
  return encodeSize({ name: method, args });
}

export function estimateProjectHostRpcResponseBytes(result: any): number {
  if (result === undefined) return 0;
  return encodeSize(result);
}

export class ProjectHostRpcTrafficAudit {
  private readonly byKey = new Map<string, AuditEntry>();
  private intervalStartedAt = Date.now();

  record({
    channel,
    method,
    args = [],
    result,
    error,
    duration_ms,
    stats,
  }: ProjectHostRpcTrafficRecord): void {
    const key = `${channel}:${method}`;
    const entry = this.byKey.get(key) ?? {
      channel,
      method,
      calls: 0,
      errors: 0,
      request_bytes: 0,
      response_bytes: 0,
      duration_ms: 0,
      max_request_bytes: 0,
      max_response_bytes: 0,
      stats: {},
    };
    const request_bytes = estimateProjectHostRpcRequestBytes({ method, args });
    const response_bytes = estimateProjectHostRpcResponseBytes(result);
    entry.calls += 1;
    entry.errors += error ? 1 : 0;
    entry.request_bytes += request_bytes;
    entry.response_bytes += response_bytes;
    entry.duration_ms += Math.max(0, Number(duration_ms) || 0);
    entry.max_request_bytes = Math.max(entry.max_request_bytes, request_bytes);
    entry.max_response_bytes = Math.max(
      entry.max_response_bytes,
      response_bytes,
    );
    for (const [name, value] of Object.entries(sumStats(stats))) {
      entry.stats[name] = (entry.stats[name] ?? 0) + value;
    }
    this.byKey.set(key, entry);
  }

  flushSummary({
    now = Date.now(),
    topMethods = DEFAULT_TOP_METHODS,
  }: {
    now?: number;
    topMethods?: number;
  } = {}): ProjectHostRpcTrafficSummary | undefined {
    if (this.byKey.size === 0) {
      this.intervalStartedAt = now;
      return;
    }
    const interval_ms = Math.max(1, now - this.intervalStartedAt);
    this.intervalStartedAt = now;

    let total_calls = 0;
    let total_errors = 0;
    let total_request_bytes = 0;
    let total_response_bytes = 0;
    const totalsByChannel = new Map<
      string,
      {
        channel: string;
        calls: number;
        errors: number;
        request_bytes: number;
        response_bytes: number;
      }
    >();

    const methods = Array.from(this.byKey.values()).map((entry) => {
      total_calls += entry.calls;
      total_errors += entry.errors;
      total_request_bytes += entry.request_bytes;
      total_response_bytes += entry.response_bytes;
      const channel = totalsByChannel.get(entry.channel) ?? {
        channel: entry.channel,
        calls: 0,
        errors: 0,
        request_bytes: 0,
        response_bytes: 0,
      };
      channel.calls += entry.calls;
      channel.errors += entry.errors;
      channel.request_bytes += entry.request_bytes;
      channel.response_bytes += entry.response_bytes;
      totalsByChannel.set(entry.channel, channel);
      return {
        channel: entry.channel,
        method: entry.method,
        calls: entry.calls,
        errors: entry.errors,
        request_bytes: entry.request_bytes,
        response_bytes: entry.response_bytes,
        total_bytes: entry.request_bytes + entry.response_bytes,
        avg_request_bytes: Math.round(entry.request_bytes / entry.calls),
        avg_response_bytes: Math.round(entry.response_bytes / entry.calls),
        avg_duration_ms:
          Math.round((entry.duration_ms * 10) / entry.calls) / 10,
        max_request_bytes: entry.max_request_bytes,
        max_response_bytes: entry.max_response_bytes,
        stats:
          Object.keys(entry.stats).length > 0 ? { ...entry.stats } : undefined,
      };
    });

    this.byKey.clear();

    return {
      interval_ms,
      total_calls,
      total_errors,
      total_request_bytes,
      total_response_bytes,
      total_bytes: total_request_bytes + total_response_bytes,
      request_bytes_per_s: roundRate(total_request_bytes, interval_ms),
      response_bytes_per_s: roundRate(total_response_bytes, interval_ms),
      top_methods: methods
        .sort(
          (a, b) =>
            b.total_bytes - a.total_bytes ||
            b.calls - a.calls ||
            a.channel.localeCompare(b.channel) ||
            a.method.localeCompare(b.method),
        )
        .slice(0, Math.max(1, topMethods)),
      totals_by_channel: Array.from(totalsByChannel.values())
        .map((entry) => ({
          ...entry,
          total_bytes: entry.request_bytes + entry.response_bytes,
        }))
        .sort(
          (a, b) =>
            b.total_bytes - a.total_bytes || a.channel.localeCompare(b.channel),
        ),
    };
  }
}

const enabled = envEnabled("COCALC_PROJECT_HOST_RPC_TRAFFIC_AUDIT");
const intervalMs = envPositiveInt(
  "COCALC_PROJECT_HOST_RPC_TRAFFIC_AUDIT_INTERVAL_MS",
  DEFAULT_INTERVAL_MS,
);
const topMethods = envPositiveInt(
  "COCALC_PROJECT_HOST_RPC_TRAFFIC_AUDIT_TOP_METHODS",
  DEFAULT_TOP_METHODS,
);
const audit = enabled ? new ProjectHostRpcTrafficAudit() : undefined;
let timer: NodeJS.Timeout | undefined;

function ensureStarted(): void {
  if (!enabled || timer || !audit) return;
  timer = setInterval(() => {
    const summary = audit.flushSummary({ topMethods });
    if (!summary) return;
    logger.info("project-host RPC traffic audit", summary);
  }, intervalMs);
  timer.unref?.();
}

export function recordProjectHostRpcTraffic(
  record: ProjectHostRpcTrafficRecord,
): void {
  if (!audit) return;
  ensureStarted();
  audit.record(record);
}
