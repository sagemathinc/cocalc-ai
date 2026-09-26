/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { JupyterActions } from "./actions";

// The browser's optimistic fast open shows a notebook read-only until its
// syncdb is ready, and the syncdb emits "metadata-change" (which runs
// sync_read_only) while it is still loading.
describe("JupyterActions.sync_read_only", () => {
  function createActions(syncdb?: object) {
    const actions: any = new JupyterActions("sync-read-only-test", {
      getStore: jest.fn(() => undefined),
    } as any);
    const state: Record<string, any> = { read_only: true };
    actions._state = "init";
    actions.syncdb = syncdb;
    actions.store = { get: (key: string) => state[key] };
    actions.setState = (obj: Record<string, any>) => Object.assign(state, obj);
    actions.set_cm_options = jest.fn();
    return { actions, state };
  }

  // Like SyncDoc, where isReady() is get_state() == "ready", so the tests
  // check behaviour rather than which of the two the guard calls.
  function syncdb(state: string, readOnly = false) {
    return {
      get_state: () => state,
      isReady: () => state == "ready",
      is_read_only: () => readOnly,
    };
  }

  it.each(["init", "closed"])(
    "stays read-only while the syncdb is %s",
    (syncdbState) => {
      const { actions, state } = createActions(syncdb(syncdbState));

      actions.sync_read_only();

      expect(state.read_only).toBe(true);
      expect(actions.set_cm_options).not.toHaveBeenCalled();
    },
  );

  it("stays read-only when there is no syncdb", () => {
    const { actions, state } = createActions(undefined);

    actions.sync_read_only();

    expect(state.read_only).toBe(true);
  });

  it("follows the syncdb once it is ready", () => {
    const { actions, state } = createActions(syncdb("ready"));

    actions.sync_read_only();

    expect(state.read_only).toBe(false);
    expect(actions.set_cm_options).toHaveBeenCalledTimes(1);

    actions.syncdb = syncdb("ready", true);
    actions.sync_read_only();

    expect(state.read_only).toBe(true);
    expect(actions.set_cm_options).toHaveBeenCalledTimes(2);
  });
});
