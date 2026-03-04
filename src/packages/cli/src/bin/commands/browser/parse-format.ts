/*
Shared parsing/formatting helpers for `cocalc browser` command handlers.

These helpers are pure and reusable so browser.ts can stay focused on
command registration and request orchestration.
*/

import type {
  BrowserActionName,
  BrowserAutomationPosture,
  BrowserCoordinateSpace,
  BrowserExecPolicyV1,
} from "@cocalc/conat/service/browser-session";
import { durationToMs } from "../../../core/utils";
import type {
  BrowserNetworkTraceDirection,
  BrowserNetworkTraceEvent,
  BrowserNetworkTracePhase,
  BrowserNetworkTraceProtocol,
  BrowserRuntimeEvent,
  BrowserRuntimeEventLevel,
  ScreenshotRenderer,
} from "./types";

export function normalizeBrowserId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id.length > 0 ? id : undefined;
}

export function normalizeBrowserPosture(
  value: unknown,
): BrowserAutomationPosture | undefined {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === "dev" || clean === "prod") return clean;
  throw new Error(`invalid browser posture '${value}'; expected 'dev' or 'prod'`);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = `${hostname ?? ""}`.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

export function defaultPostureForApiUrl(apiUrl: string): BrowserAutomationPosture {
  try {
    const host = new URL(apiUrl).hostname;
    return isLoopbackHostname(host) ? "dev" : "prod";
  } catch {
    return "dev";
  }
}

export function parseOptionalDurationMs(
  value: unknown,
  fallbackMs: number,
): number | undefined {
  const clean = `${value ?? ""}`.trim();
  if (!clean) return undefined;
  return durationToMs(clean, fallbackMs);
}

export function parseCoordinateSpace(value: unknown): BrowserCoordinateSpace {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "viewport") return "viewport";
  if (clean === "selector" || clean === "image" || clean === "normalized") {
    return clean;
  }
  throw new Error(
    `invalid coordinate space '${value}'; expected viewport|selector|image|normalized`,
  );
}

export function parseScreenshotRenderer(value: unknown): ScreenshotRenderer {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "auto") return "auto";
  if (clean === "dom" || clean === "native" || clean === "media") return clean;
  throw new Error(
    `invalid screenshot renderer '${value}'; expected auto|dom|native|media`,
  );
}

export function parseRequiredNumber(value: unknown, label: string): number {
  const num = Number(`${value ?? ""}`.trim());
  if (!Number.isFinite(num)) {
    throw new Error(`${label} must be a finite number`);
  }
  return num;
}

export function parseScrollBehavior(value: unknown): "auto" | "smooth" {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "auto") return "auto";
  if (clean === "smooth") return "smooth";
  throw new Error(`invalid scroll behavior '${value}'; expected auto|smooth`);
}

export function parseScrollAlign(
  value: unknown,
  label: "block" | "inline",
): "start" | "center" | "end" | "nearest" {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return label === "block" ? "center" : "nearest";
  if (
    clean === "start" ||
    clean === "center" ||
    clean === "end" ||
    clean === "nearest"
  ) {
    return clean;
  }
  throw new Error(`invalid --${label} '${value}'; expected start|center|end|nearest`);
}

export function parseRuntimeEventLevels(
  value: unknown,
): BrowserRuntimeEventLevel[] | undefined {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return undefined;
  const parts = clean
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length === 0) return undefined;
  const allowed = new Set<BrowserRuntimeEventLevel>([
    "trace",
    "debug",
    "log",
    "info",
    "warn",
    "error",
  ]);
  const out: BrowserRuntimeEventLevel[] = [];
  for (const part of parts) {
    if (!allowed.has(part as BrowserRuntimeEventLevel)) {
      throw new Error(
        `invalid --level '${part}'; expected comma-separated trace,debug,log,info,warn,error`,
      );
    }
    out.push(part as BrowserRuntimeEventLevel);
  }
  return out.length > 0 ? out : undefined;
}

export function parseCsvStrings(value: unknown): string[] | undefined {
  const clean = `${value ?? ""}`.trim();
  if (!clean) return undefined;
  const out = clean
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

export function parseNetworkDirection(
  value: unknown,
): BrowserNetworkTraceDirection | undefined {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === "send" || clean === "recv") {
    return clean;
  }
  throw new Error(`invalid --direction '${value}'; expected send|recv`);
}

export function parseNetworkProtocols(
  value: unknown,
): BrowserNetworkTraceProtocol[] | undefined {
  const parts = parseCsvStrings(value);
  if (!parts || parts.length === 0) return undefined;
  const allowed = new Set<BrowserNetworkTraceProtocol>(["conat", "http", "ws"]);
  const out: BrowserNetworkTraceProtocol[] = [];
  for (const part of parts) {
    const clean = `${part}`.trim().toLowerCase();
    if (!allowed.has(clean as BrowserNetworkTraceProtocol)) {
      throw new Error(`invalid --protocol '${part}'; expected conat,http,ws`);
    }
    out.push(clean as BrowserNetworkTraceProtocol);
  }
  return out.length > 0 ? [...new Set(out)] : undefined;
}

