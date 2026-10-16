export type MaintenanceKind = "snapshot" | "backup";

export interface StarvedMaintenance {
  projectId: string;
  kind: MaintenanceKind;
  retryAt: number;
  // When the work fell due: the longest-overdue work goes first.
  dueAt?: number;
}

const KINDS = ["snapshot", "backup"] as const;

// Shared by full reconciliations and event batches. Each kind is its own queue,
// ordered oldest-due first, with work not yet tried ahead of work tried (least
// recently tried first), and paced separately: snapshots are short metadata
// operations, backups long reads. Attempt history survives repeated listings,
// including failures and stale success reports from the owning bay.
export function createMaintenanceStarvationQueue(now = Date.now) {
  const queues = {
    snapshot: new Map<string, StarvedMaintenance>(),
    backup: new Map<string, StarvedMaintenance>(),
  };
  const attemptedAt = {
    snapshot: new Map<string, number>(),
    backup: new Map<string, number>(),
  };
  let inFlight = false;
  const nextAllowed: Record<MaintenanceKind, number> = {
    snapshot: 0,
    backup: 0,
  };

  const update = (items: StarvedMaintenance[], projectIds?: string[]) => {
    const scope = projectIds == null ? undefined : new Set(projectIds);
    for (const kind of KINDS) {
      const incoming = new Map(
        items
          .filter((item) => item.kind === kind)
          .map((item) => [item.projectId, item]),
      );
      const queue = queues[kind];
      for (const id of queue.keys()) {
        if ((!scope || scope.has(id)) && !incoming.has(id)) {
          queue.delete(id);
          attemptedAt[kind].delete(id);
        }
      }
      for (const [id, item] of incoming) queue.set(id, item);
    }
  };

  // The head of one kind's queue among work whose retry backoff has passed.
  const head = (kind: MaintenanceKind): StarvedMaintenance | undefined => {
    let best: StarvedMaintenance | undefined;
    let bestKey: [number, number] | undefined;
    for (const item of queues[kind].values()) {
      if (item.retryAt > now()) continue;
      const key: [number, number] = [
        attemptedAt[kind].get(item.projectId) ?? -Infinity,
        item.dueAt ?? Infinity,
      ];
      if (
        !bestKey ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] && key[1] < bestKey[1])
      ) {
        best = item;
        bestKey = key;
      }
    }
    return best;
  };

  /** The next work to wake for: of the kind whose pace allows it soonest. */
  const next = (): StarvedMaintenance | undefined => {
    const candidates = KINDS.map((kind) => head(kind)).filter(
      (item): item is StarvedMaintenance => item != null,
    );
    candidates.sort((a, b) => nextAllowed[a.kind] - nextAllowed[b.kind]);
    return candidates[0];
  };

  const reserve = (
    projectId: string,
    kind: MaintenanceKind,
    intervalMs: number,
  ) => {
    if (inFlight || now() < nextAllowed[kind]) return undefined;
    const candidate = head(kind);
    if (candidate?.projectId !== projectId) return undefined;
    inFlight = true;
    let released = false;
    return (consumed: boolean) => {
      if (released) return;
      released = true;
      inFlight = false;
      if (!consumed) return;
      // Charge attempts, not successes: a failed or invalidated oldest item
      // must neither monopolize the queue nor create a tight retry loop.
      nextAllowed[kind] = now() + intervalMs;
      if (queues[kind].has(projectId)) attemptedAt[kind].set(projectId, now());
    };
  };

  return {
    update,
    reserve,
    next,
    nextAllowedAt: (kind?: MaintenanceKind) =>
      kind ? nextAllowed[kind] : Math.min(...KINDS.map((k) => nextAllowed[k])),
  };
}
