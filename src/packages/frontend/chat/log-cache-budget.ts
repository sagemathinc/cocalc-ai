const MAX_CACHED_LOG_BYTES = 1_048_576;
const MAX_CACHED_LOG_EVENTS = 2_000;
const MAX_VISITED_VALUES = 10_000;

// Do not serialize a potentially huge log just to decide whether to retain it.
// This conservative estimate also bounds the work spent making that decision.
export function canCacheActivityLog(events: unknown[]): boolean {
  if (events.length > MAX_CACHED_LOG_EVENTS) return false;
  const pending: unknown[] = [events];
  let bytes = 0;
  let visited = 0;
  while (pending.length) {
    if (++visited > MAX_VISITED_VALUES) return false;
    const value = pending.pop();
    bytes += typeof value === "string" ? value.length * 2 : 64;
    if (bytes > MAX_CACHED_LOG_BYTES) return false;
    if (value && typeof value === "object") {
      const values = Array.isArray(value) ? value : Object.values(value);
      if (values.length + pending.length + visited > MAX_VISITED_VALUES)
        return false;
      for (const child of values) pending.push(child);
    }
  }
  return true;
}
