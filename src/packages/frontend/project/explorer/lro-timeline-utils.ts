import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import { human_readable_size } from "@cocalc/util/misc";

export function lroStatusColor(status?: string): string {
  if (status === "succeeded") return "green";
  if (status === "failed") return "red";
  if (status === "canceled") return "orange";
  if (status === "expired") return "red";
  return "processing";
}

export function lroPhaseColor({
  index,
  activeIndex,
  status,
}: {
  index: number;
  activeIndex: number;
  status?: LroStatus | string;
}): string {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "expired") {
    if (index < activeIndex) return "green";
    if (index === activeIndex) return "red";
    return "gray";
  }
  if (status === "canceled") {
    if (index < activeIndex) return "green";
    if (index === activeIndex) return "orange";
    return "gray";
  }
  if (index < activeIndex) return "green";
  if (index === activeIndex) return "blue";
  return "gray";
}

export function clampProgressPercent(
  progress?: number | null,
): number | undefined {
  if (progress == null || !Number.isFinite(progress)) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

export function lroUpdatedAt(summary?: {
  updated_at?: Date | string | null;
}): number {
  return toLroTimestamp(summary?.updated_at);
}

export function formatProgressDetail(detail?: any): string | undefined {
  if (!detail) return undefined;
  const parts: string[] = [];
  const speed = formatSpeed(detail.speed);
  if (speed) parts.push(speed);
  const eta = formatEta(detail.eta);
  if (eta) parts.push(`ETA ${eta}`);
  return parts.length ? parts.join(", ") : undefined;
}

function formatSpeed(speed?: string | number): string | undefined {
  if (speed == null) return undefined;
  if (typeof speed === "number") {
    if (!Number.isFinite(speed)) return undefined;
    return `${human_readable_size(speed, true)}/s`;
  }
  const numeric = Number.parseFloat(speed);
  if (!Number.isFinite(numeric)) {
    return speed;
  }
  return `${human_readable_size(numeric, true)}/s`;
}

function formatEta(eta?: number): string | undefined {
  if (eta == null || eta <= 0) return undefined;
  if (eta < 1000) return `${Math.round(eta)} ms`;
  if (eta < 60_000) return `${Math.round(eta / 1000)} s`;
  return `${Math.round(eta / 1000 / 60)} min`;
}

export function toLroTimestamp(value?: Date | string | number | null): number {
  if (value == null) return 0;
  const date = new Date(value as any);
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : 0;
}

export function formatDurationMs(value?: number | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const ms = Math.max(0, value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
