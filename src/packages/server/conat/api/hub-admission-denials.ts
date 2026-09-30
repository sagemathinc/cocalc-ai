import type { ServiceAdmissionDenialEvent } from "@cocalc/conat/admission/denials";

type Event = ServiceAdmissionDenialEvent;

const STRING_LIMITS = {
  surface: 120,
  limit: 120,
  source: 80,
  reason: 512,
  host_id: 80,
  account_id: 80,
  project_id: 80,
  browser_id: 80,
  socket_id: 120,
  subject: 512,
  path: 1024,
  key: 256,
} as const;

function boundedEvent(input: Event): Event {
  const strings: Partial<Record<keyof typeof STRING_LIMITS, string>> = {};
  for (const field of Object.keys(
    STRING_LIMITS,
  ) as (keyof typeof STRING_LIMITS)[]) {
    const value = input[field];
    if (typeof value === "string") {
      // Copy only the bounded prefix, detaching it from a potentially huge
      // backing string. Never retain unknown fields or stringify input objects.
      strings[field] = Buffer.from(value.slice(0, STRING_LIMITS[field]), "utf8")
        .toString("utf8")
        .trim();
    }
  }
  const finite = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    ...strings,
    surface: strings.surface || "unknown",
    limit: strings.limit || "unknown",
    current: Math.max(0, finite(input.current, 0)),
    maximum: Math.max(0, finite(input.maximum, 0)),
    count: Math.max(1, Math.floor(finite(input.count, 1))),
    time: finite(input.time, Date.now()),
  };
}

function retainedBytes(key: string, event: Event): number {
  // Conservative UTF-16 accounting including escaped JSON and a fixed object
  // allowance. The group cap separately bounds Map/object overhead.
  return 256 + 2 * (key.length + JSON.stringify(event).length);
}

// A slow telemetry sink must not become another unbounded admission queue.
export function createHubAdmissionDenialRecorder({
  record,
  warn,
  intervalMs = 10_000,
  maxGroups = 128,
  maxBytes = 256 * 1024,
}: {
  record: (event: Event) => Promise<void>;
  warn: (message: string, details: object) => void;
  intervalMs?: number;
  maxGroups?: number;
  maxBytes?: number;
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8192) {
    throw Error("telemetry maxBytes must be an integer of at least 8192");
  }
  // At most one batch can flush while another queues. Reserve overflow space
  // in each half; even a stalled sink cannot double the configured budget.
  const pendingBudget = Math.floor(maxBytes / 2) - 2048;
  let pendingBytes = 0;
  let pending = new Map<string, { event: Event; bytes: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;

  function schedule() {
    if (timer != null || flushing != null || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, intervalMs);
    timer.unref?.();
  }

  function enqueue(input: Event): void {
    let event = boundedEvent(input);
    // reason includes changing active-request ages; it is a sample, not a key.
    let key = JSON.stringify([
      event.source,
      event.limit,
      event.account_id,
      event.key,
      event.subject,
    ]);
    const previous = pending.get(key);
    const aggregate = (sample: Event, previous?: Event): Event => {
      const time = sample.time!;
      const count = Math.min(
        Number.MAX_SAFE_INTEGER,
        (previous?.count ?? 0) + (sample.count ?? 1),
      );
      return {
        ...sample,
        count,
        suppressed_count: count - 1,
        current: Math.max(previous?.current ?? 0, sample.current),
        maximum: Math.max(previous?.maximum ?? 0, sample.maximum),
        first_time: Math.min(previous?.first_time ?? time, time),
        last_time: Math.max(previous?.last_time ?? time, time),
        time,
      };
    };
    let next = aggregate(event, previous?.event);
    let bytes = retainedBytes(key, next);
    if (
      (!previous && pending.size >= maxGroups) ||
      pendingBytes - (previous?.bytes ?? 0) + bytes > pendingBudget
    ) {
      key = "overflow";
      event = {
        surface: "hub-conat-api",
        source: "hub-api-telemetry-overflow",
        limit: "mixed",
        reason:
          "Additional denial groups aggregated without account attribution",
        current: event.current,
        maximum: event.maximum,
        count: event.count,
        time: event.time,
      };
      next = aggregate(event, pending.get(key)?.event);
      bytes = retainedBytes(key, next);
    } else {
      pendingBytes += bytes - (previous?.bytes ?? 0);
    }
    pending.set(key, { event: next, bytes });
    schedule();
  }

  function flush(): Promise<void> {
    if (flushing != null) return flushing;
    if (timer != null) clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return Promise.resolve();
    const batches = [...pending.values()].map(({ event }) => event);
    pending = new Map();
    pendingBytes = 0;
    flushing = Promise.resolve()
      .then(async () => {
        warn("hub.api admission denials (aggregated)", {
          count: batches.reduce((sum, event) => sum + (event.count ?? 1), 0),
          groups: batches.length,
          samples: batches.slice(0, 3),
        });
        let failedCount = 0;
        for (const event of batches) {
          try {
            await record(event);
          } catch {
            // Telemetry is best effort: never retry into an overloaded database.
            failedCount += event.count ?? 1;
          }
        }
        if (failedCount > 0) {
          warn("failed to persist aggregated hub.api admission denials", {
            count: failedCount,
          });
        }
      })
      .finally(() => {
        flushing = undefined;
        schedule();
      });
    return flushing;
  }

  return { record: enqueue, flush };
}
