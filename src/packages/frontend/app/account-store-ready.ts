/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  redux,
  useEffect,
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

  useEffect(() => {
    let store = redux.getStore("account");
    const onReady = () => {
      setLoaded(true);
    };

    function syncLoaded(nextStore = redux.getStore("account")): void {
      const ready = !!(nextStore?.get?.("is_ready") ?? is_ready);
      setLoaded(ready);
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
      unsubscribe?.();
      store?.removeListener("is_ready", onReady);
    };
  }, [account_id, is_ready]);

  return loaded;
}
