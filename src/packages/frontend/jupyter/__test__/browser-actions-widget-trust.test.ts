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
jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {
    close = jest.fn();
    constructor(public opts: any) {
      created.push(this);
    }
  },
}));

import { JupyterActions } from "../browser-actions";

describe("widget manager follows notebook trust", () => {
  function setup(trust: boolean) {
    const actions: any = new JupyterActions("widget-trust-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    let trusted = trust;
    actions._state = "ready";
    actions.store = {
      get: (key: string) => (key == "trust" ? trusted : undefined),
    };
    actions.syncdb = { ipywidgets_state: { get_state: () => "ready" } };
    return {
      actions,
      setTrust: (value: boolean) => {
        trusted = value;
        actions.syncWidgetManagerWithTrust();
      },
    };
  }

  beforeEach(() => {
    created.length = 0;
  });

  it("does not create a widget manager for an untrusted notebook", () => {
    const { actions } = setup(false);
    actions.syncWidgetManagerWithTrust();
    expect(actions.widget_manager).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it("creates the manager when trusted and closes it when trust is lost", () => {
    const { actions, setTrust } = setup(false);
    actions.syncWidgetManagerWithTrust();
    setTrust(true);
    expect(created).toHaveLength(1);
    expect(actions.widget_manager).toBe(created[0]);
    // Repeated store changes don't create a second manager.
    setTrust(true);
    expect(created).toHaveLength(1);

    setTrust(false);
    expect(actions.widget_manager).toBeUndefined();
    expect(created[0].close).toHaveBeenCalledTimes(1);

    // Trusting again starts a fresh manager.
    setTrust(true);
    expect(created).toHaveLength(2);
    expect(actions.widget_manager).toBe(created[1]);
  });
});
