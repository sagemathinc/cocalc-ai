import { recordServiceAdmissionDenial } from "@cocalc/conat/admission/denials";

function limit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export const MAX_PROJECT_READS = limit(
  "COCALC_PROJECT_FILE_READ_MAX_ACTIVE",
  4,
);
const MAX_PRINCIPAL_READS = limit("COCALC_FILE_READ_MAX_ACTIVE_PRINCIPAL", 8);
const MAX_TOTAL_READS = limit("COCALC_FILE_READ_MAX_ACTIVE_TOTAL", 64);
// How long acquireWait waits for a free slot before failing as busy, and how
// many callers may wait at once (beyond that, busy at once).
export const READ_ADMISSION_WAIT_MS = limit(
  "COCALC_FILE_READ_ADMISSION_WAIT_MS",
  60_000,
);
const MAX_WAITING = limit("COCALC_FILE_READ_ADMISSION_MAX_WAITING", 256);
// The producer's reply when the project serves as many reads as it allows.
export const PRODUCER_BUSY = "project file read service is busy";

// Keys are independent of service names, share IDs, sockets and connections.
// Producers and consumers have separate pools because host HTTP uses both.
export class ReadAdmission {
  private total = 0;
  private projects = new Map<string, number>();
  private principals = new Map<string, number>();
  // callers of acquireWait waiting for a release
  private waiting = new Set<() => void>();

  constructor(private readonly side: "producer" | "consumer") {}

  // Like acquire, but when a limit is reached, waits (up to timeoutMs) for a
  // read to finish instead of failing at once. Callers that start many reads
  // together, e.g., a course copying an assignment to many students, then
  // run them a few at a time instead of failing some of them. Fails as busy
  // after the timeout, when too many callers already wait, or on abort.
  async acquireWait(
    project_id: string,
    principal: string,
    subject: string,
    {
      projectLimit = MAX_PROJECT_READS,
      timeoutMs = READ_ADMISSION_WAIT_MS,
      signal,
    }: { projectLimit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      const release = this.tryAcquire(project_id, principal, projectLimit);
      if (release != null) return release;
      if (remaining <= 0 || this.waiting.size >= MAX_WAITING) {
        return this.acquire(project_id, principal, subject, projectLimit);
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          this.waiting.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        signal?.addEventListener("abort", wake);
        this.waiting.add(wake);
      });
    }
  }

  acquire(
    project_id: string,
    principal: string,
    subject: string,
    projectLimit = MAX_PROJECT_READS,
  ): () => void {
    const release = this.tryAcquire(project_id, principal, projectLimit);
    if (release != null) return release;
    for (const [current, maximum, name] of this.constraints(
      project_id,
      principal,
      projectLimit,
    )) {
      if (current < maximum) continue;
      const error =
        this.side === "producer" ? PRODUCER_BUSY : "file read consumer is busy";
      recordServiceAdmissionDenial({
        surface: `project-file-read-${this.side}`,
        source: "project-service",
        limit: name,
        current,
        maximum,
        reason: error,
        subject,
        project_id,
        account_id: principal.startsWith("account:")
          ? principal.slice(8)
          : undefined,
        key: principal,
      });
      throw Error(error);
    }
    throw Error("unreachable: a limit was reached");
  }

  private constraints(
    project_id: string,
    principal: string,
    projectLimit: number,
  ) {
    return [
      [
        this.projects.get(project_id) ?? 0,
        Math.min(projectLimit, MAX_PROJECT_READS),
        "COCALC_PROJECT_FILE_READ_MAX_ACTIVE",
      ],
      [
        this.principals.get(principal) ?? 0,
        MAX_PRINCIPAL_READS,
        "COCALC_FILE_READ_MAX_ACTIVE_PRINCIPAL",
      ],
      [this.total, MAX_TOTAL_READS, "COCALC_FILE_READ_MAX_ACTIVE_TOTAL"],
    ] as const;
  }

  // A reservation, or undefined (nothing recorded) if a limit is reached.
  private tryAcquire(
    project_id: string,
    principal: string,
    projectLimit: number,
  ): (() => void) | undefined {
    for (const [current, maximum] of this.constraints(
      project_id,
      principal,
      projectLimit,
    )) {
      if (current >= maximum) return;
    }
    this.total++;
    this.projects.set(project_id, (this.projects.get(project_id) ?? 0) + 1);
    this.principals.set(principal, (this.principals.get(principal) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      for (const [map, key] of [
        [this.projects, project_id],
        [this.principals, principal],
      ] as const) {
        const count = map.get(key)! - 1;
        if (count) map.set(key, count);
        else map.delete(key);
      }
      // Each waiter retries; those that still don't fit wait again.
      for (const wake of [...this.waiting]) wake();
    };
  }
}
