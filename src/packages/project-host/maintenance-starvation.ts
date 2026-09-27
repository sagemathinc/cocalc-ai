export type MaintenanceKind = "snapshot" | "backup";

export interface StarvedMaintenance {
  projectId: string;
  kind: MaintenanceKind;
  retryAt: number;
}

// Shared by full reconciliations and event batches. Queue order survives repeated
// listings, including failures and stale success reports from the owning bay.
export function createMaintenanceStarvationQueue(now = Date.now) {
  const queues = {
    snapshot: new Map<string, StarvedMaintenance>(),
    backup: new Map<string, StarvedMaintenance>(),
  };
  let lastKind: MaintenanceKind = "backup";
  let inFlight = false;
  let nextAllowedAt = 0;

  const update = (items: StarvedMaintenance[], projectIds?: string[]) => {
    const scope = projectIds == null ? undefined : new Set(projectIds);
    for (const kind of ["snapshot", "backup"] as const) {
      const incoming = new Map(
        items
          .filter((item) => item.kind === kind)
          .map((item) => [item.projectId, item]),
      );
      const queue = queues[kind];
      for (const id of queue.keys()) {
        if ((!scope || scope.has(id)) && !incoming.has(id)) queue.delete(id);
      }
      for (const [id, item] of incoming) queue.set(id, item);
    }
  };

  const next = (): StarvedMaintenance | undefined => {
    const preferred = lastKind === "snapshot" ? "backup" : "snapshot";
    for (const kind of [preferred, lastKind]) {
      for (const item of queues[kind].values()) {
        if (item.retryAt <= now()) return item;
      }
    }
    return undefined;
  };

  const reserve = (
    projectId: string,
    kind: MaintenanceKind,
    intervalMs: number,
  ) => {
    if (inFlight || now() < nextAllowedAt) return undefined;
    const candidate = next();
    if (candidate?.projectId !== projectId || candidate.kind !== kind)
      return undefined;
    inFlight = true;
    let released = false;
    return (consumed: boolean) => {
      if (released) return;
      released = true;
      inFlight = false;
      if (!consumed) return;
      // Charge attempts, not successes: a failed or invalidated oldest item
      // must neither monopolize the queue nor create a tight retry loop.
      nextAllowedAt = now() + intervalMs;
      lastKind = kind;
      const current = queues[kind].get(projectId);
      if (current) {
        queues[kind].delete(projectId);
        queues[kind].set(projectId, current);
      }
    };
  };

  return { update, reserve, next, nextAllowedAt: () => nextAllowedAt };
}
