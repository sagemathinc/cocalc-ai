import type { LroSummary } from "@cocalc/conat/hub/api/lro";

type ListLroFunction = (opts: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  include_completed?: boolean;
}) => Promise<LroSummary[]>;

export function createSharedLroListClient({
  listLro,
  ttlMs = 5_000,
}: {
  listLro: ListLroFunction;
  ttlMs?: number;
}): ListLroFunction {
  const cache = new Map<
    string,
    {
      expiresAt: number;
      value?: LroSummary[];
      inFlight?: Promise<LroSummary[]>;
    }
  >();

  return async (opts) => {
    const key = JSON.stringify([
      opts.scope_type,
      opts.scope_id,
      !!opts.include_completed,
    ]);
    const now = Date.now();
    const current = cache.get(key);
    if (current?.inFlight) {
      return await current.inFlight;
    }
    if (current?.value && current.expiresAt > now) {
      return current.value;
    }
    const inFlight = listLro(opts)
      .then((value) => {
        cache.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return value;
      })
      .catch((err) => {
        if (cache.get(key)?.inFlight === inFlight) {
          cache.delete(key);
        }
        throw err;
      });
    cache.set(key, {
      expiresAt: now + ttlMs,
      inFlight,
    });
    return await inFlight;
  };
}
