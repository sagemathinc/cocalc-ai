/** Non-waiting admission. A timed-out caller must not free resources still in use. */
export class AgentRpcCapacity {
  private active = 0;
  private readonly projects = new Map<string, number>();

  constructor(
    private readonly hostLimit = 4,
    private readonly projectLimit = 2,
  ) {
    if (
      !Number.isSafeInteger(hostLimit) ||
      hostLimit < 1 ||
      !Number.isSafeInteger(projectLimit) ||
      projectLimit < 1
    )
      throw new Error("positive integer messaging limits required");
  }

  acquire(
    projectId: string,
  ):
    | { code: "host_overloaded" | "project_overloaded" }
    | { track<T>(work: Promise<T>): Promise<T>; release(): void } {
    if (this.active >= this.hostLimit) return { code: "host_overloaded" };
    const count = this.projects.get(projectId) ?? 0;
    if (count >= this.projectLimit) return { code: "project_overloaded" };
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
