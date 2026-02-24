export function isHostRoutingUnavailableError(error: unknown): boolean {
  const s = `${(error as any)?.message ?? (error as any)?.error ?? error ?? ""}`
    .toLowerCase()
    .trim();
  if (!s) return false;
  return (
    s.includes("no subscribers matching") ||
    s.includes("unable to route") ||
    s.includes("project actions unavailable")
  );
}

const TRANSIENT_ROUTING_GRACE_MS = 2 * 60 * 1000;

type MoveLroLike = {
  summary?: {
    status?: string;
    updated_at?: Date | string | null;
    finished_at?: Date | string | null;
    created_at?: Date | string | null;
  };
};

function toTs(value?: Date | string | null): number | undefined {
  if (!value) return;
  const d = new Date(value as any);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

export function isRecentlySucceededMove({
  moveLro,
  graceMs = TRANSIENT_ROUTING_GRACE_MS,
  nowMs = Date.now(),
}: {
  moveLro?: MoveLroLike;
  graceMs?: number;
  nowMs?: number;
}): boolean {
  const summary = moveLro?.summary;
  if (summary?.status !== "succeeded") return false;
  const ts =
    toTs(summary.updated_at) ?? toTs(summary.finished_at) ?? toTs(summary.created_at);
  if (ts == null) return false;
  return nowMs - ts <= graceMs;
}

export function shouldSuppressTransientRoutingError({
  error,
  moveLro,
  graceMs,
}: {
  error: unknown;
  moveLro?: MoveLroLike;
  graceMs?: number;
}): boolean {
  return (
    isHostRoutingUnavailableError(error) &&
    isRecentlySucceededMove({ moveLro, graceMs })
  );
}
