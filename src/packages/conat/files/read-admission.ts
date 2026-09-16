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

// Keys are independent of service names, share IDs, sockets and connections.
// Producers and consumers have separate pools because host HTTP uses both.
export class ReadAdmission {
  private total = 0;
  private projects = new Map<string, number>();
  private principals = new Map<string, number>();

  constructor(private readonly side: "producer" | "consumer") {}

  acquire(
    project_id: string,
    principal: string,
    subject: string,
    projectLimit = MAX_PROJECT_READS,
  ): () => void {
    const constraints = [
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
    for (const [current, maximum, name] of constraints) {
      if (current < maximum) continue;
      const error =
        this.side === "producer"
          ? "project file read service is busy"
          : "file read consumer is busy";
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
    };
  }
}
