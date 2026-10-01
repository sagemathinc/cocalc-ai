/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createContext, useEffect, useRef, useState } from "react";
import type { DirectoryApi } from "./workspace-api";
import { uuid } from "@cocalc/util/misc";
import type {
  CollaborationDemandScope,
  CollaborationDemandReceipt,
} from "@cocalc/util/collaboration-demand";

export const DirectoryRevisionContext = createContext({
  generation: 0,
  ready: true,
});

/** The initial check precedes all page reads. Subsequent checks use its token,
 * so commits during a page query cannot fall into a snapshot/subscription gap.
 * Tokens are opaque: only reset, not token-string changes, invalidates pages.
 */
export function useDirectoryRevision(
  api: DirectoryApi,
  active: boolean,
  scope?: CollaborationDemandScope,
) {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  active = active && visible;
  const consumer = useRef<string | undefined>(undefined);
  if (!consumer.current) consumer.current = uuid();
  // Serialize lease transitions across effect cleanup/restart. A late acquire
  // must be released before a new visible session reuses this consumer slot.
  const operations = useRef(Promise.resolve());
  const scopeKey = JSON.stringify(scope ?? null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({
    ready: false,
    generation: 0,
    error: "",
    scanSupported: false,
  });
  const wasActive = useRef(active);
  if (wasActive.current !== active) {
    wasActive.current = active;
    setState((current) => ({ ...current, ready: false, error: "" }));
  }
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let since: string | undefined;
    let lease: CollaborationDemandReceipt | undefined;
    let renewAt = 0;
    const serial = (fn: () => Promise<void>) => {
      const result = operations.current.then(fn);
      operations.current = result.catch(() => {});
      return result;
    };
    const release = async () => {
      const prior = lease;
      lease = undefined;
      if (prior && api.releaseDemand)
        await api
          .releaseDemand({
            consumer_id: prior.consumer_id,
            lease_id: prior.lease_id,
          })
          .catch(() => {});
    };
    const poll = async () => {
      try {
        const check = await api.check({ since });
        if (cancelled) return;
        if (
          !check ||
          typeof check.revision !== "string" ||
          typeof check.reset !== "boolean"
        )
          throw Error(
            "The collaboration revision service returned an invalid response.",
          );
        since = check.revision;
        if (check.demand_supported && scopeKey !== "null") {
          await serial(async () => {
            if (cancelled) return;
            if (!api.acquireDemand || !api.renewDemand || !api.releaseDemand)
              throw Error(
                "This People client does not support demand scheduling.",
              );
            try {
              if (!lease) {
                lease = await api.acquireDemand({
                  consumer_id: consumer.current!,
                  scope: JSON.parse(scopeKey),
                });
                renewAt = Date.now() + 30_000;
              } else if (renewAt <= Date.now()) {
                lease = await api.renewDemand({
                  consumer_id: lease.consumer_id,
                  lease_id: lease.lease_id,
                });
                // Use elapsed client time, not comparison to the server clock.
                // The server still independently enforces renewal and expiry.
                renewAt = Date.now() + 30_000;
              }
            } catch (error) {
              await release();
              throw error;
            } finally {
              if (cancelled) await release();
            }
          });
        } else {
          await serial(release);
        }
        if (cancelled) return;
        setState((current) =>
          !check.reset &&
          current.ready &&
          !current.error &&
          current.scanSupported === !!check.scan_supported
            ? current
            : {
                ready: true,
                generation:
                  current.generation + (check.reset || !current.ready ? 1 : 0),
                error: "",
                scanSupported: !!check.scan_supported,
              },
        );
        timer = setTimeout(
          () => void poll(),
          Math.min(30_000, Math.max(1000, check.poll_after_ms || 5000)),
        );
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          ready: false,
          error: String(error),
        }));
        // Recovery always resnapshots; never trust metadata while access is unknown.
        since = undefined;
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void serial(release);
    };
  }, [api, active, retry, scopeKey]);
  return {
    ...state,
    ready: active && state.ready,
    retry: () => setRetry((n) => n + 1),
  };
}
