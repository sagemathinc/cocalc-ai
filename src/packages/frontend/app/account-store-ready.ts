/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  redux,
  useEffect,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";

export function useAccountStoreReady(): boolean {
  const account_id = useTypedRedux("account", "account_id");
  const is_ready = useTypedRedux("account", "is_ready");
  const [loaded, setLoaded] = useState<boolean>(() => {
    const store = redux.getStore("account");
    return !!(store?.get?.("is_ready") ?? is_ready);
  });
  const mountedRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    let store = redux.getStore("account");
    const setLoadedLater = (ready: boolean) => {
      queueMicrotask(() => {
        if (!mountedRef.current) {
          return;
        }
        setLoaded((current) => (current === ready ? current : ready));
      });
    };
    const onReady = () => {
      setLoadedLater(true);
    };

    function syncLoaded(nextStore = redux.getStore("account")): void {
      const ready = !!(nextStore?.get?.("is_ready") ?? is_ready);
      setLoadedLater(ready);
    }

    syncLoaded(store);
    store?.on("is_ready", onReady);

    const unsubscribe = redux.reduxStore.subscribe(() => {
      const nextStore = redux.getStore("account");
      if (nextStore !== store) {
        store?.removeListener("is_ready", onReady);
        store = nextStore;
        store?.on("is_ready", onReady);
      }
      syncLoaded(nextStore);
    });

    return () => {
      mountedRef.current = false;
      unsubscribe?.();
      store?.removeListener("is_ready", onReady);
    };
  }, [account_id, is_ready]);

  return loaded;
}
