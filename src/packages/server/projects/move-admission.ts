export type MoveClaimCandidateRow = {
  op_id: string;
  source_host_id: string | null;
  dest_host_id: string | null;
  project_region: string;
};

export type MoveActiveDestinationHost = {
  host_id: string;
  project_region: string;
};

export type MoveClaimSelection = {
  op_id: string;
  source_host_id: string;
  dest_host_id: string;
};

export function computeAvailableMoveHostSlots({
  runningCounts,
  limitByHost,
}: {
  runningCounts: Map<string, number>;
  limitByHost: Map<string, number>;
}): Map<string, number> {
  const available = new Map<string, number>();
  for (const [host_id, limit] of limitByHost) {
    const running = runningCounts.get(host_id) ?? 0;
    available.set(host_id, Math.max(0, limit - running));
  }
  return available;
}

function chooseDestinationHost({
  source_host_id,
  project_region,
  remainingDestByHost,
  activeDestinationHosts,
}: {
  source_host_id: string;
  project_region: string;
  remainingDestByHost: Map<string, number>;
  activeDestinationHosts: MoveActiveDestinationHost[];
}): string | undefined {
  const candidates = activeDestinationHosts
    .filter(
      ({ host_id, project_region: hostRegion }) =>
        host_id !== source_host_id &&
        hostRegion === project_region &&
        (remainingDestByHost.get(host_id) ?? 0) > 0,
    )
    .sort((a, b) => {
      const remainingDelta =
        (remainingDestByHost.get(b.host_id) ?? 0) -
        (remainingDestByHost.get(a.host_id) ?? 0);
      if (remainingDelta !== 0) {
        return remainingDelta;
      }
      return a.host_id.localeCompare(b.host_id);
    });
  return candidates[0]?.host_id;
}

export function selectMoveClaimCandidates({
  candidates,
  sourceAvailableByHost,
  destAvailableByHost,
  activeDestinationHosts,
  limit,
}: {
  candidates: MoveClaimCandidateRow[];
  sourceAvailableByHost: Map<string, number>;
  destAvailableByHost: Map<string, number>;
  activeDestinationHosts: MoveActiveDestinationHost[];
  limit: number;
}): MoveClaimSelection[] {
  if (limit <= 0) return [];
  const selected: MoveClaimSelection[] = [];
  const remainingSourceByHost = new Map(sourceAvailableByHost);
  const remainingDestByHost = new Map(destAvailableByHost);

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const source_host_id = candidate.source_host_id;
    if (!source_host_id) continue;
    const remainingSource = remainingSourceByHost.get(source_host_id) ?? 0;
    if (remainingSource <= 0) continue;
    const dest_host_id =
      candidate.dest_host_id ??
      chooseDestinationHost({
        source_host_id,
        project_region: candidate.project_region,
        remainingDestByHost,
        activeDestinationHosts,
      });
    if (!dest_host_id || dest_host_id === source_host_id) continue;
    const remainingDest = remainingDestByHost.get(dest_host_id) ?? 0;
    if (remainingDest <= 0) continue;
    selected.push({
      op_id: candidate.op_id,
      source_host_id,
      dest_host_id,
    });
    remainingSourceByHost.set(source_host_id, remainingSource - 1);
    remainingDestByHost.set(dest_host_id, remainingDest - 1);
  }

  return selected;
}
