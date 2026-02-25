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
  if (!summary?.updated_at) return 0;
  const date = new Date(summary.updated_at as any);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
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
