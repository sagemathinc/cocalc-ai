/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An empty notebook stores no cells until the user starts editing, so it is
// ready with none (support ticket 21023).

import { EventEmitter } from "events";
import { List } from "immutable";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: {} },
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

function target({
  stored,
  synced,
  initialSourceSettled = Promise.resolve(),
}: {
  stored: string[];
  synced: boolean;
  initialSourceSettled?: Promise<void>;
}) {
  const store: any = new EventEmitter();
  store.cell_list = List(stored);
  store.get = (key: string) => (key === "cell_list" ? store.cell_list : null);
  return {
    store,
    initialSourceSettled,
    isClosed: () => false,
    syncdb: {
      get_state: () => "ready",
      get_one: () => (synced ? { type: "cell", id: "a" } : undefined),
    },
  };
}

const waitUntilReady = (t: any) =>
  JupyterActions.prototype.wait_until_ready.call(t);

describe("JupyterActions.wait_until_ready", () => {
  it("is ready for an empty notebook", async () => {
    await expect(
      waitUntilReady(target({ stored: [], synced: false })),
    ).resolves.toBeUndefined();
  });

  it("waits until synced cells reach the store", async () => {
    const t = target({ stored: [], synced: true });
    let ready = false;
    const done = waitUntilReady(t).then(() => (ready = true));

    await Promise.resolve();
    expect(ready).toBe(false);

    t.store.cell_list = List(["a"]);
    t.store.emit("change");
    await done;
    expect(ready).toBe(true);
  });

  it("waits for the initial load from disk before calling it empty", async () => {
    let settle = () => {};
    const t = target({
      stored: [],
      synced: false,
      initialSourceSettled: new Promise<void>((resolve) => (settle = resolve)),
    });
    let ready = false;
    const done = waitUntilReady(t).then(() => (ready = true));

    await Promise.resolve();
    expect(ready).toBe(false);

    settle();
    await done;
    expect(ready).toBe(true);
  });

  it("settling the initial source marks the store and wakes waiters", async () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions.isClosed = () => false;
    actions.store = { get: () => undefined };
    actions.setState = jest.fn();

    actions.settleInitialSource();

    await actions.initialSourceSettled;
    expect(actions.setState).toHaveBeenCalledWith({
      initial_source_settled: true,
    });
  });
});
