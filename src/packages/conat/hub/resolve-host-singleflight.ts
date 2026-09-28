import stableStringify from "json-stable-stringify";

const flights = new WeakMap<object, Map<string, Promise<unknown>>>();

// Only pending host resolution, not a result cache. The caller must supply the
// actual resolver promise, never an outer timeout that leaves its RPC running.
export function resolveHostConnectionSingleFlight<T>(
  owner: object,
  scope: unknown,
  args: unknown[],
  request: () => Promise<T>,
): Promise<T> {
  const key = stableStringify([scope, args])!;
  let pending = flights.get(owner);
  if (!pending) {
    pending = new Map();
    flights.set(owner, pending);
  }
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;

  const entries = pending;
  const flight = request().finally(() => {
    if (entries.get(key) === flight) entries.delete(key);
    if (entries.size === 0 && flights.get(owner) === entries) {
      flights.delete(owner);
    }
  });
  entries.set(key, flight);
  return flight;
}
