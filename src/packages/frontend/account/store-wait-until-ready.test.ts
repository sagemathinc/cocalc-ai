/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

import { AccountStore } from "./store";

function makeStore(is_ready: boolean) {
  let state = fromJS({ account: { is_ready } });
  const redux: any = { reduxStore: { getState: () => state } };
  const store = new AccountStore("account", redux);
  const becomeReady = () => {
    state = state.setIn(["account", "is_ready"], true);
    store.emit("is_ready");
  };
  return { store, becomeReady };
}

describe("AccountStore.waitUntilReady", () => {
  it("resolves immediately when the account is already loaded", async () => {
    const { store } = makeStore(true);
    expect(await store.waitUntilReady(50)).toBe(true);
  });

  it("resolves once the is_ready event fires", async () => {
    const { store, becomeReady } = makeStore(false);
    const p = store.waitUntilReady(5000);
    becomeReady();
    expect(await p).toBe(true);
  });

  it("returns false on timeout and removes its listener", async () => {
    const { store } = makeStore(false);
    expect(await store.waitUntilReady(1)).toBe(false);
    expect(store.listenerCount("is_ready")).toBe(0);
  });
});
