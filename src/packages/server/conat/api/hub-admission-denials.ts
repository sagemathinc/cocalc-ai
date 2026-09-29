import type { ServiceAdmissionDenialEvent } from "@cocalc/conat/admission/denials";

type Event = ServiceAdmissionDenialEvent;

// A slow telemetry sink must not become another unbounded admission queue.
export function createHubAdmissionDenialRecorder({
  record,
  warn,
  intervalMs = 10_000,
  maxGroups = 128,
}: {
  record: (event: Event) => Promise<void>;
  warn: (message: string, details: object) => void;
  intervalMs?: number;
  maxGroups?: number;
}) {
  let pending = new Map<string, Event>();
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

  function enqueue(event: Event): void {
    // reason includes changing active-request ages; it is a sample, not a key.
    let key = JSON.stringify([
      event.source,
      event.limit,
      event.account_id,
      event.key,
      event.subject,
    ]);
    if (!pending.has(key) && pending.size >= maxGroups) {
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
    }
    const previous = pending.get(key);
    const time = event.time ?? Date.now();
    const count = (previous?.count ?? 0) + (event.count ?? 1);
    pending.set(key, {
      ...event,
      count,
      suppressed_count: count - 1,
      current: Math.max(previous?.current ?? 0, event.current),
      maximum: Math.max(previous?.maximum ?? 0, event.maximum),
      first_time: Math.min(previous?.first_time ?? time, time),
      last_time: Math.max(previous?.last_time ?? time, time),
      time,
    });
    schedule();
  }

  function flush(): Promise<void> {
    if (flushing != null) return flushing;
    if (timer != null) clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return Promise.resolve();
    const batches = [...pending.values()];
    pending = new Map();
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
