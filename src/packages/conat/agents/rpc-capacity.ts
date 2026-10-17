export type AgentRpcCapacityFull = {
  code: "host_overloaded" | "project_overloaded";
  /** Messages in flight for the exhausted scope, and its limit. */
  active: number;
  limit: number;
};

export type AgentRpcCapacityLease = {
  track<T>(work: Promise<T>): Promise<T>;
  release(): void;
};

/**
 * Admission for messages being delivered. A timed-out caller must not free
 * resources still in use. Waiting is opt-in and bounded (acquireWithin).
 */
export class AgentRpcCapacity {
  private active = 0;
  private readonly projects = new Map<string, number>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly hostLimit = 96,
    private readonly projectLimit = 24,
  ) {
    if (
      !Number.isSafeInteger(hostLimit) ||
      hostLimit < 1 ||
      !Number.isSafeInteger(projectLimit) ||
      projectLimit < 1
    )
      throw new Error("positive integer messaging limits required");
  }

  acquire(projectId: string): AgentRpcCapacityFull | AgentRpcCapacityLease {
    if (this.active >= this.hostLimit)
      return {
        code: "host_overloaded",
        active: this.active,
        limit: this.hostLimit,
      };
    const count = this.projects.get(projectId) ?? 0;
    if (count >= this.projectLimit)
      return {
        code: "project_overloaded",
        active: count,
        limit: this.projectLimit,
      };
    this.active++;
    this.projects.set(projectId, count + 1);
    let pending = 0,
      finished = false,
      released = false;
    const releaseIfFinished = () => {
      if (!finished || pending || released) return;
      released = true;
      this.active--;
      const remaining = this.projects.get(projectId)! - 1;
      if (remaining) this.projects.set(projectId, remaining);
      else this.projects.delete(projectId);
      for (const wake of [...this.waiters]) wake();
    };
    return {
      track: <T>(work: Promise<T>): Promise<T> => {
        if (finished) throw new Error("messaging admission already released");
        pending++;
        return work.finally(() => {
          pending--;
          releaseIfFinished();
        });
      },
      release: () => {
        finished = true;
        releaseIfFinished();
      },
    };
  }

  /** Like acquire, but waits up to waitMs for a slot to be released. */
  async acquireWithin(
    projectId: string,
    waitMs: number,
  ): Promise<AgentRpcCapacityFull | AgentRpcCapacityLease> {
    const until = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const lease = this.acquire(projectId);
      const remaining = until - Date.now();
      if (!("code" in lease) || remaining <= 0) return lease;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }
}

/** What a sender sees when delivery capacity stays full. */
export function agentRpcCapacityReason(full: AgentRpcCapacityFull): string {
  const scope =
    full.code === "project_overloaded"
      ? "the recipient's project"
      : "the recipient's host";
  return `the recipient is busy (${full.active} of ${full.limit} messages to ${scope} are being delivered right now); retry in a few seconds`;
}
