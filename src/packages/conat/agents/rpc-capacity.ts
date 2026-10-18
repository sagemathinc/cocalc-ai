export type AgentRpcCapacityFull = {
  code: "host_overloaded" | "project_overloaded";
  /** In-flight work for the exhausted scope, and its limit. */
  active: number;
  limit: number;
  /** The exhausted limit is the tighter one for sends with attachments. */
  attachments?: true;
};

export type AgentRpcCapacityLease = {
  track<T>(work: Promise<T>): Promise<T>;
  release(): void;
};

type Counts = { active: number; projects: Map<string, number> };

/**
 * Non-waiting admission: a full scope is an explicit overload, never a queue.
 * A timed-out caller must not free resources still in use. Sends with
 * attachments also count against tighter limits, since each may hold file
 * bytes in memory.
 */
export class AgentRpcCapacity {
  private readonly all: Counts = { active: 0, projects: new Map() };
  private readonly withFiles: Counts = { active: 0, projects: new Map() };

  constructor(
    private readonly hostLimit = 96,
    private readonly projectLimit = 24,
    private readonly attachmentHostLimit = 4,
    private readonly attachmentProjectLimit = 2,
  ) {
    for (const limit of [
      hostLimit,
      projectLimit,
      attachmentHostLimit,
      attachmentProjectLimit,
    ])
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("positive integer messaging limits required");
  }

  acquire(
    projectId: string,
    { attachments = false }: { attachments?: boolean } = {},
  ): AgentRpcCapacityFull | AgentRpcCapacityLease {
    const full = check(this.all, projectId, this.hostLimit, this.projectLimit);
    if (full) return full;
    if (attachments) {
      const files = check(
        this.withFiles,
        projectId,
        this.attachmentHostLimit,
        this.attachmentProjectLimit,
      );
      if (files) return { ...files, attachments: true };
    }
    const scopes = attachments ? [this.all, this.withFiles] : [this.all];
    for (const counts of scopes) {
      counts.active++;
      counts.projects.set(projectId, (counts.projects.get(projectId) ?? 0) + 1);
    }
    let pending = 0,
      finished = false,
      released = false;
    const releaseIfFinished = () => {
      if (!finished || pending || released) return;
      released = true;
      for (const counts of scopes) {
        counts.active--;
        const remaining = counts.projects.get(projectId)! - 1;
        if (remaining) counts.projects.set(projectId, remaining);
        else counts.projects.delete(projectId);
      }
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
}

function check(
  counts: Counts,
  projectId: string,
  hostLimit: number,
  projectLimit: number,
): AgentRpcCapacityFull | undefined {
  if (counts.active >= hostLimit)
    return { code: "host_overloaded", active: counts.active, limit: hostLimit };
  const count = counts.projects.get(projectId) ?? 0;
  if (count >= projectLimit)
    return { code: "project_overloaded", active: count, limit: projectLimit };
}

/** What a sender sees when delivery capacity is full. */
export function agentRpcCapacityReason(full: AgentRpcCapacityFull): string {
  const scope =
    full.code === "project_overloaded"
      ? "the recipient's project"
      : "the recipient's host";
  const what = full.attachments ? "messages with attachments" : "messages";
  return `the recipient is busy (${full.active} of ${full.limit} ${what} to ${scope} are being delivered right now); retry in a few seconds`;
}