export function parseNetworkPhases(
  value: unknown,
): BrowserNetworkTracePhase[] | undefined {
  const parts = parseCsvStrings(value);
  if (!parts || parts.length === 0) return undefined;
  const allowed = new Set<BrowserNetworkTracePhase>([
    "publish_chunk",
    "recv_chunk",
    "recv_message",
    "drop_chunk_seq",
    "drop_chunk_timeout",
    "http_request",
    "http_response",
    "http_error",
    "ws_open",
    "ws_send",
    "ws_message",
    "ws_close",
    "ws_error",
  ]);
  const out: BrowserNetworkTracePhase[] = [];
  for (const part of parts) {
    const clean = `${part}`.trim().toLowerCase();
    if (!allowed.has(clean as BrowserNetworkTracePhase)) {
      throw new Error(
        `invalid --phase '${part}'; expected publish_chunk,recv_chunk,recv_message,drop_chunk_seq,drop_chunk_timeout,http_request,http_response,http_error,ws_open,ws_send,ws_message,ws_close,ws_error`,
      );
    }
    out.push(clean as BrowserNetworkTracePhase);
  }
  return out.length > 0 ? out : undefined;
}

export function formatRuntimeEventLine(event: BrowserRuntimeEvent): string {
  const ts = `${event.ts ?? ""}`.trim() || new Date().toISOString();
  const level = `${event.level ?? "log"}`.toUpperCase();
  const kind =
    event.kind === "console"
      ? "console"
      : event.kind === "uncaught_error"
        ? "uncaught"
        : "rejection";
  const sourceBits: string[] = [];
  if (event.source) sourceBits.push(`${event.source}`);
  if (event.line != null || event.column != null) {
    sourceBits.push(`${event.line ?? "?"}:${event.column ?? "?"}`);
  }
  const source = sourceBits.length > 0 ? ` (${sourceBits.join(" ")})` : "";
  return `${ts} [${level}] [${kind}] ${event.message}${source}`;
}

export function formatNetworkTraceLine(event: BrowserNetworkTraceEvent): string {
  const ts = `${event.ts ?? ""}`.trim() || new Date().toISOString();
  const protocol = `${event.protocol ?? "conat"}`.toUpperCase();
  const direction = `${event.direction ?? "recv"}`.toUpperCase();
  const phase = `${event.phase ?? ""}`.trim() || "unknown";
  const address = `${event.address ?? ""}`.trim();
  const subject = `${event.subject ?? ""}`.trim();
  const targetUrl = `${event.target_url ?? ""}`.trim();
  const method = `${event.method ?? ""}`.trim();
  const status = Number.isFinite(Number(event.status))
    ? `${Number(event.status)}`
    : "";
  const durationMs = Number.isFinite(Number(event.duration_ms))
    ? `${Math.max(0, Math.floor(Number(event.duration_ms)))}ms`
    : "";
  const chunk =
    event.chunk_id || event.chunk_seq != null
      ? ` chunk=${event.chunk_id ?? "?"}:${event.chunk_seq ?? "?"}${event.chunk_done ? ":done" : ""}`
      : "";
  const bytes =
    event.chunk_bytes != null || event.raw_bytes != null
      ? ` bytes=${event.chunk_bytes ?? 0}${event.raw_bytes != null ? ` raw=${event.raw_bytes}` : ""}`
      : "";
  const addrTxt = address ? ` addr=${address}` : "";
  const subjTxt = subject ? ` subj=${subject}` : "";
  const urlTxt = targetUrl ? ` url=${targetUrl}` : "";
  const methodTxt = method ? ` method=${method}` : "";
  const statusTxt = status ? ` status=${status}` : "";
  const durationTxt = durationMs ? ` dur=${durationMs}` : "";
  const msg = `${event.message ?? ""}`.trim();
  const preview = `${event.decoded_preview ?? ""}`.trim();
  const details = msg || preview ? ` ${msg || preview}` : "";
  return `${ts} [${protocol}] [${direction}] [${phase}]${addrTxt}${subjTxt}${urlTxt}${methodTxt}${statusTxt}${durationTxt}${chunk}${bytes}${details}`;
}

export function parseBrowserExecPolicy(raw: string): BrowserExecPolicyV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in browser exec policy: ${err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("browser exec policy must be a JSON object");
  }
  const row = parsed as Record<string, unknown>;
  const version = Number(row.version ?? 1);
  if (version !== 1) {
    throw new Error(`unsupported browser exec policy version '${row.version ?? ""}'; expected 1`);
  }
  const cleanStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x) => x.length > 0);
    return out.length ? out : undefined;
  };
  const cleanActionArray = (value: unknown): BrowserActionName[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x): x is BrowserActionName =>
        x === "click" ||
        x === "click_at" ||
        x === "drag" ||
        x === "type" ||
        x === "press" ||
        x === "reload" ||
        x === "navigate" ||
        x === "scroll_by" ||
        x === "scroll_to" ||
        x === "wait_for_selector" ||
        x === "wait_for_url" ||
        x === "batch",
      );
    return out.length ? out : undefined;
  };
  return {
    version: 1,
    ...(row.allow_raw_exec == null
      ? {}
      : { allow_raw_exec: !!row.allow_raw_exec }),
    ...(cleanStringArray(row.allowed_project_ids)
      ? { allowed_project_ids: cleanStringArray(row.allowed_project_ids) }
      : {}),
    ...(cleanStringArray(row.allowed_origins)
      ? { allowed_origins: cleanStringArray(row.allowed_origins) }
      : {}),
    ...(cleanActionArray(row.allowed_actions)
      ? { allowed_actions: cleanActionArray(row.allowed_actions) }
      : {}),
  };
}
