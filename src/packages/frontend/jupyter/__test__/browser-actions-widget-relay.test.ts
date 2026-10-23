/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {},
}));

jest.mock("@cocalc/frontend/monitoring/product-activity", () => ({
  recordProductActivity: jest.fn(),
}));

jest.mock("@cocalc/frontend/monitoring/ux-latency-trace", () => ({
  afterNextPaint: (callback: () => void) => callback(),
  UxLatencyTrace: class UxLatencyTrace {
    mark() {}
    record() {}
  },
}));

const created: any[] = [];
jest.mock("../widgets/frame/relay", () => ({
  WidgetRelay: class WidgetRelay {
    close = jest.fn();
    args: any[];
    constructor(...args: any[]) {
      this.args = args;
      created.push(this);
    }
  },
}));

import { JupyterActions } from "../browser-actions";

describe("the notebook's widget relay", () => {
  function setup(store: { [key: string]: any } = {}) {
    created.length = 0;
    const actions: any = new JupyterActions("widget-relay-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions._state = "ready";
    actions.store = { get: (key: string) => store[key] };
    actions.syncdb = { ipywidgets_state: { get_state: () => "ready" } };
    return actions;
  }

  it("is created once, whatever the notebook's trust", () => {
    const actions = setup({ trust: false });
    const relay = actions.widgetRelay();
    expect(relay).toBe(created[0]);
    expect(actions.widgetRelay()).toBe(relay);
    expect(created.length).toBe(1);
    expect(relay.args[0]).toBe(actions.syncdb.ipywidgets_state);
  });

  it("lets frames write only while the notebook is writable", () => {
    const store: any = { read_only: false };
    const actions = setup(store);
    const allowed = actions.widgetRelay().args[2];
    expect(allowed()).toBe(true);
    store.read_only = true;
    expect(allowed()).toBe(false);
  });

  it("isn't created without live widget state", () => {
    const actions = setup();
    actions.syncdb = { ipywidgets_state: { get_state: () => "closed" } };
    expect(actions.widgetRelay()).toBeUndefined();
    actions.syncdb = {};
    expect(actions.widgetRelay()).toBeUndefined();
  });
});
