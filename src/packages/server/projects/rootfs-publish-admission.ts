export type RootfsPublishClaimCandidateRow = {
  op_id: string;
  project_host_id: string | null;
};

export type RootfsPublishClaimSelection = {
  op_id: string;
  project_host_id: string;
};

export function computeAvailableRootfsPublishHostSlots({
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

export function selectRootfsPublishClaimCandidates({
  candidates,
  availableByHost,
  limit,
}: {
  candidates: RootfsPublishClaimCandidateRow[];
  availableByHost: Map<string, number>;
  limit: number;
}): RootfsPublishClaimSelection[] {
  if (limit <= 0) return [];
  const selected: RootfsPublishClaimSelection[] = [];
  const remainingByHost = new Map(availableByHost);

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const project_host_id = candidate.project_host_id;
    if (!project_host_id) continue;
    const remaining = remainingByHost.get(project_host_id) ?? 0;
    if (remaining <= 0) continue;
    selected.push({ op_id: candidate.op_id, project_host_id });
    remainingByHost.set(project_host_id, remaining - 1);
  }

  return selected;
}
