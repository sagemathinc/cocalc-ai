import { useEffect, useEffectEvent, useState } from "react";

/** Never expose a previous selection's document, including before effects run. */
export function useHistoryLoad<T>(selection: object, load: () => Promise<T>) {
  const [result, setResult] = useState<{
    selection: object;
    value?: T;
    error?: string;
  }>();
  const run = useEffectEvent(load);
  useEffect(() => {
    let cancelled = false;
    void run().then(
      (value) => {
        if (!cancelled) setResult({ selection, value });
      },
      (error) => {
        if (!cancelled) setResult({ selection, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selection]);
  return result?.selection === selection ? result : undefined;
}
