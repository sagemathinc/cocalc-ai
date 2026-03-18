import type { HostLocalBackupStatusRow } from "./backup-host-status";

export type BackupClaimCandidateRow = {
  op_id: string;
  host_id: string | null;
};

export function computeHostAvailableBackupSlots({
  hostStatuses,
  freshRunningCounts,
}: {
  hostStatuses: HostLocalBackupStatusRow[];
  freshRunningCounts: Map<string, number>;
}): Map<string, number> {
  const available = new Map<string, number>();
  for (const row of hostStatuses) {
    const hostVisibleLoad = row.in_flight + row.queued;
    const hubVisibleLoad = freshRunningCounts.get(row.host_id) ?? 0;
    const currentLoad = Math.max(hostVisibleLoad, hubVisibleLoad);
    available.set(row.host_id, Math.max(0, row.max_parallel - currentLoad));
  }
  return available;
}

export function selectBackupClaimCandidateIds({
  candidates,
  availableByHost,
  limit,
}: {
  candidates: BackupClaimCandidateRow[];
  availableByHost: Map<string, number>;
  limit: number;
}): string[] {
  if (limit <= 0) return [];
  const selected: string[] = [];
  const remaining = new Map(availableByHost);
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (!candidate.host_id) continue;
    const slots = remaining.get(candidate.host_id) ?? 0;
    if (slots <= 0) continue;
    selected.push(candidate.op_id);
    remaining.set(candidate.host_id, slots - 1);
  }
  return selected;
}
