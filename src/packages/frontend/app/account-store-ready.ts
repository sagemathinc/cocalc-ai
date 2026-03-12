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
  const [loaded, setLoaded] = useState<boolean>(!!is_ready);

  useEffect(() => {
    const store = redux.getStore("account");
    if (store == null) {
      setLoaded(false);
      return;
    }
    if (is_ready) {
      setLoaded(true);
      return;
    }

    setLoaded(false);
    const onReady = () => {
      setLoaded(true);
    };
    store.on("is_ready", onReady);
    return () => {
      store.removeListener("is_ready", onReady);
    };
  }, [account_id, is_ready]);

  return loaded;
}
